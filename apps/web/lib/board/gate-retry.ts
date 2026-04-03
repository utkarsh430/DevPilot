// Pure policy: has this ticket burned its QA-GATE retry budget?
//
// Why a DEDICATED counter, and never `tickets.retry_count`
// ───────────────────────────────────────────────────────
// The L1 gate's live-agent refusal is a 422 the agent is expected to RETRY
// in-session (fix the failing test, re-verify, move again). That retry is
// unbounded today: nothing counts how many times one run has been refused, so a
// producer that cannot make its own check pass can bounce off the gate forever,
// burning subscription quota on every lap. A ceiling is CLAUDE.md
// non-negotiable #3 (hard ceilings everywhere), not a nicety.
//
// `tickets.retry_count` is NOT that ceiling and must not be reused for it. That
// field is the engineer↔QA REJECT-loop counter with three live consumers that
// would all be corrupted by a second writer:
//
//   • the dispatcher re-dispatches the engineer on `retry_count > 0`
//     (a gate refusal would fake a QA reject that never happened),
//   • the F2 loop-guard (G5) stands down for exactly that signal,
//   • `enforceQaRetryCeiling` parks the ticket at `DEVPILOT_QA_MAX_RETRIES`
//     (gate refusals would eat the QA loop's budget and park a ticket QA has
//     never even seen).
//
// Corruption would run both ways: a human moving the ticket out of `blocked`
// resets `retry_count`, which would silently refill the gate budget too. So the
// gate gets `tickets.gate_retry_count` — its own column, its own ceiling, its
// own env var — and the two counters never read or write each other. They DO
// share the human-reset rule (see `transitions.ts`), because the intervention a
// park asks for is the same intervention in both cases.
//
// Deliberately pure — no DB, no Next imports — so every branch is unit-tested
// (`__tests__/gate-retry.test.ts`). The seam that calls it is `transitionTicket`
// (`lib/board/transitions.ts`), the same single choke point the gate itself
// lives on, so no `→ in_review` path can bypass the ceiling.

/** Gate refusals allowed per ticket per human touch. 3 refusals = 4 attempts. */
export const DEFAULT_QA_GATE_MAX_RETRIES = 3;

/**
 * Configurable ceiling: `DEVPILOT_QA_GATE_MAX_RETRIES`. A non-numeric or `< 1`
 * value falls back to the default — this is a cost circuit-breaker, so it can
 * be raised or lowered but never switched off by a malformed env value.
 */
export function getQaGateMaxRetries(): number {
  const n = Number(process.env.DEVPILOT_QA_GATE_MAX_RETRIES ?? DEFAULT_QA_GATE_MAX_RETRIES);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_QA_GATE_MAX_RETRIES;
  return Math.floor(n);
}

/**
 * Comment author for a gate-ceiling park. Deliberately NOT `devpilot_move_ticket`
 * (the reconciler reads that author as "the role rendered its verdict, leave it
 * alone" — and a refusal is the opposite), NOT `ticket-reconciler` (which would
 * consume a reconcile-cap slot), and distinct from `devpilot_qa_gate` so the
 * one-off ceiling park is greppable apart from the per-refusal explanations.
 */
export const QA_GATE_CEILING_AUTHOR = "devpilot_qa_gate_ceiling";

export type GateRetryDecision = { exhausted: boolean; reason: string };

/**
 * `gateRetryCount` is the count INCLUDING the refusal being handled right now
 * (the seam bumps first, then asks). So `count >= max` means "this refusal is
 * the one that exhausts the budget" and the caller must park rather than invite
 * another attempt.
 */
export function decideGateRetryCeiling(input: {
  gateRetryCount: number;
  maxRetries: number;
}): GateRetryDecision {
  if (input.gateRetryCount < input.maxRetries) {
    return {
      exhausted: false,
      reason: `gate_retry_count=${input.gateRetryCount} < ceiling=${input.maxRetries}`,
    };
  }
  return {
    exhausted: true,
    reason: `gate_retry_count=${input.gateRetryCount} reached the QA gate retry ceiling (${input.maxRetries})`,
  };
}

/** The operator-visible explanation posted on the parked ticket. `refusalReason`
 *  is the gate's own message, already fenced by `decideQaGate` where it quotes
 *  untrusted command output — appended verbatim, never re-wrapped. */
export function qaGateCeilingCommentBody(
  gateRetryCount: number,
  maxRetries: number,
  refusalReason: string,
): string {
  return (
    `The QA hand-off gate has refused this ticket ${gateRetryCount} time${gateRetryCount === 1 ? "" : "s"}, ` +
    `reaching the retry ceiling (DEVPILOT_QA_GATE_MAX_RETRIES=${maxRetries}). The engine parked the ` +
    `ticket to blocked instead of inviting another attempt — the producer is not converging on a ` +
    `hand-off the gate will accept, and each further lap costs a full producer run.\n\n` +
    `Read the gate's refusals above, then either fix the underlying failure yourself or adjust the ` +
    `ticket. Moving it out of \`blocked\` resets the gate budget, so it gets a fresh ${maxRetries} ` +
    `attempts after you have intervened.\n\nMost recent refusal:\n\n${refusalReason}`
  );
}
