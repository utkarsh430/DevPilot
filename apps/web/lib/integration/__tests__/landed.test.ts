// WI-5 — the landed readiness predicate.
//
// The two failure modes these tests exist to prevent are opposites, and both are
// catastrophic:
//
//   • too LOOSE (`status === "done"`): a dependent starts while its parent's
//     work is still only on a feature branch, and builds on a dev tip that does
//     not contain it.
//   • too TIGHT (`landed_sha IS NOT NULL`): every dependent of every ticket that
//     never produces a branch — PM, design, research, and every auto-spawned
//     merger — is wedged out of `ready` forever.

import { describe, expect, it } from "vitest";
import {
  classifyBlocker,
  humanMayOverride,
  isBlockerOpen,
  isResolvableSha,
  summarizeBlockers,
  type BlockerLandState,
} from "@/lib/integration/landed";

const blocker = (over: Partial<BlockerLandState> = {}): BlockerLandState => ({
  status: "done",
  landedSha: null,
  landPending: false,
  ...over,
});

describe("classifyBlocker", () => {
  it("landed → closed", () => {
    expect(classifyBlocker(blocker({ status: "done", landedSha: "abc1234" }))).toBe("closed");
  });

  it("not done → working (unchanged from the legacy rule)", () => {
    expect(classifyBlocker(blocker({ status: "in_progress" }))).toBe("working");
    expect(classifyBlocker(blocker({ status: "in_review" }))).toBe("working");
    expect(classifyBlocker(blocker({ status: "blocked" }))).toBe("working");
    expect(classifyBlocker(blocker({ status: "backlog" }))).toBe("working");
  });

  it("done + unlanded + a landing owed → awaiting_land (THE new state)", () => {
    expect(classifyBlocker(blocker({ status: "done", landPending: true }))).toBe("awaiting_land");
  });

  it("done + unlanded + NOTHING owed → closed", () => {
    // The case that keeps the ~48 non-code roles (and every merger ticket) from
    // wedging their dependents forever. `landed_sha IS NOT NULL` alone would call
    // this OPEN, and nothing would ever close it.
    expect(classifyBlocker(blocker({ status: "done", landPending: false }))).toBe("closed");
  });

  it("a landed ticket stays closed even if its status was later reverted", () => {
    // The work is on dev. Reverting the ticket's status doesn't take it off dev,
    // so the dependent is not un-unblocked.
    expect(classifyBlocker(blocker({ status: "in_progress", landedSha: "deadbee" }))).toBe(
      "closed",
    );
  });

  it("auto-land OFF derives the exact legacy semantics with no special-casing", () => {
    // A project with auto_land_enabled = false never writes a queue row, so
    // landPending is always false and `open ⟺ not done` falls out on its own.
    expect(isBlockerOpen(blocker({ status: "done", landPending: false }))).toBe(false);
    expect(isBlockerOpen(blocker({ status: "in_progress", landPending: false }))).toBe(true);
  });
});

describe("summarizeBlockers", () => {
  it("counts open blockers by WHY they are open", () => {
    const s = summarizeBlockers([
      blocker({ status: "done", landedSha: "aaa1111" }), // closed
      blocker({ status: "done", landPending: true }), // awaiting_land
      blocker({ status: "in_progress" }), // working
    ]);
    expect(s).toEqual({ open: 2, working: 1, awaitingLand: 1, onlyAwaitingLand: false });
  });

  it("onlyAwaitingLand iff every OPEN blocker is merely awaiting its landing", () => {
    const s = summarizeBlockers([
      blocker({ status: "done", landedSha: "aaa1111" }),
      blocker({ status: "done", landPending: true }),
    ]);
    expect(s.onlyAwaitingLand).toBe(true);
  });

  it("is not onlyAwaitingLand when nothing is open at all", () => {
    const s = summarizeBlockers([blocker({ status: "done", landedSha: "aaa1111" })]);
    expect(s.open).toBe(0);
    expect(s.onlyAwaitingLand).toBe(false);
  });

  it("no blockers → nothing open", () => {
    expect(summarizeBlockers([])).toEqual({
      open: 0,
      working: 0,
      awaitingLand: 0,
      onlyAwaitingLand: false,
    });
  });
});

describe("humanMayOverride", () => {
  it("lets a human past a blocker that is done and merely awaiting its landing", () => {
    // WI-5 must not TAKE something away from operators: a done blocker has never
    // blocked a human move, and after the re-gate a done-but-unlanded one would.
    const s = summarizeBlockers([blocker({ status: "done", landPending: true })]);
    expect(humanMayOverride(s)).toBe(true);
  });

  it("does NOT let a human past a blocker that is still being worked", () => {
    // Unchanged from today: the `→ ready` guard has always refused this, for
    // humans and agents alike.
    const s = summarizeBlockers([blocker({ status: "in_progress" })]);
    expect(humanMayOverride(s)).toBe(false);
  });

  it("does NOT override when even ONE open blocker is still working", () => {
    const s = summarizeBlockers([
      blocker({ status: "done", landPending: true }),
      blocker({ status: "in_progress" }),
    ]);
    expect(humanMayOverride(s)).toBe(false);
  });
});

describe("isResolvableSha", () => {
  it("accepts a git object name", () => {
    expect(isResolvableSha("a1b2c3d")).toBe(true);
    expect(isResolvableSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });

  it("rejects the migration's `backfill` sentinel", () => {
    // Historical done tickets are stamped `backfill` — their real sha is
    // unknowable. A builds_on child of one must root at the integration TIP (which
    // already contains that work), not ask git to check out a ref that isn't one.
    expect(isResolvableSha("backfill")).toBe(false);
  });

  it("rejects null / empty / non-hex", () => {
    expect(isResolvableSha(null)).toBe(false);
    expect(isResolvableSha(undefined)).toBe(false);
    expect(isResolvableSha("")).toBe(false);
    expect(isResolvableSha("not-a-sha")).toBe(false);
    expect(isResolvableSha("HEAD")).toBe(false);
  });
});
