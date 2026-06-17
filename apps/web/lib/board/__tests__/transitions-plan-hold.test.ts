// Integration coverage for the plan-hold gate on the REAL `transitionTicket`
// seam - the single choke point every `→ ready` path flows through.
//
// Why the seam and not the board action: the held scaffolder sits in Backlog,
// visible, next to TWO things that promote through here and know nothing about
// plans - a board drag (`moveTicketAction`) and the backlog drain, which
// force-promotes the backlog head when nothing else is eligible. Proving the
// property here proves it for both, and for any future caller.
//
// The failure this prevents is expensive and specific: the promote dispatches a
// scaffolder that the plan commit is moments from dispatching with its real
// context - two agents authoring the first commit of one genuinely-empty repo.

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
  loadBlockerSummaryService: async () => ({
    blockers: [],
    summary: { open: 0, working: 0, awaitingLand: 0 },
  }),
}));
vi.mock("@/lib/engine/dispatch-queue", () => ({ cancelPendingForTicket: async () => {} }));

import { PlanHoldError, transitionTicket } from "@/lib/board/transitions";
import { makeFakeSupabase, type FakeSupabase } from "./_fake-supabase";

let fake: FakeSupabase;

beforeEach(() => {
  vi.clearAllMocks();
  h.loadRunVerification.mockResolvedValue(null);
  fake = makeFakeSupabase({
    // The held scaffolder: parked for a plan commit that hasn't happened yet.
    held: { status: "backlog", retry_count: 0, plan_hold: true },
    // The same row after any release path claimed it.
    released: { status: "backlog", retry_count: 0, plan_hold: false },
    // An ordinary backlog ticket.
    plain: { status: "backlog", retry_count: 0 },
  });
  h.supabaseRef.current = fake.client;
});

describe("transitionTicket plan-hold gate - a held scaffolder cannot be promoted", () => {
  it("refuses a HUMAN promote (the board drag) and mutates nothing", async () => {
    await expect(
      transitionTicket({ ticketId: "held", tenantId: "tn", to: "ready", actor: "human" }),
    ).rejects.toBeInstanceOf(PlanHoldError);

    expect(fake.tickets.get("held")!.status).toBe("backlog");
    expect(fake.tickets.get("held")!.plan_hold).toBe(true);
    expect(h.inngestSend).not.toHaveBeenCalled();
  });

  it("refuses a SYSTEM promote (the backlog drain's force-promote)", async () => {
    await expect(
      transitionTicket({ ticketId: "held", tenantId: "tn", to: "ready", actor: "system" }),
    ).rejects.toBeInstanceOf(PlanHoldError);
    expect(h.inngestSend).not.toHaveBeenCalled();
  });

  it("refuses an AGENT promote", async () => {
    await expect(
      transitionTicket({ ticketId: "held", tenantId: "tn", to: "ready", actor: "agent" }),
    ).rejects.toBeInstanceOf(PlanHoldError);
    expect(h.inngestSend).not.toHaveBeenCalled();
  });

  it("tells the operator what WILL run it", async () => {
    // A card that refuses to move without saying why is just broken software.
    await expect(
      transitionTicket({ ticketId: "held", tenantId: "tn", to: "ready", actor: "human" }),
    ).rejects.toThrow(/commit the plan|discard the plan/);
  });

  it("allows `→ ready` once the hold has been cleared by the release", async () => {
    const res = await transitionTicket({
      ticketId: "released",
      tenantId: "tn",
      to: "ready",
      actor: "human",
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("released")!.status).toBe("ready");
    expect(h.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("leaves every ordinary ticket untouched", async () => {
    const res = await transitionTicket({
      ticketId: "plain",
      tenantId: "tn",
      to: "ready",
      actor: "human",
    });
    expect(res.transitioned).toBe(true);
    expect(h.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("gates only `→ ready`, not the card - a held row can still be failed", async () => {
    // `backlog → ready | failed` is the whole FSM out-edge set, so this is the
    // ONLY other move there is: an operator who wants the scaffolder gone can
    // still abandon it. The gate is about not STARTING it early, and it is not
    // a lock on the ticket.
    const res = await transitionTicket({
      ticketId: "held",
      tenantId: "tn",
      to: "failed",
      actor: "human",
    });
    expect(res.transitioned).toBe(true);
  });

  it("still SELECTS plan_hold - dropping the column would fail the gate open", async () => {
    await transitionTicket({ ticketId: "plain", tenantId: "tn", to: "ready", actor: "human" });
    expect(fake.lastTicketSelect ?? "").toContain("plan_hold");
  });
});
