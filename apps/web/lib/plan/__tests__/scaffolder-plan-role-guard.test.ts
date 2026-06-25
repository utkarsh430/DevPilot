// The plan flow may never file a scaffolder - the edit route half.
//
// `project_scaffolder` is a full catalog slug, so `ROLE_SLUG_SET.has(...)` -
// which is all this route used to check - accepts it happily. An operator (or
// anyone driving the action) could set a proposed ticket's role to the
// scaffolder, and the commit would then file a SECOND scaffolder row. The commit
// clamps the planner-proposed case silently (there is nobody to tell); a
// deliberate edit is REFUSED with a reason, because a field that quietly ignores
// what you typed is worse than one that explains itself.
//
// Also covered: discarding a plan RELEASES the held scaffolder. That is the
// human-driven release path, and it is what keeps the empty-repo guarantee off
// the fallback's best-effort `inngest.send` now that a held row can't be
// promoted by hand.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  updated: [] as Record<string, unknown>[],
  /** Rows the discard's guarded session UPDATE matches. */
  discardMatches: [{ id: "sess", project_id: "proj-1" }] as Array<Record<string, unknown>>,
  findHeld: vi.fn(
    async (_a: unknown) => ({ ticketId: "scaffolder-1" }) as { ticketId: string } | null,
  ),
  release: vi.fn(async (_a: unknown) => ({ released: true as const, ticketId: "scaffolder-1" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "u1" }),
  requireTenantId: async () => "tn",
}));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: async () => {} } }));
vi.mock("@/lib/engine/budget", () => ({ assertCanProceedPlan: async () => {} }));
vi.mock("@/lib/plan/scaffolder-release.server", () => ({
  findHeldScaffolder: h.findHeld,
  findScaffolderToRootOn: async () => null,
  releaseScaffolder: h.release,
}));
vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        h.updated.push({ table, ...patch });
        const node: Record<string, unknown> = {
          is: () => node,
          not: () => node,
          select: async () => ({
            data: table === "planning_sessions" ? h.discardMatches : [{ id: "x" }],
            error: null,
          }),
        };
        node.eq = () => node;
        return node;
      },
    }),
  }),
}));

import { discardPlanSessionAction, updateProposedTicketAction } from "@/app/(app)/plan/actions";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PROPOSED = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  h.updated = [];
  h.discardMatches = [{ id: "sess", project_id: "proj-1" }];
  h.findHeld.mockResolvedValue({ ticketId: "scaffolder-1" });
  h.release.mockResolvedValue({ released: true, ticketId: "scaffolder-1" });
});

describe("updateProposedTicketAction - the scaffolder role is refused", () => {
  it("refuses an edit that sets requested_role to the scaffolder", async () => {
    const res = await updateProposedTicketAction({
      proposedTicketId: PROPOSED,
      patch: { requested_role: "project_scaffolder" },
    });

    expect(res.ok).toBe(false);
    // Told, not silently clamped - and told what actually files it.
    expect(!res.ok && res.error).toMatch(/project creation/i);
    expect(h.updated).toEqual([]);
  });

  it("still accepts every other catalog role", async () => {
    const res = await updateProposedTicketAction({
      proposedTicketId: PROPOSED,
      patch: { requested_role: "engineer" },
    });
    expect(res.ok).toBe(true);
  });

  it("still rejects an unknown slug (the pre-existing guard is intact)", async () => {
    const res = await updateProposedTicketAction({
      proposedTicketId: PROPOSED,
      patch: { requested_role: "not_a_role" },
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/unknown role slug/);
  });
});

describe("discardPlanSessionAction - releases the held scaffolder", () => {
  it("releases it with BASE context, immediately", async () => {
    const res = await discardPlanSessionAction({ sessionId: SESSION });

    expect(res.ok).toBe(true);
    expect(h.release).toHaveBeenCalledWith({
      tenantId: "tn",
      ticketId: "scaffolder-1",
      // No plan was committed, so there is nothing confirmed to carry.
      planSessionId: null,
      via: "plan-discard",
    });
  });

  it("does nothing when the project has no held scaffolder", async () => {
    h.findHeld.mockResolvedValue(null);
    const res = await discardPlanSessionAction({ sessionId: SESSION });
    expect(res.ok).toBe(true);
    expect(h.release).not.toHaveBeenCalled();
  });

  it("does not release when the discard itself was refused", async () => {
    // Already committed/discarded, or wrong tenant. Nothing happened, so
    // nothing should be released off the back of it.
    h.discardMatches = [];
    const res = await discardPlanSessionAction({ sessionId: SESSION });
    expect(res.ok).toBe(false);
    expect(h.release).not.toHaveBeenCalled();
  });

  it("does not fail the discard when the release throws", async () => {
    h.findHeld.mockRejectedValue(new Error("db down"));
    const res = await discardPlanSessionAction({ sessionId: SESSION });
    // The session IS discarded, and the TTL fallback still covers the release.
    expect(res.ok).toBe(true);
  });
});
