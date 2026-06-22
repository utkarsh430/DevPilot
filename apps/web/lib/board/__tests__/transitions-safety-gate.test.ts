// Integration coverage for the SME safety gate embedded in the REAL
// `transitionTicket` seam (`lib/board/transitions.ts`) — the single choke point
// EVERY `→ done` path flows through (the MCP `devpilot_move_ticket` route, the board
// human move; the reconciler/aggregator/scheduler never target `done`). The DB
// is the only mocked surface; the transition logic under test is the shipping
// code.
//
// This proves the safety property directly on the seam, so it holds for ANY
// non-human caller — current or future — not just the one route wired up today:
//   • agent  → done on a safety-critical ticket is REFUSED, nothing mutates.
//   • system → done on a safety-critical ticket is REFUSED, nothing mutates.
//   • human  → done on a safety-critical ticket SUCCEEDS (the approval).
//   • a NON-safety-critical ticket is entirely unaffected, every actor.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VerificationRecord } from "@/lib/board/qa-gate";

const h = vi.hoisted(() => ({
  supabaseRef: { current: null as unknown },
  inngestSend: vi.fn(async () => {}),
  loadRunVerification: vi.fn(async (): Promise<VerificationRecord | null> => null),
}));

vi.mock("@/lib/db/server", () => ({ supabaseService: () => h.supabaseRef.current }));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: h.inngestSend } }));
vi.mock("@/lib/board/qa-gate.server", () => ({
  loadRunVerification: h.loadRunVerification,
  // B2 — the gate now also resolves the run's role (for the code-producing
  // question). These suites predate that axis; null keeps them on the
  // permissive pre-B2 behaviour they were written against.
  loadRunRole: async () => null,
  loadCohortGateRefusal: async () => null,
}));
vi.mock("@/lib/board/dependencies", () => ({
  BLOCKING_RELATION_TYPES: ["blocked_by", "builds_on"] as const,
  loadBlockersService: async () => [],
  hasOpenBlockers: async () => false,
}));
vi.mock("@/lib/engine/dispatch-queue", () => ({ cancelPendingForTicket: async () => {} }));

import { transitionTicket } from "@/lib/board/transitions";
import { makeFakeSupabase, type FakeSupabase } from "./_fake-supabase";

let fake: FakeSupabase;

beforeEach(() => {
  vi.clearAllMocks();
  h.loadRunVerification.mockResolvedValue(null);
  // The QA gate is default-off, so it never interferes with these done moves;
  // the safety gate must hold on its own regardless of that flag.
  delete process.env.ENGINEER_QA_GATE_ENABLED;
  fake = makeFakeSupabase({
    sc: { status: "in_review", retry_count: 0, safety_critical: true },
    plain: { status: "in_review", retry_count: 0, safety_critical: false },
    scProg: { status: "in_progress", retry_count: 0, safety_critical: true },
    scBlocked: { status: "blocked", retry_count: 0, safety_critical: true },
  });
  h.supabaseRef.current = fake.client;
});

describe("transitionTicket safety gate — non-human → done is refused, nothing mutates", () => {
  it("refuses an agent → done on a safety-critical ticket (the QA/verifier path)", async () => {
    const res = await transitionTicket({
      ticketId: "sc",
      tenantId: "tn",
      to: "done",
      actor: "agent",
      runId: "run-1",
    });
    expect(res.transitioned).toBe(false);
    expect(res.gateRefusal?.code).toBe("safety_approval_required");
    // The seam mutated NOTHING: status unchanged, no dispatch/terminal cleanup.
    expect(fake.tickets.get("sc")!.status).toBe("in_review");
    expect(h.inngestSend).not.toHaveBeenCalled();
  });

  it("refuses a system → done on a safety-critical ticket (any engine path)", async () => {
    const res = await transitionTicket({
      ticketId: "sc",
      tenantId: "tn",
      to: "done",
      actor: "system",
    });
    expect(res.transitioned).toBe(false);
    expect(res.gateRefusal?.code).toBe("safety_approval_required");
    expect(fake.tickets.get("sc")!.status).toBe("in_review");
  });

  it("refuses an agent → done from in_progress too (source state is irrelevant)", async () => {
    const res = await transitionTicket({
      ticketId: "scProg",
      tenantId: "tn",
      to: "done",
      actor: "agent",
    });
    expect(res.transitioned).toBe(false);
    expect(res.gateRefusal?.code).toBe("safety_approval_required");
    expect(fake.tickets.get("scProg")!.status).toBe("in_progress");
  });

  // A parked safety-critical ticket sits in `blocked`. `blocked → done` is a
  // legal FSM edge (added for the human approval), so a non-human attempting to
  // complete it FROM blocked reaches the safety gate — it must still be refused,
  // or the very state the gate parks tickets into would be an escape hatch.
  it("refuses an agent → done FROM the blocked (parked) state", async () => {
    const res = await transitionTicket({
      ticketId: "scBlocked",
      tenantId: "tn",
      to: "done",
      actor: "agent",
    });
    expect(res.transitioned).toBe(false);
    expect(res.gateRefusal?.code).toBe("safety_approval_required");
    expect(fake.tickets.get("scBlocked")!.status).toBe("blocked");
  });

  it("refuses a system → done FROM the blocked (parked) state", async () => {
    const res = await transitionTicket({
      ticketId: "scBlocked",
      tenantId: "tn",
      to: "done",
      actor: "system",
    });
    expect(res.transitioned).toBe(false);
    expect(res.gateRefusal?.code).toBe("safety_approval_required");
    expect(fake.tickets.get("scBlocked")!.status).toBe("blocked");
  });
});

describe("transitionTicket safety gate — the flag is actually read from the row", () => {
  // Guards against a silent fail-open: if the seam's ticket SELECT ever drops
  // `safety_critical`, the fake returns a row without it (mirroring Postgres),
  // the gate reads `undefined` → false → ALLOW, and every refusal test above
  // flips green-to-broken. This test names that dependency directly.
  it("selects `safety_critical` in the ticket read", async () => {
    await transitionTicket({ ticketId: "sc", tenantId: "tn", to: "done", actor: "agent" });
    expect(fake.lastTicketSelect).toContain("safety_critical");
  });

  it("fail-opens ONLY because the column is present — a dropped column would allow", async () => {
    // Positive control: with the column selected and true, the move is refused.
    const refused = await transitionTicket({
      ticketId: "sc",
      tenantId: "tn",
      to: "done",
      actor: "agent",
    });
    expect(refused.transitioned).toBe(false);
    // And the read that produced that decision did request the column.
    expect(fake.lastTicketSelect).toContain("safety_critical");
  });
});

describe("transitionTicket safety gate — the human approval completes it", () => {
  it("ALLOWS a human → done on a safety-critical ticket (board approval)", async () => {
    const res = await transitionTicket({
      ticketId: "sc",
      tenantId: "tn",
      to: "done",
      actor: "human",
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("sc")!.status).toBe("done");
  });

  it("ALLOWS a human → done from a parked (blocked) safety-critical ticket", async () => {
    // This is the real approval flow: the gate parks to blocked, the captain
    // approves from there. Requires the blocked → done FSM edge to exist.
    const res = await transitionTicket({
      ticketId: "scBlocked",
      tenantId: "tn",
      to: "done",
      actor: "human",
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("scBlocked")!.status).toBe("done");
  });
});

describe("transitionTicket safety gate — non-safety tickets are unaffected", () => {
  it("ALLOWS an agent → done on a NON-safety-critical ticket", async () => {
    const res = await transitionTicket({
      ticketId: "plain",
      tenantId: "tn",
      to: "done",
      actor: "agent",
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("plain")!.status).toBe("done");
  });

  it("ALLOWS a system → done on a NON-safety-critical ticket", async () => {
    const res = await transitionTicket({
      ticketId: "plain",
      tenantId: "tn",
      to: "done",
      actor: "system",
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("plain")!.status).toBe("done");
  });
});
