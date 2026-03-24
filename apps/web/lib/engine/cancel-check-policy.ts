// Pure policy: should the durable run loop HALT at this iteration boundary,
// and why?
//
// Why this exists (the board-pause-doesn't-stop-the-run bug)
// ─────────────────────────────────────────────────────────
// There are two independent pause primitives with different reach:
//
//   • Per-ticket pause (`pauseTicket`, lib/engine/pause-resume.ts) flips the
//     in-flight `runs.status` to 'cancelled'. The run loop's per-iteration
//     check-cancel step reads that and exits — which is why the per-ticket
//     pause actually stops the live run.
//
//   • Board / workspace automation pause (`setAutomationStateAction`) only
//     writes `projects.automation_state='paused'` (or the tenant's). That flag
//     gates NEW dispatch (dispatcher, scheduler, replay, reconciler), but the
//     run loop never read it — so a board pause stopped new work while the
//     already-running ticket kept burning to completion.
//
// This module is the single decision point that closes the second gap. The run
// loop feeds it the live `runs.status` and the effective automation-pause state
// and it decides whether to halt, distinguishing an already-cancelled run (the
// per-ticket path — nothing more to do) from a fresh automation-pause halt (the
// run loop must flip the row out of 'running' itself, then exit).
//
// Design rules
// ────────────
//   1. A run already 'cancelled' wins over everything: it is terminal, so the
//      loop just needs to notice and exit — no second write, no double emit.
//   2. Automation pause only halts a TICKET-BOUND run. A ticket-less run
//      (supervisor ad-hoc child, ticket-less replay) has no project to pause
//      and getEffectivePause would resolve to the tenant only; we still gate on
//      `hasTicket` so the halt is scoped to real board/project work and the
//      pure decision never depends on a project the run doesn't have.
//   3. The halt is RESUMABLE and does NOT move the ticket. The ticket stays in
//      whatever state it was in (matching the documented board-pause
//      semantics); resume re-dispatches it — see `isResumeDispatchable` below.

/** Minimal shape of an effective-pause result, kept local so this module stays
 *  dependency-free (the real resolver lives in automation-state.ts, which pulls
 *  server-only DB code and can't load under Vitest). */
export type PauseState = { paused: false } | { paused: true; scope: "tenant" | "project" };

export type CancelCheckDecision =
  | { halt: false }
  | { halt: "cancelled" }
  | { halt: "automation-paused"; scope: "tenant" | "project" };

/**
 * Decide whether the run loop should halt before this iteration.
 *
 * @param runStatus  the live `runs.status` for this run (undefined ⇒ row gone).
 * @param hasTicket  whether the run is ticket-bound (only then can automation
 *                   pause halt it — see design rule 2).
 * @param pause      the effective automation-pause state for (tenant, project).
 */
export function decideCancelCheck(args: {
  runStatus: string | undefined;
  hasTicket: boolean;
  pause: PauseState;
}): CancelCheckDecision {
  // Rule 1 — an already-cancelled run is terminal; just exit.
  if (args.runStatus === "cancelled") return { halt: "cancelled" };
  // Rule 2 — automation pause halts ticket-bound runs only.
  if (args.hasTicket && args.pause.paused) {
    return { halt: "automation-paused", scope: args.pause.scope };
  }
  return { halt: false };
}

/**
 * Ticket statuses that a board/workspace RESUME re-dispatches. A board-halted
 * ticket is never moved (it stays in whatever working state it was in), so it
 * comes back as `in_progress` and must be in this set for resume to re-drive
 * it. `ready` and `in_review` cover the not-yet-started / awaiting-review work
 * that the pause also silently skipped. Terminal / blocked / input_required /
 * paused tickets are deliberately left alone.
 *
 * Mirrors the `.in(...)` filter in `emitResumeDispatches`
 * (lib/automation/actions.ts) — extracted here so the "in_progress is
 * re-dispatched on resume" guarantee is unit-testable without the server-only
 * action.
 */
export const RESUME_DISPATCHABLE_STATUSES = ["ready", "in_review", "in_progress"] as const;

export function isResumeDispatchable(status: string): boolean {
  return (RESUME_DISPATCHABLE_STATUSES as readonly string[]).includes(status);
}
