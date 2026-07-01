// Integration coverage for the unpushed-work notice on the REAL `transitionTicket`
// seam (`lib/board/transitions.ts`) - the single choke point every `→ done` path
// flows through. The DB is the only mocked surface; the transition logic under
// test is the shipping code.
//
// The bug: a ticket could reach `done` while its branch had never been pushed,
// and nothing on the ticket said so. The workspace reaper then deleted the only
// copy of those commits. The reap guard now keeps the commits alive
// (lib/workspace/unpushed-work.ts); this half makes the gap VISIBLE rather than
// leaving it to a sidebar badge nobody opens.
//
// Deliberately a notice, not a block - `→ done` must still commit.

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
import { UNPUSHED_WORK_COMMENT_AUTHOR } from "@/lib/workspace/unpushed-work.server";
import { makeFakeSupabase, type FakeSupabase, type PendingPushRow } from "./_fake-supabase";

let fake: FakeSupabase;

function pendingPush(over: Partial<PendingPushRow> = {}): PendingPushRow {
  return {
    id: "pp-1",
    ticket_id: "t1",
    branch: "devpilot/sql-migrations-abc",
    workspace_path: "/Users/utkarsh430/.devpilot/workspaces/t1",
    pushed_at: null,
    unpushed_count: 2,
    ...over,
  };
}

function setup(pushes: PendingPushRow[]): void {
  fake = makeFakeSupabase({ t1: { status: "in_review", retry_count: 0 } }, pushes);
  h.supabaseRef.current = fake.client;
}

function noticeComments() {
  return fake.comments.filter((c) => c.author_id === UNPUSHED_WORK_COMMENT_AUTHOR);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.loadRunVerification.mockResolvedValue(null);
  delete process.env.ENGINEER_QA_GATE_ENABLED;
});

describe("transitionTicket → done: unpushed-work notice", () => {
  it("posts a system comment when the ticket completes with an unpushed branch", async () => {
    setup([pendingPush()]);

    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn1",
      to: "done",
      actor: "human",
    });

    // The move still commits: this is a notice, not a gate.
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("t1")?.status).toBe("done");

    const notices = noticeComments();
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(notice.author_type).toBe("system");
    expect(notice.body).toContain("never pushed");
    expect(notice.body).toContain("devpilot/sql-migrations-abc");
    expect(notice.metadata).toMatchObject({
      kind: "unpushed_work",
      pending_push_ids: ["pp-1"],
    });
  });

  it("stays silent when the ticket's work was pushed", async () => {
    setup([pendingPush({ pushed_at: "2026-07-10T12:00:00Z" })]);

    await transitionTicket({ ticketId: "t1", tenantId: "tn1", to: "done", actor: "human" });

    expect(fake.tickets.get("t1")?.status).toBe("done");
    expect(noticeComments()).toHaveLength(0);
  });

  it("stays silent for the common case of a ticket with no pending push at all", async () => {
    setup([]);

    await transitionTicket({ ticketId: "t1", tenantId: "tn1", to: "done", actor: "human" });

    expect(fake.tickets.get("t1")?.status).toBe("done");
    expect(noticeComments()).toHaveLength(0);
  });

  it("fires for an agent-driven completion too, not just a human one", async () => {
    // The dangerous path in production: the agent finishes, the ticket auto-
    // completes, nobody was watching.
    setup([pendingPush()]);

    await transitionTicket({ ticketId: "t1", tenantId: "tn1", to: "done", actor: "agent" });

    expect(fake.tickets.get("t1")?.status).toBe("done");
    expect(noticeComments()).toHaveLength(1);
  });

  it("does not duplicate the notice when a reopened ticket is completed again", async () => {
    setup([pendingPush()]);

    await transitionTicket({ ticketId: "t1", tenantId: "tn1", to: "done", actor: "human" });
    // Reopen and re-complete (done → in_progress → in_review → done).
    fake.tickets.get("t1")!.status = "in_review";
    await transitionTicket({ ticketId: "t1", tenantId: "tn1", to: "done", actor: "human" });

    expect(noticeComments()).toHaveLength(1);
  });

  it("does not notice on a non-terminal transition", async () => {
    setup([pendingPush()]);

    await transitionTicket({ ticketId: "t1", tenantId: "tn1", to: "in_progress", actor: "human" });

    expect(noticeComments()).toHaveLength(0);
  });
});
