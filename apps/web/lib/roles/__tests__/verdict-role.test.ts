// Who owes a verdict — the engine-side stamp, and the backstop it must not weaken.
//
// Two claims live here and they are different in kind:
//
//   • MEMBERSHIP. `VERDICT_ROLES` is DERIVED from the live `ROLES` catalog, so
//     these tests are checking that the derivation matches the property
//     `reconcile-policy.ts` parks on — not that a hand-written list is spelled
//     correctly. Membership is asserted in BOTH directions, because the
//     dangerous error here is INCLUSIVE (a producer told it owes a verdict is a
//     producer invited to approve its own work), which is the opposite of
//     `code-producing.ts`.
//
//   • THE BACKSTOP. The runner-side nudge exists to pre-empt the verdictless
//     park, and the whole design rests on that park still happening when the
//     nudge is ignored or never fires. So the reconciler's decision is asserted
//     here, against exactly the state an ignored nudge leaves behind.

import { describe, expect, it } from "vitest";
import { ROLES, type Role } from "@/lib/roles/index";
import { VERDICT_ROLES, isVerdictRoleConfig } from "@/lib/roles/verdict-role";
import { decideTicketReconciliation } from "@/lib/engine/reconcile-policy";

describe("VERDICT_ROLES", () => {
  it("is exactly the roles whose onSuccessStatus is 'done'", () => {
    // The property `reconcile-policy.ts` keys its `block` branch on. Derived, so
    // this cannot drift; asserted, so a change to the derivation is visible.
    const expected = Object.entries(ROLES)
      .filter(([, c]) => c.onSuccessStatus === "done")
      .map(([slug]) => slug)
      .sort();
    expect([...VERDICT_ROLES].sort()).toEqual(expected);
  });

  it("holds the three reviewer roles the prod evidence implicates", () => {
    // 12 verdictless parks on `scoursh`: qa x11, verifier x1. release_engineer
    // shares the contract and is in scope for the same reason.
    expect([...VERDICT_ROLES].sort()).toEqual(["qa", "release_engineer", "verifier"].sort());
  });

  it("excludes every PRODUCER role — the dangerous direction", () => {
    // An engineer legitimately ends its run without calling devpilot_move_ticket;
    // `applyEngineerPost` advances the ticket for it. A stamp here would invite a
    // producer to approve its own work.
    for (const slug of ["engineer", "frontend_engineer", "fullstack_engineer", "pm", "triage"]) {
      expect(VERDICT_ROLES.has(slug), slug).toBe(false);
    }
  });

  it("leaves the overwhelming majority of the catalog out", () => {
    // A regression that widened this would show up as a jump in the count long
    // before anyone noticed a role behaving oddly.
    expect(VERDICT_ROLES.size).toBeLessThan(Object.keys(ROLES).length / 10);
  });
});

describe("isVerdictRoleConfig", () => {
  it("is true for a verdict role's own config", () => {
    for (const slug of VERDICT_ROLES) {
      expect(isVerdictRoleConfig(ROLES[slug as Role]), slug).toBe(true);
    }
  });

  it("is true for a CUSTOM role whose contract makes 'done' its success state", () => {
    // The reason the predicate takes a CONFIG rather than a slug: a
    // JD-synthesized reviewer cannot appear in any static list, and
    // `loadRoleConfig` resolves it exactly as it resolves a built-in.
    expect(isVerdictRoleConfig({ onSuccessStatus: "done" })).toBe(true);
  });

  it("is false for every non-'done' success state, and for an unresolvable role", () => {
    for (const s of ["in_review", "ready", "in_progress", "blocked", null] as const) {
      expect(isVerdictRoleConfig({ onSuccessStatus: s }), String(s)).toBe(false);
    }
    // A role-less run, or a lookup that failed, must fall back to today's
    // behaviour — never to a nudge we cannot justify.
    expect(isVerdictRoleConfig(null)).toBe(false);
    expect(isVerdictRoleConfig(undefined)).toBe(false);
  });
});

describe("the reconciler stays the backstop when the nudge is ignored", () => {
  // The state an ignored nudge leaves behind, verbatim: the run finished, the
  // reviewer recorded nothing, the ticket never moved. Ticket #90's three runs.
  const ignoredNudge = {
    role: "qa",
    onSuccessStatus: "done",
    statusAtRunStart: "in_review",
    statusNow: "in_review",
    hasOtherActiveRuns: false,
    postNext: "done",
    moveTicketToolUsed: false,
  } as const;

  it("still parks a verdictless review to `blocked`", () => {
    const d = decideTicketReconciliation({ ...ignoredNudge });
    expect(d.action).toBe("block");
    expect(d.action === "block" && d.reason).toMatch(/without recording a verdict/);
  });

  it("parks the in_progress variant too", () => {
    const d = decideTicketReconciliation({
      ...ignoredNudge,
      statusAtRunStart: "in_progress",
      statusNow: "in_progress",
    });
    expect(d.action).toBe("block");
  });

  it("stands down once a verdict HAS been recorded — the nudge's success path", () => {
    // A nudge that worked makes `moveTicketToolUsed` true by the time the
    // reconciler looks, so the park it would have performed simply never arises.
    // This is the only behavioural change the seam produces on this side.
    const d = decideTicketReconciliation({ ...ignoredNudge, moveTicketToolUsed: true });
    expect(d.action).toBe("none");
  });

  it("stands down when the reviewer escalated instead — input_required is not reconcilable", () => {
    // Why `devpilot_request_human` counts as a recorded outcome on the runner
    // side: the reconciler already treats the state it produces as parked.
    const d = decideTicketReconciliation({ ...ignoredNudge, statusNow: "input_required" });
    expect(d.action).toBe("none");
  });
});
