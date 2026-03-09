// Per-run budget enforcement.
//
// Two layers:
//
//   1. Per-run dollar/token ceiling — Phase 0. Each run row carries a
//      `budget_cents`; the next action is refused once spent ≥ budget.
//      Inngest's NonRetriableError marks the run failed cleanly.
//
//   2. Per-tenant cost-velocity circuit breaker — Phase 1 fast-follow after
//      the Wave 3 runaway. Tracks aggregate per-tenant spend in a sliding
//      ~60s Redis bucket; once the bucket exceeds the configured
//      `DEVPILOT_TENANT_VELOCITY_CENTS_PER_MIN` ceiling (default $5/min), no
//      new LLM step starts for that tenant until the bucket rolls over.
//      This catches cost-explosion classes the per-run cap can't see — e.g.
//      a misconfigured dispatcher that fans hundreds of cheap runs (CLAUDE.md
//      §3 explicitly mandates this guard as P0).
//
// Phase 2 will extend the `action` parameter to "spawn" for supervisor caps.
// Keep the signature stable.
//
// The turnstile → ceiling fix and the per-project override
// ───────────────────────────────────────────────────────
// `assertCanProceed` only ever checked headroom BEFORE a step starts. Because
// every dispatch path sends `iterations: 1`, a run's one step IS its whole
// lifecycle — nothing re-checked the cap once that step's actual cost was
// known, so an overshooting step completed and the run finished normally as
// if nothing had happened. See `budget-ceiling-policy.ts` for the measured
// evidence and the full argument. `lib/engine/run-agent.ts` now calls this
// function AGAIN immediately after every step's spend is recorded — same
// function, same message shapes, same classification — so a run that just
// blew its cap stops cleanly at that boundary instead of silently continuing.
//
// `overrideCap` (threaded from `projects.budget_cap_override_enabled`) makes
// the PER-RUN check above never refuse, for callers who have decided a
// specific project's work should not be cut off mid-flight for cost. It never
// reaches the velocity breaker below, which stays the backstop precisely so
// "ignore my cap" cannot mean "no ceiling at all" for that project, and so an
// overridden project can't starve every other project sharing the tenant's
// spend window — see `decideVelocityBreaker`'s header.

import { NonRetriableError } from "inngest";
import { supabaseService } from "@/lib/db/server";
import { redis } from "@/lib/cache/redis";
import { decideBudgetCeiling, decideVelocityBreaker } from "@/lib/engine/budget-ceiling-policy";

export type BudgetAction = "llm" | "tool" | "spawn";

export type BudgetCheckResult = {
  spentCents: number;
  budgetCents: number;
  remainingCents: number;
};

// Minimum slack required before the next action (covers the cheapest realistic
// LLM call). Keeps the run from limping at 99% spent and failing partway.
const MIN_REMAINING_CENTS = 1;

// Velocity-guard constants. Window is fixed at 60s (one minute bucket) for
// simplicity; the limit is operator-configurable. Set the env var to 0 to
// disable the guard entirely (NOT recommended outside isolated test runs).
const VELOCITY_WINDOW_SEC = 60;
const DEFAULT_VELOCITY_LIMIT_CENTS_PER_MIN = 500; // $5/min/tenant
const VELOCITY_LIMIT_CENTS_PER_MIN = Number(
  process.env.DEVPILOT_TENANT_VELOCITY_CENTS_PER_MIN ?? DEFAULT_VELOCITY_LIMIT_CENTS_PER_MIN,
);

function velocityKey(tenantId: string, nowMs: number = Date.now()): string {
  const bucket = Math.floor(nowMs / 1000 / VELOCITY_WINDOW_SEC);
  return `devpilot:spend:${tenantId}:${bucket}`;
}

/**
 * Returns the current bucket's spend for a tenant (cents), read from Redis.
 *
 * FAIL-CLOSED contract: a MISSING key returns `null` and means genuinely-zero
 * spend this window → return 0 and proceed. A THROWN error means Redis is
 * unreachable, so we cannot know the tenant's spend velocity — we rethrow
 * rather than assume 0. CLAUDE.md §3 makes the cost-explosion breaker a
 * mandatory P0 guard; treating a transport error as "0 spent" silently
 * disables it during exactly the infra incident where a runaway dispatcher is
 * most dangerous (the Wave-3 runaway class).
 *
 * The throw is RETRIABLE (plain Error, not NonRetriableError). `assertCanProceed`
 * runs only inside an Inngest `step.run`, so a transient blip self-heals on the
 * step retry and only a sustained outage fails the run. That costs no
 * availability we otherwise had: local-cc jobs are dispatched through this same
 * Redis, so a sustained Redis outage already halts new work regardless.
 */
async function readTenantBucketCents(tenantId: string): Promise<number> {
  try {
    const v = await redis().get<string | number>(velocityKey(tenantId));
    if (v == null) return 0;
    return typeof v === "number" ? v : Number(v) || 0;
  } catch (err) {
    throw new Error(
      `velocity breaker failing closed: Redis unreachable, cannot verify spend ` +
        `velocity for tenant ${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function bumpTenantBucketCents(tenantId: string, addCents: number): Promise<void> {
  if (addCents <= 0 || VELOCITY_LIMIT_CENTS_PER_MIN <= 0) return;
  try {
    const r = redis();
    const key = velocityKey(tenantId);
    await r.incrby(key, addCents);
    // EXPIRE in five window-widths so historical buckets clean themselves up.
    await r.expire(key, VELOCITY_WINDOW_SEC * 5);
  } catch (err) {
    // Best-effort, and deliberately NON-throwing: the durable spend record is
    // `runs.spent_cents` (recordSpend DOES throw on failure). This Redis bucket
    // is only the velocity SIGNAL, and recordSpend runs AFTER the LLM spend has
    // already happened — throwing here would trigger an Inngest retry that
    // double-spends. Log so an operator can see the breaker's view may be
    // under-counting after a Redis blip.
    console.warn(
      `[budget] velocity bucket bump failed for tenant ${tenantId} ` +
        `(breaker may under-count until the window rolls): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
}

export type AssertCanProceedOptions = {
  /** Per-project opt-in (`projects.budget_cap_override_enabled`, resolved by
   *  the caller — this function never looks it up itself). `true` bypasses
   *  ONLY the per-run ceiling below; the tenant velocity breaker is checked
   *  unconditionally either way. Absent/`false` is today's behaviour exactly,
   *  so every pre-existing caller is unaffected. */
  overrideCap?: boolean;
};

/**
 * Throws NonRetriableError if the run has no budget headroom for the next
 * action OR if the tenant is over the velocity ceiling. Inngest stops
 * retrying on NonRetriableError, so the run is marked failed cleanly
 * instead of looping forever.
 *
 * Called at TWO boundaries by `run-agent.ts`: before a step starts (the
 * original turnstile check) and again immediately after that step's spend is
 * recorded (the ceiling fix — see this file's header). Both calls go through
 * the exact same decision, so a run's overshoot window can never exceed one
 * step regardless of which boundary catches it.
 */
export async function assertCanProceed(
  runId: string,
  action: BudgetAction,
  options: AssertCanProceedOptions = {},
): Promise<BudgetCheckResult> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("runs")
    .select("tenant_id, budget_cents, spent_cents, status")
    .eq("id", runId)
    .single();

  if (error || !data) {
    throw new NonRetriableError(`budget check failed: run ${runId} not found`);
  }
  if (data.status === "failed" || data.status === "done") {
    throw new NonRetriableError(`budget check failed: run ${runId} already ${data.status}`);
  }

  const spent = data.spent_cents ?? 0;
  const budget = data.budget_cents ?? 0;

  const ceiling = decideBudgetCeiling({
    action,
    runId,
    spentCents: spent,
    budgetCents: budget,
    minRemainingCents: MIN_REMAINING_CENTS,
    overrideCap: options.overrideCap ?? false,
  });
  if (!ceiling.ok) {
    throw new NonRetriableError(ceiling.message);
  }

  // Tenant velocity guard — NEVER gated on `overrideCap`. See
  // `decideVelocityBreaker`'s header for why this is the correct backstop.
  // Short-circuits on a disabled breaker (limit <= 0) exactly as before, so a
  // Redis outage with the breaker explicitly turned off never throws here.
  if (VELOCITY_LIMIT_CENTS_PER_MIN > 0 && data.tenant_id) {
    const tenantBucket = await readTenantBucketCents(data.tenant_id as string);
    const velocity = decideVelocityBreaker({
      tenantId: data.tenant_id as string,
      bucketCents: tenantBucket,
      limitCentsPerMin: VELOCITY_LIMIT_CENTS_PER_MIN,
      windowSec: VELOCITY_WINDOW_SEC,
    });
    if (!velocity.ok) {
      throw new NonRetriableError(velocity.message);
    }
  }

  return { spentCents: spent, budgetCents: budget, remainingCents: ceiling.remainingCents };
}

// ─── Plan-session breaker (Phase 2.5 / M7) ────────────────────────────────
//
// Plan-mode discussions and the ultra-panel are LLM-spend surfaces with no
// `runs` row to gate against, so we need a sibling check. Same Redis 60s
// velocity bucket the runs path uses (keyed per-tenant-AND-project so two
// concurrent operators in the same tenant don't starve each other's quotas
// inside a single project), plus a per-session HARD cap.
//
// Failure-mode contract:
//   • Throws plain `Error` with a stable `PLAN_SESSION_BUDGET:` prefix so
//     calling server actions can pattern-match the message for the UI toast.
//     (No NonRetriableError here — plan actions aren't inside Inngest.)
//   • Fail-CLOSED on Redis transport errors (matches `assertCanProceed`): a
//     transport error rethrows rather than assuming zero spend. The DB-based
//     per-session hard cap below is the primary, Redis-independent guard, so a
//     plan turn is never left un-capped even if the velocity bucket is down —
//     this just keeps the two spend surfaces symmetric.
//
// Hard-cap env:
//   DEVPILOT_PLAN_SESSION_MAX_CENTS — per-session ceiling (default 100¢ = $1).
//   Tested at 10¢ in the cost-ceiling smoke-test step of the plan's
//   verification matrix.

const DEFAULT_PLAN_SESSION_MAX_CENTS = 100;
const PLAN_SESSION_MAX_CENTS = Number(
  process.env.DEVPILOT_PLAN_SESSION_MAX_CENTS ?? DEFAULT_PLAN_SESSION_MAX_CENTS,
);

function planVelocityKey(tenantId: string, projectId: string, nowMs: number = Date.now()): string {
  const bucket = Math.floor(nowMs / 1000 / VELOCITY_WINDOW_SEC);
  return `devpilot:spend:${tenantId}:${projectId}:${bucket}`;
}

async function readProjectBucketCents(tenantId: string, projectId: string): Promise<number> {
  // Same fail-CLOSED contract as readTenantBucketCents: missing key → 0, but a
  // Redis transport error rethrows. The plan path additionally has a DB-based
  // per-session hard cap (assertCanProceedPlan, Redis-independent) as its
  // primary guard, so this is defense-in-depth kept symmetric with the runs path.
  try {
    const v = await redis().get<string | number>(planVelocityKey(tenantId, projectId));
    if (v == null) return 0;
    return typeof v === "number" ? v : Number(v) || 0;
  } catch (err) {
    throw new Error(
      `plan velocity breaker failing closed: Redis unreachable for tenant ${tenantId} ` +
        `project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function bumpProjectBucketCents(
  tenantId: string,
  projectId: string,
  addCents: number,
): Promise<void> {
  if (addCents <= 0 || VELOCITY_LIMIT_CENTS_PER_MIN <= 0) return;
  try {
    const r = redis();
    const key = planVelocityKey(tenantId, projectId);
    await r.incrby(key, addCents);
    await r.expire(key, VELOCITY_WINDOW_SEC * 5);
  } catch (err) {
    // Best-effort signal only (same rationale as bumpTenantBucketCents); the
    // durable record is planning_sessions.spent_cents. Never throw post-spend.
    console.warn(
      `[budget] plan velocity bucket bump failed for tenant ${tenantId} ` +
        `project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type PlanBudgetCheckArgs = {
  tenantId: string;
  projectId: string;
  sessionId: string;
  estCents: number;
};

/**
 * Throws `Error("PLAN_SESSION_BUDGET: …")` if either the per-session hard
 * cap would be exceeded by `estCents` OR the per-tenant-per-project velocity
 * bucket is over the configured limit. Otherwise returns the current
 * session spend so the caller can log it.
 *
 * Call at the TOP of every plan-mode server action that does an LLM call.
 */
export async function assertCanProceedPlan(
  args: PlanBudgetCheckArgs,
): Promise<{ spentCents: number }> {
  const { tenantId, projectId, sessionId, estCents } = args;

  // 1. Per-session hard cap. Read the session row's current spent_cents
  //    via service client (we're called from inside a server action that
  //    has already verified the caller's tenant membership).
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_sessions")
    .select("spent_cents, status, tenant_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) {
    throw new Error(`PLAN_SESSION_BUDGET: failed to load session ${sessionId}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`PLAN_SESSION_BUDGET: session ${sessionId} not found`);
  }
  if (data.tenant_id && data.tenant_id !== tenantId) {
    throw new Error(`PLAN_SESSION_BUDGET: session ${sessionId} tenant mismatch`);
  }
  const status = data.status as string;
  if (status === "discarded" || status === "committed") {
    throw new Error(
      `PLAN_SESSION_BUDGET: session ${sessionId} is ${status}; no further spend allowed`,
    );
  }

  const sessionSpent = (data.spent_cents as number | null) ?? 0;
  if (PLAN_SESSION_MAX_CENTS > 0 && sessionSpent + estCents > PLAN_SESSION_MAX_CENTS) {
    throw new Error(
      `PLAN_SESSION_BUDGET: per-session cap reached for session ${sessionId}: spent=${sessionSpent}¢ ` +
        `est=${estCents}¢ cap=${PLAN_SESSION_MAX_CENTS}¢ (raise DEVPILOT_PLAN_SESSION_MAX_CENTS to lift)`,
    );
  }

  // 2. Per-project velocity bucket.
  if (VELOCITY_LIMIT_CENTS_PER_MIN > 0) {
    const bucket = await readProjectBucketCents(tenantId, projectId);
    if (bucket >= VELOCITY_LIMIT_CENTS_PER_MIN) {
      throw new Error(
        `PLAN_SESSION_BUDGET: velocity circuit breaker tripped for tenant=${tenantId} project=${projectId}: ` +
          `bucket=${bucket}¢ limit=${VELOCITY_LIMIT_CENTS_PER_MIN}¢/min. ` +
          `Wait ${VELOCITY_WINDOW_SEC}s for the window to roll, then retry.`,
      );
    }
  }

  return { spentCents: sessionSpent };
}

/**
 * Add `addCents` to BOTH the session's running spend AND the per-project
 * velocity bucket. Mirrors `recordSpend` for the runs path.
 */
export async function recordPlanSessionSpend(args: {
  tenantId: string;
  projectId: string;
  sessionId: string;
  addCents: number;
}): Promise<void> {
  const { tenantId, projectId, sessionId, addCents } = args;
  if (addCents <= 0) return;
  const supabase = supabaseService();
  // Read-modify-write rather than a SQL increment so we keep the codepath
  // single-file with no migration churn. The plan-mode write-rate is human-
  // typed-message-paced, so the race window is negligible.
  const { data, error } = await supabase
    .from("planning_sessions")
    .select("spent_cents")
    .eq("id", sessionId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(
      `recordPlanSessionSpend: session ${sessionId} not found: ${error?.message ?? "missing row"}`,
    );
  }
  const next = ((data.spent_cents as number | null) ?? 0) + addCents;
  const { error: upErr } = await supabase
    .from("planning_sessions")
    .update({ spent_cents: next })
    .eq("id", sessionId);
  if (upErr) {
    throw new Error(`recordPlanSessionSpend: update failed: ${upErr.message}`);
  }
  await bumpProjectBucketCents(tenantId, projectId, addCents);
}

/** Adds the cost of a just-completed action to the run's spent_cents AND
 *  the tenant's current velocity bucket. */
export async function recordSpend(runId: string, addCents: number): Promise<void> {
  if (addCents <= 0) return;
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("runs")
    .select("tenant_id, spent_cents")
    .eq("id", runId)
    .single();
  if (error || !data) {
    throw new Error(`recordSpend: run ${runId} not found`);
  }
  const next = (data.spent_cents ?? 0) + addCents;
  const { error: upErr } = await supabase
    .from("runs")
    .update({ spent_cents: next, last_event_at: new Date().toISOString() })
    .eq("id", runId);
  if (upErr) {
    throw new Error(`recordSpend: ${upErr.message}`);
  }
  if (data.tenant_id) {
    await bumpTenantBucketCents(data.tenant_id as string, addCents);
  }
}
