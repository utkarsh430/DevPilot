// The evidence rule for settling a landed ticket's stale push row.
//
// EVERY ASSERTION HERE IS A DATA-LOSS ASSERTION, not a tidiness one. `pushed_at`
// non-null releases the unpushed-work reap guard (`decideWorkspaceReap`, and the
// runner's own `checkWorkspaceReapSafety`), so a rule that settles one row too
// many is a route to deleting the only copy of a commit. The refusals are the
// feature; the single `settle` arm is the easy part.

import { describe, expect, it } from "vitest";
import { LANDED_SHA_BACKFILL_SENTINEL } from "@/lib/integration/land-policy";
import {
  BACKFILL_SENTINEL,
  decideUnsettledPushRepair,
  describeUnsettledPushRepair,
  type UnsettledPushEvidence,
} from "@/lib/integration/unsettled-push-policy";

/** A row that SHOULD settle. Every test below perturbs exactly one field, so a
 *  green refusal is always attributable to the field it names. */
function landed(over: Partial<UnsettledPushEvidence> = {}): UnsettledPushEvidence {
  return {
    pushId: "push-1",
    pushedAt: null,
    ticketId: "ticket-1",
    landedSha: "abc123",
    hasNothingToLandNotice: false,
    resolvedPushId: "push-1",
    ...over,
  };
}

describe("decideUnsettledPushRepair - the case it exists for", () => {
  it("settles a landed ticket's own unsettled push row", () => {
    const d = decideUnsettledPushRepair(landed());
    expect(d.action).toBe("settle");
  });
});

describe("decideUnsettledPushRepair - THE CONTROL THAT MATTERS", () => {
  // A remediation that acts on everything looks identical to a correct one on a
  // healthy board. This is the assertion that tells them apart: a push row with
  // no landing behind it is ORDINARY - it is in-flight work, it is what the
  // /changes badge counts, and it is what holds the workspace against the
  // reaper. Settling it releases the guard on live, unpushed commits.
  it("refuses a ticket that has NOT landed", () => {
    const d = decideUnsettledPushRepair(landed({ landedSha: null }));
    expect(d).toMatchObject({ action: "stand_down", reason: "not-landed" });
  });

  it("refuses every unlanded row even when everything else lines up", () => {
    for (const via of ["push-1", null]) {
      const d = decideUnsettledPushRepair(landed({ landedSha: null, resolvedPushId: via }));
      expect(d.action).toBe("stand_down");
    }
  });
});

describe("decideUnsettledPushRepair - the sentinel is not a landing", () => {
  // `20260715000000` §6 stamped this over every already-done ticket in one
  // statement: it contacted no remote, resolved no branch, and read no push row.
  // #157 and #158 both excluded it for exactly this reason, and #158 then found
  // that of the four rows it blocked, only ONE was settleable on other evidence.
  it("refuses the 'backfill' sentinel", () => {
    const d = decideUnsettledPushRepair(landed({ landedSha: BACKFILL_SENTINEL }));
    expect(d).toMatchObject({ action: "stand_down", reason: "backfill-sentinel" });
  });

  // Re-declared rather than imported so the policy stays a leaf module. Pinned
  // here so the two can never drift into disagreeing about what the sentinel is.
  it("agrees with land-policy about the sentinel's value", () => {
    expect(BACKFILL_SENTINEL).toBe(LANDED_SHA_BACKFILL_SENTINEL);
  });
});

describe("decideUnsettledPushRepair - nothing-to-land is not proof of a push", () => {
  // PR #137 stamps `landed_sha` for this outcome too, using the BASE TIP, so the
  // sha alone can no longer distinguish "this branch's commits merged" from
  // "this branch had no commits". `deriveLandingState` orders the notice ahead
  // of the sha for the same reason. And this is exactly DevPilot-7's shape: a
  // review-only ticket whose branch may never have reached the remote at all,
  // which #158 could only settle by going and finding a positional witness.
  it("refuses a ticket carrying the nothing-to-land notice", () => {
    const d = decideUnsettledPushRepair(landed({ hasNothingToLandNotice: true }));
    expect(d).toMatchObject({ action: "stand_down", reason: "nothing-to-land" });
  });
});

describe("decideUnsettledPushRepair - only the landing's own row", () => {
  // #156's scope argument, inherited rather than restated: ONE row, by id, never
  // "every unpushed row for this ticket". A ticket carrying a second push on
  // another branch keeps it, and keeps being counted, correctly.
  it("refuses a row the landing did not resolve", () => {
    const d = decideUnsettledPushRepair(landed({ resolvedPushId: "push-2" }));
    expect(d).toMatchObject({ action: "stand_down", reason: "not-the-landings-row" });
  });

  it("refuses when the ticket resolves to no push at all", () => {
    const d = decideUnsettledPushRepair(landed({ resolvedPushId: null }));
    expect(d).toMatchObject({ action: "stand_down", reason: "not-the-landings-row" });
  });
});

describe("decideUnsettledPushRepair - the remaining refusals", () => {
  it("refuses a row somebody already settled", () => {
    const d = decideUnsettledPushRepair(landed({ pushedAt: "2026-08-04T00:00:00.000Z" }));
    expect(d).toMatchObject({ action: "stand_down", reason: "already-settled" });
  });

  // `pending_pushes.ticket_id` is `on delete set null`, so this is reachable.
  // There is no landing that can vouch for such a row.
  it("refuses a row that names no ticket", () => {
    const d = decideUnsettledPushRepair(landed({ ticketId: null }));
    expect(d).toMatchObject({ action: "stand_down", reason: "no-ticket" });
  });
});

describe("describeUnsettledPushRepair", () => {
  const detail = describeUnsettledPushRepair({
    ticketId: "ticket-1",
    pushId: "push-1",
    branch: "devpilot/thing",
    landedSha: "abc123",
    via: "direct",
  });

  // The ledger's whole value is that a reader can tell maintenance from a
  // symptom. A sentence that only said "settled a stale row" would read as
  // housekeeping, which is precisely how the WIP-slot leak stayed invisible.
  it("says the repair is itself a defect signal", () => {
    expect(detail).toMatch(/DEFECT SIGNAL/);
    expect(detail).toMatch(/stampLanded/);
    expect(detail).toMatch(/Find the route/);
  });

  it("names the facts an operator needs to go and look", () => {
    expect(detail).toContain("ticket-1");
    expect(detail).toContain("push-1");
    expect(detail).toContain("devpilot/thing");
    expect(detail).toContain("abc123");
  });

  // A push reached through a merger means the landing route involved a conflict
  // resolution - a materially different route, and the one PR #191 changed.
  it("calls out a row reached through a merger", () => {
    const viaMerger = describeUnsettledPushRepair({
      ticketId: "ticket-1",
      pushId: "push-1",
      branch: "devpilot/thing",
      landedSha: "abc123",
      via: "merger",
    });
    expect(viaMerger).toMatch(/merger/);
    expect(detail).not.toMatch(/merger/);
  });
});
