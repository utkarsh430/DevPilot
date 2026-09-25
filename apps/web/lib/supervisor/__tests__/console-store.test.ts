// The console's read and act path.
//
// The fake below ACTUALLY APPLIES `.eq` / `.in` / `.neq` / `.is`. That is the
// whole point: a fake that ignores filters makes every scoping assertion here
// vacuous, and this is exactly the "service-role read keyed on an
// attacker-controllable pointer" class AGENTS.md records recurring. Each scoping
// test is paired with a CONTROL that neuters the predicate and asserts the
// foreign row WOULD be picked up.
//
// It matters unusually much on this surface, because what a missing predicate
// produces is not a disclosure - it is a list of tickets the ACT half can then
// MOVE, on a board the operator is not looking at.

import { describe, expect, it, vi } from "vitest";
import {
  loadConsoleSnapshot,
  runConsoleAction,
  type ConsoleDeps,
} from "@/lib/supervisor/console-store";
import { classifyTicketState } from "@/lib/supervisor/console-facts";
import type { DispatchQueueGroup } from "@/lib/engine/dispatch-rescue-policy";

const OURS = "tenant-ours";
const THEIRS = "tenant-theirs";
const PROJECT = "proj-1";
const NOW = "2026-08-04T12:00:00.000Z";
/** Three hours old — comfortably past the 30-minute orphan grace. */
const STALE = "2026-08-04T09:00:00.000Z";

type Row = Record<string, unknown>;

function makeDb(
  tables: Record<string, Row[]>,
  opts: {
    ignoreTenantFilter?: boolean;
    /** Tables with NO `tenant_id` column: filtering on it errors 42703, as
     *  Postgres does. This is what makes the regression above non-vacuous. */
    tenantlessTables?: string[];
    /** Tables whose reads fail outright. */
    brokenTables?: string[];
  } = {},
) {
  const inserted: Array<{ table: string; row: Row }> = [];
  const db = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      let failed = opts.brokenTables?.includes(table) ? "read failed" : null;
      const builder = {
        select() {
          return builder;
        },
        insert(row: Row) {
          inserted.push({ table, row });
          return {
            ...builder,
            error: null,
            then: (r: (v: unknown) => unknown) => Promise.resolve(r({ error: null })),
          };
        },
        eq(col: string, val: unknown) {
          if (col === "tenant_id" && opts.tenantlessTables?.includes(table)) {
            failed = `column ${table}.tenant_id does not exist`;
            return builder;
          }
          if (col === "tenant_id" && opts.ignoreTenantFilter) return builder;
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        neq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] !== val);
          return builder;
        },
        is(col: string, val: unknown) {
          rows = rows.filter((r) =>
            val === null ? r[col] === null || r[col] === undefined : r[col] === val,
          );
          return builder;
        },
        or() {
          // The only `.or` in the read path is "status != done OR landed_sha is
          // null", which no fixture here exercises negatively; applying it as a
          // no-op keeps the fake honest about what it does NOT model.
          return builder;
        },
        in(col: string, vals: unknown[]) {
          rows = rows.filter((r) => vals.includes(r[col]));
          return builder;
        },
        lt(col: string, val: unknown) {
          rows = rows.filter((r) => String(r[col]) < String(val));
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(
            failed
              ? { data: null, error: { message: failed } }
              : { data: rows[0] ?? null, error: null },
          );
        },
        then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) {
          return Promise.resolve(
            resolve(
              failed ? { data: null, error: { message: failed } } : { data: rows, error: null },
            ),
          );
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, inserted };
}

function baseTables(over: { supervisorEnabled?: boolean; extraTickets?: Row[] } = {}) {
  return {
    projects: [
      {
        id: PROJECT,
        tenant_id: OURS,
        name: "scoursh",
        supervisor_enabled: over.supervisorEnabled ?? true,
        automation_state: "running",
      },
    ],
    tenants: [{ id: OURS, automation_state: "running" }],
    engine_liveness: [{ id: "recovery-cron", last_seen_at: NOW }],
    tickets: [
      {
        id: "t-ours",
        tenant_id: OURS,
        project_id: PROJECT,
        ticket_number: 27,
        title: "ours",
        status: "in_progress",
        requested_role: "engineer",
        updated_at: STALE,
        landed_sha: null,
        retry_count: 0,
        gate_retry_count: 0,
        safety_critical: false,
      },
      ...(over.extraTickets ?? []),
    ],
    runs: [] as Row[],
    comments: [] as Row[],
    ticket_dependencies: [] as Row[],
    dispatch_queue: [] as Row[],
    pending_pushes: [] as Row[],
    integration_queue: [] as Row[],
    supervisor_actions: [] as Row[],
  };
}

function makeDeps(db: unknown, over: Partial<ConsoleDeps> = {}): ConsoleDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    nowIso: NOW,
    loadQueueGroups: async () => [] as DispatchQueueGroup[],
    isAutomationPaused: async () => false,
    releaseQueue: async () => ({ reason: "unused", released: 0 }),
    recoverTicket: async () => ({ ok: true, recovered: true, to: "input_required" as const }),
    staleSeconds: 300,
    dispatchGraceSeconds: 600,
    orphanGraceSeconds: 1800,
    ...over,
  };
}

describe("loadConsoleSnapshot — tenant scoping", () => {
  it("refuses a project that belongs to another tenant", async () => {
    const { db } = makeDb({
      ...baseTables(),
      projects: [
        {
          id: PROJECT,
          tenant_id: THEIRS,
          name: "theirs",
          supervisor_enabled: true,
          automation_state: "running",
        },
      ],
    });
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    expect(res.ok).toBe(false);
  });

  it("CONTROL: with the tenant predicate neutered, the foreign project IS accepted", async () => {
    const { db } = makeDb(
      {
        ...baseTables(),
        projects: [
          {
            id: PROJECT,
            tenant_id: THEIRS,
            name: "theirs",
            supervisor_enabled: true,
            automation_state: "running",
          },
        ],
      },
      { ignoreTenantFilter: true },
    );
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    expect(res.ok).toBe(true);
  });

  it("never folds a foreign tenant's ticket into the snapshot", async () => {
    const tables = baseTables({
      extraTickets: [
        {
          id: "t-theirs",
          tenant_id: THEIRS,
          project_id: PROJECT,
          ticket_number: 99,
          title: "theirs",
          status: "in_progress",
          requested_role: null,
          updated_at: STALE,
          landed_sha: null,
          retry_count: 0,
          gate_retry_count: 0,
          safety_critical: false,
        },
      ],
    });
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.snapshot.tickets.map((t) => t.ticketId)).toEqual(["t-ours"]);
  });

  it("CONTROL: with the tenant predicate neutered, the foreign ticket appears", async () => {
    const tables = baseTables({
      extraTickets: [
        {
          id: "t-theirs",
          tenant_id: THEIRS,
          project_id: PROJECT,
          ticket_number: 99,
          title: "theirs",
          status: "in_progress",
          requested_role: null,
          updated_at: STALE,
          landed_sha: null,
          retry_count: 0,
          gate_retry_count: 0,
          safety_critical: false,
        },
      ],
    });
    const { db } = makeDb(tables, { ignoreTenantFilter: true });
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.snapshot.tickets.map((t) => t.ticketId)).toContain("t-theirs");
  });

  it("never attributes a foreign tenant's platform note to our ticket", async () => {
    const tables = baseTables();
    tables.comments = [
      {
        ticket_id: "t-ours",
        tenant_id: THEIRS,
        author_type: "system",
        author_id: "devpilot_qa_gate",
        body: "another board's refusal",
        created_at: NOW,
      },
    ];
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets[0]!.notice).toBeNull();
  });

  it("CONTROL: with the tenant predicate neutered, the foreign note is attributed", async () => {
    const tables = baseTables();
    tables.comments = [
      {
        ticket_id: "t-ours",
        tenant_id: THEIRS,
        author_type: "system",
        author_id: "devpilot_qa_gate",
        body: "another board's refusal",
        created_at: NOW,
      },
    ];
    const { db } = makeDb(tables, { ignoreTenantFilter: true });
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets[0]!.notice?.author).toBe("devpilot_qa_gate");
  });
});

describe("loadConsoleSnapshot — the facts it gathers", () => {
  it("derives a recoverable orphan for a ticket with no run and nothing queued", async () => {
    const { db } = makeDb(baseTables());
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    const t = res.result.snapshot.tickets[0]!;
    expect(t.orphan?.recoverable).toBe(true);
    expect(res.result.actions.map((a) => a.kind)).toEqual(["recover_stalled_ticket"]);
  });

  it("stands down when a live run exists — the never-damage guard", async () => {
    const tables = baseTables();
    tables.runs = [
      {
        ticket_id: "t-ours",
        tenant_id: OURS,
        status: "running",
        fan_out_group: null,
        last_event_at: NOW,
        created_at: NOW,
      },
    ];
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets[0]!.hasLiveRun).toBe(true);
    expect(res.result.actions).toEqual([]);
  });

  it("stands down when a dispatch is queued — the drain still owns it", async () => {
    const tables = baseTables();
    tables.dispatch_queue = [
      { ticket_id: "t-ours", tenant_id: OURS, status: "pending", agent_id: "a" },
    ];
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.actions).toEqual([]);
  });

  it("reads blockers WITHOUT a tenant predicate — `ticket_dependencies` has no such column", async () => {
    // THE REGRESSION. This console shipped with `.eq("tenant_id", …)` on the
    // dependency read; PostgREST answers 42703 and the whole read fails, so
    // EVERY ticket reported as having no blockers. Driving it against a real
    // board produced "DevPilot-92 is unblocked" for a ticket the database had
    // `blocked_by` an `in_review` parent.
    //
    // The fake below models the column's absence: any query that filters
    // `ticket_dependencies` on `tenant_id` errors, exactly as Postgres does.
    const tables = baseTables();
    tables.ticket_dependencies = [
      { ticket_id: "t-ours", blocks_ticket_id: "t-parent", relation_type: "blocked_by" },
    ];
    tables.tickets.push({
      id: "t-parent",
      tenant_id: OURS,
      project_id: PROJECT,
      ticket_number: 5,
      title: "parent",
      status: "in_review",
      requested_role: null,
      updated_at: STALE,
      landed_sha: null,
      retry_count: 0,
      gate_retry_count: 0,
      safety_critical: false,
    });
    const { db } = makeDb(tables, { tenantlessTables: ["ticket_dependencies"] });
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    const ours = res.result.snapshot.tickets.find((t) => t.ticketId === "t-ours")!;
    expect(ours.blockersKnown).toBe(true);
    expect(ours.blockers.map((b) => b.key)).toEqual(["DevPilot-5"]);
    expect(classifyTicketState(ours).kind).toBe("blocked_by_dependency");
  });

  it("a foreign blocker does not resolve, so it is dropped rather than rendered", async () => {
    // The boundary for this read is the ENDPOINTS: the dependency row carries no
    // tenant, so a row pointing out of the tenant must fail to resolve against
    // the tenant-scoped `tickets` read.
    const tables = baseTables();
    tables.ticket_dependencies = [
      { ticket_id: "t-ours", blocks_ticket_id: "t-foreign", relation_type: "blocked_by" },
    ];
    tables.tickets.push({
      id: "t-foreign",
      tenant_id: THEIRS,
      project_id: PROJECT,
      ticket_number: 5,
      title: "theirs",
      status: "in_review",
      requested_role: null,
      updated_at: STALE,
      landed_sha: null,
      retry_count: 0,
      gate_retry_count: 0,
      safety_critical: false,
    });
    const { db } = makeDb(tables, { tenantlessTables: ["ticket_dependencies"] });
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets.find((t) => t.ticketId === "t-ours")!.blockers).toEqual([]);
  });

  it("an unreadable dependency read NEVER reports as `unblocked`", async () => {
    // Fail-closed. Empty-because-we-could-not-look and empty-because-there-are-
    // none must not render the same sentence.
    const tables = baseTables();
    // A backlog ticket, because that is the state whose sentence is the claim
    // being tested: "unblocked, waiting for the drain".
    tables.tickets[0]!.status = "backlog";
    const { db } = makeDb(tables, { brokenTables: ["ticket_dependencies"] });
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    const ours = res.result.snapshot.tickets[0]!;
    expect(ours.blockersKnown).toBe(false);
    const d = classifyTicketState(ours);
    expect(d.kind).toBe("ready_to_start");
    expect(d.detail).toContain("could not be read");
    expect(d.detail).not.toContain("Unblocked");
  });

  it("does NOT put a landing verdict on a ticket that is still in flight", async () => {
    // `deriveLandingState` answers "where did this ticket's work end up", which
    // has no answer until the ticket is finished. An in-flight ticket with an
    // unpushed branch would otherwise report `not_landed (never_pushed)` -
    // reading as a failure when an agent is simply still working. Same rule the
    // board card applies via `landingCardTreatment`.
    const tables = baseTables();
    tables.pending_pushes = [
      {
        ticket_id: "t-ours",
        tenant_id: OURS,
        branch: "devpilot/in-flight",
        pushed_at: null,
        conflict_state: "clean",
        unpushed_count: 12,
        updated_at: STALE,
      },
    ];
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    const ours = res.result.snapshot.tickets[0]!;
    expect(ours.status).toBe("in_progress");
    expect(ours.landing).toBeNull();
    // …but the unpushed branch is still reported, as a neutral fact. It is the
    // data-loss-guard signal and is worth seeing on a stalled ticket.
    expect(ours.unpushedBranches).toEqual([{ branch: "devpilot/in-flight", commits: 12 }]);
  });

  it("DOES put a landing verdict on a settled ticket", async () => {
    const tables = baseTables();
    tables.tickets[0]!.status = "done";
    tables.integration_queue = [
      {
        ticket_id: "t-ours",
        tenant_id: OURS,
        status: "failed",
        last_error: "push rejected (non-fast-forward)",
        claimed_at: null,
        updated_at: STALE,
      },
    ];
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets[0]!.landing?.kind).toBe("not_landed");
  });

  it("ignores a `related` dependency row — only blocking relations block", async () => {
    // An @mention auto-creates a `related` row. Reporting it as a blocker is
    // the same bug class that once held real tickets out of `ready`.
    const tables = baseTables();
    tables.ticket_dependencies = [
      {
        ticket_id: "t-ours",
        tenant_id: OURS,
        blocks_ticket_id: "t-other",
        relation_type: "related",
      },
    ];
    tables.tickets.push({
      id: "t-other",
      tenant_id: OURS,
      project_id: PROJECT,
      ticket_number: 5,
      title: "mentioned",
      status: "in_progress",
      updated_at: STALE,
      landed_sha: null,
      requested_role: null,
      retry_count: 0,
      gate_retry_count: 0,
      safety_critical: false,
    });
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets.find((t) => t.ticketId === "t-ours")!.blockers).toEqual([]);
  });

  it("skips a noisy system author so the note that explains the ticket survives", async () => {
    const tables = baseTables();
    tables.comments = [
      {
        ticket_id: "t-ours",
        tenant_id: OURS,
        author_type: "system",
        author_id: "schedule:adhoc",
        body: "dispatched by schedule",
        created_at: "2026-08-04T11:00:00.000Z",
      },
      {
        ticket_id: "t-ours",
        tenant_id: OURS,
        author_type: "system",
        author_id: "devpilot_qa_gate",
        body: "Hand-off to QA refused: this ticket's branch adds no commits.",
        created_at: "2026-08-04T10:00:00.000Z",
      },
    ];
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), { tenantId: OURS, projectId: PROJECT });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets[0]!.notice?.author).toBe("devpilot_qa_gate");
  });
});

describe("loadConsoleSnapshot — a ticket the operator named", () => {
  function settledTicket(over: Record<string, unknown> = {}) {
    return {
      id: "t-settled",
      tenant_id: OURS,
      project_id: PROJECT,
      ticket_number: 86,
      title: "already landed",
      status: "done",
      requested_role: null,
      updated_at: STALE,
      landed_sha: "abc1234",
      retry_count: 0,
      gate_retry_count: 0,
      safety_critical: false,
      ...over,
    };
  }

  it("pulls in a ticket the base scan excluded", async () => {
    // The scan deliberately drops done-AND-landed work; the operator is still
    // entitled to ask about it, and "it landed" is a real answer.
    const tables = baseTables();
    tables.tickets.push(settledTicket());
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      focusTicketKeys: ["DevPilot-86"],
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets.map((t) => t.key)).toContain("DevPilot-86");
  });

  it("does not duplicate a ticket the scan already returned", async () => {
    const { db } = makeDb(baseTables());
    const res = await loadConsoleSnapshot(makeDeps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      focusTicketKeys: ["DevPilot-27"],
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets.filter((t) => t.key === "DevPilot-27")).toHaveLength(1);
  });

  it("never resolves a named key to ANOTHER TENANT's ticket", async () => {
    // `ticket_number` is per-project, so the number alone is not a boundary -
    // the co-located tenant and project predicates are.
    const tables = baseTables();
    tables.tickets.push(settledTicket({ tenant_id: THEIRS }));
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      focusTicketKeys: ["DevPilot-86"],
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets.map((t) => t.key)).not.toContain("DevPilot-86");
  });

  it("CONTROL: with the tenant predicate neutered, the foreign ticket IS pulled in", async () => {
    const tables = baseTables();
    tables.tickets.push(settledTicket({ tenant_id: THEIRS }));
    const { db } = makeDb(tables, { ignoreTenantFilter: true });
    const res = await loadConsoleSnapshot(makeDeps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      focusTicketKeys: ["DevPilot-86"],
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets.map((t) => t.key)).toContain("DevPilot-86");
  });

  it("never resolves a named key to another PROJECT's ticket", async () => {
    const tables = baseTables();
    tables.tickets.push(settledTicket({ project_id: "other-project" }));
    const { db } = makeDb(tables);
    const res = await loadConsoleSnapshot(makeDeps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      focusTicketKeys: ["DevPilot-86"],
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.result.snapshot.tickets.map((t) => t.key)).not.toContain("DevPilot-86");
  });

  it("ignores a malformed key rather than querying on it", async () => {
    const { db } = makeDb(baseTables());
    const res = await loadConsoleSnapshot(makeDeps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      focusTicketKeys: ["DevPilot-abc", "'; drop table tickets; --", ""],
    });
    expect(res.ok).toBe(true);
  });
});

describe("runConsoleAction — the gate and the re-derivation", () => {
  it("refuses every action when supervision is off for the project", async () => {
    const { db } = makeDb(baseTables({ supervisorEnabled: false }));
    const recoverTicket = vi.fn();
    const res = await runConsoleAction(makeDeps(db, { recoverTicket }), {
      tenantId: OURS,
      projectId: PROJECT,
      actionId: "recover_stalled_ticket:t-ours",
      requestedBy: "operator u1",
    });
    expect(res.ok).toBe(false);
    // The primitive is never reached, so the gate is a gate rather than a label.
    expect(recoverTicket).not.toHaveBeenCalled();
  });

  it("refuses an action id the board does not currently offer, without calling the primitive", async () => {
    // A forged POST and a hallucinated model recommendation reduce to the same
    // thing: naming a target that is not on the freshly derived list.
    const { db } = makeDb(baseTables());
    const recoverTicket = vi.fn();
    const res = await runConsoleAction(makeDeps(db, { recoverTicket }), {
      tenantId: OURS,
      projectId: PROJECT,
      actionId: "recover_stalled_ticket:some-other-ticket",
      requestedBy: "operator u1",
    });
    expect(res.ok).toBe(false);
    expect(recoverTicket).not.toHaveBeenCalled();
  });

  it("routes an offered recovery to the primitive and reports what it did", async () => {
    const { db, inserted } = makeDb(baseTables());
    const recoverTicket = vi.fn(async () => ({
      ok: true as const,
      recovered: true as const,
      to: "input_required" as const,
    }));
    const res = await runConsoleAction(makeDeps(db, { recoverTicket }), {
      tenantId: OURS,
      projectId: PROJECT,
      actionId: "recover_stalled_ticket:t-ours",
      requestedBy: "operator u1",
    });
    expect(res).toMatchObject({ ok: true, applied: true });
    expect(recoverTicket).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-ours", tenant_id: OURS }),
    );
    // And it says the ticket was NOT re-run, which is the thing "unstick" hides.
    if (res.ok && res.applied) expect(res.summary).toContain("NOT been re-run");
    expect(inserted.map((i) => i.table)).toContain("supervisor_actions");
  });

  it("records a commanded fix under the SAME cause the autonomous supervisor uses", async () => {
    // Splitting the cause would read as tidier and would silently re-open the
    // hole this ledger exists for: `detectRepeatDefect` groups on cause, so a
    // separate one would stop the indictment ever seeing an operator's own
    // repeated sweeps - which are the ones that caused the incident.
    const { db, inserted } = makeDb(baseTables());
    await runConsoleAction(makeDeps(db), {
      tenantId: OURS,
      projectId: PROJECT,
      actionId: "recover_stalled_ticket:t-ours",
      requestedBy: "operator u1",
    });
    const row = inserted.find((i) => i.table === "supervisor_actions")!.row;
    expect(row.cause).toBe("stalled_ticket");
    // …while staying distinguishable from an automatic one.
    expect(row.action).toBe("operator:recover_ticket");
    expect(String(row.detail)).toContain("operator u1");
    expect(row.tenant_id).toBe(OURS);
  });

  it("reports a primitive's refusal instead of working around it, and writes NO ledger row", async () => {
    // A refusal is the safety mechanism working. Recording it as a fix would
    // both lie in the audit trail and inflate the repeat-defect count.
    const { db, inserted } = makeDb(baseTables());
    const recoverTicket = vi.fn(async () => ({
      ok: true as const,
      recovered: false as const,
      reason: "within-grace",
    }));
    const res = await runConsoleAction(makeDeps(db, { recoverTicket }), {
      tenantId: OURS,
      projectId: PROJECT,
      actionId: "recover_stalled_ticket:t-ours",
      requestedBy: "operator u1",
    });
    expect(res).toMatchObject({ ok: true, applied: false, reason: "within-grace" });
    if (res.ok && !res.applied) expect(res.summary).toContain("not written at the same instant");
    expect(inserted.filter((i) => i.table === "supervisor_actions")).toEqual([]);
  });

  it("releases a queue group through the primitive when one is offered", async () => {
    const group: DispatchQueueGroup = {
      tenantId: OURS,
      agentId: "agent-eng",
      wipLimit: 3,
      runningRuns: 0,
      waitingRuns: 0,
      pendingRows: 2,
      oldestPendingIso: "2026-08-04T11:00:00.000Z",
    };
    const { db, inserted } = makeDb(baseTables());
    const releaseQueue = vi.fn(async () => ({
      reason: "the release event never arrived",
      released: 2,
    }));
    const res = await runConsoleAction(
      makeDeps(db, { releaseQueue, loadQueueGroups: async () => [group] }),
      {
        tenantId: OURS,
        projectId: PROJECT,
        actionId: "release_dispatch_queue:agent-eng",
        requestedBy: "operator u1",
      },
    );
    expect(res).toMatchObject({ ok: true, applied: true });
    expect(releaseQueue).toHaveBeenCalledWith(group);
    const row = inserted.find((i) => i.table === "supervisor_actions")!.row;
    expect(row.cause).toBe("board_deadlock");
    expect(row.action).toBe("operator:release_dispatch_queue");
  });
});
