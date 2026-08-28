// The supervisor console's ACT half - what an operator may command, derived
// from board state. PURE (no IO, no `server-only`).
//
// ══════════════════════════════════════════════════════════════════════════
// THE SAFETY ARGUMENT. It is NOT the autonomous supervisor's argument, and
// getting the difference wrong in either direction is the way this feature
// causes harm.
// ══════════════════════════════════════════════════════════════════════════
//
// The autonomous supervisor fails CLOSED on engine health: while the engine's
// own crons are executing it observes and changes nothing, because the reapers
// own the board and two writers is the two-writer problem - on this very board
// duplicate dispatch once put two agents in one git workspace and one agent's
// commit swept up the other's half-finished edits.
//
// AN OPERATOR-COMMANDED ACTION IS NOT THAT CASE. The human is explicitly
// asking, now, with the board in front of them; refusing because a cron might
// eventually get to it is exactly the behaviour that teaches people to bypass
// the tool and go to the database by hand - which is how the WIP-slot leak
// stayed invisible for six hours in the first place. So commanded actions are
// NOT gated on engine health.
//
// The HAZARD, however, is identical. What makes commanding safe is not a health
// gate; it is that the primitives are already concurrency-safe:
//
//   • `dispatch_queue_claim_next` is an atomic claim, so two callers releasing
//     the same group cannot both take the same row.
//   • `recoverOrphanedTicket` re-derives all five pieces of evidence and
//     re-runs `decideOrphanRecovery` before it writes anything, so a ticket
//     that came alive between the console rendering and the operator clicking
//     is refused BY THE ACTOR, not by us.
//
// ⚠️ NEVER ADD A BYPASS THAT SKIPS THAT RE-DERIVATION. It will be tempting: a
// commanded recovery can come back `skip:within-grace`, which reads like the
// tool being obstructive when the operator can see the ticket is dead. It is
// not obstruction - it is the only thing standing between a console click and
// interrupting live work. The correct response to a refusal is to REPORT it,
// with the primitive's own reason, which is what `describeActionOutcome` does.
//
// ══════════════════════════════════════════════════════════════════════════
// THE SECOND SAFETY PROPERTY: THE MODEL CANNOT NAME A TARGET.
// ══════════════════════════════════════════════════════════════════════════
//
// Ticket titles, comment bodies and land errors are AGENT-WRITABLE, and they
// are the substance of what the console shows a model. Principle 6 says that
// content is data, never instructions - so the model must not be an edge on any
// path to a mutation.
//
// It is not one, structurally rather than by prompt instruction: the set of
// available actions is computed HERE, from the database snapshot, by
// `deriveAvailableActions`. The model is shown that list and may only reply
// with ids DRAWN FROM IT (`groundConsoleReply` drops everything else). It has
// no field in which to express a ticket, an agent, a status or a target of any
// kind. A fully compromised model - one that does exactly what an injected
// ticket title tells it - can therefore cause exactly one thing to happen: an
// action that was ALREADY available on this board appears higher in a list the
// operator then reads and clicks, or does not.
//
// And the operator's click is re-grounded too: `runConsoleAction` recomputes
// this list server-side from the live database and refuses an id that is no
// longer available, so a forged POST cannot conjure one either.
//
// ══════════════════════════════════════════════════════════════════════════
// THE VOCABULARY IS CLOSED, AND EVERY MEMBER IS REVERSIBLE.
// ══════════════════════════════════════════════════════════════════════════
//
// Two kinds, both delegating to the autonomous supervisor's own primitives.
// Neither can delete anything, discard a commit, approve anything, start a run
// directly, or raise a WIP or budget limit.
//
// The OPERATOR-COMMANDED vocabulary is a separate, wider set and lives in
// `console-commands.ts`. It is not a relaxation of this one: these two remain
// exactly what they were, derived from board state rather than from the
// operator's message, and a commanded remediation still records the SAME
// defect cause the autonomous loop would. What is still refused everywhere -
// discarding work, force operations, credentials, publishing - is refused by
// being ABSENT from both vocabularies, and `describeRefusedCapability` (in
// that module) is the copy that says so.

import { decideDispatchRescue, type DispatchQueueGroup } from "@/lib/engine/dispatch-rescue-policy";
import type { ConsoleSnapshot } from "@/lib/supervisor/console-facts";

export const CONSOLE_ACTION_KINDS = [
  /** Release `dispatch_queue` rows an agent has capacity for. Primitive:
   *  `releaseGroup` (dispatch-rescue-store.ts). */
  "release_dispatch_queue",
  /** Hand a stalled ticket back to a human. Primitive: `recoverOrphanedTicket`
   *  (orphan-ticket-reaper.ts). Never re-dispatches: the work already failed
   *  once and we do not know why. */
  "recover_stalled_ticket",
] as const;

export type ConsoleActionKind = (typeof CONSOLE_ACTION_KINDS)[number];

export type ConsoleAction = {
  /** Stable, content-derived id. The ONLY thing a client or a model may send.
   *  Deterministic so the same board yields the same id across a render and the
   *  click that follows it - and so a stale id simply fails to match. */
  id: string;
  kind: ConsoleActionKind;
  /** The ledger cause. Deliberately one of the AUTONOMOUS supervisor's causes -
   *  see `console-store.ts` for why a commanded fix must count into the same
   *  bucket as an automatic one. */
  cause: "board_deadlock" | "stalled_ticket";
  /** Button text. Imperative, names the target. */
  label: string;
  /** What will actually happen, in one sentence. Rendered next to the button:
   *  an operator must be able to decline from the description alone. */
  consequence: string;
  /** Set for `recover_stalled_ticket`. */
  ticketId?: string;
  ticketKey?: string;
  /** Set for `release_dispatch_queue`. */
  agentId?: string;
  slots?: number;
};

function actionId(kind: ConsoleActionKind, target: string): string {
  return `${kind}:${target}`;
}

/**
 * Everything an operator may command on this board, right now.
 *
 * Derived from the snapshot rather than offered unconditionally, and the
 * difference matters in both directions: an action offered when its primitive
 * would refuse is a button that does nothing (and teaches the operator the
 * console is broken), while an action withheld when it WOULD work is the
 * console being useless at the one moment it exists for.
 *
 * So membership is decided by the primitives' OWN policies:
 *   • a queue group is offered only when `decideDispatchRescue` says release;
 *   • a ticket is offered only when `decideOrphanRecovery` said recover, which
 *     the snapshot already carries as `orphan.recoverable`.
 *
 * Both are re-run inside the primitive at execution time, so this list is an
 * OFFER, never an authorisation.
 */
export function deriveAvailableActions(
  snapshot: ConsoleSnapshot,
  queueGroups: readonly DispatchQueueGroup[],
  graceSeconds: number,
): ConsoleAction[] {
  const out: ConsoleAction[] = [];

  for (const g of queueGroups) {
    const d = decideDispatchRescue(g, snapshot.nowIso, graceSeconds);
    if (d.action !== "release") continue;
    out.push({
      id: actionId("release_dispatch_queue", g.agentId),
      kind: "release_dispatch_queue",
      cause: "board_deadlock",
      label: `Release ${d.slots} queued dispatch${d.slots === 1 ? "" : "es"}`,
      consequence:
        `Hands ${d.slots} queued ticket(s) back to the dispatcher for this agent, which then ` +
        `re-applies every gate (WIP, budget, automation pause) from scratch. It does not start a ` +
        `run directly and cannot exceed the WIP limit.`,
      agentId: g.agentId,
      slots: d.slots,
    });
  }

  for (const t of snapshot.tickets) {
    if (!t.orphan?.recoverable || !t.orphan.to) continue;
    out.push({
      id: actionId("recover_stalled_ticket", t.ticketId),
      kind: "recover_stalled_ticket",
      cause: "stalled_ticket",
      label: `Unstick ${t.key}`,
      consequence:
        `Moves ${t.key} to ${t.orphan.to === "input_required" ? "Input required" : "Blocked"} with ` +
        `a comment explaining that nothing was working on it. It does NOT re-run the work - the ` +
        `last attempt failed and we do not know why, so it comes back to you.`,
      ticketId: t.ticketId,
      ticketKey: t.key,
    });
  }

  return out;
}

/** Look one up by the id a client or model sent. Returns undefined for anything
 *  not in the freshly derived list - which is the whole point. */
export function findConsoleAction(
  available: readonly ConsoleAction[],
  id: unknown,
): ConsoleAction | undefined {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return undefined;
  return available.find((a) => a.id === id);
}

// ───────────────────────────────────────────────────────────────────────────
// Outcomes
// ───────────────────────────────────────────────────────────────────────────

export type ConsoleActionOutcome =
  | { ok: true; kind: ConsoleActionKind; applied: true; summary: string }
  /** The PRIMITIVE declined. Not an error, and not something to work around. */
  | { ok: true; kind: ConsoleActionKind; applied: false; summary: string; reason: string }
  | { ok: false; error: string };

/**
 * Turn a primitive's refusal into a sentence an operator can act on.
 *
 * A refusal here is the safety mechanism doing its job, so the copy has to make
 * that legible - "nothing happened" invites a retry loop, and worse, invites
 * the next engineer to add the bypass this module's header forbids. Each known
 * reason gets the fact behind it AND what would change it.
 */
export function describeActionOutcome(kind: ConsoleActionKind, reason: string): string {
  if (kind === "release_dispatch_queue") {
    if (reason.startsWith("at-capacity")) {
      return (
        `Nothing released: this agent's live runs already fill its WIP limit (${reason.replace("at-capacity:", "")}). ` +
        `The queue is doing exactly what it should - a slot frees when one of those runs finishes.`
      );
    }
    if (reason === "within-grace") {
      return (
        "Nothing released: the oldest queued row is younger than the rescue grace, so its release " +
        "may still be in flight. Releasing now could double-dispatch a ticket whose completion " +
        "event is on its way."
      );
    }
    if (reason === "queue-empty") {
      return "Nothing released: the queue drained between the console reading it and you clicking.";
    }
    return `Nothing released (${reason}).`;
  }

  if (reason.startsWith("skip:") || reason.startsWith("within-grace")) {
    const r = reason.replace(/^skip:/, "");
    if (r === "within-grace") {
      return (
        "Not recovered: the ticket has shown activity too recently. The recovery check refuses " +
        "inside its grace window because a dispatch and its run row are not written at the same " +
        "instant, and moving a ticket in that gap interrupts work that is genuinely starting."
      );
    }
    if (r === "live-run") {
      return (
        "Not recovered: a run on this ticket became live between the console reading it and you " +
        "clicking. This is the guard working - the ticket is not stalled after all."
      );
    }
    if (r === "pending-dispatch") {
      return (
        "Not recovered: a dispatch is queued for this ticket, so the drain still owns it. Release " +
        "the queue first if that queue cannot drain."
      );
    }
    if (r === "latest-run-done") {
      return (
        "Not recovered: this ticket's last run SUCCEEDED, which the stuck-ticket sweeper owns " +
        "rather than this recovery. Two mechanisms acting on one ticket is what the split avoids."
      );
    }
    if (r === "automation-paused") {
      return "Not recovered: automation is paused for this board, and the pause wins. Resume it first.";
    }
    return `Not recovered (${r}).`;
  }
  return `Not recovered (${reason}).`;
}

// `describeRefusedCapability` USED TO LIVE HERE and now lives in
// `console-commands.ts`, deliberately rather than as a tidy-up.
//
// It described a two-action console ("I can only do two things to this board").
// Once the command vocabulary landed that sentence was FALSE - it told an
// operator the console could not mark anything done at a point when it could -
// and a capability boundary that misdescribes itself is worse than none,
// because an operator plans around it. There is one such sentence and it lives
// with the vocabulary it describes, so widening the vocabulary and updating the
// sentence are the same edit rather than two edits one of which gets forgotten.
