// POST /api/runners/supervision
//
// The project supervisor's tick. The RUNNER is the clock; this route is the
// actor. Read `lib/engine/supervisor-policy.ts` for why the loop lives in the
// runner process at all.
//
// ── THE DIVISION, AND WHY IT IS THIS WAY ──────────────────────────────────
// The runner is the only resident process in the system, so it keeps ticking
// when the Inngest scheduler is dead - which is the entire point, since every
// recovery mechanism in devpilot is a cron. But the runner holds NO database
// credentials and must not gain any, so it cannot look at a board, and it is
// POOLED ACROSS TENANTS, so it must not be trusted to name one.
//
// The request body therefore carries no tenant, no project, and no ticket. Its
// only fields are the runner's own identity and the set of runs it is provably
// executing right now. Every tenant and project in the plan is derived from the
// row the engine read - the same boundary every other runner route observes.
//
// The runner's evidence is admitted as a VETO ONLY (`isVetoedByLiveRunner`): it
// can stop the supervisor acting on a ticket, never cause it to act. That
// asymmetry is what makes it safe to accept unverified input here at all - the
// worst a lying runner achieves is a supervisor that does LESS.
//
// Auth: `x-devpilot-runner-key`, the same gate as every other runner route.
//
// Request body:  { runnerId?: string, activeRunIds?: string[] }
// Response 200:  a SupervisionPassResult, or { throttled: true }
// Response 401:  { error } - bad runner key

import { NextResponse } from "next/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { redis } from "@/lib/cache/redis";
import { runSupervisionPass } from "@/lib/engine/supervisor-store";
import { defaultSupervisorDeps } from "@/lib/engine/supervisor-store.server";

export const dynamic = "force-dynamic";

/**
 * How many run ids one report may name. A runner's concurrency is ~1–3; this is
 * two orders of magnitude of headroom and exists only so a malformed or hostile
 * body cannot make us build an unbounded Set.
 */
const MAX_REPORTED_RUNS = 256;

/**
 * Minimum seconds between supervision passes, INSTANCE-WIDE.
 *
 * The runner pool is multi-host and every runner ticks independently, so
 * without this the pass cost multiplies by the number of runners and several
 * supervisors race on the same candidate window - the two-writer problem this
 * feature is otherwise so careful to avoid, reintroduced among the supervisors
 * themselves. The lease makes at most one pass run per window regardless of how
 * many runners are up.
 *
 * Held in Redis with `nx` + `ex`, so it expires on its own and a crashed pass
 * cannot wedge supervision permanently.
 */
const PASS_LEASE_SECONDS = Number(process.env.DEVPILOT_SUPERVISOR_MIN_INTERVAL_SECONDS ?? "45");
const PASS_LEASE_KEY = "devpilot:supervisor:pass";

/**
 * Take the pass lease.
 *
 * FAILS OPEN on a Redis error: Redis being unreachable is not a reason to stop
 * supervising, and the pass is idempotent (every remediation goes through an
 * atomic claim or a CAS-guarded transition). The lease is a cost control, not a
 * correctness mechanism - saying so here matters, because a reader could
 * otherwise mistake it for the thing that prevents double remediation.
 */
async function takePassLease(): Promise<boolean> {
  try {
    const got = await redis().set(PASS_LEASE_KEY, "1", { nx: true, ex: PASS_LEASE_SECONDS });
    return got !== null;
  } catch {
    return true;
  }
}

type Body = { runnerId?: unknown; activeRunIds?: unknown };

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const payload = (await request.json().catch(() => null)) as Body | null;

  // Diagnostic ONLY. It is never used to scope anything - a pooled runner names
  // no tenant and no project here, and this string is not verified against the
  // `runners` table. It exists so a failed pass can be attributed to a host in
  // the log, which is the question you ask when one runner in a pool misbehaves.
  const runnerId = typeof payload?.runnerId === "string" ? payload.runnerId.slice(0, 64) : "?";

  const activeRunIds = new Set<string>(
    Array.isArray(payload?.activeRunIds)
      ? payload.activeRunIds
          .filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 64)
          .slice(0, MAX_REPORTED_RUNS)
      : [],
  );

  if (!(await takePassLease())) {
    // Another runner ran a pass inside the window. Cheap, silent, and it does
    // NOT probe the database - the whole point of the lease is that N runners
    // cost what one costs.
    return NextResponse.json(
      { throttled: true, leaseSeconds: PASS_LEASE_SECONDS },
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const deps = defaultSupervisorDeps(new Date().toISOString());
    const result = await runSupervisionPass(deps, activeRunIds);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    // A supervisor that can 500 its own loop is not a supervisor. Report the
    // failure and let the runner keep ticking.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[supervisor] pass failed (driven by runner=${runnerId}): ${msg}`);
    return NextResponse.json({ error: msg, ok: false }, { status: 200 });
  }
}
