// Classifies a run failure into a short, distinct, greppable reason — the
// missing half of the silent-`failed` class documented in AGENTS.md.
//
// The incident (2026-08-06/07): four tickets on one board were parked by the
// orphan-ticket reaper with `runs.status_reason` NULL on the run that failed
// them. In every case the underlying work was fine (verified: full test
// suites passing in each workspace) — the failure carried real, specific
// information and every one of those specifics was discarded before it
// reached the `runs` row. `runAgentFailed` (run-agent.ts) is the single
// choke point for EVERY NonRetriableError thrown out of the run loop — a
// timed-out `waitForEvent`, a runner-reported step failure, a refused
// workspace precondition, an unrecognised runner policy, an init failure, a
// tripped per-tenant velocity circuit breaker, an exhausted per-run budget, a
// failed `run_steps` persist, or a genuinely uncaught exception — so
// classifying it there covers every one of those distinct causes without
// touching the throw sites themselves.
//
// Measured pattern behind the incident: the failing run was consistently the
// FOLLOW-ON dispatched right after a producer run completed `done` (a
// review/QA dispatch), failing ~80-110s later — and on at least one occasion
// two different tickets' producer runs completed in the SAME second, with
// both follow-ons then failing within seconds of each other. That shape
// points at `assertCanProceed` (budget.ts): its per-tenant cost-velocity
// breaker is a SHARED 60s bucket, so a burst of producer runs completing
// together and dispatching follow-on work in the same window can trip it for
// several tickets near-simultaneously — a `NonRetriableError` thrown on the
// very first LLM step of each follow-on run. The classifier below gives that
// case (and the sibling per-run budget-exhaustion case) its own distinct
// code precisely so this is diagnosable from `runs.status_reason` alone the
// next time it happens, rather than requiring a repeat of this investigation.
//
// Deliberately a CODE, not the raw message alone: a downstream reader (an
// operator scanning a board, a future auto-response) needs to answer "is
// this the SAME kind of failure as that other one" without string-matching
// free text, and the existing `status_reason` values in this codebase
// ("runner-disconnected", "paused:automation:<scope>") are already short,
// stable prefixes for exactly that reason. The code is always followed by
// the real (truncated) message, so nothing about "what actually happened"
// is lost relative to just storing the message.
//
// "unknown" is deliberately NOT a value this can return for a non-empty
// message — an unrecognised shape still carries the real text under the
// `uncaught-exception` code. It is reserved for the one case where nothing
// was actually captured (an empty message), and even then the code says so
// explicitly rather than rendering blank.

const MAX_REASON_CHARS = 300;

function truncate(s: string, max = MAX_REASON_CHARS): string {
  const trimmed = s.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export type RunFailureReasonCode =
  | "step-timeout"
  | "runner-reported-failure"
  | "workspace-precondition"
  | "unknown-runner-policy"
  | "init-failed"
  | "velocity-breaker-tripped"
  | "velocity-breaker-unreachable"
  | "budget-exceeded"
  | "budget-check-refused"
  | "persist-step-failed"
  | "finish-step-failed"
  | "uncaught-exception"
  | "unknown";

// Order matters only in that every entry must be checked before the
// catch-all `uncaught-exception` bucket below — the patterns themselves are
// mutually exclusive on their own canonical messages (asserted in tests).
const CLASSIFIERS: ReadonlyArray<{ code: RunFailureReasonCode; pattern: RegExp }> = [
  { code: "step-timeout", pattern: /^local-cc step \d+ timed out after/ },
  { code: "runner-reported-failure", pattern: /^local-cc step \d+ reported failure/ },
  { code: "workspace-precondition", pattern: /^workspace precondition failed/ },
  { code: "unknown-runner-policy", pattern: /^unknown runnerPolicy/ },
  { code: "init-failed", pattern: /^init failed/ },
  // The per-tenant cost-velocity circuit breaker (budget.ts) — a shared
  // sliding 60s bucket, so a burst of concurrent producer runs completing at
  // once and dispatching follow-on (review/QA) work in the same second can
  // trip it for several tickets near-simultaneously. Distinguished from a
  // plain per-run budget exhaustion because the response is different: wait
  // for the window to roll, versus the run genuinely ran out of budget.
  { code: "velocity-breaker-tripped", pattern: /^tenant velocity circuit breaker tripped/ },
  { code: "velocity-breaker-unreachable", pattern: /^velocity breaker failing closed/ },
  { code: "budget-exceeded", pattern: /^budget exceeded for/ },
  { code: "budget-check-refused", pattern: /^budget check failed: run/ },
  { code: "persist-step-failed", pattern: /^persist step failed/ },
  { code: "finish-step-failed", pattern: /^finish failed/ },
];

/**
 * Turns the raw error message Inngest attaches to `inngest/function.failed`
 * into a `<code>:<detail>` string suitable for `runs.status_reason`.
 *
 * Every known NonRetriableError shape thrown out of run-agent.ts's run loop
 * gets its own code so a timeout, a runner-reported failure, and a refused
 * precondition read as distinctly different reasons rather than one blanket
 * "failed". Anything that doesn't match a known shape — the genuine
 * unhandled-rejection / crash case — still carries the real message under
 * `uncaught-exception`, never a blank default.
 */
export function classifyRunFailureReason(errorMessage: string): string {
  const msg = (errorMessage ?? "").trim();
  if (!msg) return "unknown:no error message was captured";

  for (const { code, pattern } of CLASSIFIERS) {
    if (pattern.test(msg)) return `${code}:${truncate(msg)}`;
  }
  return `uncaught-exception:${truncate(msg)}`;
}
