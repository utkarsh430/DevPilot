// `moveTicketAction` is a COMPARE-AND-SET, and refuses a held scaffolder.
//
// The bug this pins shut: the action read the ticket's status, validated the FSM
// edge, then round-tripped to the DB for the blocker summary before writing -
// and the write matched on `id` alone, with the dispatch fired unconditionally.
// Anything that moved the ticket inside that window (a plan-commit scaffolder
// release, an agent, another operator) got a second dispatch stacked on top of
// its own, from a decision made against a status that no longer held.
//
// For the scaffolder that is the #79 failure exactly: two agents authoring the
// first commit of one genuinely-empty repo.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** The status `moveTicketAction`'s own read sees. */
  currentStatus: "backlog" as string,
  transitionTicket: vi.fn(
    async (_a: unknown): Promise<{ transitioned: boolean }> => ({ transitioned: true }),
  ),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "u1" }),
  requireTenantId: async () => "tn",
}));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: vi.fn(async () => {}) } }));
// Classes defined INLINE in the factory (it is hoisted above any top-level
// declaration, and the real module reaches Next server APIs so it can't be
// imported here). The action narrows with `instanceof`, and it resolves the
// class through this same mock, so the narrowing under test is real. The
// genuine PlanHoldError is exercised against the real seam in
// transitions-plan-hold.test.ts.
vi.mock("@/lib/board/transitions", () => ({
  BlockedByDependencyError: class extends Error {},
  PlanHoldError: class PlanHoldError extends Error {},
  transitionTicket: h.transitionTicket,
  addComment: vi.fn(async () => {}),
}));
// Everything else board/actions.ts pulls in at module scope (it is a "use
// server" file, so its whole import graph loads even for one action).
vi.mock("@/lib/projects/current", () => ({ resolveActiveProjectId: async () => null }));
vi.mock("@/lib/engine/dep-suggest", () => ({ suggestDependencies: async () => [] }));
vi.mock("@/lib/board/topo", () => ({ computePlacementAfterBlockers: async () => null }));
vi.mock("@/lib/runs/first-run.server", () => ({ probeFirstRun: async () => ({}) }));
vi.mock("@/lib/board/create-ticket", () => ({
  createTicketCore: async () => ({ ok: true }),
  loadAndSuggestDeps: async () => [],
}));
vi.mock("@/lib/db/server", () => ({
  supabaseServer: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { status: h.currentStatus, tenant_id: "tn" },
            error: null,
          }),
        }),
      }),
    }),
  }),
  supabaseService: () => ({}),
}));

import { moveTicketAction } from "@/app/(app)/board/actions";
import { PlanHoldError } from "@/lib/board/transitions";

const TICKET = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  h.currentStatus = "backlog";
  h.transitionTicket.mockResolvedValue({ transitioned: true });
});

describe("moveTicketAction - compare-and-set", () => {
  it("passes the status it validated as expectedFrom, so the write is a CAS", async () => {
    const res = await moveTicketAction({ ticketId: TICKET, toStatus: "ready" });

    expect(res.ok).toBe(true);
    expect(h.transitionTicket).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: TICKET, to: "ready", expectedFrom: "backlog" }),
    );
  });

  it("keeps the human actor (the operator override is unchanged)", async () => {
    await moveTicketAction({ ticketId: TICKET, toStatus: "ready" });
    expect(h.transitionTicket).toHaveBeenCalledWith(expect.objectContaining({ actor: "human" }));
  });

  it("reports a lost CAS instead of pretending the move happened", async () => {
    // The scaffolder release (or an agent) moved the ticket during the read →
    // blocker-check → write window. The seam wrote nothing and dispatched
    // nothing; the operator gets told to refresh rather than a false success.
    h.transitionTicket.mockResolvedValue({ transitioned: false });

    const res = await moveTicketAction({ ticketId: TICKET, toStatus: "ready" });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/changed status/i);
  });

  it("surfaces the plan-hold refusal as the operator-readable reason", async () => {
    h.transitionTicket.mockRejectedValue(
      new PlanHoldError("this project's scaffolder is held for its pending plan - commit the plan"),
    );

    const res = await moveTicketAction({ ticketId: TICKET, toStatus: "ready" });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/commit the plan/);
  });
});
