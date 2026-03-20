// Blocker queries must read ONLY the blocking relation flavours.
//
// `ticket_dependencies` grew a `relation_type` discriminator when it was
// generalised into a multi-flavour relations table, but `fetchBlockerRows` kept
// selecting every row - so a `related` or `duplicate` row acted as a hard "not
// ready" blocker. @mentions auto-create `related` rows (`parse-mentions.ts`), so
// @mentioning a ticket that wasn't done yet silently wedged the commenter's own
// ticket out of `ready`, with nothing on the board explaining why.
//
// The fake below is the real PostgREST query SHAPE (`.eq(...).in(...)`), so a
// regression that drops the filter surfaces here as an open blocker, exactly as
// it would in Postgres.

import { describe, it, expect, beforeEach, vi } from "vitest";

type DepRow = { ticket_id: string; blocks_ticket_id: string; relation_type: string };
type TicketRow = { id: string; status: string; title: string; tenant_id: string };

const store = vi.hoisted(() => ({
  deps: [] as DepRow[],
  tickets: [] as TicketRow[],
}));

class Q {
  private eqs: Record<string, unknown> = {};
  private ins: Record<string, unknown[]> = {};
  constructor(private table: string) {}
  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.eqs[col] = val;
    return this;
  }
  in(col: string, vals: readonly unknown[]): this {
    this.ins[col] = [...vals];
    return this;
  }
  private rows(): unknown[] {
    const src: Record<string, unknown>[] =
      this.table === "ticket_dependencies"
        ? (store.deps as unknown as Record<string, unknown>[])
        : (store.tickets as unknown as Record<string, unknown>[]);
    return src.filter(
      (r) =>
        Object.entries(this.eqs).every(([c, v]) => r[c] === v) &&
        Object.entries(this.ins).every(([c, vs]) => vs.includes(r[c])),
    );
  }
  then<T>(onF: (v: { data: unknown; error: unknown }) => T): Promise<T> {
    return Promise.resolve(onF({ data: this.rows(), error: null }));
  }
}

vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({ from: (t: string) => new Q(t) }),
  supabaseServer: async () => ({ from: (t: string) => new Q(t) }),
}));

import { BLOCKING_RELATION_TYPES, hasOpenBlockers, loadBlockers } from "@/lib/board/dependencies";

const TENANT = "tenant-a";
const OPEN = { id: "open-ticket", status: "in_progress", title: "Still open", tenant_id: TENANT };

beforeEach(() => {
  store.tickets = [OPEN];
  store.deps = [];
});

describe("only blocking relation flavours block readiness", () => {
  it("a `related` row (an @mention) does NOT block - the wedge this fixes", async () => {
    store.deps = [{ ticket_id: "t1", blocks_ticket_id: OPEN.id, relation_type: "related" }];
    expect(await hasOpenBlockers("t1", TENANT)).toBe(false);
    expect(await loadBlockers("t1", TENANT)).toHaveLength(0);
  });

  it("a `duplicate` row does NOT block", async () => {
    store.deps = [{ ticket_id: "t1", blocks_ticket_id: OPEN.id, relation_type: "duplicate" }];
    expect(await hasOpenBlockers("t1", TENANT)).toBe(false);
  });

  it("a `blocked_by` row still blocks while its blocker is open", async () => {
    store.deps = [{ ticket_id: "t1", blocks_ticket_id: OPEN.id, relation_type: "blocked_by" }];
    expect(await hasOpenBlockers("t1", TENANT)).toBe(true);
    expect(await loadBlockers("t1", TENANT)).toHaveLength(1);
  });

  it("a `builds_on` row still blocks - the parent branch must land first", async () => {
    store.deps = [{ ticket_id: "t1", blocks_ticket_id: OPEN.id, relation_type: "builds_on" }];
    expect(await hasOpenBlockers("t1", TENANT)).toBe(true);
  });

  it("a done blocker stops blocking; a `related` open ticket never mattered", async () => {
    store.tickets = [
      { id: "done-ticket", status: "done", title: "Landed", tenant_id: TENANT },
      OPEN,
    ];
    store.deps = [
      { ticket_id: "t1", blocks_ticket_id: "done-ticket", relation_type: "blocked_by" },
      { ticket_id: "t1", blocks_ticket_id: OPEN.id, relation_type: "related" },
    ];
    expect(await hasOpenBlockers("t1", TENANT)).toBe(false);
  });

  it("mixed rows: the blocking one decides, the reference one is ignored", async () => {
    store.deps = [
      { ticket_id: "t1", blocks_ticket_id: OPEN.id, relation_type: "blocked_by" },
      { ticket_id: "t1", blocks_ticket_id: OPEN.id, relation_type: "related" },
    ];
    const blockers = await loadBlockers("t1", TENANT);
    // Only one row survives the filter - the reference row must not double-count.
    expect(blockers).toHaveLength(1);
    expect(await hasOpenBlockers("t1", TENANT)).toBe(true);
  });

  it("pins the blocking set - adding `related`/`duplicate` here re-opens the wedge", () => {
    expect([...BLOCKING_RELATION_TYPES]).toEqual(["blocked_by", "builds_on"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The blocker read is TENANT-SCOPED (defence in depth on the service-role path).
//
// Red on revert: delete the `.eq("tenant_id", …)` from `fetchBlockerRows` and
// the first test below fails — the foreign ticket resolves and blocks. These
// reads run on a service-role client with RLS off, and `tickets` carries its own
// `tenant_id`, so a clean blocker id does NOT imply a clean blocker row.
// ───────────────────────────────────────────────────────────────────────────

describe("blocker reads are scoped to the ticket's tenant", () => {
  const FOREIGN = {
    id: "foreign-ticket",
    status: "in_progress",
    title: "Another tenant's work",
    tenant_id: "tenant-b",
  };

  it("a blocker row pointing OUT of the tenant does not resolve, so it cannot block", async () => {
    store.tickets = [FOREIGN];
    store.deps = [{ ticket_id: "t1", blocks_ticket_id: FOREIGN.id, relation_type: "blocked_by" }];
    expect(await hasOpenBlockers("t1", TENANT)).toBe(false);
    expect(await loadBlockers("t1", TENANT)).toHaveLength(0);
  });

  it("an in-tenant blocker is unaffected — the predicate excludes nothing legitimate", async () => {
    store.tickets = [OPEN, FOREIGN];
    store.deps = [
      { ticket_id: "t1", blocks_ticket_id: OPEN.id, relation_type: "blocked_by" },
      { ticket_id: "t1", blocks_ticket_id: FOREIGN.id, relation_type: "blocked_by" },
    ];
    const blockers = await loadBlockers("t1", TENANT);
    expect(blockers.map((b) => b.id)).toEqual([OPEN.id]);
    expect(await hasOpenBlockers("t1", TENANT)).toBe(true);
  });
});
