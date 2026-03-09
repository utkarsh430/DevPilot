// Minimal in-memory Supabase stand-in for the L1 seam integration tests.
//
// NOT a test file (no `.test.ts` suffix, so vitest never collects it). It
// implements only the query shapes `transitionTicket` / `addComment` /
// `applyEngineerPost` actually use — a tickets store and a comments log — so we
// can drive the REAL `transitionTicket` (and the real engineer postprocess
// recovery) end-to-end and assert on the resulting ticket status + comments,
// which is exactly what the first attempt's wrong-seam bug slipped past.
//
// Supported chains:
//   from("tickets").select(cols).eq("id", id).single()
//   from("tickets").update(patch).eq("id", id)[.eq("status", s)].select("id")
//   from("comments").insert(row)
//   from("comments").select(cols).eq(...)                (unpushed-work idempotency read)
//   from("pending_pushes").select(cols).eq("ticket_id", id)
//   from("runs").update(patch).eq("id", id)              (branch_key persist)

export type TicketRow = {
  status: string;
  retry_count: number;
  /** B2 — the QA-GATE refusal counter, deliberately distinct from
   *  `retry_count` (the engineer<->QA reject loop's). Modelled separately here
   *  precisely so a test can prove the gate writes this one and not that one;
   *  collapsing them in the fake would make that assertion vacuous. */
  gate_retry_count?: number;
  safety_critical?: boolean;
  /** The plan-hold marker (migration 20260727000000). Same fail-open logic as
   *  `safety_critical`: only surfaced when the read selects it. */
  plan_hold?: boolean;
  /** The ticket's own tenant — the scope the seam hands to the L1 gate's
   *  service-role verification read. Same projection logic as the two above:
   *  only surfaced when selected, so a seam that stops selecting it reads
   *  `undefined` and the mis-scoping is visible rather than silent. */
  tenant_id?: string;
};
export type CommentRow = {
  ticket_id?: string;
  /** The row's own tenant. Modelled because the comment READS that hang off a
   *  ticket (the unpushed-work notice's idempotency check, the reconciler's
   *  verdict probe) are tenant-scoped, so a fake that dropped the column on
   *  insert would make every such read miss and look like a duplicate-notice
   *  bug rather than a fixture gap. */
  tenant_id?: string;
  author_type: string;
  author_id: string;
  body: string;
  metadata?: Record<string, unknown> | null;
};
/** Enough of `pending_pushes` for the unpushed-work notice on `→ done`. */
export type PendingPushRow = {
  id: string;
  ticket_id: string;
  branch: string;
  workspace_path: string;
  pushed_at: string | null;
  unpushed_count: number | null;
};

export type FakeSupabase = {
  client: unknown;
  tickets: Map<string, TicketRow>;
  comments: CommentRow[];
  pendingPushes: PendingPushRow[];
  /** The column list passed to the last `tickets` READ `.select(...)` (not the
   *  update `.select("id")`). Lets a test pin that the seam still selects
   *  `safety_critical` — dropping it would fail-open the SME gate. */
  lastTicketSelect: string | null;
};

class Query {
  private mode: "select" | "update" | "insert" = "select";
  private eqs: Record<string, unknown> = {};
  private ins: Record<string, unknown[]> = {};
  private patch: Record<string, unknown> | null = null;
  private insertRow: Record<string, unknown> | null = null;
  private selectCols: string | null = null;

  constructor(
    private store: FakeSupabase,
    private table: string,
  ) {}

  select(cols?: string): this {
    // In read mode this is a no-op recorder; in update mode `.select("id")` is
    // the awaited terminal (handled by `then`). We record the READ column list
    // (mode still "select" — `update()`/`insert()` run BEFORE their `.select`)
    // so a test can prove the tickets read still asks for `safety_critical`;
    // the row we return then honours that list, so dropping the column from the
    // real seam fail-opens the SME gate here too, not silently.
    if (this.mode === "select" && typeof cols === "string") {
      this.selectCols = cols;
      if (this.table === "tickets") this.store.lastTicketSelect = cols;
    }
    return this;
  }
  update(patch: Record<string, unknown>): this {
    this.mode = "update";
    this.patch = patch;
    return this;
  }
  insert(row: Record<string, unknown>): this {
    this.mode = "insert";
    this.insertRow = row;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.eqs[col] = val;
    return this;
  }
  /** `.in(col, values)` - used by the blocker/promotion queries' relation_type
   *  filter. Recorded as a set-membership predicate for list reads. */
  in(col: string, vals: readonly unknown[]): this {
    this.ins[col] = [...vals];
    return this;
  }

  single(): Promise<{ data: unknown; error: unknown }> {
    return this.runRead(true);
  }
  maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    return this.runRead(false);
  }

  // Makes `await query` work for update-`.select("id")` and insert terminals.
  then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T): Promise<T> {
    return this.runWrite().then(onF, onR);
  }

  private matchTicketId(): string | null {
    const id = this.eqs.id as string | undefined;
    if (!id) return null;
    if (this.eqs.status !== undefined) {
      const row = this.store.tickets.get(id);
      if (!row || row.status !== this.eqs.status) return null;
    }
    return id;
  }

  private async runRead(single: boolean): Promise<{ data: unknown; error: unknown }> {
    if (this.table === "tickets") {
      const id = this.eqs.id as string | undefined;
      const row = id ? this.store.tickets.get(id) : undefined;
      if (!row)
        return single
          ? { data: null, error: { message: "not found" } }
          : { data: null, error: null };
      // Only surface `safety_critical` when the read actually selected it (or
      // `*`). This mirrors real Postgres: an omitted column is absent from the
      // row, so a seam that forgets to select it reads `undefined` → the gate
      // fail-opens. That makes "dropping the column" a visible test failure.
      const cols = this.selectCols ?? "";
      const includesSafety = cols.includes("*") || cols.includes("safety_critical");
      const includesPlanHold = cols.includes("*") || cols.includes("plan_hold");
      const includesTenant = cols.includes("*") || cols.includes("tenant_id");
      const includesGateRetry = cols.includes("*") || cols.includes("gate_retry_count");
      return {
        data: {
          status: row.status,
          retry_count: row.retry_count,
          ...(includesSafety ? { safety_critical: row.safety_critical === true } : {}),
          ...(includesPlanHold ? { plan_hold: row.plan_hold === true } : {}),
          ...(includesTenant ? { tenant_id: row.tenant_id ?? "tn" } : {}),
          ...(includesGateRetry ? { gate_retry_count: row.gate_retry_count ?? 0 } : {}),
        },
        error: null,
      };
    }
    return { data: null, error: null };
  }

  /** List reads: `await from(t).select(cols).eq(...)` with no single/maybeSingle. */
  private async runList(): Promise<{ data: unknown; error: unknown }> {
    if (this.table === "pending_pushes") {
      const ticketId = this.eqs.ticket_id as string | undefined;
      const rows = this.store.pendingPushes.filter(
        (r) => ticketId === undefined || r.ticket_id === ticketId,
      );
      return { data: rows, error: null };
    }
    if (this.table === "comments") {
      const rows = this.store.comments.filter(
        (c) =>
          Object.entries(this.eqs).every(
            ([col, val]) => (c as unknown as Record<string, unknown>)[col] === val,
          ) &&
          Object.entries(this.ins).every(([col, vals]) =>
            vals.includes((c as unknown as Record<string, unknown>)[col]),
          ),
      );
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  }

  private async runWrite(): Promise<{ data: unknown; error: unknown }> {
    if (this.mode === "insert") {
      if (this.table === "comments" && this.insertRow) {
        this.store.comments.push({
          ticket_id: this.insertRow.ticket_id as string | undefined,
          tenant_id: this.insertRow.tenant_id as string | undefined,
          author_type: String(this.insertRow.author_type),
          author_id: String(this.insertRow.author_id),
          body: String(this.insertRow.body),
          metadata: (this.insertRow.metadata as Record<string, unknown> | null) ?? null,
        });
      }
      return { data: null, error: null };
    }
    // An awaited SELECT with no `.single()`/`.maybeSingle()` — a list read.
    if (this.mode === "select") {
      return this.runList();
    }
    if (this.mode === "update") {
      if (this.table === "tickets" && this.patch) {
        const id = this.matchTicketId();
        if (!id) return { data: [], error: null }; // CAS miss / no match
        const row = this.store.tickets.get(id)!;
        if (typeof this.patch.status === "string") row.status = this.patch.status;
        if (typeof this.patch.retry_count === "number") row.retry_count = this.patch.retry_count;
        if (typeof this.patch.gate_retry_count === "number")
          row.gate_retry_count = this.patch.gate_retry_count;
        return { data: [{ id }], error: null };
      }
      // runs / other tables: accept silently.
      return { data: [], error: null };
    }
    return { data: null, error: null };
  }
}

export function makeFakeSupabase(
  tickets: Record<string, TicketRow>,
  pendingPushes: PendingPushRow[] = [],
): FakeSupabase {
  const store: FakeSupabase = {
    client: null,
    tickets: new Map(Object.entries(tickets).map(([id, r]) => [id, { ...r }])),
    comments: [],
    pendingPushes: pendingPushes.map((r) => ({ ...r })),
    lastTicketSelect: null,
  };
  store.client = { from: (table: string) => new Query(store, table) };
  return store;
}
