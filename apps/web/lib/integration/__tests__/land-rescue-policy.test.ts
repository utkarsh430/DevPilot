// The never-triggered-land decision core.
//
// Every assertion here is a property the rescue must have, not an example of
// what it happens to do today:
//
//   • a `pending` row whose event was lost IS re-emitted, after the grace;
//   • an IN-FLIGHT row is NEVER touched — the one that would cause real damage;
//   • a permanently-failing land STOPS being retried instead of looping;
//   • a legitimately dependency-deferred row is neither rescued nor failed.

import { describe, expect, it } from "vitest";
import {
  decideLandRescue,
  isDependencyDeferred,
  parseRescueRecord,
  renderRescueRecord,
  rescueBackoffMs,
  LAND_RESCUE_BASE_GRACE_MS,
  LAND_RESCUE_BACKOFF_CAP_MS,
  LAND_RESCUE_MAX_RESCUES,
} from "@/lib/integration/land-rescue-policy";

const MIN = 60_000;

function input(over: Partial<Parameters<typeof decideLandRescue>[0]> = {}) {
  return {
    status: "pending",
    idleMs: 60 * MIN,
    rescues: 0,
    attempts: 1,
    projectLandInFlight: false,
    dependencyDeferred: false,
    ...over,
  };
}

describe("decideLandRescue — the never-triggered land", () => {
  it("re-emits a pending row that has been idle past the grace", () => {
    const d = decideLandRescue(input({ idleMs: 10 * MIN }));
    expect(d.action).toBe("rescue");
    expect(d.action === "rescue" && d.nextRescueCount).toBe(1);
  });

  it("reproduces the observed production shape (pending, attempts=1, never claimed)", () => {
    // status=pending attempts=1 claimed_at=null, untouched for hours.
    const d = decideLandRescue(input({ idleMs: 7 * 60 * MIN, attempts: 1, rescues: 0 }));
    expect(d.action).toBe("rescue");
  });

  it("holds off inside the grace, so an event still in flight is not duplicated", () => {
    const d = decideLandRescue(input({ idleMs: LAND_RESCUE_BASE_GRACE_MS - 1 }));
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.reason).toMatch(/within-backoff/);
  });
});

describe("decideLandRescue — the double-land guard", () => {
  // These two are the assertions that matter most: a second concurrent land
  // would rebase and merge onto a dev tip another worker is moving.
  it.each(["landing", "awaiting_merge_resolution", "landed", "failed", "cancelled"])(
    "never touches a %s row, however idle",
    (status) => {
      const d = decideLandRescue(input({ status, idleMs: 30 * 24 * 60 * MIN, rescues: 99 }));
      expect(d.action).toBe("skip");
      expect(d.action === "skip" && d.reason).toBe(`not-pending:${status}`);
    },
  );

  it("stands down entirely while the project's land lane is busy", () => {
    // Another row is `landing`. That worker re-pumps the queue when it
    // finishes, so the event is queued — not missing.
    const d = decideLandRescue(
      input({ projectLandInFlight: true, idleMs: 6 * 60 * MIN, rescues: LAND_RESCUE_MAX_RESCUES }),
    );
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.reason).toBe("project-lane-busy");
  });

  it("the lane guard outranks the give-up, so a busy lane can never fail a row", () => {
    const d = decideLandRescue(
      input({ projectLandInFlight: true, rescues: LAND_RESCUE_MAX_RESCUES + 5 }),
    );
    expect(d.action).not.toBe("give_up");
  });
});

describe("decideLandRescue — retry storms", () => {
  it("backs off exponentially, so a permanently-failing land is not hammered", () => {
    expect(rescueBackoffMs(0)).toBe(LAND_RESCUE_BASE_GRACE_MS);
    expect(rescueBackoffMs(1)).toBe(2 * LAND_RESCUE_BASE_GRACE_MS);
    expect(rescueBackoffMs(3)).toBe(8 * LAND_RESCUE_BASE_GRACE_MS);
    expect(rescueBackoffMs(99)).toBe(LAND_RESCUE_BACKOFF_CAP_MS);
  });

  it("a row rescued three times waits 8x the base before the fourth", () => {
    const within = decideLandRescue(
      input({ rescues: 3, idleMs: 8 * LAND_RESCUE_BASE_GRACE_MS - 1 }),
    );
    expect(within.action).toBe("skip");
    const past = decideLandRescue(input({ rescues: 3, idleMs: 8 * LAND_RESCUE_BASE_GRACE_MS }));
    expect(past.action).toBe("rescue");
  });

  it("GIVES UP once the rescue budget is spent — it does not loop forever", () => {
    // The live `workflow`-scope push rejection: fails identically every time.
    const d = decideLandRescue(
      input({ rescues: LAND_RESCUE_MAX_RESCUES, idleMs: 24 * 60 * MIN, attempts: 3 }),
    );
    expect(d.action).toBe("give_up");
    expect(d.reason).toMatch(/needs a human/);
    // The reason carries both counters, so the record says WHY it stopped.
    expect(d.reason).toContain(String(LAND_RESCUE_MAX_RESCUES));
    expect(d.reason).toContain("attempts: 3");
  });

  it("gives the LAST rescue its full window before failing the row", () => {
    // One tick after the 6th rescue: the marker says 6/6, but the backoff has
    // not elapsed, so we wait rather than failing work that may still land.
    const d = decideLandRescue(input({ rescues: LAND_RESCUE_MAX_RESCUES, idleMs: 1 * MIN }));
    expect(d.action).toBe("skip");
  });

  it("a rescued row eventually terminates rather than being rescued forever", () => {
    let rescues = 0;
    for (let i = 0; i < 50; i++) {
      const d = decideLandRescue(input({ rescues, idleMs: 365 * 24 * 60 * MIN }));
      if (d.action === "give_up") break;
      expect(d.action).toBe("rescue");
      rescues = d.action === "rescue" ? d.nextRescueCount : rescues;
    }
    expect(rescues).toBe(LAND_RESCUE_MAX_RESCUES);
  });
});

describe("decideLandRescue — a dependency-deferred row is left alone", () => {
  it("is neither rescued nor given up on, however long it waits", () => {
    // A `builds_on` child whose parent has not landed yet is pending BY
    // DESIGN. Failing it would break a healthy stacked chain.
    const d = decideLandRescue(
      input({ dependencyDeferred: true, idleMs: 30 * 24 * 60 * MIN, rescues: 99 }),
    );
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.reason).toBe("dependency-deferred");
  });
});

describe("isDependencyDeferred — the SQL claim gate, mirrored", () => {
  it("builds_on: an unlanded, done parent with a land still owed defers the child", () => {
    expect(
      isDependencyDeferred([
        {
          relationType: "builds_on",
          blockerStatus: "done",
          blockerLandedSha: null,
          blockerLandPending: true,
        },
      ]),
    ).toBe(true);
  });

  it("builds_on: a done parent with NOTHING owed does not defer (the ~48 non-code roles)", () => {
    expect(
      isDependencyDeferred([
        {
          relationType: "builds_on",
          blockerStatus: "done",
          blockerLandedSha: null,
          blockerLandPending: false,
        },
      ]),
    ).toBe(false);
  });

  it("builds_on: a landed parent does not defer", () => {
    expect(
      isDependencyDeferred([
        {
          relationType: "builds_on",
          blockerStatus: "done",
          blockerLandedSha: "abc123",
          blockerLandPending: true,
        },
      ]),
    ).toBe(false);
  });

  it("blocked_by gates on DONE, not on landed — the merger case", () => {
    // A merger has no branch and can never land; gating on its sha would park
    // its source forever.
    expect(
      isDependencyDeferred([
        {
          relationType: "blocked_by",
          blockerStatus: "done",
          blockerLandedSha: null,
          blockerLandPending: true,
        },
      ]),
    ).toBe(false);
    expect(
      isDependencyDeferred([
        {
          relationType: "blocked_by",
          blockerStatus: "in_progress",
          blockerLandedSha: null,
          blockerLandPending: false,
        },
      ]),
    ).toBe(true);
  });

  it("an unresolvable blocker is treated as open, never as clear", () => {
    expect(
      isDependencyDeferred([
        {
          relationType: "builds_on",
          blockerStatus: null,
          blockerLandedSha: null,
          blockerLandPending: false,
        },
      ]),
    ).toBe(true);
  });

  it("no blocking relations at all is not deferred", () => {
    expect(isDependencyDeferred([])).toBe(false);
  });
});

describe("the rescue record — a pattern of rescues stays visible", () => {
  it("round-trips the count while PRESERVING the original failure text", () => {
    // That text is the real diagnosis (the workflow-scope rejection). Losing it
    // across rescues would leave the operator with nothing to act on.
    const original = "push rejected: … does not carry the `workflow` scope";
    const written = renderRescueRecord({
      rescues: 2,
      maxRescues: 6,
      nowIso: "2026-07-19T22:00:00.000Z",
      original,
    });
    expect(written).toContain("[land-rescue 2/6 @ 2026-07-19T22:00:00.000Z]");
    expect(written).toContain(original);

    const parsed = parseRescueRecord(written);
    expect(parsed.rescues).toBe(2);
    expect(parsed.original).toBe(original);
  });

  it("counts up across successive rescues instead of resetting", () => {
    let record = parseRescueRecord("boom");
    for (let i = 1; i <= 3; i++) {
      const written = renderRescueRecord({
        rescues: record.rescues + 1,
        maxRescues: 6,
        nowIso: "2026-07-19T22:00:00.000Z",
        original: record.original,
      });
      record = parseRescueRecord(written);
      expect(record.rescues).toBe(i);
      expect(record.original).toBe("boom");
    }
  });

  it("reads an un-marked last_error as zero rescues, keeping the text", () => {
    expect(parseRescueRecord("some earlier failure")).toEqual({
      rescues: 0,
      original: "some earlier failure",
    });
    expect(parseRescueRecord(null)).toEqual({ rescues: 0, original: null });
  });
});
