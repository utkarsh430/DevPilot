// The 2026-08-03 deadlock, as a test.
//
// The first block is the reproduction the brief asks for: N tickets held every
// WIP slot while every one of their runs was dead, and nothing on earth could
// release them. It fails against pre-fix code for the most literal reason
// possible — `decideDispatchRescue` did not exist, so nothing ever asked
// whether the agent actually had capacity.
//
// The second block is the guard that matters just as much: the naive fix is to
// stop counting, and unbounded concurrency is what makes the engine time out
// under load in the first place. Every "still bites" case here is a case the
// rescue must refuse.

import { describe, expect, it } from "vitest";
import {
  decideDispatchRescue,
  describeDispatchStall,
  detectDispatchStall,
  occupiedSlots,
  DISPATCH_RESCUE_GRACE_SECONDS_DEFAULT,
  WIP_OCCUPYING_RUN_STATUSES,
  type DispatchQueueGroup,
} from "@/lib/engine/dispatch-rescue-policy";

const NOW = "2026-08-03T12:00:00.000Z";
const GRACE = DISPATCH_RESCUE_GRACE_SECONDS_DEFAULT;

/** Minutes before NOW, as an ISO string. */
function agoMinutes(m: number): string {
  return new Date(Date.parse(NOW) - m * 60_000).toISOString();
}

function group(over: Partial<DispatchQueueGroup> = {}): DispatchQueueGroup {
  return {
    tenantId: "t1",
    agentId: "engineer-agent",
    wipLimit: 3,
    runningRuns: 0,
    waitingRuns: 0,
    pendingRows: 1,
    oldestPendingIso: agoMinutes(60),
    ...over,
  };
}

describe("the incident: five tickets, zero runs, seven hours", () => {
  // The measured state, verbatim:
  //   running runs, instance-wide: 0
  //   #45 in_progress idle 4.9h  latest run: failed
  //   #54 in_progress idle 4.8h  latest run: cancelled
  //   #57 in_progress idle 5.9h  latest run: failed
  //   #58 in_progress idle 5.2h  latest run: failed
  //   #61 in_progress idle 5.7h  latest run: failed
  // ...and the board refusing every new dispatch at "WIP limit (3/3)".
  const incident = group({
    wipLimit: 3,
    // Every one of those five runs ended `failed` or `cancelled`, so NOTHING
    // occupies a slot. This is the whole point: a dead run is not a live one.
    runningRuns: 0,
    waitingRuns: 0,
    pendingRows: 4, // the tickets that waited seven hours
    oldestPendingIso: agoMinutes(7 * 60),
  });

  it("releases the queue — a dead run does not hold a WIP slot", () => {
    const d = decideDispatchRescue(incident, NOW, GRACE);
    expect(d.action).toBe("release");
  });

  it("releases exactly the free capacity, never more", () => {
    const d = decideDispatchRescue(incident, NOW, GRACE);
    if (d.action !== "release") throw new Error("expected release");
    // 3 free slots, 4 rows queued → release 3. The 4th waits for a real slot.
    expect(d.slots).toBe(3);
  });

  it("never releases more rows than are actually queued", () => {
    const d = decideDispatchRescue({ ...incident, pendingRows: 1 }, NOW, GRACE);
    if (d.action !== "release") throw new Error("expected release");
    expect(d.slots).toBe(1);
  });

  it("says why, naming the contradiction rather than just 'stuck'", () => {
    const d = decideDispatchRescue(incident, NOW, GRACE);
    if (d.action !== "release") throw new Error("expected release");
    expect(d.reason).toContain("0/3");
    expect(d.reason).toContain("release event never arrived");
  });
});

describe("the WIP limit still bites when runs are genuinely running", () => {
  it("stands down at exactly the limit", () => {
    const d = decideDispatchRescue(group({ runningRuns: 3, wipLimit: 3 }), NOW, GRACE);
    expect(d).toEqual({ action: "none", reason: "at-capacity:3/3" });
  });

  it("stands down over the limit", () => {
    const d = decideDispatchRescue(group({ runningRuns: 5, wipLimit: 3 }), NOW, GRACE);
    expect(d.action).toBe("none");
  });

  it("capacity is checked BEFORE the clock — an ancient queue behind live runs is not rescued", () => {
    // The dangerous shape: rows queued for a week behind a genuinely busy
    // agent. If the grace were evaluated first this would release and blow the
    // concurrency cap.
    const d = decideDispatchRescue(
      group({ runningRuns: 3, wipLimit: 3, oldestPendingIso: agoMinutes(7 * 24 * 60) }),
      NOW,
      GRACE,
    );
    expect(d.action).toBe("none");
    expect(d.reason).toContain("at-capacity");
  });

  it("a run parked on a human still holds its slot", () => {
    // `awaiting_human` is a legitimate multi-day wait. Reaping or discounting
    // it would destroy exactly the human-in-the-loop pause the engine exists
    // to support.
    const d = decideDispatchRescue(
      group({ runningRuns: 0, waitingRuns: 3, wipLimit: 3 }),
      NOW,
      GRACE,
    );
    expect(d.action).toBe("none");
    expect(d.reason).toContain("at-capacity:3/3");
  });

  it("releases only the genuinely free slots when partially busy", () => {
    const d = decideDispatchRescue(
      group({ runningRuns: 2, wipLimit: 3, pendingRows: 5 }),
      NOW,
      GRACE,
    );
    if (d.action !== "release") throw new Error("expected release");
    expect(d.slots).toBe(1);
  });

  it("counts running and parked runs against the same limit", () => {
    expect(occupiedSlots({ runningRuns: 2, waitingRuns: 1 })).toBe(3);
    const d = decideDispatchRescue(
      group({ runningRuns: 2, waitingRuns: 1, wipLimit: 3 }),
      NOW,
      GRACE,
    );
    expect(d.action).toBe("none");
  });

  it("counts the same run statuses the dispatcher's own gate counts", () => {
    // A divergence here would release a row the dispatcher instantly re-blocks.
    expect([...WIP_OCCUPYING_RUN_STATUSES]).toEqual(["running", "awaiting_human"]);
  });
});

describe("grace and fail-closed inputs", () => {
  it("holds off while the completion could still legitimately be in flight", () => {
    const d = decideDispatchRescue(group({ oldestPendingIso: agoMinutes(1) }), NOW, GRACE);
    expect(d).toEqual({ action: "none", reason: "within-grace" });
  });

  it("acts once the grace is exceeded", () => {
    const justOver = new Date(Date.parse(NOW) - (GRACE * 1000 + 1)).toISOString();
    const d = decideDispatchRescue(group({ oldestPendingIso: justOver }), NOW, GRACE);
    expect(d.action).toBe("release");
  });

  it("does nothing when the queue is empty", () => {
    const d = decideDispatchRescue(group({ pendingRows: 0 }), NOW, GRACE);
    expect(d).toEqual({ action: "none", reason: "queue-empty" });
  });

  it("stands down on an unusable WIP limit rather than inventing capacity", () => {
    for (const wipLimit of [0, -1, Number.NaN]) {
      const d = decideDispatchRescue(group({ wipLimit }), NOW, GRACE);
      expect(d).toEqual({ action: "none", reason: "unusable-wip-limit" });
    }
  });

  it("stands down on an unparseable queue age", () => {
    const d = decideDispatchRescue(group({ oldestPendingIso: "not-a-date" }), NOW, GRACE);
    expect(d).toEqual({ action: "none", reason: "indeterminate-queue-age" });
  });
});

describe("the contradiction detector", () => {
  it("fires on WIP saturated + zero running runs", () => {
    const s = detectDispatchStall(
      [
        group({
          runningRuns: 0,
          waitingRuns: 0,
          pendingRows: 4,
          oldestPendingIso: agoMinutes(420),
        }),
      ],
      NOW,
      GRACE,
    );
    expect(s.contradiction).toBe(true);
    expect(s.stalledRows).toBe(4);
    expect(s.stalledAgents).toBe(1);
    expect(s.oldestStalledMinutes).toBe(420);
  });

  it("stays SILENT on WIP saturated + runs actually running", () => {
    // The case that must never fire. A detector that cannot tell these apart
    // is noise, and noise gets ignored.
    const s = detectDispatchStall(
      [group({ runningRuns: 3, pendingRows: 9, oldestPendingIso: agoMinutes(600) })],
      NOW,
      GRACE,
    );
    expect(s.contradiction).toBe(false);
    expect(s.runningRuns).toBe(3);
  });

  it("stays silent while the queue is young", () => {
    const s = detectDispatchStall(
      [group({ pendingRows: 3, oldestPendingIso: agoMinutes(1) })],
      NOW,
      GRACE,
    );
    expect(s.contradiction).toBe(false);
  });

  it("stays silent on an empty queue even with nothing running", () => {
    // An idle board is not a stalled one.
    const s = detectDispatchStall([group({ pendingRows: 0 })], NOW, GRACE);
    expect(s.contradiction).toBe(false);
  });

  it("reports a human-parked queue as parked, not as a contradiction", () => {
    const s = detectDispatchStall(
      [
        group({
          runningRuns: 0,
          waitingRuns: 2,
          pendingRows: 3,
          oldestPendingIso: agoMinutes(600),
        }),
      ],
      NOW,
      GRACE,
    );
    expect(s.contradiction).toBe(false);
    expect(s.parked).toBe(true);
  });

  it("fires for a stalled agent even when a DIFFERENT agent is busy", () => {
    // Per-group, not "are any runs alive anywhere" — the stalled agent's queue
    // really is unreleasable regardless of what the other one is doing.
    const s = detectDispatchStall(
      [
        group({ agentId: "busy", runningRuns: 3, pendingRows: 2 }),
        group({ agentId: "stalled", runningRuns: 0, pendingRows: 5 }),
      ],
      NOW,
      GRACE,
    );
    expect(s.contradiction).toBe(true);
    expect(s.stalledRows).toBe(5);
    expect(s.stalledAgents).toBe(1);
  });

  it("ignores an unparseable timestamp rather than reporting a false stall", () => {
    const s = detectDispatchStall([group({ oldestPendingIso: "nope" })], NOW, GRACE);
    expect(s.contradiction).toBe(false);
  });

  it("explains the impossibility instead of just saying 'at WIP limit'", () => {
    const s = detectDispatchStall(
      [group({ pendingRows: 4, oldestPendingIso: agoMinutes(420) })],
      NOW,
      GRACE,
    );
    const text = describeDispatchStall(s);
    expect(text).toContain("nothing is running");
    expect(text).toContain("cannot be released");
    expect(text).toContain("4 tickets");
  });

  it("describes the healthy states without alarm", () => {
    expect(describeDispatchStall(detectDispatchStall([], NOW, GRACE))).toBe("idle");
    expect(
      describeDispatchStall(detectDispatchStall([group({ runningRuns: 2 })], NOW, GRACE)),
    ).toContain("2 run(s) executing");
  });
});
