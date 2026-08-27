// POST /api/runs/[id]/verification
//
// Runner → engine. After a producer run's agent step finishes (or when it
// calls `devpilot_move_ticket(in_review)`), the runner executes the configured check
// command (`ENGINEER_QA_COMMAND` [+ `ENGINEER_BUILD_COMMAND`]) against the
// workspace and POSTs the outcome here. The engine stores it; the
// `ENGINEER_QA_GATE_ENABLED` gate embedded in `transitionTicket`
// (`lib/board/transitions.ts`, keyed on the `actor` discriminator) reads it —
// strictly `WHERE run_id = <the transitioning run>` — and refuses the QA
// hand-off when `exit_code > 0` (v1). See `lib/board/qa-gate.ts` for the
// decision and `20260710000000_run_verifications.sql` for the storage split.
//
// The route segment is `[id]` and not `[runId]` because Next.js forbids two
// differently-named dynamic segments at the same position, and every sibling
// under `/api/runs` already uses `[id]`. The URL is unchanged:
// `POST /api/runs/<runId>/verification`.
//
// Auth: `x-devpilot-runner-key` header — same gate as every other runner→engine
// endpoint (`checkRunnerAuth`).
//
// Request body:  { command: string, exit_code: int, head_sha: string,
//                  base_sha?: string, pushed: boolean, output_tail?: string }
//   exit_code:  > 0 = real failure (blocks) · 0 = pass · < 0 = indeterminate
//   base_sha:   run-start HEAD; preserved-first on upsert (COALESCE) so the
//               gate's no-commit no-op sees the true run base, not a drifted one
// Response 200:  { ok: true, runId, ranAt }
// Response 400:  { error } — missing/invalid field
// Response 401:  { error } — bad runner key
// Response 404:  { error } — run not found
// Response 500:  { error } — DB write failed
//
// `ran_at` is stamped server-side and is NOT accepted from the body: a
// client-supplied clock is not a trustworthy freshness signal.
//
// Writes are upserts on `run_id`. A run that verifies twice — the agent fixed
// the failure and re-ran the command — overwrites its own row, so the gate
// reads the run's latest attempt rather than its first. That is the property
// that lets a blocked agent retry: fix, re-verify, move again.
//
// curl example:
//   curl -X POST http://localhost:3000/api/runs/<runId>/verification \
//     -H 'Content-Type: application/json' \
//     -H "x-devpilot-runner-key: $DEVPILOT_RUNNER_REGISTRATION_KEY" \
//     -d '{"command":"pnpm test","exit_code":0,"head_sha":"abc123","pushed":true,"output_tail":"..."}'

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";

export const dynamic = "force-dynamic";

/**
 * Cap on the stored output tail. Enough for a failing test's summary block,
 * bounded so a runaway build log can't bloat the row (the gate quotes an even
 * shorter slice back to the agent).
 */
const MAX_OUTPUT_TAIL_CHARS = 8000;

type Body = {
  command?: unknown;
  exit_code?: unknown;
  head_sha?: unknown;
  base_sha?: unknown;
  pushed?: unknown;
  output_tail?: unknown;
  commits_ahead?: unknown;
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id: runId } = await params;
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });

  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (command.length === 0) {
    return NextResponse.json({ error: "command required (non-empty string)" }, { status: 400 });
  }

  // Reject a non-integer exit code rather than coercing: `Number("")` is 0,
  // and silently storing a passing verification for a malformed body is the
  // one failure mode this endpoint must never have.
  if (typeof body.exit_code !== "number" || !Number.isInteger(body.exit_code)) {
    return NextResponse.json({ error: "exit_code required (integer)" }, { status: 400 });
  }
  const exitCode = body.exit_code;

  const headSha = typeof body.head_sha === "string" ? body.head_sha.trim() : "";
  if (headSha.length === 0) {
    return NextResponse.json({ error: "head_sha required (non-empty string)" }, { status: 400 });
  }

  // base_sha (contract addendum) is OPTIONAL: runners that predate it, and
  // unborn-HEAD workspaces, omit it. A present-but-blank value normalises to
  // null so the gate's no-commit no-op only fires on a real sha.
  const rawBase = typeof body.base_sha === "string" ? body.base_sha.trim() : "";
  const baseSha = rawBase.length > 0 ? rawBase : null;

  if (typeof body.pushed !== "boolean") {
    return NextResponse.json({ error: "pushed required (boolean)" }, { status: 400 });
  }
  const pushed = body.pushed;

  const rawTail = typeof body.output_tail === "string" ? body.output_tail : "";
  const outputTail =
    rawTail.length > MAX_OUTPUT_TAIL_CHARS ? rawTail.slice(-MAX_OUTPUT_TAIL_CHARS) : rawTail;

  // commits_ahead (B2, empty delivery) is OPTIONAL and must stay that way: every
  // pre-B2 runner omits it, and so does a runner that could not determine it.
  // A non-integer or negative value is DROPPED to null rather than rejected —
  // the rest of the record is still worth storing, and null degrades to the
  // gate's fail-open, whereas coercing garbage to 0 would assert "this branch
  // delivers nothing" on the strength of a malformed field.
  const rawAhead = body.commits_ahead;
  const commitsAhead =
    typeof rawAhead === "number" && Number.isInteger(rawAhead) && rawAhead >= 0 ? rawAhead : null;

  const supabase = supabaseService();

  // The run is the source of truth for tenant + ticket: neither is accepted
  // from the body, so a runner key cannot write a verification into another
  // tenant's scope.
  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("id, tenant_id, ticket_id")
    .eq("id", runId)
    .single();
  if (runErr || !run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const ranAt = new Date().toISOString();
  // Atomic upsert via the DB function: it PRESERVES base_sha from the first
  // write (COALESCE) while overwriting the rest, so a multi-iteration run keeps
  // its run-start base even as later iterations report a drifted one. A plain
  // client upsert can't express that and a read-then-write would race the two
  // runner hooks that POST for the same run.
  const { error: upsertErr } = await supabase.rpc("upsert_run_verification", {
    p_tenant_id: run.tenant_id,
    p_run_id: run.id,
    p_ticket_id: run.ticket_id,
    p_command: command,
    p_exit_code: exitCode,
    p_head_sha: headSha,
    p_base_sha: baseSha,
    p_pushed: pushed,
    p_output_tail: outputTail,
    p_ran_at: ranAt,
    p_commits_ahead: commitsAhead,
  });
  if (upsertErr) {
    console.error(`[verification] upsert failed for run=${runId}:`, upsertErr);
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, runId: run.id, ranAt });
}
