// The scaffolder seed/hold/rooting policy. Each test here pins a property the
// design depends on, not just a branch:
//
//   • A no-plan create is UNCHANGED (ready + dispatch). This is the path every
//     existing project took; a regression here is a silently un-scaffolded repo.
//   • A plan create is HELD and not dispatched. This is the feature.
//   • The rooting is transitive-minimal and never self-edges.
//   • The hold TTL cannot be switched off by a malformed env value - the
//     fallback it drives IS the empty-repo guarantee.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCAFFOLDER_HOLD_TTL_MINUTES,
  decidePlanHoldGate,
  decideScaffolderSeed,
  isRootableScaffolder,
  isScaffolderRole,
  planScaffolderRooting,
  resolveScaffolderHoldTtlMinutes,
} from "@/lib/plan/scaffolder";

describe("decideScaffolderSeed", () => {
  it("fires immediately when there is no plan (today's behaviour, byte-for-byte)", () => {
    expect(decideScaffolderSeed({ generatePlan: false })).toEqual({
      status: "ready",
      planHold: false,
      dispatchNow: true,
      scheduleFallback: false,
    });
  });

  it("holds the row in backlog and does NOT dispatch when a plan was requested", () => {
    const seed = decideScaffolderSeed({ generatePlan: true });
    expect(seed.status).toBe("backlog");
    expect(seed.dispatchNow).toBe(false);
  });

  it("marks a held row with the durable plan_hold identity, and only a held row", () => {
    // `status === "backlog"` is a SHAPE that a released-then-reset row also
    // wears; plan_hold is the identity every release path claims on.
    expect(decideScaffolderSeed({ generatePlan: true }).planHold).toBe(true);
    expect(decideScaffolderSeed({ generatePlan: false }).planHold).toBe(false);
  });

  it("arms the abandonment fallback for a held row, and only for a held row", () => {
    expect(decideScaffolderSeed({ generatePlan: true }).scheduleFallback).toBe(true);
    expect(decideScaffolderSeed({ generatePlan: false }).scheduleFallback).toBe(false);
  });
});

describe("resolveScaffolderHoldTtlMinutes", () => {
  it("defaults when unset", () => {
    expect(resolveScaffolderHoldTtlMinutes(undefined)).toBe(DEFAULT_SCAFFOLDER_HOLD_TTL_MINUTES);
  });

  it("honours a configured value", () => {
    expect(resolveScaffolderHoldTtlMinutes("15")).toBe(15);
    expect(resolveScaffolderHoldTtlMinutes("120.9")).toBe(120);
  });

  it("falls back rather than disabling the guarantee on a malformed value", () => {
    for (const raw of ["", "soon", "0", "-5", "NaN"]) {
      expect(resolveScaffolderHoldTtlMinutes(raw)).toBe(DEFAULT_SCAFFOLDER_HOLD_TTL_MINUTES);
    }
  });
});

describe("planScaffolderRooting", () => {
  const SCAFFOLDER = "scaffolder-1";

  it("roots every plan ROOT on the scaffolder with a builds_on edge", () => {
    const rows = planScaffolderRooting({
      scaffolderTicketId: SCAFFOLDER,
      committed: [
        { ticketId: "a", blockedBy: [] },
        { ticketId: "b", blockedBy: [] },
      ],
    });
    expect(rows).toEqual([
      { ticket_id: "a", blocks_ticket_id: SCAFFOLDER, relation_type: "builds_on" },
      { ticket_id: "b", blocks_ticket_id: SCAFFOLDER, relation_type: "builds_on" },
    ]);
  });

  it("skips a ticket that already has a blocker - it reaches the scaffolder transitively", () => {
    const rows = planScaffolderRooting({
      scaffolderTicketId: SCAFFOLDER,
      committed: [
        { ticketId: "a", blockedBy: [] },
        { ticketId: "b", blockedBy: ["a"] },
        { ticketId: "c", blockedBy: ["a", "b"] },
      ],
    });
    expect(rows.map((r) => r.ticket_id)).toEqual(["a"]);
  });

  it("never roots the scaffolder on itself", () => {
    const rows = planScaffolderRooting({
      scaffolderTicketId: SCAFFOLDER,
      committed: [{ ticketId: SCAFFOLDER, blockedBy: [] }],
    });
    expect(rows).toEqual([]);
  });

  it("returns nothing for an empty commit", () => {
    expect(planScaffolderRooting({ scaffolderTicketId: SCAFFOLDER, committed: [] })).toEqual([]);
  });
});

describe("decidePlanHoldGate", () => {
  it("refuses promoting a held scaffolder to ready", () => {
    const d = decidePlanHoldGate({ to: "ready", planHold: true });
    expect(d.allow).toBe(false);
    // The refusal has to tell the operator what WILL run it, or a card that
    // won't move is just broken software.
    expect(!d.allow && d.reason).toMatch(/commit the plan/);
  });

  it("is actor-agnostic: the drain's force-promote is refused too", () => {
    // The backlog drain force-promotes the backlog head when nothing else is
    // eligible, through this same seam, knowing nothing about plans.
    expect(decidePlanHoldGate({ to: "ready", planHold: true }).allow).toBe(false);
  });

  it("allows every other move of a held row", () => {
    // The hold is about not STARTING it early, not about freezing the card.
    for (const to of ["blocked", "paused", "in_progress", "backlog"]) {
      expect(decidePlanHoldGate({ to, planHold: true }).allow).toBe(true);
    }
  });

  it("allows `→ ready` once the hold is cleared", () => {
    // Cleared by the release. From here on the ticket is an ordinary one.
    expect(decidePlanHoldGate({ to: "ready", planHold: false }).allow).toBe(true);
  });
});

describe("isScaffolderRole / isRootableScaffolder", () => {
  it("recognises the scaffolder slug and nothing else", () => {
    expect(isScaffolderRole("project_scaffolder")).toBe(true);
    for (const other of ["engineer", "qa", null, undefined, ""]) {
      expect(isScaffolderRole(other)).toBe(false);
    }
  });

  it("roots on any scaffolder except a failed one", () => {
    // A `builds_on` edge to a failed ticket never closes - it would silently
    // wedge the whole committed backlog behind a dead ticket.
    expect(isRootableScaffolder("failed")).toBe(false);
    for (const s of ["backlog", "ready", "in_progress", "in_review", "done", "blocked"]) {
      expect(isRootableScaffolder(s)).toBe(true);
    }
  });
});
