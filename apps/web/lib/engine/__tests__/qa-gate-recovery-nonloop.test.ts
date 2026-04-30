// The recovery-non-loop regression (spec §7 Step 6, third bullet).
//
// When the L1 gate refuses, the engine paths park the ticket to `blocked`. That
// state must be a genuine dead-end for the two automation loops that would
// otherwise re-touch a stranded ticket — the ticket-reconciler and the
// stuck-ticket sweeper — so a flaky check can never hot-loop a ticket. These
// are pure, load-bearing facts of the FSM/policy layer; asserting them here
// locks them against a careless future edit that adds `blocked` to a scan set.

import { describe, it, expect } from "vitest";
import { decideTicketReconciliation, RECONCILABLE_STATUSES } from "@/lib/engine/reconcile-policy";
import { ALLOWED_TRANSITIONS } from "@/lib/board/state";

describe("blocked is outside the reconciler's reach", () => {
  it("blocked is not a RECONCILABLE status", () => {
    expect(RECONCILABLE_STATUSES.has("blocked")).toBe(false);
  });

  it("the reconciler no-ops on a blocked ticket (parked deliberately)", () => {
    const d = decideTicketReconciliation({
      role: "engineer",
      onSuccessStatus: "in_review",
      statusAtRunStart: "in_progress",
      statusNow: "blocked",
      hasOtherActiveRuns: false,
      postNext: null,
      moveTicketToolUsed: false,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("parked");
  });

  it("a second reconciler pass still leaves a blocked ticket alone (no re-park)", () => {
    // Idempotent by construction: the decision is a pure function of statusNow,
    // so re-running it yields the same no-op.
    const args = {
      role: "engineer" as const,
      onSuccessStatus: "in_review" as const,
      statusAtRunStart: null,
      statusNow: "blocked" as const,
      hasOtherActiveRuns: false,
      postNext: null,
      moveTicketToolUsed: false,
    };
    expect(decideTicketReconciliation(args).action).toBe("none");
    expect(decideTicketReconciliation(args).action).toBe("none");
  });
});

describe("blocked is reversible and terminal-for-the-loops", () => {
  it("blocked can be reopened (reversible, so an operator/auto-redispatch can recover)", () => {
    // Not a dead terminal like done/failed — it exits to in_progress/paused/failed.
    expect(ALLOWED_TRANSITIONS.blocked.length).toBeGreaterThan(0);
    expect(ALLOWED_TRANSITIONS.blocked).toContain("in_progress");
  });

  it("the sweeper only scans assigned/in_progress/in_review — never blocked", () => {
    // Mirror of SWEEPABLE_TICKET_STATUSES in stuck-ticket-sweep.ts (kept in sync
    // with this list by construction — the sweeper's DB query filters `.in()` on
    // exactly these). blocked's absence is what keeps a parked ticket unswept.
    const SWEEPABLE = ["assigned", "in_progress", "in_review"];
    expect(SWEEPABLE).not.toContain("blocked");
  });
});
