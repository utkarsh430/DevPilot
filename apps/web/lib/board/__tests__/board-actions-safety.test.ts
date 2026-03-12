// Caller-side coverage for the board server actions that touch the SME safety
// gate. Two properties are pinned here so a refactor can't silently break them:
//   • `moveTicketAction` declares `actor:"human"` to the seam — the ONE actor
//     that may complete a safety-critical ticket. Flip it and the human
//     approval path would itself be gated (or, worse, a non-human value would
//     read as an override). This is the guard the L1 gate's first attempt
//     lacked at the caller boundary.
//   • `setTicketSafetyCriticalAction` writes the flag AND records an attributable
//     `devpilot_safety_gate` audit comment (who armed/disarmed it).
//
// Everything the actions import is mocked; the assertions are about the actions'
// own wiring, not the seam (proven in transitions-safety-gate.test.ts).

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireUser: vi.fn(async () => ({ id: "u1", email: "captain@example.com" })),
  requireTenantId: vi.fn(async () => "tn"),
  transitionTicket: vi.fn(async () => ({ transitioned: true })),
  addComment: vi.fn(async () => {}),
  // Read client (supabaseServer): returns the ticket the action looks up.
  serverTicket: { status: "blocked", tenant_id: "tn" } as { status: string; tenant_id: string },
  // Write client (supabaseService): captures the tickets UPDATE patch.
  updatePatch: null as unknown,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: h.requireUser,
  requireTenantId: h.requireTenantId,
}));
vi.mock("@/lib/board/transitions", () => ({
  transitionTicket: h.transitionTicket,
  addComment: h.addComment,
  // Defined inline: the factory is hoisted above any top-level declaration.
  BlockedByDependencyError: class extends Error {},
}));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: vi.fn(async () => {}) } }));
vi.mock("@/lib/db/server", () => ({
  supabaseServer: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: h.serverTicket, error: null }) }),
      }),
    }),
  }),
  supabaseService: () => ({
    from: () => ({
      update: (patch: unknown) => {
        h.updatePatch = patch;
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
  }),
}));
vi.mock("@/lib/projects/current", () => ({ resolveActiveProjectId: async () => null }));
vi.mock("@/lib/engine/dep-suggest", () => ({ suggestDependencies: async () => [] }));
vi.mock("@/lib/board/topo", () => ({ computePlacementAfterBlockers: async () => null }));
vi.mock("@/lib/runs/first-run.server", () => ({ probeFirstRun: async () => ({}) }));

import { moveTicketAction, setTicketSafetyCriticalAction } from "@/app/(app)/board/actions";

// A syntactically-valid UUID for the zod .uuid() schemas.
const TID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1", email: "captain@example.com" });
  h.requireTenantId.mockResolvedValue("tn");
  h.transitionTicket.mockResolvedValue({ transitioned: true });
  h.serverTicket = { status: "blocked", tenant_id: "tn" };
  h.updatePatch = null;
});

describe("moveTicketAction — the human approval actor", () => {
  it('declares actor:"human" to the seam on a → done move', async () => {
    const res = await moveTicketAction({ ticketId: TID, toStatus: "done" });
    expect(res.ok).toBe(true);
    expect(h.transitionTicket).toHaveBeenCalledTimes(1);
    const arg = (h.transitionTicket.mock.calls as unknown[][])[0]![0] as {
      to: string;
      actor: string;
    };
    expect(arg.to).toBe("done");
    // The refactor-guard: only "human" may complete a safety-critical ticket.
    expect(arg.actor).toBe("human");
  });

  it("uses the blocked → done edge (the parked-approval path is FSM-legal)", async () => {
    // serverTicket.status is "blocked"; canTransition(blocked, done) must hold,
    // or the action would reject before ever reaching the seam.
    const res = await moveTicketAction({ ticketId: TID, toStatus: "done" });
    expect(res.ok).toBe(true);
  });
});

describe("setTicketSafetyCriticalAction — flag write + audit trail", () => {
  it("arms the flag and records an attributable devpilot_safety_gate audit comment", async () => {
    const res = await setTicketSafetyCriticalAction({ ticketId: TID, safetyCritical: true });
    expect(res.ok).toBe(true);
    expect(h.updatePatch).toEqual({ safety_critical: true });

    expect(h.addComment).toHaveBeenCalledTimes(1);
    const c = (h.addComment.mock.calls as unknown[][])[0]![0] as {
      authorType: string;
      authorId: string;
      body: string;
    };
    expect(c.authorType).toBe("system");
    expect(c.authorId).toBe("devpilot_safety_gate");
    // Attributable: records WHO (the comment's created_at is the WHEN).
    expect(c.body).toContain("captain@example.com");
    expect(c.body).toMatch(/armed/i);
  });

  it("records a disarm audit comment when the flag is removed", async () => {
    const res = await setTicketSafetyCriticalAction({ ticketId: TID, safetyCritical: false });
    expect(res.ok).toBe(true);
    expect(h.updatePatch).toEqual({ safety_critical: false });
    const c = (h.addComment.mock.calls as unknown[][])[0]![0] as { authorId: string; body: string };
    expect(c.authorId).toBe("devpilot_safety_gate");
    expect(c.body).toMatch(/removed/i);
  });
});
