// Pure policy for the operator "Restart from dev" reopen flow. No IO, no env,
// no Next imports — same pattern as `qa-gate.ts` / `safety-gate.ts`, so the
// rules that keep a reopen SAFE are unit-testable without a DB or a runner.
//
// Three decisions live here:
//
//   • decideReopenGate       — may this actor RESET a ticket back to `backlog`
//                              from a state that only an operator may leave that
//                              way (`done` reopen, or a non-done "Discard &
//                              restart")? Only a human may. Enforced at the
//                              `transitionTicket` seam, so it holds for every
//                              present and future caller.
//   • decideRestartFromDev   — the SAFE "Restart from dev": given a ticket's
//                              status and its `pending_pushes` rows, reopen,
//                              refuse because status is wrong, or refuse because
//                              wiping the workspace would destroy unpushed
//                              commits? The unpushed-work branch composes the
//                              SACRED data-loss guard (`decideWorkspaceReap`) so
//                              this action can never be the path that silently
//                              discards the only copy of a commit.
//   • decideDiscardAndRestart — the DELIBERATE "Discard & restart from dev": may
//                              a non-done, partially-completed ticket be reset to
//                              backlog while INTENTIONALLY discarding its
//                              uncommitted/unpushed work? This is the operator's
//                              sanctioned override of the data-loss hold — it does
//                              NOT refuse on unpushed work (that is the whole
//                              point), it only rejects a wrong status. The actual
//                              wipe is gated elsewhere to this explicit, confirmed,
//                              human action (a `force` flag threaded only from the
//                              discard server action into the cleanup pipeline);
//                              the automatic reaper's guard stays fully intact.

import type { TicketStatus } from "@/lib/board/state";
// `import type` is erased at build time, so pulling the actor type from
// `transitions.ts` (which has IO) does NOT drag that module into this pure one —
// the same trick `safety-gate.ts` uses to stay Vitest-loadable.
import type { TransitionActor } from "@/lib/board/transitions";
import { decideWorkspaceReap, type PendingPushLike } from "@/lib/workspace/unpushed-work";

export type ReopenGateDecision = { allow: true } | { allow: false; reason: string };

/**
 * The states a ticket may only be RESET to `backlog` FROM by a human.
 *
 *   • `done`           — the "Restart from dev" reopen (a re-run of a finished
 *                        ticket is an operator decision).
 *   • `in_progress` /
 *     `input_required` /
 *     `blocked`        — the "Discard & restart from dev" reset (abandoning
 *                        in-flight work + wiping the workspace is an operator
 *                        decision).
 *
 * `paused` is deliberately ABSENT: `paused → backlog` predates this gate and is
 * reachable by any actor (pause-resume machinery), so gating it here would be a
 * behavioral change / a tightening of an existing agent-facing edge — the discard
 * action still passes `actor: "human"`, it just isn't newly restricted for
 * others. `ready → backlog` is likewise untouched (an existing unschedule edge).
 */
const HUMAN_ONLY_BACKLOG_RESET_SOURCES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "done",
  "in_progress",
  "input_required",
  "blocked",
]);

/**
 * Gate every operator-only RESET to `backlog`. A move INTO `backlog` from one of
 * the human-only source states (see the set above) is allowed only for a human;
 * an agent or engine path is refused. Because EVERY transition flows through
 * `transitionTicket`, which calls this, the gate is bypass-proof — the same shape
 * as the safety gate. Conditioning on `to === "backlog"` is what keeps the
 * legitimate agent out-edges of these states (e.g. `in_progress → in_review`,
 * `blocked → in_progress`) completely untouched.
 */
export function decideReopenGate(args: {
  from: TicketStatus;
  to: TicketStatus;
  actor: TransitionActor;
}): ReopenGateDecision {
  if (
    args.to === "backlog" &&
    HUMAN_ONLY_BACKLOG_RESET_SOURCES.has(args.from) &&
    args.actor !== "human"
  ) {
    return {
      allow: false,
      reason: `resetting a ${args.from} ticket to backlog requires a human actor (got ${args.actor})`,
    };
  }
  return { allow: true };
}

export type RestartFromDevDecision =
  /** Safe to reopen: status is restartable and no unpushed work is at risk. */
  | { action: "reopen" }
  /** Only a `done` or `paused` ticket can be restarted. */
  | { action: "reject_status"; reason: string }
  /** The workspace holds commits that exist on no remote. Restarting would
   *  fresh-clone (destroying them), so we refuse and hand back the offending
   *  rows for the operator to land / push / discard first. NEVER a silent wipe. */
  | { action: "refuse_unpushed"; holding: PendingPushLike[] };

/**
 * Decide whether an operator "Restart from dev" may proceed.
 *
 * The data-loss guard is the whole point of this function: the ONLY branch that
 * returns `reopen` is the one where `decideWorkspaceReap` says the workspace
 * carries no unpushed work — so a restart can never be the path that discards
 * the sole copy of a commit. When unpushed work exists, we refuse and surface
 * the branches, rather than wiping; the operator lands, pushes, or discards it
 * first (all existing affordances) and then restarts.
 */
export function decideRestartFromDev(args: {
  status: TicketStatus;
  pendingPushes: PendingPushLike[];
}): RestartFromDevDecision {
  if (args.status !== "done" && args.status !== "paused") {
    return {
      action: "reject_status",
      reason: `only a done or paused ticket can be restarted (this one is ${args.status})`,
    };
  }
  const reap = decideWorkspaceReap(args.pendingPushes);
  if (!reap.reap) return { action: "refuse_unpushed", holding: reap.holding };
  return { action: "reopen" };
}

/** The non-done statuses a "Discard & restart from dev" may act on. A `done`
 *  ticket is deliberately excluded — its recovery is the safe "Restart from dev"
 *  (which refuses on unpushed) or "Land into dev"; discard is for a ticket whose
 *  in-flight work the operator wants to throw away and re-run from scratch. */
const DISCARDABLE_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "in_progress",
  "paused",
  "blocked",
  "input_required",
]);

export type DiscardAndRestartDecision =
  /** Status is discardable: proceed to discard the workspace work and reset to
   *  backlog. Deliberately carries NO unpushed-work refusal — the discard is the
   *  operator's sanctioned override of the data-loss hold. */
  | { action: "discard_reset" }
  /** Not a discardable status (e.g. `done`, `ready`, `failed`). */
  | { action: "reject_status"; reason: string };

/**
 * Decide whether an operator "Discard & restart from dev" may proceed.
 *
 * Unlike `decideRestartFromDev`, this deliberately does NOT consult the
 * unpushed-work guard: the operator has explicitly confirmed they want the work
 * discarded, so unpushed commits are the thing being thrown away, not a reason to
 * refuse. This is an EXPLICIT override of the data-loss hold, never a weakening of
 * it — the automatic reaper's `decideWorkspaceReap` and the runner-side reap guard
 * are untouched and still refuse on unpushed work. The only thing that makes the
 * wipe actually happen is a `force` flag that the discard server action threads
 * into the cleanup pipeline, reachable from no reaper or agent path.
 *
 * The one thing this DOES enforce is status: only a non-done, partially-completed
 * ticket is discardable.
 */
export function decideDiscardAndRestart(args: { status: TicketStatus }): DiscardAndRestartDecision {
  if (!DISCARDABLE_STATUSES.has(args.status)) {
    return {
      action: "reject_status",
      reason: `only a non-done, in-progress ticket can be discarded and restarted (this one is ${args.status})`,
    };
  }
  return { action: "discard_reset" };
}
