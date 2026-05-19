// Regression for two coupled behaviours of the PM/Engineer hard-coded
// postprocess transition:
//
//   1. The SPURIOUS-PARK bug (the follow-up flagged in #80). PM and Engineer are
//      the only built-in roles that HARD-CODE a ticket transition in postprocess
//      (`applyPmPost` → `ready`, `applyEngineerPost` → `in_review`). In practice
//      the agent often ALREADY moves the ticket to that target via
//      `devpilot_move_ticket` during its run, and postprocess then attempted the
//      SAME move again — a redundant double-move that `assertTransition` rejects
//      (`in_review → in_review` etc.), which the #80 hardening caught and parked
//      to `blocked`, surfacing a spurious operator-visible block. The fix makes
//      the postprocess transition IDEMPOTENT via `expectedFrom: "in_progress"`:
//      when the agent already moved the ticket (it now sits past its
//      pre-transition state) the move short-circuits to `{ transitioned: false }`
//      — no throw, no park — and postprocess is a SILENT no-op.
//
//   2. The GENUINE cases still work. A ticket the agent left in its
//      pre-transition state (`in_progress`) is still advanced by postprocess (no
//      strand). A real `BlockedByDependencyError` (in the pre-state, but an
//      unlanded dependency refuses `→ ready`) is STILL caught and parked to
//      `blocked` — a legitimate human signal — with an explanatory comment
//      authored by `devpilot_role_post` (NOT `devpilot_move_ticket`, which the
//      reconciler reads as a rendered verdict). Postprocess always returns a
//      non-throwing outcome so the run finishes cleanly.
//
// Loads the REAL `applyRolePostProcess` → `applyPmPost`/`applyEngineerPost` and
// the REAL `transitionTicket`; only the DB, verification loader, and blocker
// summary are mocked.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VerificationRecord } from "@/lib/board/qa-gate";
import type { BlockerSummary } from "@/lib/integration/landed";

const EMPTY_SUMMARY: BlockerSummary = {
  open: 0,
  working: 0,
  awaitingLand: 0,
  onlyAwaitingLand: false,
};

const h = vi.hoisted(() => ({
  supabaseRef: { current: null as unknown },
  inngestSend: vi.fn(async () => {}),
  loadRunVerification: vi.fn(async (): Promise<VerificationRecord | null> => null),
  // Per-test control of the `→ ready` dependency guard. Summary inlined here (not
  // referencing the module const) because `vi.hoisted` runs before it initializes.
  blockerSummary: {
    current: {
      blockers: [] as unknown[],
      summary: { open: 0, working: 0, awaitingLand: 0, onlyAwaitingLand: false } as BlockerSummary,
    },
  },
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
  loadBlockerSummaryService: async () => h.blockerSummary.current,
}));
vi.mock("@/lib/engine/dispatch-queue", () => ({ cancelPendingForTicket: async () => {} }));
// Neither PM nor engineer declares `branches`, so postprocess only calls this to
// decide there's no branch-key to persist. Null → no-op, no roles/load imports.
vi.mock("@/lib/roles/load", () => ({ getBuiltinRoleConfig: () => null }));
vi.mock("@/lib/roles/qa", () => ({ qaRole: {} }));

import { applyRolePostProcess } from "@/lib/roles/postprocess";
import { makeFakeSupabase, type FakeSupabase } from "@/lib/board/__tests__/_fake-supabase";

const RUN = "run-x";

let fake: FakeSupabase;

beforeEach(() => {
  vi.clearAllMocks();
  h.loadRunVerification.mockResolvedValue(null);
  h.blockerSummary.current = { blockers: [], summary: EMPTY_SUMMARY };
  // Gate off by default so the engineer test's throw comes from assertTransition,
  // not the L1 gate (which returns a typed refusal, a separate path).
  delete process.env.ENGINEER_QA_GATE_ENABLED;
});

describe("postprocess transition is idempotent (no spurious park) and preserves genuine parks", () => {
  it("PM: agent already moved the ticket (`ready`) → silent no-op, no spurious park", async () => {
    // The PM agent already advanced the ticket to `ready` via devpilot_move_ticket
    // during its run. The postprocess `→ ready` is now a redundant double-move;
    // `expectedFrom: "in_progress"` short-circuits it instead of throwing an
    // illegal-edge error and parking to `blocked` (the #80 spurious-park bug).
    fake = makeFakeSupabase({ t1: { status: "ready", retry_count: 0 } });
    h.supabaseRef.current = fake.client;

    const out = await applyRolePostProcess({
      role: "pm",
      ticketId: "t1",
      tenantId: "tn",
      agentDisplayName: "PM",
      finalText: "Refined the ticket.",
      runId: RUN,
    });

    // Silent no-op: the run finishes cleanly and the follow-up is owned by the
    // agent's own move (next: "dispatch", same as the happy path).
    expect(out.next).toBe("dispatch");
    // Ticket is untouched — it stays where the agent left it, NOT parked.
    expect(fake.tickets.get("t1")!.status).toBe("ready");
    // The regression assertion: NO spurious park to `blocked`.
    expect(fake.comments.some((c) => c.author_id === "devpilot_role_post")).toBe(false);
    expect(fake.tickets.get("t1")!.status).not.toBe("blocked");
  });

  it("PM: a BlockedByDependencyError parks to blocked and preserves the dependency signal", async () => {
    // Ticket is legally at `in_progress`, but a dependency is still open, so the
    // `→ ready` guard throws BlockedByDependencyError (not assertTransition).
    fake = makeFakeSupabase({ t1: { status: "in_progress", retry_count: 0 } });
    h.supabaseRef.current = fake.client;
    h.blockerSummary.current = {
      blockers: [{ status: "in_progress" }],
      summary: { open: 1, working: 1, awaitingLand: 0, onlyAwaitingLand: false },
    };

    const out = await applyRolePostProcess({
      role: "pm",
      ticketId: "t1",
      tenantId: "tn",
      agentDisplayName: "PM",
      finalText: "Refined the ticket.",
      runId: RUN,
    });

    expect(out.next).toBe("done");
    expect(fake.tickets.get("t1")!.status).toBe("blocked");
    const park = fake.comments.find((c) => c.author_id === "devpilot_role_post");
    expect(park).toBeDefined();
    // The real dependency signal is preserved in the fenced comment.
    expect(park!.body).toContain("open blocker");
  });

  it("Engineer: agent already moved the ticket (`in_review`) → silent no-op, no spurious park", async () => {
    // The engineer agent already advanced the ticket to `in_review` via
    // devpilot_move_ticket during its run. The postprocess `→ in_review` is now a
    // redundant same-state double-move; `expectedFrom: "in_progress"`
    // short-circuits it instead of throwing `in_review → in_review` and parking
    // to `blocked` (the #80 spurious-park bug this change kills).
    fake = makeFakeSupabase({ t1: { status: "in_review", retry_count: 0 } });
    h.supabaseRef.current = fake.client;

    const out = await applyRolePostProcess({
      role: "engineer",
      ticketId: "t1",
      tenantId: "tn",
      agentDisplayName: "Engineer",
      finalText: "Implemented the feature.",
      runId: RUN,
    });

    // Silent no-op: run finishes cleanly, the agent's own move owns the follow-up.
    expect(out.next).toBe("dispatch");
    // Ticket stays where the agent left it — NOT parked to `blocked`.
    expect(fake.tickets.get("t1")!.status).toBe("in_review");
    // The regression assertion: NO spurious park to `blocked`.
    expect(fake.comments.some((c) => c.author_id === "devpilot_role_post")).toBe(false);
    expect(fake.tickets.get("t1")!.status).not.toBe("blocked");
  });

  it("Engineer: agent did NOT move the ticket (`in_progress`) → postprocess advances it to in_review (no strand)", async () => {
    // The engineer left the ticket in its pre-transition state. The idempotent
    // postprocess is the FALLBACK that still advances it, so nothing strands.
    fake = makeFakeSupabase({ t1: { status: "in_progress", retry_count: 0 } });
    h.supabaseRef.current = fake.client;

    const out = await applyRolePostProcess({
      role: "engineer",
      ticketId: "t1",
      tenantId: "tn",
      agentDisplayName: "Engineer",
      finalText: "Implemented the feature.",
      runId: RUN,
    });

    expect(out.next).toBe("dispatch");
    expect(fake.tickets.get("t1")!.status).toBe("in_review");
    // No park on the happy fallback path.
    expect(fake.comments.some((c) => c.author_id === "devpilot_role_post")).toBe(false);
    // The `→ in_review` transition fired its dispatch event.
    expect(h.inngestSend).toHaveBeenCalled();
  });

  it("PM: the normal `in_progress → ready` hand-off is unaffected (still dispatches)", async () => {
    fake = makeFakeSupabase({ t1: { status: "in_progress", retry_count: 0 } });
    h.supabaseRef.current = fake.client;

    const out = await applyRolePostProcess({
      role: "pm",
      ticketId: "t1",
      tenantId: "tn",
      agentDisplayName: "PM",
      finalText: "Refined the ticket.",
      runId: RUN,
    });

    expect(out.next).toBe("dispatch");
    expect(fake.tickets.get("t1")!.status).toBe("ready");
    // No park comment on the happy path.
    expect(fake.comments.some((c) => c.author_id === "devpilot_role_post")).toBe(false);
    // The `→ ready` transition fired its dispatch event.
    expect(h.inngestSend).toHaveBeenCalled();
  });
});
