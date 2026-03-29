// Route-level coverage for the MCP `devpilot_move_ticket` handler
// (`app/api/runners/tools/move-ticket/route.ts`) — the ONE non-human path that
// reaches `done`. Everything the route touches is mocked; the assertions are
// about the ROUTE's own behaviour: what actor it declares to the seam, and how
// it recovers from an SME safety refusal (park to blocked, 200 not 422,
// `devpilot_safety_gate` author). The seam's decision itself is proven separately in
// `transitions-safety-gate.test.ts`.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GateRefusal } from "@/lib/board/transitions";

const h = vi.hoisted(() => ({
  authOk: { ok: true } as { ok: boolean; reason?: string },
  ticketRow: null as unknown,
  transitionTicket: vi.fn(),
  addComment: vi.fn(async () => {}),
  inngestSend: vi.fn(async () => {}),
}));

vi.mock("@/lib/runners/auth", () => ({ checkRunnerAuth: () => h.authOk }));
vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: h.ticketRow,
            error: h.ticketRow ? null : { message: "nf" },
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/board/transitions", () => ({
  transitionTicket: h.transitionTicket,
  addComment: h.addComment,
}));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: h.inngestSend } }));

import { POST } from "@/app/api/runners/tools/move-ticket/route";

function req(body: unknown): Request {
  return new Request("http://t/api/runners/tools/move-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SAFETY_REFUSAL: GateRefusal = {
  code: "safety_approval_required",
  reason: "safety-critical: requires human approval before Done.",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.authOk = { ok: true };
  h.ticketRow = { id: "t1", tenant_id: "tn", status: "in_review", retry_count: 0 };
  h.transitionTicket.mockReset();
});

describe("move-ticket route — SME safety refusal recovery (agent → done)", () => {
  beforeEach(() => {
    // First call is the agent → done attempt (refused); the route's recovery
    // then calls transitionTicket again to park to blocked (succeeds).
    h.transitionTicket.mockImplementation(async (input: { to: string }) => {
      if (input.to === "blocked") return { transitioned: true };
      return { transitioned: false, gateRefusal: SAFETY_REFUSAL };
    });
  });

  it('declares actor:"agent" to the seam on the completion attempt', async () => {
    await POST(req({ ticketId: "t1", status: "done", runId: "run-1" }));
    const firstCall = (h.transitionTicket.mock.calls as unknown[][])[0]![0] as {
      to: string;
      actor: string;
      runId?: string;
    };
    expect(firstCall.to).toBe("done");
    // The refactor-guard: if someone flips this to "human"/"system" the gate is
    // bypassed / mis-driven. Pin it.
    expect(firstCall.actor).toBe("agent");
    expect(firstCall.runId).toBe("run-1");
  });

  it("parks to blocked and returns 200 {parked, requiresHumanApproval} — NOT 422", async () => {
    const res = await POST(req({ ticketId: "t1", status: "done", runId: "run-1" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.parked).toBe(true);
    expect(json.requiresHumanApproval).toBe(true);
    expect(json.status).toBe("blocked");
    expect(json.code).toBe("safety_approval_required");

    // The park move: to blocked, system-authored, dispatch suppressed.
    const parkCall = (h.transitionTicket.mock.calls as unknown[][]).find(
      (c) => (c[0] as { to: string }).to === "blocked",
    );
    expect(parkCall).toBeDefined();
    const park = parkCall![0] as { actor: string; emitDispatch: boolean };
    expect(park.actor).toBe("system");
    expect(park.emitDispatch).toBe(false);
  });

  it("audits the refusal under `devpilot_safety_gate`, never `devpilot_move_ticket`", async () => {
    await POST(req({ ticketId: "t1", status: "done", runId: "run-1" }));
    const authors = (h.addComment.mock.calls as unknown[][]).map(
      (c) => (c[0] as { authorId: string }).authorId,
    );
    expect(authors).toContain("devpilot_safety_gate");
    // A refusal must NOT be stamped as a verdict — the reconciler reads an
    // `devpilot_move_ticket` comment after run start as "the role rendered its verdict".
    expect(authors).not.toContain("devpilot_move_ticket");
  });
});

describe("move-ticket route — non-safety completion is unaffected", () => {
  it('passes actor:"agent" and returns the normal 200 done payload', async () => {
    h.transitionTicket.mockResolvedValue({ transitioned: true });
    const res = await POST(req({ ticketId: "t1", status: "done", runId: "run-1" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.parked).toBeUndefined();
    expect(json.status).toBe("done");
    expect(((h.transitionTicket.mock.calls as unknown[][])[0]![0] as { actor: string }).actor).toBe(
      "agent",
    );
  });
});
