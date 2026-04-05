// Drain sliding-window tests - WI-13, the concurrency fix.
//
// The interesting property is a CONCURRENCY property, so most of these drive the
// real loop (`runDrainWindow`) against an in-memory board rather than asserting
// on the pure sub-decisions. What's under test is therefore the shipped
// scheduling behaviour: `drainBacklogFn` supplies the same loop with durable
// Inngest steps as its IO and nothing else.
//
// The board models the bit that made the old drain look "parallel-safe" while
// being serial: the dispatcher promotes `ready → in_progress` within
// milliseconds, so a started ticket is live on the board from the next poll on.

import { describe, expect, it } from "vitest";
import type { TicketStatus } from "@/lib/board/state";
import {
  DEFAULT_DRAIN_PARALLELISM,
  MAX_LAND_WAIT_ROUNDS,
  planFill,
  planPollRound,
  resolveDrainParallelism,
  runDrainWindow,
  type DrainOutcome,
  type DrainProbe,
  type StartResult,
} from "@/lib/engine/drain-window";
import { summarizeBlockers } from "@/lib/integration/landed";

// ---------------------------------------------------------------------------
// In-memory board
// ---------------------------------------------------------------------------

interface FakeTicket {
  status: TicketStatus;
  /** ids this ticket is blocked_by / builds_on. */
  blockers: string[];
  /** Polls this ticket needs before it settles, once started. */
  pollsToSettle: number;
  /** Status it settles into. `null` = the row is deleted (vanishes). */
  settlesTo: TicketStatus | null;
  /** WI-5 - the integration-branch sha this ticket's work landed as. A ticket
   *  that reaches `done` is NOT automatically landed: the land worker gets there
   *  a moment later, and the gap is the window the drain has to handle. */
  landedSha: string | null;
  /** Is a landing still owed for it (an integration_queue row exists)? */
  landPending: boolean;
  /** Polls after settling `done` before the land worker lands it. 0 = it lands
   *  in the same tick (or has nothing to land). */
  pollsToLand: number;
}

interface DrainTrace {
  summary: Array<{ ticketId: string; outcome: DrainOutcome }>;
  /** Highest number of simultaneously in-flight tickets observed at any poll. */
  maxConcurrency: number;
  /** In-flight set snapshot at each poll round. */
  concurrencySnapshots: string[][];
  startOrder: string[];
  starts: Record<string, number>;
  /** How many times the drain waited on the land worker. */
  landWaits: number;
  /** Tickets left in the backlog because their parent never landed. */
  deferred: string[];
}

function ticket(over: Partial<FakeTicket> = {}): FakeTicket {
  return {
    status: "backlog",
    blockers: [],
    pollsToSettle: 1,
    settlesTo: "done",
    landedSha: null,
    landPending: false,
    pollsToLand: 0,
    ...over,
  };
}

async function drain(args: {
  board: Record<string, FakeTicket>;
  order: string[];
  parallelism: number;
  maxPolls?: number;
}): Promise<DrainTrace> {
  const board = new Map(Object.entries(args.board));
  const trace: DrainTrace = {
    summary: [],
    maxConcurrency: 0,
    concurrencySnapshots: [],
    startOrder: [],
    starts: {},
    landWaits: 0,
    deferred: [],
  };
  const inFlight = new Set<string>();
  const remainingPolls = new Map<string, number>();
  /** Tickets that have settled `done` and are waiting on the land worker. */
  const landing = new Map<string, number>();

  // The REAL predicate, not a re-implementation: the blocker classification the
  // board uses is `summarizeBlockers` from lib/integration/landed.ts, so what
  // these tests exercise is the shipped readiness rule.
  const blockerSummary = (id: string) =>
    summarizeBlockers(
      (board.get(id)?.blockers ?? []).map((b) => {
        const blocker = board.get(b);
        return {
          status: (blocker?.status ?? "done") as TicketStatus,
          landedSha: blocker?.landedSha ?? null,
          landPending: blocker?.landPending ?? false,
        };
      }),
    );
  const hasOpenBlockers = (id: string) => blockerSummary(id).open > 0;

  /** One tick of the land worker: a done ticket with a landing owed eventually
   *  gets its sha stamped, which is what actually unblocks its dependents. */
  const tickLandWorker = () => {
    for (const [id, left] of [...landing]) {
      const remaining = left - 1;
      if (remaining <= 0) {
        const t = board.get(id);
        if (t) {
          t.landedSha = `sha-${id}`;
          t.landPending = false;
        }
        landing.delete(id);
      } else {
        landing.set(id, remaining);
      }
    }
  };

  trace.summary = await runDrainWindow({
    ticketIds: args.order,
    parallelism: args.parallelism,
    maxPolls: args.maxPolls ?? 10,
    io: {
      async probe(pending): Promise<Record<string, DrainProbe>> {
        const out: Record<string, DrainProbe> = {};
        for (const id of pending) {
          const t = board.get(id);
          const summary = t ? blockerSummary(id) : null;
          out[id] = {
            status: t?.status ?? null,
            hasOpenBlockers: summary ? summary.open > 0 : false,
            onlyAwaitingLand: summary ? summary.onlyAwaitingLand : false,
          };
        }
        return out;
      },
      async start(id): Promise<StartResult> {
        trace.startOrder.push(id);
        trace.starts[id] = (trace.starts[id] ?? 0) + 1;
        // Mirrors transitionTicket: the dependency guard is what actually
        // refuses, and it refuses at move time, not at probe time.
        if (hasOpenBlockers(id)) {
          return { ok: false, blocked: true, error: "blocked by dependency" };
        }
        const t = board.get(id)!;
        // ready → in_progress happens within milliseconds via the dispatcher.
        t.status = "in_progress";
        inFlight.add(id);
        remainingPolls.set(id, t.pollsToSettle);
        return { ok: true };
      },
      async onSkipped() {},
      async onStartFailed() {},
      async onSettled(id) {
        inFlight.delete(id);
      },
      // WI-5.4 - the drain waits for the land worker rather than forcing a
      // ticket whose only blocker is a done-but-unlanded parent.
      async waitForLand() {
        trace.landWaits++;
        tickLandWorker();
      },
      async onDeferred(id) {
        trace.deferred.push(id);
      },
      async sleep() {
        // Virtual time: every in-flight ticket burns one poll's worth of work,
        // and the land worker gets a tick too (it runs concurrently with the
        // drain in the real system - that concurrency IS the race under test).
        tickLandWorker();
        for (const id of inFlight) {
          const left = (remainingPolls.get(id) ?? 0) - 1;
          remainingPolls.set(id, left);
          if (left <= 0) {
            const t = board.get(id)!;
            if (t.settlesTo === null) board.delete(id);
            else t.status = t.settlesTo;
            // A ticket that lands `done` with work to land starts its clock now.
            if (t.settlesTo === "done" && t.landPending) {
              landing.set(id, Math.max(1, t.pollsToLand));
            }
          }
        }
      },
      async poll(ids): Promise<Record<string, TicketStatus | null>> {
        // Observe concurrency exactly where it matters: tickets the drain is
        // holding slots for and that are actually live on the board.
        const live = [...inFlight];
        trace.concurrencySnapshots.push(live);
        trace.maxConcurrency = Math.max(trace.maxConcurrency, live.length);
        const out: Record<string, TicketStatus | null> = {};
        for (const id of ids) out[id] = board.get(id)?.status ?? null;
        return out;
      },
    },
  });

  return trace;
}

const outcomes = (t: DrainTrace) =>
  Object.fromEntries(t.summary.map((s) => [s.ticketId, s.outcome] as const));

// ---------------------------------------------------------------------------
// The bug this task fixes
// ---------------------------------------------------------------------------

describe("runDrainWindow - parallel fan-out", () => {
  it("keeps up to N independent tickets in flight (the WI-13 fix)", async () => {
    const board = Object.fromEntries(
      ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => [id, ticket({ pollsToSettle: 2 })]),
    );
    const t = await drain({ board, order: Object.keys(board), parallelism: 3 });

    expect(t.maxConcurrency).toBe(3);
    expect(Object.values(outcomes(t))).toEqual(Array(6).fill("done"));
    // Every ticket started exactly once - no wave double-claimed a slot.
    expect(Object.values(t.starts).every((n) => n === 1)).toBe(true);
    expect(t.startOrder).toHaveLength(6);
  });

  it("never over-fills the window, at any parallelism", async () => {
    for (const parallelism of [1, 2, 5, 10]) {
      const board = Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `t${i}`,
          // Uneven durations: slots free at different rounds, which is exactly
          // where an over-filling window would show up.
          ticket({ pollsToSettle: (i % 4) + 1 }),
        ]),
      );
      const t = await drain({ board, order: Object.keys(board), parallelism });
      expect(t.maxConcurrency).toBeLessThanOrEqual(parallelism);
      expect(t.maxConcurrency).toBe(Math.min(parallelism, 12));
      expect(t.summary).toHaveLength(12);
      expect(Object.values(t.starts).every((n) => n === 1)).toBe(true);
    }
  });

  it("parallelism 1 reproduces the old strictly-serial drain", async () => {
    const board = Object.fromEntries(
      ["a", "b", "c"].map((id) => [id, ticket({ pollsToSettle: 2 })]),
    );
    const t = await drain({ board, order: ["a", "b", "c"], parallelism: 1 });

    expect(t.maxConcurrency).toBe(1);
    expect(t.startOrder).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Dependencies still serialise
// ---------------------------------------------------------------------------

describe("runDrainWindow - dependency eligibility", () => {
  it("serialises a real dependency chain even at high parallelism", async () => {
    const board: Record<string, FakeTicket> = {
      a: ticket({ pollsToSettle: 2 }),
      b: ticket({ blockers: ["a"], pollsToSettle: 2 }),
      c: ticket({ blockers: ["b"], pollsToSettle: 2 }),
    };
    const t = await drain({ board, order: ["a", "b", "c"], parallelism: 5 });

    // One at a time, in chain order, all the way to done - and never "stuck":
    // a blocked ticket waits for its blocker instead of burning its one attempt.
    expect(t.maxConcurrency).toBe(1);
    expect(t.startOrder).toEqual(["a", "b", "c"]);
    expect(outcomes(t)).toEqual({ a: "done", b: "done", c: "done" });
  });

  it("a blocked ticket never wastes a slot - independents fan out around it", async () => {
    const board: Record<string, FakeTicket> = {
      // The chain head sits FIRST in backlog order, so a naive window would
      // hand slot 1 to `chain2` and stall it.
      chain1: ticket({ pollsToSettle: 4 }),
      chain2: ticket({ blockers: ["chain1"], pollsToSettle: 1 }),
      solo1: ticket({ pollsToSettle: 1 }),
      solo2: ticket({ pollsToSettle: 1 }),
      solo3: ticket({ pollsToSettle: 1 }),
    };
    const t = await drain({ board, order: Object.keys(board), parallelism: 3 });

    expect(t.maxConcurrency).toBe(3);
    // chain2 is only ever started after chain1 is done.
    expect(t.startOrder.indexOf("chain2")).toBeGreaterThan(t.startOrder.indexOf("chain1"));
    // The two free slots went to independent work, not to the blocked ticket.
    expect(t.startOrder.slice(0, 3)).toEqual(["chain1", "solo1", "solo2"]);
    expect(t.concurrencySnapshots[0]).toEqual(["chain1", "solo1", "solo2"]);
    expect(Object.values(outcomes(t))).toEqual(Array(5).fill("done"));
    // chain2 never had a wasted start attempt.
    expect(t.starts.chain2).toBe(1);
  });

  it("records a ticket blocked from OUTSIDE the drain as stuck, and terminates", async () => {
    const board: Record<string, FakeTicket> = {
      // `ext` is not part of the backlog snapshot and never completes, so
      // nothing in this drain can ever unblock `x`. The window must not
      // deadlock waiting for it.
      ext: ticket({ status: "in_progress" }),
      x: ticket({ blockers: ["ext"] }),
      y: ticket(),
    };
    const t = await drain({ board, order: ["x", "y"], parallelism: 2 });

    expect(outcomes(t)).toEqual({ x: "stuck", y: "done" });
    expect(t.starts.x).toBe(1); // forced exactly once, not retried forever
  });

  it("terminates when EVERY pending ticket is permanently blocked", async () => {
    const board: Record<string, FakeTicket> = {
      ext: ticket({ status: "blocked" }),
      p: ticket({ blockers: ["ext"] }),
      q: ticket({ blockers: ["ext"] }),
    };
    const t = await drain({ board, order: ["p", "q"], parallelism: 3 });

    expect(outcomes(t)).toEqual({ p: "stuck", q: "stuck" });
  });

  it("terminates on a dependency cycle instead of spinning", async () => {
    const board: Record<string, FakeTicket> = {
      m: ticket({ blockers: ["n"] }),
      n: ticket({ blockers: ["m"] }),
    };
    const t = await drain({ board, order: ["m", "n"], parallelism: 2 });

    expect(outcomes(t)).toEqual({ m: "stuck", n: "stuck" });
  });
});

// ---------------------------------------------------------------------------
// Safeguards carried over from the serial drain
// ---------------------------------------------------------------------------

describe("runDrainWindow - preserved safeguards", () => {
  it("skips a ticket that left backlog since the snapshot, without burning a slot", async () => {
    const board: Record<string, FakeTicket> = {
      moved: ticket({ status: "in_review" }), // operator moved it by hand
      a: ticket({ pollsToSettle: 2 }),
      b: ticket({ pollsToSettle: 2 }),
    };
    const t = await drain({ board, order: ["moved", "a", "b"], parallelism: 2 });

    expect(outcomes(t)).toEqual({ moved: "skipped", a: "done", b: "done" });
    expect(t.startOrder).toEqual(["a", "b"]);
    expect(t.maxConcurrency).toBe(2); // the skip did NOT eat a slot
  });

  it("records failed / stuck / timeout outcomes and keeps draining", async () => {
    const board: Record<string, FakeTicket> = {
      fails: ticket({ settlesTo: "failed" }),
      stuck: ticket({ settlesTo: "input_required" }),
      hangs: ticket({ pollsToSettle: 999 }), // never settles → timeout
      gone: ticket({ settlesTo: null }), // row vanishes mid-drain
      ok: ticket(),
    };
    const t = await drain({
      board,
      order: ["fails", "stuck", "hangs", "gone", "ok"],
      parallelism: 2,
      maxPolls: 4,
    });

    expect(outcomes(t)).toEqual({
      fails: "failed",
      stuck: "stuck",
      hangs: "timeout",
      gone: "failed",
      ok: "done",
    });
  });

  it("frees a timed-out ticket's slot exactly once", async () => {
    const board: Record<string, FakeTicket> = {
      hang1: ticket({ pollsToSettle: 999 }),
      hang2: ticket({ pollsToSettle: 999 }),
      after: ticket(),
    };
    const t = await drain({
      board,
      order: ["hang1", "hang2", "after"],
      parallelism: 2,
      maxPolls: 3,
    });

    expect(outcomes(t)).toEqual({ hang1: "timeout", hang2: "timeout", after: "done" });
    expect(t.maxConcurrency).toBe(2);
    expect(t.starts.after).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pure sub-decisions
// ---------------------------------------------------------------------------

describe("resolveDrainParallelism", () => {
  it("defaults to 3 when unset - the fix has to be exercised by default", () => {
    expect(resolveDrainParallelism(undefined)).toBe(DEFAULT_DRAIN_PARALLELISM);
    expect(resolveDrainParallelism(null)).toBe(3);
    expect(resolveDrainParallelism(Number.NaN)).toBe(3);
  });

  it("honours an explicit value and clamps it to [1, 10]", () => {
    expect(resolveDrainParallelism(1)).toBe(1);
    expect(resolveDrainParallelism(7)).toBe(7);
    expect(resolveDrainParallelism(0)).toBe(1);
    expect(resolveDrainParallelism(-5)).toBe(1);
    expect(resolveDrainParallelism(99)).toBe(10);
    expect(resolveDrainParallelism(3.9)).toBe(3);
  });
});

describe("planFill", () => {
  const backlog = (hasOpenBlockers = false): DrainProbe => ({
    status: "backlog",
    hasOpenBlockers,
    onlyAwaitingLand: false,
  });
  /** Blocked ONLY by a done parent that hasn't landed yet - transient, and a
   *  land worker is on its way to clear it. */
  const awaitingLand = (): DrainProbe => ({
    status: "backlog",
    hasOpenBlockers: true,
    onlyAwaitingLand: true,
  });

  it("never hands out more slots than the window has free", () => {
    const plan = planFill({
      pending: ["a", "b", "c"],
      probes: { a: backlog(), b: backlog(), c: backlog() },
      inFlightCount: 2,
      parallelism: 3,
    });
    expect(plan.starts).toEqual(["a"]);
  });

  it("returns no starts when the window is full", () => {
    const plan = planFill({
      pending: ["a"],
      probes: { a: backlog() },
      inFlightCount: 3,
      parallelism: 3,
    });
    expect(plan.starts).toEqual([]);
    expect(plan.forced).toBe(false);
  });

  it("defers blocked tickets while something is in flight (a completion may unblock them)", () => {
    const plan = planFill({
      pending: ["blocked", "free"],
      probes: { blocked: backlog(true), free: backlog() },
      inFlightCount: 1,
      parallelism: 3,
    });
    expect(plan.starts).toEqual(["free"]);
    expect(plan.forced).toBe(false);
  });

  it("waits rather than forcing while work is still in flight", () => {
    const plan = planFill({
      pending: ["blocked"],
      probes: { blocked: backlog(true) },
      inFlightCount: 1,
      parallelism: 3,
    });
    expect(plan.starts).toEqual([]);
    expect(plan.forced).toBe(false);
  });

  it("forces the blocked head when nothing is in flight, so the drain can't deadlock", () => {
    const plan = planFill({
      pending: ["blocked1", "blocked2"],
      probes: { blocked1: backlog(true), blocked2: backlog(true) },
      inFlightCount: 0,
      parallelism: 2,
    });
    // Both get forced - the move refuses them and they're recorded `stuck`,
    // exactly as the serial drain did.
    expect(plan.starts).toEqual(["blocked1", "blocked2"]);
    expect(plan.forced).toBe(true);
  });

  it("skips non-backlog and missing rows without spending a slot", () => {
    const plan = planFill({
      pending: ["gone", "moved", "a"],
      probes: {
        moved: { status: "in_progress", hasOpenBlockers: false, onlyAwaitingLand: false },
        a: backlog(),
      },
      inFlightCount: 0,
      parallelism: 1,
    });
    expect(plan.skipped).toEqual(["gone", "moved"]);
    expect(plan.starts).toEqual(["a"]);
  });
});

describe("planPollRound", () => {
  it("settles terminal and stuck statuses, keeps the rest running", () => {
    const r = planPollRound({
      inFlight: [
        { ticketId: "d", polls: 0 },
        { ticketId: "f", polls: 0 },
        { ticketId: "b", polls: 0 },
        { ticketId: "i", polls: 0 },
        { ticketId: "run", polls: 0 },
      ],
      statuses: {
        d: "done",
        f: "failed",
        b: "blocked",
        i: "input_required",
        run: "in_progress",
      },
      maxPolls: 10,
    });
    expect(r.settled.map((s) => [s.ticketId, s.outcome])).toEqual([
      ["d", "done"],
      ["f", "failed"],
      ["b", "stuck"],
      ["i", "stuck"],
    ]);
    expect(r.running).toEqual([{ ticketId: "run", polls: 1 }]);
  });

  it("times a ticket out on its last poll and treats a vanished row as failed", () => {
    const r = planPollRound({
      inFlight: [
        { ticketId: "slow", polls: 9 },
        { ticketId: "gone", polls: 0 },
      ],
      statuses: { slow: "in_progress" },
      maxPolls: 10,
    });
    expect(r.settled).toEqual([
      { ticketId: "slow", finalStatus: "timeout", outcome: "timeout" },
      { ticketId: "gone", finalStatus: "failed", outcome: "failed" },
    ]);
    expect(r.running).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WI-5.4 - the drain must not DROP a ticket whose parent is merely landing
//
// Re-gating readiness onto "landed" (not "done") opened a window the drain never
// had to reason about: a parent finishes `done`, the land worker hasn't squashed
// it onto dev yet, and for those seconds the dependent reads as blocked. If it is
// the last thing in the backlog, the old forced-head branch would hand it to
// transitionTicket, eat the BlockedByDependencyError, record it `stuck` and lose
// it - to a race with a worker that was about to unblock it.
// ---------------------------------------------------------------------------

describe("runDrainWindow - done-but-unlanded parent (WI-5)", () => {
  it("does NOT force-drop a dependent whose parent is done and landing", async () => {
    const board = {
      // The parent finishes fast, but its landing takes 2 more ticks.
      parent: ticket({ pollsToSettle: 1, settlesTo: "done", landPending: true, pollsToLand: 2 }),
      child: ticket({ blockers: ["parent"] }),
    };
    const t = await drain({ board, order: ["parent", "child"], parallelism: 3 });

    // The whole point: the child RUNS. It is not `stuck`, and it is not dropped.
    expect(outcomes(t)).toEqual({ parent: "done", child: "done" });
    expect(t.starts.child).toBe(1);
  });

  it("waits for the land worker instead of forcing the head", async () => {
    const board = {
      parent: ticket({ pollsToSettle: 1, settlesTo: "done", landPending: true, pollsToLand: 3 }),
      child: ticket({ blockers: ["parent"] }),
    };
    const t = await drain({ board, order: ["parent", "child"], parallelism: 1 });

    // At parallelism 1 the parent settles and empties the window, so the child is
    // the only pending ticket with nothing in flight - the exact shape that used
    // to trip the forced head. It waited instead.
    expect(t.landWaits).toBeGreaterThan(0);
    expect(outcomes(t).child).toBe("done");
    expect(t.deferred).toEqual([]);
  });

  it("leaves the dependent IN BACKLOG (never `stuck`) when the landing never comes", async () => {
    const board = {
      // A landing that never completes: the queue is wedged, or auto-land is down.
      parent: ticket({
        pollsToSettle: 1,
        settlesTo: "done",
        landPending: true,
        pollsToLand: 10_000,
      }),
      child: ticket({ blockers: ["parent"] }),
    };
    const t = await drain({ board, order: ["parent", "child"], parallelism: 2 });

    // `deferred`, NOT `stuck` - and it was never started, so it is still sitting
    // in the backlog for the next drain (which WI-4's land-success event fires).
    expect(outcomes(t).child).toBe("deferred");
    expect(t.deferred).toEqual(["child"]);
    expect(t.starts.child).toBeUndefined();
    // It gave up rather than spinning - the loop terminates.
    expect(t.landWaits).toBe(MAX_LAND_WAIT_ROUNDS);
  });

  it("still forces (and sticks) a ticket whose parent is genuinely still WORKING", async () => {
    // The distinction that makes the above safe: an upstream that is not done
    // cannot be unblocked by any worker, so forcing it is still the honest
    // outcome. Only `awaiting_land` is deferred.
    const board = {
      child: ticket({ blockers: ["ghost"] }),
      ghost: ticket({ status: "in_progress" }),
    };
    const t = await drain({ board, order: ["child"], parallelism: 2 });

    expect(outcomes(t).child).toBe("stuck");
    expect(t.deferred).toEqual([]);
  });

  it("a done parent with NOTHING to land unblocks its child immediately", async () => {
    // The non-code case (PM/design tickets, and auto-spawned mergers): no queue
    // row is ever written, so `done` closes the blocker with no landing to wait
    // for. Gating on landed_sha alone would have wedged these forever.
    const board = {
      pm: ticket({ pollsToSettle: 1, settlesTo: "done", landPending: false }),
      child: ticket({ blockers: ["pm"] }),
    };
    const t = await drain({ board, order: ["pm", "child"], parallelism: 1 });

    expect(outcomes(t)).toEqual({ pm: "done", child: "done" });
    expect(t.landWaits).toBe(0);
  });
});

describe("planFill - awaiting-land is deferred, not forced", () => {
  const backlog = (hasOpenBlockers = false): DrainProbe => ({
    status: "backlog",
    hasOpenBlockers,
    onlyAwaitingLand: false,
  });
  const awaitingLand = (): DrainProbe => ({
    status: "backlog",
    hasOpenBlockers: true,
    onlyAwaitingLand: true,
  });

  it("never forces a ticket that is only awaiting a landing, even with nothing in flight", () => {
    const plan = planFill({
      pending: ["waiting"],
      probes: { waiting: awaitingLand() },
      inFlightCount: 0,
      parallelism: 3,
    });
    expect(plan.starts).toEqual([]);
    expect(plan.forced).toBe(false);
    expect(plan.awaitingLand).toEqual(["waiting"]);
  });

  it("forces a genuinely-blocked head while still deferring the awaiting-land one", () => {
    const plan = planFill({
      pending: ["waiting", "blocked"],
      probes: { waiting: awaitingLand(), blocked: backlog(true) },
      inFlightCount: 0,
      parallelism: 3,
    });
    // Progress is preserved (the real deadlock is broken) without eating the
    // ticket that a worker is about to unblock.
    expect(plan.starts).toEqual(["blocked"]);
    expect(plan.forced).toBe(true);
    expect(plan.awaitingLand).toEqual(["waiting"]);
  });

  it("prefers an eligible ticket over both", () => {
    const plan = planFill({
      pending: ["waiting", "free"],
      probes: { waiting: awaitingLand(), free: backlog() },
      inFlightCount: 0,
      parallelism: 1,
    });
    expect(plan.starts).toEqual(["free"]);
    expect(plan.forced).toBe(false);
  });
});
