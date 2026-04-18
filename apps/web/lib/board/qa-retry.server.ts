// Service half of the QA retry ceiling (pure policy: `qa-retry.ts`).
//
// Gathers the evidence (ticket status + retry_count), asks the policy, and - on
// exhaustion - parks the ticket to `blocked` with an operator-visible comment.
// Called from the dispatcher as its FIRST gate, before any role is picked, so an
// exhausted ticket costs zero LLM spend.

import { supabaseService } from "@/lib/db/server";
import { addComment, transitionTicket } from "@/lib/board/transitions";
import type { TicketStatus } from "@/lib/board/state";
import {
  QA_RETRY_CEILING_AUTHOR,
  decideQaRetryCeiling,
  getQaMaxRetries,
  qaRetryCeilingCommentBody,
} from "@/lib/board/qa-retry";

export type QaRetryCeilingResult = {
  /** True when the ticket was (or already is) parked - the dispatcher must not dispatch. */
  parked: boolean;
  reason: string;
  retryCount?: number;
  maxRetries?: number;
};

/**
 * Enforce the QA retry ceiling for one ticket. Best-effort by design: a DB read
 * failure returns `{parked: false}` and the dispatch proceeds exactly as it does
 * today - a broken ceiling must never wedge a healthy ticket.
 *
 * The park is CAS-guarded on the status we read (`expectedFrom`), so a
 * concurrent move between our read and the write is a clean no-op rather than a
 * clobber, and `emitDispatch: false` keeps us from nudging the dispatcher at a
 * ticket we just parked (which is what closes the loop).
 */
export async function enforceQaRetryCeiling(args: {
  ticketId: string;
  tenantId: string;
}): Promise<QaRetryCeilingResult> {
  const supabase = supabaseService();
  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("status, retry_count")
    .eq("id", args.ticketId)
    .maybeSingle();
  if (error || !ticket) {
    return { parked: false, reason: "ticket-not-readable" };
  }

  const status = ticket.status as TicketStatus;
  const retryCount = (ticket.retry_count as number | null) ?? 0;
  const maxRetries = getQaMaxRetries();
  const decision = decideQaRetryCeiling({ status, retryCount, maxRetries });
  if (!decision.exhausted) {
    return { parked: false, reason: decision.reason, retryCount, maxRetries };
  }

  console.warn(
    `[qa-retry-ceiling] ticket ${args.ticketId} ${decision.reason} - parking to blocked instead of re-dispatching`,
  );

  const result = await transitionTicket({
    ticketId: args.ticketId,
    tenantId: args.tenantId,
    to: "blocked",
    // Engine-authored park; the ticket is parked for a human, so don't nudge the
    // dispatcher at it.
    actor: "system",
    emitDispatch: false,
    expectedFrom: status,
  });
  if (!result.transitioned) {
    // Someone moved the ticket between our read and the write. Whatever they did
    // supersedes the park; refuse the dispatch anyway - the counter is still at
    // the ceiling and the next dispatch event re-evaluates from fresh state.
    return { parked: true, reason: "lost-park-race", retryCount, maxRetries };
  }

  try {
    await addComment({
      ticketId: args.ticketId,
      tenantId: args.tenantId,
      authorType: "system",
      authorId: QA_RETRY_CEILING_AUTHOR,
      body: qaRetryCeilingCommentBody(retryCount, maxRetries),
    });
  } catch (err) {
    // The park already committed - a failed audit comment must not un-park it.
    console.warn(
      `[qa-retry-ceiling] park comment failed for ticket ${args.ticketId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { parked: true, reason: decision.reason, retryCount, maxRetries };
}
