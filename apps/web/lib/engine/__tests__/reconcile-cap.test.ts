// The reconcile cap: per PHASE, and visible to the operator when it freezes.
//
// Before: MAX_RECONCILES_PER_TICKET counted every reconciler comment over the
// ticket's whole LIFETIME, so a long-lived ticket that stranded once during
// refinement, once during implementation and once during review was frozen on
// its fourth strand - three unrelated hiccups spread over days read as one
// runaway loop. And the freeze was announced only to `console.warn`: the ticket
// just stopped moving, with nothing on the board saying why.
//
// After: the count resets whenever the ticket makes real forward progress under
// its own power (an agent's `devpilot_move_ticket` verdict = a new phase), and the
// freeze posts an operator-visible comment - once per phase, because the sweeper
// re-reaches this branch every 5 minutes.
//
// The runaway case must still trip: an agent that never advances its ticket
// produces no verdict, so its phase never rolls over.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Comment = {
  ticket_id: string;
  tenant_id: string;
  author_type: string;
  author_id: string;
  body: string;
  created_at: string;
};

const store = vi.hoisted(() => ({
  ticket: { id: "t1", tenant_id: "tn", status: "in_progress" },
  comments: [] as Comment[],
  now: 0,
}));

/** Monotonic timestamps so ordering/`gt` comparisons are deterministic. */
function stamp(): string {
  store.now += 1000;
  return new Date(store.now).toISOString();
}

class Q {
  private eqs: Record<string, unknown> = {};
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
    return Promise.resolve({ data: null, error: null });
  }
  eq(col: string, val: unknown): this {
    this.eqs[col] = val;
    return this;
  }
  neq(): this {
    return this;
  }
  in(): this {
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
  private rows(): Comment[] {
    if (this.table !== "comments") return [];
    const rows = store.comments.filter(
      (c) =>
        Object.entries(this.eqs).every(
          ([col, val]) => (c as unknown as Record<string, unknown>)[col] === val,
        ) && Object.entries(this.gts).every(([col, val]) => String(c[col as keyof Comment]) > val),
    );
    return this.desc ? [...rows].reverse() : rows;
  }
  maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    if (this.table === "tickets") {
      return Promise.resolve({ data: store.ticket, error: null });
    }
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
  transitionTicket: vi.fn(async () => ({ transitioned: true })),
  inngestSend: vi.fn(async () => {}),
}));

// The reconciler pulls in the role loader, which transitively imports a
// `server-only`-guarded module. Neutralise the guard for the node test env.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/server", () => ({ supabaseService: () => ({ from: (t: string) => new Q(t) }) }));
vi.mock("@/lib/engine/inngest", () => ({ inngest: { send: h.inngestSend } }));
vi.mock("@/lib/board/transitions", () => ({
  transitionTicket: h.transitionTicket,
  // Real addComment writes through the same fake store the reads see.
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
  MAX_RECONCILES_PER_TICKET,
  RECONCILER_COMMENT_AUTHOR,
  RECONCILE_CAP_COMMENT_AUTHOR,
  reconcileTicketAfterRun,
} from "@/lib/engine/ticket-reconciler";

/** An engineer run that completed 'done' without advancing its ticket - the
 *  canonical strand. The policy decides `transition → in_review`. */
function strandedRun(runId = "run-1") {
  return reconcileTicketAfterRun({
    runId,
    tenantId: "tn",
    ticketId: "t1",
    role: "engineer",
    agentId: null,
    statusAtRunStart: "in_progress" as const,
    postNext: null,
    runStartedAtIso: null,
  });
}

function addTrail(authorId: string, n: number) {
  for (let i = 0; i < n; i++) {
    store.comments.push({
      ticket_id: "t1",
      tenant_id: "tn",
      author_type: "system",
      author_id: authorId,
      body: `#${i}`,
      created_at: stamp(),
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  store.now = 0;
  store.comments = [];
  store.ticket = { id: "t1", tenant_id: "tn", status: "in_progress" };
  h.transitionTicket.mockResolvedValue({ transitioned: true });
});

describe("the cap counts reconciles per PHASE, not per lifetime", () => {
  it("freezes after MAX_RECONCILES_PER_TICKET strands inside one phase", async () => {
    addTrail(RECONCILER_COMMENT_AUTHOR, MAX_RECONCILES_PER_TICKET);
    const res = await strandedRun();
    expect(res).toEqual({ skipped: "reconcile-cap-exceeded" });
    expect(h.transitionTicket).not.toHaveBeenCalled();
  });

  it("still repairs a ticket that stranded once per phase across a long life", async () => {
    // Three strands, each followed by a real agent verdict (`devpilot_move_ticket`)
    // that closed the phase. Under lifetime counting this fourth strand was
    // frozen; per-phase it is the FIRST of the current phase, so it is repaired.
    for (let phase = 0; phase < MAX_RECONCILES_PER_TICKET; phase++) {
      addTrail(RECONCILER_COMMENT_AUTHOR, 1);
      addTrail("devpilot_move_ticket", 1);
    }
    const res = await strandedRun();
    expect(res).toMatchObject({ applied: true });
    expect(h.transitionTicket).toHaveBeenCalledOnce();
  });

  it("a runaway agent still trips the cap - no verdict means no new phase", async () => {
    // The failure mode the cap exists for: every run completes without ever
    // calling devpilot_move_ticket, so nothing closes the phase.
    addTrail(RECONCILER_COMMENT_AUTHOR, MAX_RECONCILES_PER_TICKET + 2);
    const res = await strandedRun();
    expect(res).toEqual({ skipped: "reconcile-cap-exceeded" });
  });

  it("only reconciles AFTER the last verdict count toward the cap", async () => {
    addTrail(RECONCILER_COMMENT_AUTHOR, 10); // ancient history, another phase
    addTrail("devpilot_move_ticket", 1); // ← phase boundary
    addTrail(RECONCILER_COMMENT_AUTHOR, MAX_RECONCILES_PER_TICKET - 1);
    const res = await strandedRun();
    expect(res).toMatchObject({ applied: true });
  });
});

describe("a frozen ticket is surfaced to the operator", () => {
  beforeEach(() => {
    addTrail(RECONCILER_COMMENT_AUTHOR, MAX_RECONCILES_PER_TICKET);
  });

  it("posts a comment explaining the freeze, under its own author", async () => {
    await strandedRun();
    const notices = store.comments.filter((c) => c.author_id === RECONCILE_CAP_COMMENT_AUTHOR);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("reconcile cap");
    expect(notices[0]!.body).toContain("in_progress");
  });

  it("posts it ONCE per phase - the 5-min sweeper must not spam the thread", async () => {
    await strandedRun("run-1");
    await strandedRun("run-2");
    await strandedRun("run-3");
    expect(store.comments.filter((c) => c.author_id === RECONCILE_CAP_COMMENT_AUTHOR)).toHaveLength(
      1,
    );
  });

  it("the notice is not itself a reconcile attempt (own author, own counter)", async () => {
    await strandedRun();
    // If the notice were authored `ticket-reconciler` it would inflate the very
    // count that gates it - a self-feeding cap.
    expect(RECONCILE_CAP_COMMENT_AUTHOR).not.toBe(RECONCILER_COMMENT_AUTHOR);
    const reconcilerComments = store.comments.filter(
      (c) => c.author_id === RECONCILER_COMMENT_AUTHOR,
    );
    expect(reconcilerComments).toHaveLength(MAX_RECONCILES_PER_TICKET);
  });

  it("notices again in a NEW phase, after the ticket moved and re-stranded", async () => {
    await strandedRun("run-1");
    addTrail("devpilot_move_ticket", 1); // the ticket moved forward: new phase…
    addTrail(RECONCILER_COMMENT_AUTHOR, MAX_RECONCILES_PER_TICKET); // …and re-stranded to the cap
    await strandedRun("run-2");
    expect(store.comments.filter((c) => c.author_id === RECONCILE_CAP_COMMENT_AUTHOR)).toHaveLength(
      2,
    );
  });
});
