// Integration coverage for the L1 gate embedded in the REAL `transitionTicket`
// seam (`lib/board/transitions.ts`) — the single choke point every `→ in_review`
// path flows through. The DB and the run-verification loader are the only
// mocked surfaces; the transition logic under test is the shipping code.
//
// This is the test the first attempt lacked: it proves the gate lives on the
// seam, so ANY non-human caller (engineer postprocess, reconciler, aggregator,
// MCP tool) that reaches `in_review` is gated — not just the one route that was
// wired up. It also proves the refusal is a true no-op: status unchanged, no
// retry bump, no dispatch event.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VerificationRecord } from "@/lib/board/qa-gate";

const h = vi.hoisted(() => ({
  supabaseRef: { current: null as unknown },
  inngestSend: vi.fn(async () => {}),
  loadRunVerification: vi.fn(async (): Promise<VerificationRecord | null> => null),
  loadRunRole: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("@/lib/db/server", () => ({ supabaseService: () => h.supabaseRef.current }));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: h.inngestSend } }));
vi.mock("@/lib/board/qa-gate.server", () => ({
  loadRunVerification: h.loadRunVerification,
  // B2 — the gate resolves the run's role itself (the code-producing question).
  // Default null = "unresolvable role" = the permissive pre-B2 behaviour the
  // pre-existing cases in this file were written against.
  loadRunRole: h.loadRunRole,
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

const RUN = "run-1";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function failing(): VerificationRecord {
  return {
    command: "pnpm test",
    exitCode: 1,
    headSha: HEAD,
    baseSha: BASE,
    pushed: true,
    commitsAhead: null,
    outputTail: "2 failing",
  };
}
function passing(): VerificationRecord {
  return { ...failing(), exitCode: 0 };
}

let fake: FakeSupabase;

beforeEach(() => {
  vi.clearAllMocks();
  h.loadRunVerification.mockResolvedValue(null);
  h.loadRunRole.mockResolvedValue(null);
  fake = makeFakeSupabase({ t1: { status: "in_progress", retry_count: 0 } });
  h.supabaseRef.current = fake.client;
  delete process.env.ENGINEER_QA_GATE_ENABLED;
});

describe("transitionTicket L1 gate — refusal is a true no-op", () => {
  it("refuses an agent → in_review with a failing verification; nothing mutates", async () => {
    process.env.ENGINEER_QA_GATE_ENABLED = "1";
    h.loadRunVerification.mockResolvedValue(failing());

    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });

    expect(res.transitioned).toBe(false);
    expect(res.gateRefusal?.code).toBe("verification_failed");
    // The seam moved NOTHING: status unchanged, no dispatch emitted.
    expect(fake.tickets.get("t1")!.status).toBe("in_progress");
    expect(h.inngestSend).not.toHaveBeenCalled();
    // B2 — the ONE thing a refusal now writes is its own retry counter, so the
    // 422-retry loop is bounded. It must NOT be the reject-loop counter: that
    // one drives dispatcher re-dispatch and the QA ceiling, and a gate refusal
    // faking a QA reject would corrupt both.
    expect(fake.tickets.get("t1")!.gate_retry_count).toBe(1);
    expect(fake.tickets.get("t1")!.retry_count).toBe(0);
    // Run-scoped AND tenant-scoped: the loader was asked for exactly this run,
    // within the tenant read off the ticket row itself. The tenant argument is
    // not decoration — this loader fails open, so an unscoped read would hand
    // the gate a forged `{tenant_id: attacker, run_id: <our run>}` pass.
    expect(h.loadRunVerification).toHaveBeenCalledWith(RUN, "tn");
  });

  it("also gates a system → in_review (reconciler/aggregator paths)", async () => {
    process.env.ENGINEER_QA_GATE_ENABLED = "1";
    h.loadRunVerification.mockResolvedValue(failing());
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "system",
      runId: RUN,
    });
    expect(res.transitioned).toBe(false);
    expect(res.gateRefusal).toBeDefined();
    expect(fake.tickets.get("t1")!.status).toBe("in_progress");
  });
});

describe("B2 — empty delivery, through the real seam", () => {
  // The record a producer that committed nothing to the branch would post:
  // the check itself passed (nothing to break), and the branch is empty.
  function emptyBranch(): VerificationRecord {
    return { ...passing(), commitsAhead: 0 };
  }

  beforeEach(() => {
    process.env.ENGINEER_QA_GATE_ENABLED = "1";
    h.loadRunVerification.mockResolvedValue(emptyBranch());
  });

  it("REFUSES a code-producing role handing off a branch with no commits", async () => {
    h.loadRunRole.mockResolvedValue("backend_engineer");
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });
    expect(res.transitioned).toBe(false);
    expect(res.gateRefusal?.code).toBe("empty_delivery");
    expect(fake.tickets.get("t1")!.status).toBe("in_progress");
    expect(h.inngestSend).not.toHaveBeenCalled();
  });

  it("resolves the role from the RUN, run- and tenant-scoped (no caller has to pass it)", async () => {
    h.loadRunRole.mockResolvedValue("engineer");
    await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });
    expect(h.loadRunRole).toHaveBeenCalledWith(RUN, "tn");
  });

  it("LETS A NON-CODE ROLE THROUGH on the identical record", async () => {
    // The control that makes the refusal above meaningful, and the regression
    // that would wedge ~48 roles if it ever broke. Same evidence, same seam,
    // same actor — only the role differs.
    h.loadRunRole.mockResolvedValue("product_manager");
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });
    expect(res.transitioned).toBe(true);
    expect(res.gateRefusal).toBeUndefined();
    expect(fake.tickets.get("t1")!.status).toBe("in_review");
    // …and it costs the ticket nothing.
    expect(fake.tickets.get("t1")!.gate_retry_count ?? 0).toBe(0);
  });

  it("lets an UNRESOLVABLE role through (a DB hiccup must never refuse a hand-off)", async () => {
    h.loadRunRole.mockResolvedValue(null);
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });
    expect(res.transitioned).toBe(true);
  });

  it("a human still overrides an empty delivery", async () => {
    h.loadRunRole.mockResolvedValue("engineer");
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "human",
    });
    expect(res.transitioned).toBe(true);
  });
});

describe("B2 — the gate's own retry ceiling (bounded 422 loop)", () => {
  beforeEach(() => {
    process.env.ENGINEER_QA_GATE_ENABLED = "1";
    delete process.env.DEVPILOT_QA_GATE_MAX_RETRIES;
    h.loadRunVerification.mockResolvedValue(failing());
  });

  async function refuse() {
    return transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });
  }

  it("counts each refusal and keeps inviting a retry below the ceiling", async () => {
    for (const expected of [1, 2]) {
      const res = await refuse();
      expect(res.gateRefusal?.code).toBe("verification_failed");
      expect(fake.tickets.get("t1")!.gate_retry_count).toBe(expected);
    }
  });

  it("switches to gate_retry_exhausted AT the ceiling so the caller parks instead of retrying", async () => {
    await refuse();
    await refuse();
    const third = await refuse();
    expect(fake.tickets.get("t1")!.gate_retry_count).toBe(3);
    expect(third.gateRefusal?.code).toBe("gate_retry_exhausted");
    // The ceiling message must still carry the underlying failure, or the
    // operator is told a budget ran out without being told what failed.
    expect(third.gateRefusal?.reason).toContain("pnpm test");
    // Still a pure refusal: the seam parks nothing itself, the caller does.
    expect(fake.tickets.get("t1")!.status).toBe("in_progress");
  });

  it("NEVER spends the engineer↔QA reject budget on a gate refusal", async () => {
    await refuse();
    await refuse();
    await refuse();
    expect(fake.tickets.get("t1")!.retry_count).toBe(0);
  });

  it("a human moving the ticket out of blocked resets the gate budget", async () => {
    await refuse();
    await refuse();
    fake.tickets.get("t1")!.status = "blocked";
    await transitionTicket({ ticketId: "t1", tenantId: "tn", to: "in_progress", actor: "human" });
    expect(fake.tickets.get("t1")!.gate_retry_count).toBe(0);
    // …and the budget is genuinely fresh, not merely zeroed on paper.
    const next = await refuse();
    expect(next.gateRefusal?.code).toBe("verification_failed");
  });

  it("honours a configured ceiling", async () => {
    process.env.DEVPILOT_QA_GATE_MAX_RETRIES = "1";
    const first = await refuse();
    expect(first.gateRefusal?.code).toBe("gate_retry_exhausted");
  });
});

describe("transitionTicket L1 gate — allow paths", () => {
  it("allows a human → in_review even with a failing verification (operator override)", async () => {
    process.env.ENGINEER_QA_GATE_ENABLED = "1";
    h.loadRunVerification.mockResolvedValue(failing());
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "human",
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("t1")!.status).toBe("in_review");
    // A human move never even reads a verification.
    expect(h.loadRunVerification).not.toHaveBeenCalled();
  });

  it("is byte-for-byte unchanged when the flag is OFF (default)", async () => {
    // flag unset
    h.loadRunVerification.mockResolvedValue(failing());
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("t1")!.status).toBe("in_review");
    // Flag off → the gate never runs, so it never loads a verification.
    expect(h.loadRunVerification).not.toHaveBeenCalled();
    expect(h.inngestSend).toHaveBeenCalledTimes(1); // dispatch emitted as usual
  });

  it("allows an agent → in_review with a passing verification", async () => {
    process.env.ENGINEER_QA_GATE_ENABLED = "1";
    h.loadRunVerification.mockResolvedValue(passing());
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("t1")!.status).toBe("in_review");
  });

  it("allows a no-commit run (base_sha === head_sha) — protects non-code producers", async () => {
    process.env.ENGINEER_QA_GATE_ENABLED = "1";
    h.loadRunVerification.mockResolvedValue({ ...failing(), baseSha: HEAD, headSha: HEAD });
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("t1")!.status).toBe("in_review");
  });

  it("fails open when the run has no verification record", async () => {
    process.env.ENGINEER_QA_GATE_ENABLED = "1";
    h.loadRunVerification.mockResolvedValue(null);
    const res = await transitionTicket({
      ticketId: "t1",
      tenantId: "tn",
      to: "in_review",
      actor: "agent",
      runId: RUN,
    });
    expect(res.transitioned).toBe(true);
    expect(fake.tickets.get("t1")!.status).toBe("in_review");
  });
});
