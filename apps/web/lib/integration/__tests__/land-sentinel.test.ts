// The sentinel-bypass rule for the operator "Land now" action, proved on the
// pure `decideLandedShaGate`. The ONE property that must hold: a backfilled
// ticket (`landed_sha = 'backfill'`) is enqueueable under the EXPLICIT operator
// path (`force: true`) but NOT under the auto path (`force: false`), and a
// GENUINELY landed ticket (a real sha) is never re-landed either way.

import { describe, it, expect } from "vitest";
import { decideLandedShaGate, LANDED_SHA_BACKFILL_SENTINEL } from "@/lib/integration/land-policy";

describe("decideLandedShaGate — nothing landed yet", () => {
  it("proceeds when landed_sha is null (auto path)", () => {
    expect(decideLandedShaGate({ landedSha: null, force: false })).toEqual({ action: "proceed" });
  });
  it("proceeds when landed_sha is null (operator path)", () => {
    expect(decideLandedShaGate({ landedSha: null, force: true })).toEqual({ action: "proceed" });
  });
});

describe("decideLandedShaGate — the backfill sentinel", () => {
  it("reads as already-landed under the AUTO path (force:false) — never auto-enqueues", () => {
    expect(decideLandedShaGate({ landedSha: LANDED_SHA_BACKFILL_SENTINEL, force: false })).toEqual({
      action: "already_landed",
    });
  });

  it("is cleared and landed under the OPERATOR path (force:true)", () => {
    expect(decideLandedShaGate({ landedSha: LANDED_SHA_BACKFILL_SENTINEL, force: true })).toEqual({
      action: "clear_sentinel_and_land",
    });
  });

  it("uses the literal the migration stamps", () => {
    // Guards against the constant drifting away from the migration's value.
    expect(LANDED_SHA_BACKFILL_SENTINEL).toBe("backfill");
  });
});

describe("decideLandedShaGate — a genuinely landed ticket is never re-landed", () => {
  const realSha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

  it("stays already-landed under the auto path", () => {
    expect(decideLandedShaGate({ landedSha: realSha, force: false })).toEqual({
      action: "already_landed",
    });
  });

  it("stays already-landed even under the operator force path", () => {
    // force only sees through the BACKFILL sentinel — a real landing is real.
    expect(decideLandedShaGate({ landedSha: realSha, force: true })).toEqual({
      action: "already_landed",
    });
  });
});
