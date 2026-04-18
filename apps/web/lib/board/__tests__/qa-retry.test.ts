// The QA retry ceiling - the fix for the unbounded engineer↔QA reject loop.
//
// Two layers, both exercised here:
//   • the pure policy (`lib/board/qa-retry.ts`) - where the ceiling bites and
//     where it deliberately does NOT;
//   • the enforcement seam (`lib/board/qa-retry.server.ts`) driving the REAL
//     `transitionTicket` against the in-memory Supabase fake, which is what the
//     dispatcher calls as its first gate. The load-bearing assertion is the one
//     that pins the cost bug shut: a reject past the ceiling PARKS the ticket to
//     `blocked` and emits NO dispatch event - i.e. the engineer is not re-run.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_QA_MAX_RETRIES,
  QA_RETRY_CEILING_AUTHOR,
  decideQaRetryCeiling,
  getQaMaxRetries,
} from "@/lib/board/qa-retry";
import type { TicketStatus } from "@/lib/board/state";
import { ALLOWED_TRANSITIONS } from "@/lib/board/state";

const h = vi.hoisted(() => ({
  supabaseRef: { current: null as unknown },
  inngestSend: vi.fn(async () => {}),
}));

vi.mock("@/lib/db/server", () => ({ supabaseService: () => h.supabaseRef.current }));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: h.inngestSend } }));
vi.mock("@/lib/board/qa-gate.server", () => ({
  loadRunVerification: async () => null,
  loadRunRole: async () => null,
  loadCohortGateRefusal: async () => null,
}));
vi.mock("@/lib/board/dependencies", () => ({
  BLOCKING_RELATION_TYPES: ["blocked_by", "builds_on"] as const,
  loadBlockersService: async () => [],
  hasOpenBlockers: async () => false,
}));
vi.mock("@/lib/engine/dispatch-queue", () => ({ cancelPendingForTicket: async () => {} }));

import { enforceQaRetryCeiling } from "@/lib/board/qa-retry.server";
import { transitionTicket } from "@/lib/board/transitions";
import { makeFakeSupabase, type FakeSupabase } from "./_fake-supabase";

describe("decideQaRetryCeiling - the pure ceiling", () => {
  const max = DEFAULT_QA_MAX_RETRIES;

  it("allows retries below the ceiling", () => {
    for (const retryCount of [0, 1, 2]) {
      const d = decideQaRetryCeiling({ status: "in_progress", retryCount, maxRetries: max });
      expect(d.exhausted).toBe(false);
    }
  });

  it("exhausts AT the ceiling (3 rejects = 4 engineer attempts) and beyond", () => {
    for (const retryCount of [3, 4, 9]) {
      const d = decideQaRetryCeiling({ status: "in_progress", retryCount, maxRetries: max });
      expect(d.exhausted).toBe(true);
      expect(d.reason).toContain("ceiling");
    }
  });

  it("only bites in `in_progress` - where every QA reject lands the ticket", () => {
    // in_review is exempt on purpose: work already in review deserves QA's
    // verdict. ready/assigned are exempt because the reject loop never lands
    // there AND `blocked` is not even a legal edge from them - a park would throw.
    const others: TicketStatus[] = [
      "backlog",
      "ready",
      "assigned",
      "in_review",
      "input_required",
      "blocked",
      "paused",
      "done",
      "failed",
    ];
    for (const status of others) {
      expect(decideQaRetryCeiling({ status, retryCount: 99, maxRetries: max }).exhausted).toBe(
        false,
      );
    }
  });

  it("in_progress → blocked is a legal FSM edge, so the park can always commit", () => {
    expect(ALLOWED_TRANSITIONS.in_progress).toContain("blocked");
  });

  it("honours a configured ceiling, and falls back to 3 on a garbage value", () => {
    const prev = process.env.DEVPILOT_QA_MAX_RETRIES;
    try {
      process.env.DEVPILOT_QA_MAX_RETRIES = "5";
      expect(getQaMaxRetries()).toBe(5);
      for (const bad of ["", "abc", "0", "-2"]) {
        process.env.DEVPILOT_QA_MAX_RETRIES = bad;
        expect(getQaMaxRetries()).toBe(DEFAULT_QA_MAX_RETRIES);
      }
    } finally {
      if (prev === undefined) delete process.env.DEVPILOT_QA_MAX_RETRIES;
      else process.env.DEVPILOT_QA_MAX_RETRIES = prev;
    }
  });
});

describe("enforceQaRetryCeiling - the dispatcher's first gate", () => {
  let fake: FakeSupabase;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEVPILOT_QA_MAX_RETRIES;
    delete process.env.ENGINEER_QA_GATE_ENABLED;
    fake = makeFakeSupabase({
      // Third QA reject just landed: retry_count is AT the default ceiling.
      exhausted: { status: "in_progress", retry_count: 3 },
      // One reject in - still inside the budget.
      retrying: { status: "in_progress", retry_count: 1 },
      // Work in review with a maxed counter: QA must still get to rule on it.
      reviewing: { status: "in_review", retry_count: 3 },
      // The parked ticket, awaiting the human who will reset the budget.
      parked: { status: "blocked", retry_count: 3 },
    });
    h.supabaseRef.current = fake.client;
  });

  it("parks an exhausted ticket to blocked and does NOT re-dispatch the engineer", async () => {
    const res = await enforceQaRetryCeiling({ ticketId: "exhausted", tenantId: "tn" });

    expect(res.parked).toBe(true);
    expect(fake.tickets.get("exhausted")!.status).toBe("blocked");
    // THE cost assertion: no `ticket/dispatch-needed` - the loop is over. The
    // dispatcher short-circuits on `parked`, so no role is picked and no run
    // (engineer or QA) is ever requested.
    expect(h.inngestSend).not.toHaveBeenCalled();
  });

  it("surfaces WHY to the operator, under its own author", async () => {
    await enforceQaRetryCeiling({ ticketId: "exhausted", tenantId: "tn" });
    const comment = fake.comments.find((c) => c.author_id === QA_RETRY_CEILING_AUTHOR);
    expect(comment).toBeDefined();
    expect(comment!.body).toContain("retry ceiling");
    // NEVER `devpilot_move_ticket` (the reconciler reads that as a rendered verdict)
    // and never `ticket-reconciler` (that would burn a reconcile-cap slot).
    const authors = fake.comments.map((c) => c.author_id);
    expect(authors).not.toContain("devpilot_move_ticket");
    expect(authors).not.toContain("ticket-reconciler");
  });

  it("leaves a ticket inside its budget alone", async () => {
    const res = await enforceQaRetryCeiling({ ticketId: "retrying", tenantId: "tn" });
    expect(res.parked).toBe(false);
    expect(fake.tickets.get("retrying")!.status).toBe("in_progress");
    expect(fake.comments).toHaveLength(0);
  });

  it("never parks a ticket in review - QA still renders its verdict", async () => {
    const res = await enforceQaRetryCeiling({ ticketId: "reviewing", tenantId: "tn" });
    expect(res.parked).toBe(false);
    expect(fake.tickets.get("reviewing")!.status).toBe("in_review");
  });

  it("fails open when the ticket can't be read - a broken ceiling never wedges a ticket", async () => {
    const res = await enforceQaRetryCeiling({ ticketId: "does-not-exist", tenantId: "tn" });
    expect(res.parked).toBe(false);
  });
});

describe("recovery - a human un-blocking resets the retry budget", () => {
  let fake: FakeSupabase;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEVPILOT_QA_MAX_RETRIES;
    delete process.env.ENGINEER_QA_GATE_ENABLED;
    fake = makeFakeSupabase({
      parked: { status: "blocked", retry_count: 3 },
      parked2: { status: "blocked", retry_count: 3 },
      working: { status: "in_progress", retry_count: 2 },
    });
    h.supabaseRef.current = fake.client;
  });

  it("resets retry_count when a human moves the ticket out of blocked", async () => {
    await transitionTicket({
      ticketId: "parked",
      tenantId: "tn",
      to: "in_progress",
      actor: "human",
    });
    expect(fake.tickets.get("parked")!.retry_count).toBe(0);
    // …and the next enforce pass lets it run again, with a fresh budget.
    const res = await enforceQaRetryCeiling({ ticketId: "parked", tenantId: "tn" });
    expect(res.parked).toBe(false);
  });

  it("does NOT reset for a system/agent move out of blocked - the ceiling can't self-clear", async () => {
    await transitionTicket({
      ticketId: "parked2",
      tenantId: "tn",
      to: "in_progress",
      actor: "system",
    });
    expect(fake.tickets.get("parked2")!.retry_count).toBe(3);
    // Still exhausted: the very next dispatch parks it straight back.
    const res = await enforceQaRetryCeiling({ ticketId: "parked2", tenantId: "tn" });
    expect(res.parked).toBe(true);
    expect(fake.tickets.get("parked2")!.status).toBe("blocked");
  });

  it("leaves retry_count alone on a human move that isn't leaving blocked", async () => {
    await transitionTicket({
      ticketId: "working",
      tenantId: "tn",
      to: "in_review",
      actor: "human",
    });
    expect(fake.tickets.get("working")!.retry_count).toBe(2);
  });
});
