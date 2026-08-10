// A run may drive at most ONE verdictless-review park.
//
// The wedge (observed live 2026-08-01, ticket de18a05f / run bb1cc5ee)
// ───────────────────────────────────────────────────────────────────
// A qa run completed with no verdict, so the reconciler parked the ticket to
// `blocked` telling the operator to "unblock it once resolved". They did.
// Twelve minutes later the sweeper parked it again with a byte-identical
// comment naming the SAME run — no new run had been created in between. The
// reconciler decides from "the ticket's latest verdict-role run completed with
// no verdict", which a human unblock does not change, and the `block` branch
// deliberately bypasses the sweeper's ticket-scoped already-reconciled check.
// So the same finished run drove the same park on every 5-minute tick, and the
// documented recovery path was impossible to follow.
//
// The protection itself is NOT the bug and must survive: a genuinely NEW
// verdictless run still parks. The naive fix — parking less — would be worse
// than the wedge, so the second block below is the one that matters.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ALLOWED_TRANSITIONS } from "@/lib/board/state";

type Comment = {
  ticket_id: string;
  tenant_id: string;
  author_type: string;
  author_id: string;
  body: string;
  created_at: string;
};

type RunStep = { run_id: string; idx: number; kind: string; payload: Record<string, unknown> };

const store = vi.hoisted(() => ({
  ticket: { id: "t1", tenant_id: "tn", status: "in_review" as string },
  comments: [] as Comment[],
  steps: [] as RunStep[],
  now: 0,
}));

/** Monotonic timestamps so `gt` comparisons are deterministic. */
function stamp(): string {
  store.now += 1000;
  return new Date(store.now).toISOString();
}

/**
 * Fake Supabase client that ACTUALLY applies `.eq`/`.in`/`.gt` — a
 * filter-ignoring fake would make every assertion here vacuous — and that
 * enforces `run_steps`' real `unique (run_id, idx)` constraint, since the park
 * marker's at-most-once property rests on it.
 */
class Q {
  private eqs: Record<string, unknown> = {};
  private ins: Record<string, unknown[]> = {};
  private gts: Record<string, string> = {};
  private head = false;
  private desc = false;
  constructor(private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.head = true;
    return this;
  }
  insert(row: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
    if (this.table === "comments") {
      store.comments.push({
        ticket_id: String(row.ticket_id),
        tenant_id: String(row.tenant_id ?? "tn"),
        author_type: String(row.author_type),
        author_id: String(row.author_id),
        body: String(row.body),
        created_at: stamp(),
      });
    }
    if (this.table === "run_steps") {
      const runId = String(row.run_id);
      const idx = Number(row.idx);
      if (store.steps.some((s) => s.run_id === runId && s.idx === idx)) {
        // `unique (run_id, idx)` — supabase-js surfaces this as an error, and
        // the reconciler's audit writes are best-effort, so it only warns.
        return Promise.resolve({
          data: null,
          error: {
            message: 'duplicate key value violates unique constraint "run_steps_run_id_idx_key"',
          },
        });
      }
      store.steps.push({
        run_id: runId,
        idx,
        kind: String(row.kind),
        payload: (row.payload ?? {}) as Record<string, unknown>,
      });
    }
    return Promise.resolve({ data: null, error: null });
  }
  eq(col: string, val: unknown): this {
    this.eqs[col] = val;
    return this;
  }
  neq(): this {
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.ins[col] = vals;
    return this;
  }
  gt(col: string, val: string): this {
    this.gts[col] = val;
    return this;
  }
  order(_col: string, opts?: { ascending?: boolean }): this {
    this.desc = opts?.ascending === false;
    return this;
  }
  limit(): this {
    return this;
  }
  private matches(row: Record<string, unknown>): boolean {
    return (
      Object.entries(this.eqs).every(([col, val]) => row[col] === val) &&
      Object.entries(this.ins).every(([col, vals]) => vals.includes(row[col])) &&
      Object.entries(this.gts).every(([col, val]) => String(row[col]) > val)
    );
  }
  private rows(): Record<string, unknown>[] {
    const source: Record<string, unknown>[] =
      this.table === "comments"
        ? (store.comments as unknown as Record<string, unknown>[])
        : this.table === "run_steps"
          ? (store.steps as unknown as Record<string, unknown>[])
          : [];
    const rows = source.filter((r) => this.matches(r));
    return this.desc ? [...rows].reverse() : rows;
  }
  maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    if (this.table === "tickets") return Promise.resolve({ data: store.ticket, error: null });
    return Promise.resolve({ data: this.rows()[0] ?? null, error: null });
  }
  then<T>(onF: (v: { data: unknown; error: unknown; count?: number }) => T): Promise<T> {
    if (this.table === "runs") return Promise.resolve(onF({ data: [], error: null }));
    const rows = this.rows();
    return Promise.resolve(
      onF(
        this.head ? { data: null, error: null, count: rows.length } : { data: rows, error: null },
      ),
    );
  }
}

const h = vi.hoisted(() => ({
  transitionTicket: vi.fn(async (_a: unknown) => ({ transitioned: true })),
  inngestSend: vi.fn(async () => {}),
}));

// The reconciler pulls in the role loader, which transitively imports a
// `server-only`-guarded module. Neutralise the guard for the node test env.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/server", () => ({ supabaseService: () => ({ from: (t: string) => new Q(t) }) }));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: h.inngestSend } }));
vi.mock("@/lib/board/transitions", () => ({
  transitionTicket: h.transitionTicket,
  addComment: async (a: { ticketId: string; authorType: string; authorId: string; body: string }) =>
    void store.comments.push({
      ticket_id: a.ticketId,
      tenant_id: "tn",
      author_type: a.authorType,
      author_id: a.authorId,
      body: a.body,
      created_at: stamp(),
    }),
}));
vi.mock("@/lib/engine/automation-state", () => ({
  getEffectivePauseForTicket: async () => ({ paused: false }),
}));

import {
  RECONCILER_COMMENT_AUTHOR,
  RECONCILE_AUDIT_STEP_IDX,
  RECONCILE_PARK_AUDIT_STEP_IDX,
  reconcileTicketAfterRun,
} from "@/lib/engine/ticket-reconciler";

/**
 * A sweeper pass over a qa run that completed 'done' with no verdict — the
 * canonical `block` decision. `statusAtRunStart: null` is what puts the
 * reconciler in sweeper mode, exactly as stuck-ticket-sweep.ts calls it.
 */
function sweepPass(runId: string) {
  return reconcileTicketAfterRun({
    runId,
    tenantId: "tn",
    ticketId: "t1",
    role: "qa",
    agentId: null,
    statusAtRunStart: null,
    postNext: null,
    runStartedAtIso: new Date(0).toISOString(),
  });
}

/** What a human does when they follow the park comment's own instruction. */
function humanUnblocksTo(status: string) {
  store.ticket = { ...store.ticket, status };
}

const parkComments = () =>
  store.comments.filter(
    (c) => c.author_id === RECONCILER_COMMENT_AUTHOR && c.body.includes("recorded NO verdict"),
  );

beforeEach(() => {
  vi.clearAllMocks();
  store.now = 0;
  store.comments = [];
  store.steps = [];
  store.ticket = { id: "t1", tenant_id: "tn", status: "in_review" };
  // The park is a CAS on the status the decision was based on; mirror that so
  // a second park attempt on an already-moved ticket is a clean no-op.
  h.transitionTicket.mockImplementation(async (a: unknown) => {
    const arg = a as { to: string; expectedFrom?: string };
    if (arg.expectedFrom && arg.expectedFrom !== store.ticket.status)
      return { transitioned: false };
    store.ticket = { ...store.ticket, status: arg.to };
    return { transitioned: true };
  });
});

describe("a human's unblock sticks (the reported wedge)", () => {
  it("does NOT re-park after the operator moves the ticket out of blocked", async () => {
    // 1. The verdictless run is parked. This is correct and must happen.
    const first = await sweepPass("run-stale");
    expect(first).toMatchObject({ applied: true });
    expect(store.ticket.status).toBe("blocked");

    // 2. The operator resolves the underlying fault and does exactly what the
    //    park comment told them to.
    humanUnblocksTo("in_review");

    // 3. The next sweeper tick sees the same ticket and the same finished run.
    const second = await sweepPass("run-stale");

    expect(second).toEqual({ skipped: "run-already-parked" });
    expect(store.ticket.status).toBe("in_review");
    expect(parkComments()).toHaveLength(1);
  });

  it("stays unblocked across many ticks — the sweeper runs every 5 minutes forever", async () => {
    await sweepPass("run-stale");
    humanUnblocksTo("in_review");
    for (let tick = 0; tick < 5; tick++) await sweepPass("run-stale");
    expect(store.ticket.status).toBe("in_review");
    expect(parkComments()).toHaveLength(1);
  });

  it("holds for an unblock to in_progress too (the other legal exit from blocked)", async () => {
    await sweepPass("run-stale");
    humanUnblocksTo("in_progress");
    const second = await sweepPass("run-stale");
    expect(second).toEqual({ skipped: "run-already-parked" });
    expect(store.ticket.status).toBe("in_progress");
  });

  it("heals a ticket parked BEFORE the marker existed (no backfill, no migration)", async () => {
    // Exactly what production carries today: the generic reconcile audit row
    // with a `block` decision, and no dedicated park marker.
    store.steps.push({
      run_id: "run-stale",
      idx: RECONCILE_AUDIT_STEP_IDX,
      kind: "system",
      payload: { kind: "ticket-reconciled", decision: { action: "block", reason: "…" } },
    });
    const res = await sweepPass("run-stale");
    expect(res).toEqual({ skipped: "run-already-parked" });
    expect(store.ticket.status).toBe("in_review");
    expect(parkComments()).toHaveLength(0);
  });
});

describe("the protection still bites (the fix must not simply park less)", () => {
  it("parks a genuinely NEW verdictless run after the operator unblocked", async () => {
    await sweepPass("run-1");
    expect(store.ticket.status).toBe("blocked");
    humanUnblocksTo("in_review");

    // The unblock fired a fresh dispatch; the new review ALSO recorded no
    // verdict. That is a new fact about new work and must be surfaced.
    const res = await sweepPass("run-2");

    expect(res).toMatchObject({ applied: true, decision: { action: "block" } });
    expect(store.ticket.status).toBe("blocked");
    expect(parkComments()).toHaveLength(2);
  });

  it("parks the very first verdictless run of a ticket with no history at all", async () => {
    const res = await sweepPass("run-fresh");
    expect(res).toMatchObject({ applied: true, decision: { action: "block" } });
    expect(store.ticket.status).toBe("blocked");
  });

  it("a prior NON-park reconcile on the same run never counts as a park", async () => {
    // The 99_994 row is also written for `transition`/`dispatch` decisions.
    // Treating its mere existence as "already parked" would suppress a genuine
    // first park — which is why hasRunAlreadyParked reads the decision.
    store.steps.push({
      run_id: "run-x",
      idx: RECONCILE_AUDIT_STEP_IDX,
      kind: "system",
      payload: { kind: "ticket-reconciled", decision: { action: "dispatch", reason: "…" } },
    });
    const res = await sweepPass("run-x");
    expect(res).toMatchObject({ applied: true, decision: { action: "block" } });
    expect(store.ticket.status).toBe("blocked");
  });

  it("records the marker under its own idx, so a dispatch row cannot swallow it", async () => {
    await sweepPass("run-1");
    const marker = store.steps.find((s) => s.idx === RECONCILE_PARK_AUDIT_STEP_IDX);
    expect(marker).toBeDefined();
    expect(marker!.run_id).toBe("run-1");
    expect(RECONCILE_PARK_AUDIT_STEP_IDX).not.toBe(RECONCILE_AUDIT_STEP_IDX);
  });
});

describe("runs that are not stranded verdictless reviews behave exactly as before", () => {
  it("a run whose ticket already carries a verdict is left alone (no park, no marker)", async () => {
    // `devpilot_move_ticket` after run start = the reviewer rendered its verdict.
    store.comments.push({
      ticket_id: "t1",
      tenant_id: "tn",
      author_type: "system",
      author_id: "devpilot_move_ticket",
      body: "approved",
      created_at: stamp(),
    });
    const res = await reconcileTicketAfterRun({
      runId: "run-verdict",
      tenantId: "tn",
      ticketId: "t1",
      role: "qa",
      agentId: null,
      statusAtRunStart: null,
      postNext: null,
      runStartedAtIso: new Date(0).toISOString(),
    });
    expect(res).toMatchObject({ applied: false, decision: { action: "none" } });
    expect(store.ticket.status).toBe("in_review");
    expect(store.steps).toHaveLength(0);
  });

  it("a ticket already moved on (terminal) is left alone", async () => {
    store.ticket = { id: "t1", tenant_id: "tn", status: "done" };
    const res = await sweepPass("run-done");
    expect(res).toMatchObject({ applied: false, decision: { action: "none" } });
    expect(store.steps).toHaveLength(0);
  });

  it("a lost CAS race parks nothing and burns no marker — a later genuine park still works", async () => {
    // A run that never gets to park (someone moved the ticket between the read
    // and the write) must not be recorded as having parked.
    h.transitionTicket.mockResolvedValueOnce({ transitioned: false });
    const raced = await sweepPass("run-race");
    expect(raced).toEqual({ skipped: "lost-transition-race" });
    expect(store.steps).toHaveLength(0);

    const retried = await sweepPass("run-race");
    expect(retried).toMatchObject({ applied: true, decision: { action: "block" } });
  });
});

// The sibling park to check (and NOT to "fix"): the QA-gate refusal.
//
// Two writers author `devpilot_qa_gate` parks — role postprocess and the MCP
// move-ticket ceiling — and both execute INSIDE a live run, so no finished run
// can drive them; a re-park there means a new run genuinely failed the gate
// again, which is correct. The one stale-run-driven gate park is the
// reconciler's OWN (`gateBlocked`), and it is already idempotent because,
// unlike `block`, it sits BELOW the sweeper's already-reconciled check. That
// placement is the entire protection, so pin it: moving the gate path above
// that check — the natural way to "make it consistent" with the block branch —
// would open the identical wedge.
describe("the QA-gate park is not wedged the same way", () => {
  it("a second sweep after a human unblock short-circuits as already-reconciled", async () => {
    const gateRefusal = {
      code: "verification_failed",
      reason: "Hand-off to QA refused: the verification command `pnpm test` exited 1",
    };
    h.transitionTicket.mockImplementation(async (a: unknown) => {
      const arg = a as { to: string; expectedFrom?: string };
      if (arg.to === "in_review") return { transitioned: false, gateRefusal };
      if (arg.expectedFrom && arg.expectedFrom !== store.ticket.status) {
        return { transitioned: false };
      }
      store.ticket = { ...store.ticket, status: arg.to };
      return { transitioned: true };
    });
    store.ticket = { id: "t1", tenant_id: "tn", status: "in_progress" };

    const producerSweep = () =>
      reconcileTicketAfterRun({
        runId: "run-gate",
        tenantId: "tn",
        ticketId: "t1",
        role: "engineer",
        agentId: null,
        statusAtRunStart: null,
        postNext: null,
        runStartedAtIso: new Date(0).toISOString(),
      });

    expect(await producerSweep()).toMatchObject({ gateBlocked: true });
    expect(store.ticket.status).toBe("blocked");

    humanUnblocksTo("in_progress");
    expect(await producerSweep()).toEqual({ skipped: "already-reconciled" });
    expect(store.ticket.status).toBe("in_progress");
  });
});

describe("the park comment tells the operator something they can act on", () => {
  it("states that this run stands down, and names the real options", async () => {
    await sweepPass("run-1");
    const body = parkComments()[0]!.body;
    // The old text's only instruction was "unblock it once resolved" — which
    // the engine then undid. It must not promise that alone again.
    expect(body).toContain("will not park this ticket again");
    expect(body).toContain("in_progress");
    expect(body).toContain("done");
    expect(body).toContain("Discard & restart from dev");
  });

  it("is honest that a re-dispatch may be declined rather than promising a re-run", async () => {
    await sweepPass("run-1");
    expect(parkComments()[0]!.body).toContain("declines");
  });

  it("every move it recommends is a legal exit from `blocked`", async () => {
    // The trap this exists for: the FIRST draft of this comment told the
    // operator to "move the ticket back to in_review", which is NOT in
    // ALLOWED_TRANSITIONS.blocked — a plausible-sounding instruction that
    // silently does nothing when followed, which is worse than saying less.
    await sweepPass("run-1");
    const body = parkComments()[0]!.body;
    const legal = ALLOWED_TRANSITIONS.blocked as readonly string[];
    for (const status of ["in_progress", "done", "backlog"]) {
      expect(body).toContain(`\`${status}\``);
      expect(legal).toContain(status);
    }
    // …and it says so about the one an operator would otherwise reach for,
    // rather than recommending it.
    expect(legal).not.toContain("in_review");
    expect(body).toContain("`blocked → in_review` is not a legal move");
    expect(body).not.toContain("back to `in_review`");
    expect(body).not.toContain("move it to `in_review`");
  });
});
