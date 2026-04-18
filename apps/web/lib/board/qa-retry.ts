// Pure policy: has the engineer↔QA reject loop burned its retry budget?
//
// Why this exists (the unbounded reject loop)
// ───────────────────────────────────────────
// `tickets.retry_count` is bumped on every QA reject (`in_review → in_progress`
// through `transitionTicket`'s `retryDelta`, the MCP `devpilot_move_ticket` route
// being its only writer), but until now nothing ever COMPARED it to a maximum:
// the dispatcher's state machine reads `retry_count > 0` and re-dispatches the
// engineer, and the F2 loop-guard (G5) deliberately steps aside whenever
// `retry_count > 0` - a QA reject is exactly the "legitimate fresh signal" that
// guard exempts. So an engineer and a QA that disagree forever bounce a ticket
// in_review ⇄ in_progress, burning a full engineer run + a full QA run per lap.
// The only backstop was the tenant-wide spend throttle, which starves every
// OTHER ticket in the tenant before it stops the loop.
//
// This module is the ceiling. It is deliberately pure - no DB, no Next imports -
// so `__tests__/qa-retry.test.ts` can exercise every branch; the seam that calls
// it is the dispatcher (via `qa-retry.server.ts`), which is the single choke
// point where a retry actually turns into spend.
//
// Recovery is a first-class part of the design: an exhausted ticket is PARKED to
// `blocked` (reversible, outside RECONCILABLE_STATUSES and the sweeper's scan -
// a true loop exit, unlike `failed`), and a HUMAN moving it back out of `blocked`
// resets `retry_count` to 0 (see `transitions.ts`). Without that reset the park
// would be a permanent wedge: the operator un-blocks, the dispatcher re-reads the
// still-exhausted counter, and parks it straight back.

import type { TicketStatus } from "@/lib/board/state";

/** Retries (QA rejects) allowed per human touch. 3 rejects = 4 engineer attempts. */
export const DEFAULT_QA_MAX_RETRIES = 3;

/**
 * Configurable ceiling: `DEVPILOT_QA_MAX_RETRIES`. A non-numeric or < 1 value falls
 * back to the default - the ceiling is a cost circuit-breaker (CLAUDE.md
 * non-negotiable #3), so it can be raised or lowered but never switched off by
 * a malformed env value.
 */
export function getQaMaxRetries(): number {
  const n = Number(process.env.DEVPILOT_QA_MAX_RETRIES ?? DEFAULT_QA_MAX_RETRIES);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_QA_MAX_RETRIES;
  return Math.floor(n);
}

/** Comment author for a ceiling park. Deliberately NOT `devpilot_move_ticket` (the
 *  reconciler reads that as "the role rendered its verdict") and NOT
 *  `ticket-reconciler` (which would consume a reconcile-cap slot). */
export const QA_RETRY_CEILING_AUTHOR = "devpilot_qa_retry_ceiling";

export type QaRetryDecision = { exhausted: boolean; reason: string };

/**
 * The ceiling bites in exactly one place: a ticket sitting in `in_progress`
 * whose `retry_count` has reached the ceiling. That is where every QA reject
 * lands the ticket (`in_review → in_progress`) and where the dispatcher would
 * hand it back to the engineer for another lap.
 *
 * Scoped that narrowly on purpose:
 *   • `in_review` is NOT gated - a ticket already in review has work that
 *     deserves QA's verdict; refusing there would strand the last attempt
 *     unreviewed.
 *   • `ready` / `assigned` are NOT gated - the reject loop never lands there,
 *     and `blocked` isn't even a legal FSM edge from either (see `state.ts`),
 *     so a park from those states would throw rather than park.
 *   • terminal / paused / input_required states are not loops at all.
 */
export function decideQaRetryCeiling(input: {
  status: TicketStatus;
  retryCount: number;
  maxRetries: number;
}): QaRetryDecision {
  if (input.status !== "in_progress") {
    return { exhausted: false, reason: `status=${input.status} is not the retry-loop state` };
  }
  if (input.retryCount < input.maxRetries) {
    return {
      exhausted: false,
      reason: `retry_count=${input.retryCount} < ceiling=${input.maxRetries}`,
    };
  }
  return {
    exhausted: true,
    reason: `retry_count=${input.retryCount} reached the QA retry ceiling (${input.maxRetries})`,
  };
}

/** The operator-visible explanation posted on the parked ticket. */
export function qaRetryCeilingCommentBody(retryCount: number, maxRetries: number): string {
  return (
    `QA has rejected this ticket ${retryCount} time${retryCount === 1 ? "" : "s"}, reaching the ` +
    `retry ceiling (DEVPILOT_QA_MAX_RETRIES=${maxRetries}). The engine parked the ticket to blocked ` +
    `instead of dispatching another engineer attempt - the engineer and QA are not converging, ` +
    `and each further lap costs a full engineer run plus a full QA run.\n\n` +
    `Read QA's rejection comments above, then either fix the disagreement (sharpen the acceptance ` +
    `criteria, or do the change yourself) or close the ticket. Moving it out of \`blocked\` resets ` +
    `the retry budget, so the loop gets a fresh ${maxRetries} attempts after you have intervened.`
  );
}
