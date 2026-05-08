// Pure policy: should a just-completed (status='done') run's ticket be
// advanced by the engine, and to where?
//
// Why this exists (the stuck-in_progress bug, ticket 865345ef)
// ────────────────────────────────────────────────────────────
// Tool-driven roles (qa, verifier, the specialist engineers, custom M5
// roles, …) advance their ticket exclusively via the `devpilot_move_ticket` MCP
// tool DURING the agent step; postprocess deliberately fires no transition
// for them (lib/roles/postprocess.ts). When such a run completes without the
// tool call — the canonical case being a pause-resume replay that lost the
// role's system prompt (lib/engine/replay.ts) — nothing advanced the ticket:
// `dispatchOnRunComplete` only drains the WIP queue, and the dispatcher's
// state machine returns role=null for an untouched `in_progress` ticket. The
// ticket sat in `in_progress` forever.
//
// This module is the single decision point closing that gap. It is consumed
// by two callers with the same semantics:
//   • run-agent's post-completion `reconcile-ticket` step (event-time), and
//   • the stuck-ticket sweeper cron (repair of already-stuck rows).
//
// Design rules
// ────────────
//   1. FSM-legal only — every transition we emit passes `canTransition`; we
//      never force-jump states.
//   2. Never force-approve — a verdict role (onSuccessStatus='done') that
//      completed WITHOUT rendering a verdict did not do its job; the remedy
//      is to re-queue the review (in_review → dispatcher deterministically
//      picks qa), never to mark the ticket done.
//   3. Do nothing when the evidence says the run (or anyone else) already
//      handled the ticket: status changed during the run, the move tool was
//      used, another run is active, or the agent parked the ticket
//      (input_required / blocked / paused).

import { canTransition, isTerminal, type TicketStatus } from "@/lib/board/state";

export type ReconcileInput = {
  /** Resolved role slug of the completed run; null when unresolvable. */
  role: string | null;
  /** The role's declared success landing state; null when role unknown. */
  onSuccessStatus: TicketStatus | null;
  /**
   * Ticket status snapshotted when the run started. null = unknown (the
   * sweeper has no snapshot); the caller must then have established through
   * other evidence that the ticket is stale.
   */
  statusAtRunStart: TicketStatus | null;
  /** Ticket status now. */
  statusNow: TicketStatus;
  /** Any OTHER run on the ticket currently running / awaiting_human. */
  hasOtherActiveRuns: boolean;
  /**
   * What `applyRolePostProcess` returned for this run; null when postprocess
   * did not execute (e.g. the run carried no role). "dispatch" means the
   * postprocess path already owns the follow-up.
   */
  postNext: "dispatch" | "done" | "failed" | null;
  /**
   * True when a `devpilot_move_ticket` call landed for this ticket during the
   * run (detected via the tool's system comment or a status change). The
   * role rendered its verdict — even a same-state no-op move re-emits
   * dispatch on its own path — so we must not second-guess it.
   */
  moveTicketToolUsed: boolean;
};

export type ReconcileDecision =
  | { action: "none"; reason: string }
  | { action: "transition"; to: TicketStatus; reason: string }
  // Park a stranded verdict/reviewer run's ticket to `blocked` (reversible)
  // because it recorded NO verdict — see the verdictless-review branch below.
  // The caller surfaces the reason + the agent's summary to a human; it never
  // re-runs the review (a fresh run is non-deterministic and could flip a
  // "changes requested" into a spurious approve).
  | { action: "block"; reason: string }
  | { action: "dispatch"; reason: string };

/** Ticket states in which a completed-but-silent run leaves work stranded. */
export const RECONCILABLE_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "ready",
  "assigned",
  "in_progress",
  "in_review",
]);

export function decideTicketReconciliation(input: ReconcileInput): ReconcileDecision {
  if (input.postNext === "dispatch") {
    return { action: "none", reason: "postprocess already dispatched a follow-up" };
  }
  if (input.moveTicketToolUsed) {
    return { action: "none", reason: "run advanced the ticket via devpilot_move_ticket" };
  }
  if (isTerminal(input.statusNow)) {
    return { action: "none", reason: `ticket is terminal (${input.statusNow})` };
  }
  if (!RECONCILABLE_STATUSES.has(input.statusNow)) {
    // input_required / blocked / paused / backlog — parked deliberately;
    // their own resume paths (human reply, unblock, resumeTicket) own it.
    return { action: "none", reason: `ticket parked (${input.statusNow})` };
  }
  if (input.statusAtRunStart !== null && input.statusAtRunStart !== input.statusNow) {
    return { action: "none", reason: "ticket moved during the run" };
  }
  if (
    input.statusAtRunStart === null &&
    input.onSuccessStatus !== null &&
    input.statusNow === input.onSuccessStatus
  ) {
    // Sweep mode (no run-start snapshot): the ticket already sits exactly
    // where the role's contract lands it, so the run demonstrably advanced
    // it — e.g. an engineer's postprocess moved in_progress → in_review and
    // the follow-up dispatch was the dispatcher's deliberate decline. Not a
    // stranded ticket; touching it would post a false operator comment.
    return {
      action: "none",
      reason: `ticket already at role ${input.role}'s success state (${input.statusNow})`,
    };
  }
  if (input.hasOtherActiveRuns) {
    return { action: "none", reason: "another run is active on the ticket" };
  }

  // The run completed 'done' and demonstrably left its ticket exactly where
  // it started, with nothing else in flight. Advance per the role contract.
  const onSuccess = input.onSuccessStatus;
  if (onSuccess && onSuccess !== "done" && canTransition(input.statusNow, onSuccess)) {
    return {
      action: "transition",
      to: onSuccess,
      reason: `run completed without advancing the ticket; applying role ${input.role}'s onSuccessStatus`,
    };
  }

  // Verdict/reviewer roles (onSuccessStatus='done': qa, verifier,
  // release_engineer) render their verdict ONLY by calling devpilot_move_ticket
  // (approve → done, reject → in_progress). A run that completed with the
  // ticket still sitting at a pre-verdict working state and NO verdict recorded
  // (moveTicketToolUsed false, status unchanged, nothing else in flight — all
  // established above) left no actionable outcome:
  //   • in_review  = the verdict point; the reviewer never moved it.
  //   • in_progress = the 865345ef case (a failed review paused+resumed and
  //                   replayed 'done' without a verdict), which the dispatcher
  //                   can't recover — retry_count=0 returns role=null and it
  //                   hangs forever.
  // We must never force a verdict (rule 2), and re-dispatching either silently
  // re-runs the reviewer until the reconcile cap then freezes with only a
  // console.warn (the reported bug) — a fresh review is non-deterministic and
  // can flip a genuine "changes requested" into a spurious approve — or, at
  // in_progress/retry=0, returns role=null and hangs. So park it to `blocked`
  // (reversible, outside both reconcile loops) and let the caller surface the
  // real verdict text to a human: needs re-review or manual triage. `blocked`
  // is a loop-EXIT — the caller parks even a cap-exhausted ticket (see the
  // reconciler), so tickets already frozen at cap get surfaced, not just newly
  // stranded ones.
  if (
    input.role !== null &&
    onSuccess === "done" &&
    (input.statusNow === "in_review" || input.statusNow === "in_progress") &&
    canTransition(input.statusNow, "blocked")
  ) {
    return {
      action: "block",
      reason: `verdict role ${input.role} completed without recording a verdict (no devpilot_move_ticket call); parking for re-review / manual triage`,
    };
  }

  // Everything else (unknown role, illegal onSuccessStatus from here,
  // ready/assigned oddities): wake the dispatcher and let its routing decide.
  return {
    action: "dispatch",
    reason: "run completed without advancing the ticket; re-dispatching",
  };
}
