// Pure policy: is this ticket ORPHANED - sitting in an agent-owned working
// state with nothing on earth about to move it - and if so, where do we hand
// it back to the human?
//
// The incident (2026-07-19)
// ─────────────────────────
// A ticket sat at `in_progress` with ZERO runs in a non-terminal state and an
// EMPTY `dispatch_queue`. The board said "an agent is working on it". Nothing
// was. The operator posted "try deploying this to Vercel" twice, half an hour
// apart, and neither reply created a run: `postCommentAction` only re-dispatches
// on an `input_required` ticket, because an `in_progress` one is ASSUMED to have
// a live run that will read the comment. There was none, so both messages went
// into the thread and were never consumed. It took a direct database write
// (status → input_required) to revive it.
//
// Why the existing machinery did not catch it
// ───────────────────────────────────────────
// This is a GAP in the existing reapers, not a reaper that failed to run. Two
// of them bracket this case without covering it:
//
//   • `staleRunReaper` (lib/engine/stale-run-reaper.ts) fails a run wedged in
//     `running`, and says so in its own header: "Out of scope: Ticket state
//     changes. The ticket whose run got reaped stays where it was (likely
//     'in_progress')." It fixes the RUN and leaves the TICKET orphaned.
//
//   • `stuckTicketSweeper` (lib/engine/stuck-ticket-sweep.ts) repairs stranded
//     tickets, but only ones whose LATEST run is `status='done'` - see its
//     `if (latest.status !== "done") return skip(...)` and its `skip:no-runs`
//     branch. A ticket whose latest run ended `failed` or `cancelled`, or which
//     has no runs at all, is skipped forever.
//
// So a ticket is repairable when its last run SUCCEEDED and unrepairable when
// its last run FAILED, which is exactly backwards from where the risk lies. PR
// #127 (the workspace precondition) widened the hole: refusals that used to end
// `done` - and were therefore sweepable - now correctly end `failed`, and moved
// straight into the blind spot.
//
// The event-time half has the same shape: runAgent's `reconcile-ticket` step is
// the LAST step of the SUCCESS path, so a run that dies on a NonRetriableError
// routes to `runAgentFailed` and never reaches it. `runAgentFailed` mutates the
// ticket only under the `escalate_to_human` supervision strategy
// (lib/engine/supervision.ts) - under the default `let_it_crash`, and under its
// `externally-terminated` early return, nobody owns the ticket at all. This
// reaper is the general case of the recovery `escalate_to_human` already does.
//
// This module covers precisely the cases the sweeper skips, and it is written
// to be NON-OVERLAPPING with it by construction: a latest run of `done` is an
// explicit stand-down here (`latest-run-done`), handed to the sweeper. The two
// crons therefore never both act on one ticket.
//
// Design rules
// ────────────
//  1. NEVER touch a ticket with a live run or a queued dispatch. Killing work in
//     flight is the only way this feature could do real damage, so those two
//     checks come FIRST, before anything else is even considered.
//  2. Grace before judgement. A dispatch event and its `runs` row are not
//     written atomically; reaping into that window would be worse than the bug.
//     See ORPHAN_GRACE_SECONDS_DEFAULT for the number and its derivation.
//  3. Hand back to the human; never re-dispatch. The work already failed once
//     and we do not know why. An automatic re-dispatch of a failed run can loop
//     and burn budget with no new information; moving the ticket to a
//     waiting-for-input state restores the operator's own resume path (a
//     comment on an `input_required` ticket fires a fresh dispatch) and costs
//     nothing if we are wrong.
//  4. Say what happened, including what we do not know. A ticket that silently
//     changes state is a smaller mystery, not a solved one.

import { canTransition, type TicketStatus } from "@/lib/board/state";

/**
 * States in which a ticket is AGENT-OWNED: the board claims an agent is working
 * and no human action inside the product is expected.
 *
 * Derived from the transition table (lib/board/state.ts) plus the dispatcher's
 * routing, not guessed:
 *
 *   • `in_progress` - the incident state. Agent-owned, and `in_progress →
 *     input_required` is a legal edge, so recovery lands on the one state whose
 *     human reply provably re-dispatches.
 *
 *   • `in_review` - also agent-owned, and deterministically so: `decideRole`
 *     returns `{role:"qa"}` for EVERY `in_review` ticket (lib/engine/dispatcher.ts),
 *     so this is never a "human reviews it himself" parking spot. `in_review →
 *     input_required` is NOT a legal edge, so recovery is `→ blocked`, which is
 *     the same reversible park the verdictless-review branch of reconcile-policy
 *     already chose for a stranded review.
 *
 * Deliberately EXCLUDED:
 *   • `assigned` - its only out-edges are ready/in_progress/paused/failed, so
 *     there is no waiting-for-human state to recover it TO. It is also a
 *     transient state the backlog drain owns.
 *   • `ready` / `backlog` - not agent-owned; nothing is running by definition,
 *     so "no live run" is the correct state, not an orphan.
 */
export const ORPHANABLE_TICKET_STATUSES = ["in_progress", "in_review"] as const;
export type OrphanableStatus = (typeof ORPHANABLE_TICKET_STATUSES)[number];

/**
 * Run statuses that mean "this run may still do work". `runs.status` is
 * running | awaiting_human | done | failed (20260601000000_core.sql), plus
 * `cancelled` written by the pause paths.
 *
 * `awaiting_human` is included on purpose and is the more important of the two:
 * it is a legitimate multi-day pause, and reaping it would destroy exactly the
 * kind of long human-in-the-loop wait the engine exists to support. Same set
 * the stuck-ticket sweeper treats as active.
 */
export const LIVE_RUN_STATUSES = ["running", "awaiting_human"] as const;

/**
 * How long a ticket must look orphaned before we believe it. 30 minutes.
 *
 * The window has to clear three things, and the binding one is the third:
 *
 *   1. The dispatch→run write race. `transitionTicket` emits
 *      `ticket/dispatch-needed`, Inngest delivers it, the dispatcher runs, and
 *      only then does a `runs` row exist. Normally seconds; minutes if the
 *      Inngest queue is backed up or a deploy is rolling. Nowhere near 30.
 *
 *   2. The stale-run reaper's own 15-minute threshold
 *      (DEVPILOT_STALE_RUN_THRESHOLD_MINUTES). While a wedged run still reads
 *      `running` we stand down anyway (rule 1), but we want that reaper to have
 *      FINISHED before we speak, so the ticket's story reads "the run failed,
 *      then we recovered the ticket" rather than the two racing. 15 + its
 *      5-minute cron period + margin.
 *
 *   3. The cost asymmetry. Being slow costs the operator some waiting on a
 *      ticket that is already dead. Being wrong means interrupting live work.
 *      30 minutes is also roughly the interval at which the operator himself
 *      gave up and re-posted, so it is not meaningfully slower than a human
 *      noticing - while leaving a wide margin over every mechanism above.
 *
 * With the 5-minute cron this recovers an orphan 30–35 minutes after it strands.
 * Override with DEVPILOT_ORPHAN_TICKET_GRACE_SECONDS.
 */
export const ORPHAN_GRACE_SECONDS_DEFAULT = 1800;

/** Author for the system comment. Its OWN id, never `devpilot_move_ticket` -
 *  the reconciler string-matches that author as a rendered verdict
 *  (lib/engine/ticket-reconciler.ts), and forging one would make a stranded
 *  ticket look reviewed. */
export const ORPHAN_REAPER_COMMENT_AUTHOR = "devpilot_orphan_reaper";

export type OrphanEvidence = {
  status: OrphanableStatus;
  /** `tickets.updated_at` - bumped by the transition that emitted the dispatch,
   *  so it is the clock for the dispatch→run race. */
  ticketUpdatedAtIso: string;
  /** Any run on this ticket in LIVE_RUN_STATUSES. */
  hasLiveRun: boolean;
  /** Any `dispatch_queue` row for this ticket with status='pending'. */
  hasPendingDispatch: boolean;
  /** Status of the newest run on the ticket; null when it has no runs at all. */
  latestRunStatus: string | null;
  /** `fan_out_group` of the newest run; non-null means the aggregator owns it. */
  latestRunFanOutGroup: string | null;
  /** Newest activity timestamp on the newest run (last_event_at ?? created_at);
   *  null when the ticket has no runs. */
  latestRunActivityIso: string | null;
  /** Effective project/tenant automation pause. */
  automationPaused: boolean;
  /** Timestamp of the newest ORPHAN_REAPER_COMMENT_AUTHOR comment, if any. */
  lastRecoveryCommentIso: string | null;
  nowIso: string;
  graceSeconds: number;
};

export type OrphanDecision =
  | { action: "none"; reason: string }
  | { action: "recover"; to: TicketStatus; reason: string };

/** The moment the ticket last showed ANY sign of life. Recovery is measured
 *  from here, so a run that failed a minute ago restarts the whole grace window
 *  and lets the run-completion machinery finish before we intervene. */
export function orphanIdleSinceIso(e: {
  ticketUpdatedAtIso: string;
  latestRunActivityIso: string | null;
}): string {
  const run = e.latestRunActivityIso;
  if (!run) return e.ticketUpdatedAtIso;
  return run > e.ticketUpdatedAtIso ? run : e.ticketUpdatedAtIso;
}

export function decideOrphanRecovery(e: OrphanEvidence): OrphanDecision {
  // ── Rule 1: the two never-damage guards, first and unconditional. ──────────
  if (e.hasLiveRun) return { action: "none", reason: "live-run" };
  if (e.hasPendingDispatch) return { action: "none", reason: "pending-dispatch" };

  // ── Non-overlap with the stuck-ticket sweeper. ────────────────────────────
  // A latest run of `done` is precisely the case that sweeper handles (with a
  // whole role-contract policy behind it). Standing down here is what keeps the
  // two crons from both acting on one ticket.
  if (e.latestRunStatus === "done") return { action: "none", reason: "latest-run-done" };

  // A fan-out cohort's completion is the aggregator's business; a sibling can
  // still be settling the group even when this ticket looks quiet.
  if (e.latestRunFanOutGroup) return { action: "none", reason: "fan-out-cohort" };

  // The operator's off switch wins. A board/workspace pause deliberately leaves
  // the ticket where it is and cancels its run - which looks EXACTLY like an
  // orphan and must not be treated as one.
  if (e.automationPaused) return { action: "none", reason: "automation-paused" };

  // ── Rule 2: grace. ────────────────────────────────────────────────────────
  const idleSince = orphanIdleSinceIso(e);
  const idleMs = Date.parse(e.nowIso) - Date.parse(idleSince);
  if (!Number.isFinite(idleMs)) {
    // Unparseable timestamps: we do not know how long this has been quiet, so
    // we do not act. Fail-closed - the cost of waiting is bounded, the cost of
    // a wrong reap is not.
    return { action: "none", reason: "indeterminate-idle-time" };
  }
  if (idleMs < e.graceSeconds * 1000) return { action: "none", reason: "within-grace" };

  // ── Idempotency. ──────────────────────────────────────────────────────────
  // Recovery moves the ticket OUT of ORPHANABLE_TICKET_STATUSES, so it cannot
  // be re-scanned until something puts it back - the transition is the real
  // idempotency. This is the belt-and-braces half: if the transition keeps
  // failing (a gate refuses it, say), we must not post the same comment on
  // every 5-minute tick.
  if (e.lastRecoveryCommentIso && e.lastRecoveryCommentIso >= idleSince) {
    return { action: "none", reason: "already-recovered" };
  }

  // ── Rule 3: hand back to the human. ───────────────────────────────────────
  const to: TicketStatus = e.status === "in_progress" ? "input_required" : "blocked";
  if (!canTransition(e.status, to)) {
    // Unreachable given the table today; kept because a future edit to
    // ALLOWED_TRANSITIONS must degrade to "do nothing", never to a throw
    // inside a cron.
    return { action: "none", reason: `illegal-recovery-edge:${e.status}->${to}` };
  }
  return {
    action: "recover",
    to,
    reason: `no live run and no queued dispatch since ${idleSince}`,
  };
}

/**
 * The operator-facing explanation. Written to state what is KNOWN and to name
 * what is not - a recovered ticket that does not say why it moved is only a
 * smaller mystery than one that hangs.
 *
 * `latestRunStatusReason` is `runs.status_reason` on that last run. It is
 * frequently NULL - not every failure path stamps it - and that must never
 * be papered over: a fabricated cause is worse than an honest "we do not
 * know why", so the closing line only claims to know why when a reason was
 * actually recorded.
 */
export function renderOrphanRecoveryComment(input: {
  to: TicketStatus;
  fromStatus: OrphanableStatus;
  idleSinceIso: string;
  graceSeconds: number;
  latestRunStatus: string | null;
  latestRunStatusReason: string | null;
}): string {
  const minutes = Math.round(input.graceSeconds / 60);
  const reasonKnown = Boolean(input.latestRunStatusReason && input.latestRunStatusReason.trim());
  const lastRun =
    input.latestRunStatus === null
      ? "This ticket has no runs at all - the dispatch that should have started one never produced a run."
      : reasonKnown
        ? `Its last run ended \`${input.latestRunStatus}\` - \`${input.latestRunStatusReason}\`.`
        : `Its last run ended \`${input.latestRunStatus}\`.`;
  const nextStep =
    input.to === "input_required"
      ? "It is now **Input required**, so replying on this ticket will start a fresh run (that is the resume path; a reply to an *In progress* ticket with no live run goes nowhere)."
      : "It is now **Blocked**, which is reversible - move it back to *In progress* to have it picked up again.";
  // Never claim ignorance when a reason was captured - AND never invent one
  // when it wasn't. Whichever of these renders, it is the honest sentence.
  const diagnosisLine = reasonKnown
    ? `**This is a recovery, not a fix** - the failure reason above is what was captured automatically; check it (and the run history) before re-running.`
    : `**We do not know why the work stopped** - this is a recovery, not a diagnosis. Check the run history for the last run's failure before re-running.`;

  return [
    `**Recovered a stalled ticket.**`,
    ``,
    `This ticket sat in \`${input.fromStatus}\` with no live run and nothing queued to dispatch since ${input.idleSinceIso} (over ${minutes} minutes). ${lastRun}`,
    ``,
    `The board was reporting that an agent was working on it. Nothing was, and any comment you posted in that state was not being read by anything.`,
    ``,
    nextStep,
    ``,
    diagnosisLine,
  ].join("\n");
}
