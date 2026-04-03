// Backlog-drain sliding window - the PURE decision core behind `drainBacklogFn`
// (`lib/engine/ticket-scheduler.ts`).
//
// The drain used to be strictly serial: move one backlog ticket to `ready`,
// block until it reached a terminal/stuck status, then move the next. Because
// the dispatcher promotes `ready → in_progress` within milliseconds, at most
// ONE ticket was ever live on the board, no matter how many agents were idle.
//
// This module models the replacement: a sliding window that keeps up to
// `parallelism` tickets in flight and tops the window back up each time one
// settles. It is deliberately IO-free so it can be unit-tested (the durable
// function around it can't load under Vitest - it imports Next server APIs).
//
// Two decisions live here:
//
//   • planFill      - which pending tickets to START now (dependency-eligible
//                     first, never more than the free slots), which to DROP as
//                     no-longer-in-backlog, and - when nothing is in flight and
//                     nothing is eligible - which blocked ticket to force so the
//                     drain can't deadlock on its own backlog.
//   • planPollRound - which in-flight tickets have SETTLED (terminal, stuck,
//                     vanished, or out of polls) and which keep running.
//
// Dependency edges (`blocked_by` / `builds_on`) serialise naturally: a ticket
// with an open blocker is never handed a slot, so a chain A → B → C drains one
// at a time even at parallelism 10, while independent tickets fan out.

import type { TicketStatus } from "@/lib/board/state";

/** Default window when neither the event nor the schedule row specifies one.
 *  3 matches the per-agent WIP default and the local-cc concurrency guidance
 *  in AGENTS.md ("~1–3 steady concurrent agents"). */
export const DEFAULT_DRAIN_PARALLELISM = 3;

/** Hard ceiling, mirroring the `ticket_schedules.drain_parallelism` CHECK. */
export const MAX_DRAIN_PARALLELISM = 10;

export const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set(["done", "failed"]);

// "Stuck" statuses count as settled for the purpose of freeing a slot -
// `blocked` and `input_required` mean the ticket is awaiting something outside
// the drain's control, and we don't want to hold a slot for 4 hours on them.
export const STUCK_STATUSES: ReadonlySet<TicketStatus> = new Set(["blocked", "input_required"]);

/** How many fill rounds the drain will wait for a done-but-unlanded parent to
 *  land before it gives up and leaves the dependent in the backlog. At the
 *  30s poll interval that is ~10 minutes — long enough for a normal land
 *  (rebase + squash-merge), short enough that a wedged queue doesn't hold the
 *  drain open for hours. Giving up is not a drop: the ticket stays in backlog,
 *  and WI-4's land-success event fires a fresh `ticket-drain/requested`, so the
 *  moment the parent lands the dependent is picked straight back up. */
export const MAX_LAND_WAIT_ROUNDS = 20;

export type DrainOutcome = "done" | "failed" | "stuck" | "timeout" | "skipped" | "deferred";

/** What one durable probe step learned about a pending backlog ticket. */
export interface DrainProbe {
  /** Current status, or null when the ticket no longer exists. */
  status: TicketStatus | null;
  /** True when at least one `blocked_by` / `builds_on` blocker is still open —
   *  under WI-5 that means "not yet LANDED on the integration branch", not
   *  merely "not done" (see lib/integration/landed.ts). */
  hasOpenBlockers: boolean;
  /** True when the ticket is blocked ONLY by parents that are already done and
   *  are just waiting on the land worker. This is a TRANSIENT block with a
   *  known resolver, and it must be treated differently from a parent that is
   *  genuinely still being worked — see `planFill`. */
  onlyAwaitingLand: boolean;
}

export interface InFlightEntry {
  ticketId: string;
  /** Polls already spent on this ticket. */
  polls: number;
}

export interface FillPlan {
  /** Tickets to transition `backlog → ready` now, in backlog order. */
  starts: string[];
  /** Tickets that left `backlog` on their own (operator moved them, or they
   *  vanished) - drop them from pending without consuming a slot. */
  skipped: string[];
  /** True when `starts` had to ignore dependency eligibility to break a
   *  deadlock (nothing in flight, nothing eligible). Those transitions are
   *  expected to fail with `BlockedByDependencyError` and be recorded `stuck`,
   *  exactly as the serial drain did. */
  forced: boolean;
  /** Tickets held back ONLY because a done parent hasn't landed yet. They stay
   *  pending and cost no slot; the caller waits for the land rather than
   *  forcing them. Never overlaps `starts` or `skipped`. */
  awaitingLand: string[];
}

/** Clamp an event/schedule-supplied parallelism into [1, MAX], defaulting to
 *  DEFAULT_DRAIN_PARALLELISM when absent or not a finite number. */
export function resolveDrainParallelism(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return DEFAULT_DRAIN_PARALLELISM;
  return Math.max(1, Math.min(MAX_DRAIN_PARALLELISM, Math.floor(raw)));
}

export function classifySettled(status: TicketStatus | null): {
  finalStatus: TicketStatus | "timeout";
  outcome: DrainOutcome;
} | null {
  // Ticket vanished mid-drain - treat as a failure, same as the serial drain.
  if (status === null) return { finalStatus: "failed", outcome: "failed" };
  if (status === "done") return { finalStatus: "done", outcome: "done" };
  if (status === "failed") return { finalStatus: "failed", outcome: "failed" };
  if (STUCK_STATUSES.has(status)) return { finalStatus: status, outcome: "stuck" };
  return null; // still running
}

/**
 * Decide which pending tickets get a slot this fill round.
 *
 * Invariants (the concurrency contract - see the tests):
 *   • `starts.length + inFlightCount <= parallelism` - the window never
 *     over-fills, so two fill rounds can't double-claim a slot.
 *   • Every id appears at most once across `starts` and `skipped`, and the
 *     caller removes both from `pending`, so a ticket can't be started twice.
 *   • A ticket with an open blocker is never started while a slot could go to
 *     an eligible one - a blocked ticket never wastes a slot.
 *   • Progress guarantee: with `inFlightCount === 0` and a non-empty pending
 *     list, this ALWAYS returns at least one start, skip, or awaitingLand entry,
 *     so the drain loop cannot spin.
 *
 * WI-5 - the forced head must not eat a ticket whose parent is merely LANDING.
 * Re-gating readiness onto "landed" (not "done") introduced a window the drain
 * never had to reason about: a parent finishes `done`, the land worker hasn't
 * squashed it onto dev yet, and for those few seconds its dependent reads as
 * blocked. If that dependent is the only thing left in the backlog, the old
 * forced-head branch would hand it to `transitionTicket`, eat the
 * BlockedByDependencyError, record it `stuck` and DROP it - permanently losing a
 * ticket to a race with a worker that was about to unblock it, milliseconds
 * later.
 *
 * So the blocked set is split by WHY it is blocked. A ticket whose parent is
 * still being worked is `forcible` exactly as before - nothing in flight means
 * nothing can ever unblock it, so forcing it (→ `stuck`) is the honest outcome.
 * A ticket whose parents are all done and merely awaiting their landing is
 * `awaitingLand`: it stays pending, costs no slot, and the caller waits for the
 * worker rather than forcing it. Forcing is for deadlock; this is not a
 * deadlock, it is latency.
 */
export function planFill(args: {
  pending: readonly string[];
  probes: Readonly<Record<string, DrainProbe>>;
  inFlightCount: number;
  parallelism: number;
}): FillPlan {
  const { pending, probes, inFlightCount, parallelism } = args;
  const slots = Math.max(0, parallelism - inFlightCount);

  const skipped: string[] = [];
  const eligible: string[] = [];
  const forcible: string[] = [];
  const awaitingLand: string[] = [];

  for (const id of pending) {
    // A missing probe means the row didn't come back from the read - same
    // treatment as a ticket that left backlog: drop it, don't burn a slot.
    const probe = probes[id];
    if (!probe || probe.status !== "backlog") {
      skipped.push(id);
      continue;
    }
    if (!probe.hasOpenBlockers) eligible.push(id);
    else if (probe.onlyAwaitingLand) awaitingLand.push(id);
    else forcible.push(id);
  }

  if (slots === 0) return { starts: [], skipped, forced: false, awaitingLand };

  const starts = eligible.slice(0, slots);
  if (starts.length > 0) return { starts, skipped, forced: false, awaitingLand };

  // Nothing eligible. If something is still in flight, wait - finishing it may
  // unblock a dependent. If NOTHING is in flight, no completion can ever unblock
  // a ticket whose upstream is still being WORKED, so hand the blocked head(s)
  // to the transition anyway: it raises BlockedByDependencyError, the drain
  // records `stuck` and moves on. That is exactly what the serial drain did, and
  // it keeps the loop making progress.
  //
  // Tickets in `awaitingLand` are deliberately NOT forced here - a completion IS
  // coming (from the land worker, not from this drain), so forcing them would
  // drop a ticket that is seconds away from being startable.
  if (inFlightCount === 0 && forcible.length > 0) {
    return { starts: forcible.slice(0, slots), skipped, forced: true, awaitingLand };
  }

  return { starts: [], skipped, forced: false, awaitingLand };
}

/**
 * Fold one poll round over the in-flight set: every in-flight ticket spends one
 * poll, settles (terminal / stuck / vanished / out of polls), or keeps running.
 * A settled ticket is removed from `running` exactly once, so a slot can't be
 * freed twice.
 */
export function planPollRound(args: {
  inFlight: readonly InFlightEntry[];
  statuses: Readonly<Record<string, TicketStatus | null>>;
  maxPolls: number;
}): {
  settled: Array<{
    ticketId: string;
    finalStatus: TicketStatus | "timeout";
    outcome: DrainOutcome;
  }>;
  running: InFlightEntry[];
} {
  const settled: Array<{
    ticketId: string;
    finalStatus: TicketStatus | "timeout";
    outcome: DrainOutcome;
  }> = [];
  const running: InFlightEntry[] = [];

  for (const entry of args.inFlight) {
    const polls = entry.polls + 1;
    const status = entry.ticketId in args.statuses ? args.statuses[entry.ticketId]! : null;
    const done = classifySettled(status);
    if (done) {
      settled.push({ ticketId: entry.ticketId, ...done });
      continue;
    }
    if (polls >= args.maxPolls) {
      settled.push({ ticketId: entry.ticketId, finalStatus: "timeout", outcome: "timeout" });
      continue;
    }
    running.push({ ticketId: entry.ticketId, polls });
  }

  return { settled, running };
}

export type StartResult = { ok: true } | { ok: false; blocked: boolean; error: string };

/**
 * Every side effect the drain loop performs. `drainBacklogFn` implements these
 * as durable Inngest steps; the tests implement them against an in-memory board.
 * The loop itself (below) is shared, so what the tests exercise IS the shipped
 * scheduling behaviour, not a re-implementation of it.
 */
export interface DrainWindowIO {
  /** Status + blocker eligibility for every still-pending ticket. */
  probe(pending: readonly string[], fillRound: number): Promise<Record<string, DrainProbe>>;
  /** Transition `backlog → ready`. Must report a dependency refusal as
   *  `{ ok: false, blocked: true }` - that's what makes a blocked ticket
   *  `stuck` rather than a slot-holder. */
  start(ticketId: string): Promise<StartResult>;
  /** Ticket left backlog on its own between the snapshot and its turn. */
  onSkipped(ticketId: string): Promise<void>;
  /** `start` refused (dependency blocker, or a real error). */
  onStartFailed(ticketId: string, result: { blocked: boolean; error: string }): Promise<void>;
  /** Ticket settled and its slot is now free. */
  onSettled(
    ticketId: string,
    finalStatus: TicketStatus | "timeout",
    outcome: DrainOutcome,
  ): Promise<void>;
  sleep(pollRound: number): Promise<void>;
  poll(
    inFlightIds: readonly string[],
    pollRound: number,
  ): Promise<Record<string, TicketStatus | null>>;
  /** Wait for the land worker to make progress, when the ONLY thing left in the
   *  backlog is tickets whose done parents haven't landed yet. Distinct from
   *  `sleep` so the durable step ids can't collide with the poll sleeps. */
  waitForLand(waitRound: number): Promise<void>;
  /** The drain gave up waiting for a landing. The ticket is LEFT IN BACKLOG (it
   *  is not started, not failed, not dropped) - WI-4's land-success event fires
   *  a fresh drain that will pick it straight back up. */
  onDeferred(ticketId: string): Promise<void>;
}

/**
 * The sliding-window drain loop: fill up to `parallelism` eligible tickets,
 * poll the in-flight set, top the window back up as slots free, repeat until
 * the backlog snapshot is exhausted and nothing is in flight.
 */
export async function runDrainWindow(args: {
  ticketIds: readonly string[];
  parallelism: number;
  maxPolls: number;
  io: DrainWindowIO;
}): Promise<Array<{ ticketId: string; outcome: DrainOutcome }>> {
  const { parallelism, maxPolls, io } = args;
  const summary: Array<{ ticketId: string; outcome: DrainOutcome }> = [];

  let pending: string[] = args.ticketIds.slice();
  let inFlight: InFlightEntry[] = [];
  let fillRound = 0;
  let pollRound = 0;
  let landWaits = 0;

  while (pending.length > 0 || inFlight.length > 0) {
    // FILL - top the window back up. A ticket that is dependency-blocked is
    // deferred (stays pending, costs no slot) and re-probed next round, because
    // the blocker may be one of the tickets currently in flight.
    if (pending.length > 0 && inFlight.length < parallelism) {
      const probes = await io.probe(pending, fillRound);
      fillRound++;

      const plan = planFill({ pending, probes, inFlightCount: inFlight.length, parallelism });

      // Claim every ticket the plan touched in one shot: once it's out of
      // `pending`, no later fill round can hand the same ticket a second slot.
      const claimed = new Set([...plan.starts, ...plan.skipped]);
      pending = pending.filter((id) => !claimed.has(id));

      for (const ticketId of plan.skipped) {
        summary.push({ ticketId, outcome: "skipped" });
        await io.onSkipped(ticketId);
      }

      for (const ticketId of plan.starts) {
        const started = await io.start(ticketId);
        if (!started.ok) {
          // Never entered the window - no slot consumed.
          summary.push({ ticketId, outcome: started.blocked ? "stuck" : "failed" });
          await io.onStartFailed(ticketId, { blocked: started.blocked, error: started.error });
          continue;
        }
        inFlight.push({ ticketId, polls: 0 });
      }

      // Nothing started, nothing in flight, and everything left is waiting on a
      // landing. planFill refused to force these (a completion IS coming, from
      // the land worker), so the loop must not spin on them: wait for the worker
      // and re-probe. If the landing never arrives, leave them in the backlog
      // rather than burning them - the land-success event re-drains the project.
      if (inFlight.length === 0 && plan.starts.length === 0 && plan.awaitingLand.length > 0) {
        if (landWaits >= MAX_LAND_WAIT_ROUNDS) {
          for (const ticketId of plan.awaitingLand) {
            summary.push({ ticketId, outcome: "deferred" });
            await io.onDeferred(ticketId);
          }
          break;
        }
        await io.waitForLand(landWaits);
        landWaits++;
        continue;
      }
    }

    if (inFlight.length === 0) {
      // Done, or the next fill round has work to claim. planFill's progress
      // guarantee (it forces the blocked head when nothing is in flight, and
      // surfaces awaitingLand otherwise - handled above) means this can't spin.
      if (pending.length === 0) break;
      continue;
    }

    // POLL the whole in-flight set at once. Sleep first - a ticket can't
    // transition within the same tick we kicked it.
    await io.sleep(pollRound);
    const statuses = await io.poll(
      inFlight.map((e) => e.ticketId),
      pollRound,
    );
    pollRound++;

    const round = planPollRound({ inFlight, statuses, maxPolls });
    inFlight = round.running;
    for (const s of round.settled) {
      summary.push({ ticketId: s.ticketId, outcome: s.outcome });
      await io.onSettled(s.ticketId, s.finalStatus, s.outcome);
    }
  }

  return summary;
}
