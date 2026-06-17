// Integration coverage for the reopen gate embedded in the REAL
// `transitionTicket` seam. `done → backlog` is now a legal FSM edge, but it is
// HUMAN-ONLY: a re-run of a finished ticket is an operator decision. Proving it
// on the seam (not just the pure policy) means it holds for every caller that
// reaches `transitionTicket`, current or future — including the MCP move route
// (`actor: "agent"`) and every engine path (`actor: "system"`).

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
  loadBlockerSummaryService: async () => ({
    blockers: [],
    summary: { open: 0, working: 0, awaitingLand: 0, onlyAwaitingLand: false },
  }),
  hasOpenBlockers: async () => false,
}));
vi.mock("@/lib/engine/dispatch-queue", () => ({ cancelPendingForTicket: async () => {} }));

import { transitionTicket } from "@/lib/board/transitions";
import { makeFakeSupabase, type FakeSupabase } from "./_fake-supabase";

let fake: FakeSupabase;

beforeEach(() => {
  vi.clearAllMocks();
  fake = makeFakeSupabase({
    doneTicket: { status: "done", retry_count: 0, safety_critical: false },
    pausedTicket: { status: "paused", retry_count: 0, safety_critical: false },
    inProgressTicket: { status: "in_progress", retry_count: 0, safety_critical: false },
    blockedTicket: { status: "blocked", retry_count: 0, safety_critical: false },
    inputRequiredTicket: { status: "input_required", retry_count: 0, safety_critical: false },
  });
  h.supabaseRef.current = fake.client;
});

describe("transitionTicket reopen gate — leaving done is human-only", () => {
  it("ALLOWS a human to reopen done → backlog", async () => {
    const res = await transitionTicket({
      ticketId: "doneTicket",
      tenantId: "tn",
      to: "backlog",
      actor: "human",
      emitDispatch: false,
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("doneTicket")!.status).toBe("backlog");
  });

  it("REFUSES an agent reopening done → backlog — nothing mutates", async () => {
    await expect(
      transitionTicket({
        ticketId: "doneTicket",
        tenantId: "tn",
        to: "backlog",
        actor: "agent",
        emitDispatch: false,
      }),
    ).rejects.toThrow(/human actor/i);
    // The seam mutated NOTHING.
    expect(fake.tickets.get("doneTicket")!.status).toBe("done");
    expect(h.inngestSend).not.toHaveBeenCalled();
  });

  it("REFUSES the system/engine reopening done → backlog", async () => {
    await expect(
      transitionTicket({
        ticketId: "doneTicket",
        tenantId: "tn",
        to: "backlog",
        actor: "system",
        emitDispatch: false,
      }),
    ).rejects.toThrow(/human actor/i);
    expect(fake.tickets.get("doneTicket")!.status).toBe("done");
  });
});

describe("transitionTicket reopen gate — the paused reopen is unaffected", () => {
  // paused → backlog was already legal for any actor; the reopen gate only bites
  // when leaving `done`. The restart action still passes actor:"human", but the
  // gate itself must not newly restrict the paused edge.
  it("ALLOWS a human to reopen paused → backlog", async () => {
    const res = await transitionTicket({
      ticketId: "pausedTicket",
      tenantId: "tn",
      to: "backlog",
      actor: "human",
      emitDispatch: false,
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("pausedTicket")!.status).toBe("backlog");
  });

  it("does not newly restrict an agent moving paused → backlog", async () => {
    const res = await transitionTicket({
      ticketId: "pausedTicket",
      tenantId: "tn",
      to: "backlog",
      actor: "agent",
      emitDispatch: false,
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("pausedTicket")!.status).toBe("backlog");
  });
});

describe("transitionTicket reset gate — the discard reset edges are human-only", () => {
  // "Discard & restart from dev" resets a NON-done ticket to backlog. Those new
  // → backlog edges must be reachable ONLY by a human; an agent or engine path
  // is refused at the seam, exactly like the done reopen.
  const cases = [
    { id: "inProgressTicket", from: "in_progress" },
    { id: "blockedTicket", from: "blocked" },
    { id: "inputRequiredTicket", from: "input_required" },
  ] as const;

  for (const c of cases) {
    it(`ALLOWS a human to reset ${c.from} → backlog`, async () => {
      const res = await transitionTicket({
        ticketId: c.id,
        tenantId: "tn",
        to: "backlog",
        actor: "human",
        emitDispatch: false,
      });
      expect(res.transitioned).toBe(true);
      expect(fake.tickets.get(c.id)!.status).toBe("backlog");
    });

    it(`REFUSES an agent resetting ${c.from} → backlog — nothing mutates`, async () => {
      await expect(
        transitionTicket({
          ticketId: c.id,
          tenantId: "tn",
          to: "backlog",
          actor: "agent",
          emitDispatch: false,
        }),
      ).rejects.toThrow(/human actor/i);
      expect(fake.tickets.get(c.id)!.status).toBe(c.from);
      expect(h.inngestSend).not.toHaveBeenCalled();
    });

    it(`REFUSES the system/engine resetting ${c.from} → backlog`, async () => {
      await expect(
        transitionTicket({
          ticketId: c.id,
          tenantId: "tn",
          to: "backlog",
          actor: "system",
          emitDispatch: false,
        }),
      ).rejects.toThrow(/human actor/i);
      expect(fake.tickets.get(c.id)!.status).toBe(c.from);
    });
  }

  it("does NOT gate an agent moving in_progress → in_review (only → backlog is gated)", async () => {
    // Regression guard: the reset gate must never catch the legitimate
    // agent-facing out-edges of these states.
    const res = await transitionTicket({
      ticketId: "inProgressTicket",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      emitDispatch: false,
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("inProgressTicket")!.status).toBe("in_review");
  });
});
