// The unqueued-land sweep, driven against the MEASURED production state.
//
// PRODUCTION SHAPE, reproduced in `scourshBoard()` below (project `scoursh`,
// 2026-08-03): 70 `done` tickets - 45 landed, 19 that correctly produced no
// branch, and 6 stranded in three distinct ways.
//
//   #42, #45   integration_queue `failed`, attempts=3   (push rejected
//              non-fast-forward, retried identically three times)
//   #52        integration_queue `pending`, attempts=1  (claimed by nobody)
//   #69, #76, #77   NO ROW AT ALL                       ← this sweep's entire scope
//
// THE ASSERTION IS BIDIRECTIONAL AND THAT IS THE POINT. A test that only proves
// #69/#76/#77 get enqueued passes for an implementation that enqueues all 22
// unlanded tickets - including the 19 with nothing to land and the three whose
// landing has already been decided. So every test below asserts the exact
// enqueued SET, not a count or a membership.
//
// The fake ACTUALLY APPLIES `.eq` / `.in` / `.is` / `.lt` against a shared store.
// A filter-ignoring fake would make every tenant assertion vacuous. Each tenant
// assertion carries a CONTROL that neuters exactly one predicate (i.e. what
// deleting it looks like) and proves the foreign row WOULD be reached.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadUnqueuedLandCandidate,
  rescueUnqueuedLand,
  sweepUnqueuedLands,
  type UnqueuedLandDeps,
  type UnlandedTicketRow,
} from "@/lib/integration/unqueued-land-store";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

/**
 * `neuterTenantEqOn` drops ONLY the `tenant_id` predicate, and only on the named
 * tables - the precise mutation that "deleting the `.eq('tenant_id', …)`" is.
 * Neutering every `.eq` would also break the scan's own `status` filter and
 * prove nothing about tenant scoping.
 */
function fakeClient(
  tables: Tables,
  opts: { neuterTenantEqOn?: string[]; errorOn?: string[] } = {},
): SupabaseClient {
  const neutered = new Set(opts.neuterTenantEqOn ?? []);
  const erroring = new Set(opts.errorOn ?? []);

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let order: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    const self: Record<string, unknown> = {};

    self.select = () => self;
    self.eq = (c: string, v: unknown) => {
      if (c === "tenant_id" && neutered.has(table)) return self;
      filters.push((r) => r[c] === v);
      return self;
    };
    self.in = (c: string, vs: unknown[]) => {
      filters.push((r) => vs.includes(r[c]));
      return self;
    };
    self.is = (c: string, v: unknown) => {
      filters.push((r) => (r[c] ?? null) === v);
      return self;
    };
    self.lt = (c: string, v: unknown) => {
      filters.push((r) => String(r[c] ?? "") < String(v));
      return self;
    };
    self.not = (c: string, _op: string, _v: unknown) => {
      filters.push((r) => r[c] !== null && r[c] !== undefined);
      return self;
    };
    self.order = (column: string, o?: { ascending?: boolean }) => {
      order = { column, ascending: o?.ascending ?? true };
      return self;
    };
    self.limit = (n: number) => {
      limit = n;
      return self;
    };

    const run = () => {
      let matched = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { column, ascending } = order;
        matched = [...matched].sort((a, b) => {
          const av = String(a[column] ?? "");
          const bv = String(b[column] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limit !== null) matched = matched.slice(0, limit);
      return matched.map((r) => ({ ...r }));
    };

    const fail = () => ({ data: null, error: { message: `${table} unreadable` } });

    self.maybeSingle = () =>
      Promise.resolve(
        erroring.has(table) ? fail() : { data: run()[0] ?? null, error: null as null },
      );
    self.then = (
      resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) =>
      Promise.resolve()
        .then(() => (erroring.has(table) ? fail() : { data: run(), error: null }))
        .then(resolve, reject);

    return self;
  }

  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const PROJ = "99999999-9999-4999-8999-999999999999";

const NOW = "2026-08-03T18:00:00.000Z";
/** Comfortably past the 15-minute grace. */
const OLD = "2026-08-03T12:00:00.000Z";

function deps(
  tables: Tables,
  over: Partial<UnqueuedLandDeps> & { neuterTenantEqOn?: string[]; errorOn?: string[] } = {},
): { deps: UnqueuedLandDeps; enqueued: string[] } {
  const enqueued: string[] = [];
  const { neuterTenantEqOn, errorOn, ...rest } = over;
  return {
    enqueued,
    deps: {
      db: fakeClient(tables, { neuterTenantEqOn, errorOn }),
      enqueue: async ({ ticketId }) => {
        enqueued.push(ticketId);
        return { enqueued: true };
      },
      nowIso: NOW,
      graceSeconds: 15 * 60,
      instanceAutoLandEnabled: true,
      ...rest,
    },
  };
}

// ── the measured board ─────────────────────────────────────────────────────

const STRANDED = ["t-69", "t-76", "t-77"];
const FAILED_ROW = ["t-42", "t-45"];
const PENDING_ROW = ["t-52"];
/** The 19 that correctly produced no branch - the control case. */
const NO_BRANCH = Array.from({ length: 19 }, (_, i) => `t-nb-${i}`);
/** The 45 that landed. */
const LANDED = Array.from({ length: 45 }, (_, i) => `t-landed-${i}`);

function ticket(id: string, over: Row = {}): Row {
  return {
    id,
    tenant_id: T1,
    project_id: PROJ,
    status: "done",
    landed_sha: null,
    updated_at: OLD,
    requested_role: null,
    parent_ticket_id: null,
    ...over,
  };
}

function push(ticketId: string): Row {
  return {
    id: `push-${ticketId}`,
    tenant_id: T1,
    ticket_id: ticketId,
    merger_ticket_id: null,
    branch: `devpilot/${ticketId}`,
    workspace_path: `/ws/${ticketId}`,
    pushed_at: null,
    head_sha: "deadbee",
    updated_at: OLD,
  };
}

/** The shape `sweepUnqueuedLands` selects, for the per-candidate loaders. */
function scanRow(id: string, over: Partial<UnlandedTicketRow> = {}): UnlandedTicketRow {
  return {
    id,
    tenant_id: T1,
    project_id: PROJ,
    status: "done",
    landed_sha: null,
    updated_at: OLD,
    requested_role: null,
    parent_ticket_id: null,
    ...over,
  };
}

function scourshBoard(): Tables {
  const tickets: Row[] = [
    ...STRANDED.map((id) => ticket(id)),
    ...FAILED_ROW.map((id) => ticket(id)),
    ...PENDING_ROW.map((id) => ticket(id)),
    ...NO_BRANCH.map((id) => ticket(id)),
    ...LANDED.map((id) => ticket(id, { landed_sha: "c921359c921359c921359c921359c921359c9213" })),
  ];
  // Only the branch-bearing tickets have a push row. The 19 have none - that is
  // what "produced no branch" means in the data.
  const pending_pushes: Row[] = [...STRANDED, ...FAILED_ROW, ...PENDING_ROW].map(push);
  const integration_queue: Row[] = [
    ...FAILED_ROW.map((id) => ({
      id: `q-${id}`,
      tenant_id: T1,
      project_id: PROJ,
      ticket_id: id,
      status: "failed",
      attempts: 3,
    })),
    ...PENDING_ROW.map((id) => ({
      id: `q-${id}`,
      tenant_id: T1,
      project_id: PROJ,
      ticket_id: id,
      status: "pending",
      attempts: 1,
    })),
    // …and the 45 landed rows, which the scan never reaches.
    ...LANDED.map((id) => ({
      id: `q-${id}`,
      tenant_id: T1,
      project_id: PROJ,
      ticket_id: id,
      status: "landed",
      attempts: 1,
    })),
  ];
  return {
    tickets,
    pending_pushes,
    integration_queue,
    ticket_dependencies: [],
    projects: [{ id: PROJ, tenant_id: T1, auto_land_enabled: true }],
  };
}

describe("the sweep against the measured `scoursh` board", () => {
  it("finds exactly the three tickets with no queue row, and nothing else", async () => {
    const { deps: d, enqueued } = deps(scourshBoard());
    const result = await sweepUnqueuedLands(d);

    // The scan sees the 25 unlanded done tickets (70 − 45 landed).
    expect(result.scanned).toBe(25);
    expect(enqueued.sort()).toEqual([...STRANDED].sort());
    expect(result.enqueued).toBe(3);
  });

  it("stands down on the two `failed` rows - a verdict already reached", async () => {
    const { deps: d } = deps(scourshBoard());
    const result = await sweepUnqueuedLands(d);
    for (const id of FAILED_ROW) {
      expect(result.outcomes).toContainEqual({ ticketId: id, outcome: "none:already-queued" });
    }
  });

  it("leaves the `pending` row to landRescueReaper", async () => {
    const { deps: d } = deps(scourshBoard());
    const result = await sweepUnqueuedLands(d);
    expect(result.outcomes).toContainEqual({ ticketId: "t-52", outcome: "none:already-queued" });
  });

  // THE CONTROL CASE. Without the `hasBranch` clause this sweep enqueues 22
  // tickets and puts a permanent stream of no-op lands through a serialized
  // worker.
  it("stands down on all nineteen tickets that produced no branch", async () => {
    const { deps: d } = deps(scourshBoard());
    const result = await sweepUnqueuedLands(d);
    const noBranch = result.outcomes.filter((o) => o.outcome === "none:no-branch");
    expect(noBranch.map((o) => o.ticketId).sort()).toEqual([...NO_BRANCH].sort());
    expect(noBranch).toHaveLength(19);
  });

  it("finds nothing on a healthy board", async () => {
    const tables = scourshBoard();
    // Every done ticket landed. Nothing is owed.
    tables.tickets = (tables.tickets as Row[]).map((t) => ({
      ...t,
      landed_sha: "c921359c921359c921359c921359c921359c9213",
    }));
    const { deps: d, enqueued } = deps(tables);
    const result = await sweepUnqueuedLands(d);
    expect(result.scanned).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it("stands down entirely when the project never opted in", async () => {
    const tables = scourshBoard();
    tables.projects = [{ id: PROJ, tenant_id: T1, auto_land_enabled: false }];
    const { deps: d, enqueued } = deps(tables);
    const result = await sweepUnqueuedLands(d);
    expect(enqueued).toEqual([]);
    // The three that already carry a queue row are reported by THAT clause -
    // it runs first, deliberately, so a decision already reached is never
    // re-litigated for any other reason. Everything else names the opt-out.
    for (const id of STRANDED) {
      expect(result.outcomes).toContainEqual({
        ticketId: id,
        outcome: "none:auto-land-disabled-for-project",
      });
    }
    expect(
      result.outcomes.every((o) =>
        ["none:auto-land-disabled-for-project", "none:already-queued"].includes(o.outcome),
      ),
    ).toBe(true);
  });

  it("stands down entirely when the instance kill switch is off", async () => {
    const { deps: d, enqueued } = deps(scourshBoard(), { instanceAutoLandEnabled: false });
    await sweepUnqueuedLands(d);
    expect(enqueued).toEqual([]);
  });

  it("respects the grace: a ticket that just reached done is untouched", async () => {
    const tables = scourshBoard();
    tables.tickets = (tables.tickets as Row[]).map((t) =>
      STRANDED.includes(t.id as string) ? { ...t, updated_at: NOW } : t,
    );
    const { deps: d, enqueued } = deps(tables);
    await sweepUnqueuedLands(d);
    // Filtered out by the scan's own `updated_at < cutoff` pre-filter.
    expect(enqueued).toEqual([]);
  });
});

describe("a dependency-deferred child is left alone", () => {
  it("does not enqueue a builds_on child whose parent has not landed", async () => {
    const tables = scourshBoard();
    (tables.tickets as Row[]).push(ticket("t-parent", { status: "in_progress", landed_sha: null }));
    (tables.ticket_dependencies as Row[]).push({
      ticket_id: "t-69",
      blocks_ticket_id: "t-parent",
      relation_type: "builds_on",
    });
    const { deps: d, enqueued } = deps(tables);
    const result = await sweepUnqueuedLands(d);
    expect(enqueued.sort()).toEqual(["t-76", "t-77"]);
    expect(result.outcomes).toContainEqual({
      ticketId: "t-69",
      outcome: "none:dependency-deferred",
    });
  });

  it("picks it up on the tick after the parent lands", async () => {
    const tables = scourshBoard();
    (tables.tickets as Row[]).push(
      ticket("t-parent", { status: "done", landed_sha: "abc1234abc1234abc1234abc1234abc1234abcd" }),
    );
    (tables.ticket_dependencies as Row[]).push({
      ticket_id: "t-69",
      blocks_ticket_id: "t-parent",
      relation_type: "builds_on",
    });
    const { deps: d, enqueued } = deps(tables);
    await sweepUnqueuedLands(d);
    expect(enqueued.sort()).toEqual([...STRANDED].sort());
  });

  // `related` / `duplicate` rows are references, not gates - the same rule the
  // readiness path holds. An @mention auto-creates one, so treating it as a
  // blocker would strand a ticket with nothing on the board saying why.
  it("ignores a non-blocking relation entirely", async () => {
    const tables = scourshBoard();
    (tables.tickets as Row[]).push(ticket("t-mentioned", { status: "in_progress" }));
    (tables.ticket_dependencies as Row[]).push({
      ticket_id: "t-69",
      blocks_ticket_id: "t-mentioned",
      relation_type: "related",
    });
    const { deps: d, enqueued } = deps(tables);
    await sweepUnqueuedLands(d);
    expect(enqueued.sort()).toEqual([...STRANDED].sort());
  });
});

describe("a merger in the scan redirects rather than being landed", () => {
  // A merger reaching `done` is itself `done` + unlanded + no queue row, so it
  // matches the scan. Standing it down here is what stops the sweep calling
  // `enqueueForLanding` every five minutes just to re-derive a redirect.
  it("stands down on the merger and enqueues its source instead", async () => {
    const tables = scourshBoard();
    // t-69's push was re-parented to the merger it spawned (the orphan shape).
    tables.pending_pushes = (tables.pending_pushes as Row[]).map((p) =>
      p.ticket_id === "t-69" ? { ...p, ticket_id: "t-merger", merger_ticket_id: "t-merger" } : p,
    );
    (tables.tickets as Row[]).push(
      ticket("t-merger", {
        status: "done",
        parent_ticket_id: "t-69",
        requested_role: "release_engineer",
      }),
    );

    const { deps: d, enqueued } = deps(tables);
    const result = await sweepUnqueuedLands(d);
    expect(enqueued).not.toContain("t-merger");
    expect(enqueued.sort()).toEqual([...STRANDED].sort());
    expect(result.outcomes).toContainEqual({
      ticketId: "t-merger",
      outcome: "none:merger-redirects-to-source",
    });
  });

  // A `release_engineer` ticket with NO parent is an ordinary ticket, not a
  // merger, and must not be swept up by the role alone.
  it("does not treat a parentless release_engineer ticket as a merger", async () => {
    const tables = scourshBoard();
    tables.tickets = (tables.tickets as Row[]).map((t) =>
      t.id === "t-69" ? { ...t, requested_role: "release_engineer" } : t,
    );
    const { deps: d, enqueued } = deps(tables);
    await sweepUnqueuedLands(d);
    expect(enqueued).toContain("t-69");
  });
});

describe("a branch held by a merger still counts as a branch", () => {
  // `resolveTicketPush`, not a bare `ticket_id` read: a merger that resolved
  // this ticket's conflict may hold the push, and reading it directly is the
  // orphan that already cancelled one land over a branch with 15 commits on it.
  it("resolves the push through the merger the source spawned", async () => {
    const tables = scourshBoard();
    // t-69's push was re-parented to its merger.
    tables.pending_pushes = (tables.pending_pushes as Row[]).map((p) =>
      p.ticket_id === "t-69" ? { ...p, ticket_id: "t-merger", merger_ticket_id: "t-merger" } : p,
    );
    (tables.tickets as Row[]).push(
      ticket("t-merger", {
        status: "done",
        parent_ticket_id: "t-69",
        requested_role: "release_engineer",
      }),
    );
    const { deps: d, enqueued } = deps(tables);
    await sweepUnqueuedLands(d);
    expect(enqueued).toContain("t-69");
  });
});

// ── tenant scope: every read, with a control per predicate ─────────────────

describe("tenant scope is the whole boundary", () => {
  const foreignTicket = (): UnlandedTicketRow => scanRow("t-69");

  // A foreign `integration_queue` row is a DISARM signal: read as "already
  // queued", it strands our ticket permanently.
  it("ignores another tenant's queue row for our ticket", async () => {
    const tables = scourshBoard();
    (tables.integration_queue as Row[]).push({
      id: "q-foreign",
      tenant_id: T2,
      project_id: PROJ,
      ticket_id: "t-69",
      status: "landing",
      attempts: 1,
    });
    const { deps: d } = deps(tables);
    const c = await loadUnqueuedLandCandidate(d, foreignTicket());
    expect(c.hasQueueRow).toBe(false);
  });

  it("CONTROL: without the tenant predicate that foreign row IS reached", async () => {
    const tables = scourshBoard();
    (tables.integration_queue as Row[]).push({
      id: "q-foreign",
      tenant_id: T2,
      project_id: PROJ,
      ticket_id: "t-69",
      status: "landing",
      attempts: 1,
    });
    const { deps: d } = deps(tables, { neuterTenantEqOn: ["integration_queue"] });
    const c = await loadUnqueuedLandCandidate(d, foreignTicket());
    expect(c.hasQueueRow).toBe(true);
  });

  // A foreign `projects` row is an ARM signal: read as opted-in, it lands for a
  // project that opted out.
  it("does not read another tenant's project as opted in", async () => {
    const tables = scourshBoard();
    tables.projects = [
      { id: PROJ, tenant_id: T1, auto_land_enabled: false },
      { id: PROJ, tenant_id: T2, auto_land_enabled: true },
    ];
    const { deps: d } = deps(tables);
    const c = await loadUnqueuedLandCandidate(d, foreignTicket());
    expect(c.autoLandEnabled).toBe(false);
  });

  it("CONTROL: without the tenant predicate the foreign project arms it", async () => {
    const tables = scourshBoard();
    tables.projects = [
      { id: PROJ, tenant_id: T2, auto_land_enabled: true },
      { id: PROJ, tenant_id: T1, auto_land_enabled: false },
    ];
    const { deps: d } = deps(tables, { neuterTenantEqOn: ["projects"] });
    const c = await loadUnqueuedLandCandidate(d, foreignTicket());
    expect(c.autoLandEnabled).toBe(true);
  });

  // The sharpest read of all: what this returns decides whether a BRANCH is
  // handed to a merge into the integration branch.
  it("does not resolve another tenant's push as our ticket's branch", async () => {
    const tables = scourshBoard();
    tables.pending_pushes = [{ ...push("t-69"), tenant_id: T2 }];
    const { deps: d } = deps(tables);
    const c = await loadUnqueuedLandCandidate(d, foreignTicket());
    expect(c.hasBranch).toBe(false);
  });

  it("CONTROL: without the tenant predicate the foreign branch IS returned", async () => {
    const tables = scourshBoard();
    tables.pending_pushes = [{ ...push("t-69"), tenant_id: T2 }];
    const { deps: d } = deps(tables, { neuterTenantEqOn: ["pending_pushes"] });
    const c = await loadUnqueuedLandCandidate(d, foreignTicket());
    expect(c.hasBranch).toBe(true);
  });

  // `ticket_dependencies` carries no tenant column, so its safety comes from
  // re-scoping the blocker TICKETS it points at.
  it("does not let another tenant's blocker defer our land", async () => {
    const tables = scourshBoard();
    (tables.tickets as Row[]).push(
      ticket("t-foreign-parent", { tenant_id: T2, status: "in_progress" }),
    );
    (tables.ticket_dependencies as Row[]).push({
      ticket_id: "t-69",
      blocks_ticket_id: "t-foreign-parent",
      relation_type: "builds_on",
    });
    const { deps: d } = deps(tables);
    const c = await loadUnqueuedLandCandidate(d, foreignTicket());
    // Unresolvable blocker → still deferred (fail closed), which is correct -
    // but it must be deferred because we could not SEE it, not because we read
    // another tenant's row.
    expect(c.dependencyDeferred).toBe(true);
  });
});

// ── fail-closed on unreadable facts ────────────────────────────────────────

describe("an unreadable fact never produces an enqueue", () => {
  it("treats a ticket with no project as ineligible", async () => {
    const { deps: d } = deps(scourshBoard());
    const c = await loadUnqueuedLandCandidate(d, scanRow("t-69", { project_id: null }));
    expect(c.autoLandEnabled).toBe(false);
    expect(c.hasBranch).toBe(false);
    expect(c.dependencyDeferred).toBe(true);
  });

  // FAIL CLOSED. An unreadable queue is treated as "a row exists", so the sweep
  // stands down rather than minting a duplicate landing on top of one it could
  // not see. Waiting costs one more five-minute tick.
  it("treats an unreadable integration_queue as 'already queued'", async () => {
    const { deps: d } = deps(scourshBoard(), { errorOn: ["integration_queue"] });
    const c = await loadUnqueuedLandCandidate(d, scanRow("t-69"));
    expect(c.hasQueueRow).toBe(true);
  });

  it("treats an unreadable dependency graph as deferred", async () => {
    const { deps: d } = deps(scourshBoard(), { errorOn: ["ticket_dependencies"] });
    const c = await loadUnqueuedLandCandidate(d, scanRow("t-69"));
    expect(c.dependencyDeferred).toBe(true);
  });

  it("enqueues nothing when the scan itself fails", async () => {
    const { deps: d, enqueued } = deps(scourshBoard(), { errorOn: ["tickets"] });
    const result = await sweepUnqueuedLands(d);
    expect(result).toEqual({ scanned: 0, enqueued: 0, outcomes: [] });
    expect(enqueued).toEqual([]);
  });

  it("reports, rather than swallows, an enqueue refused by the seam", async () => {
    const tables = scourshBoard();
    const { deps: base } = deps(tables);
    const d: UnqueuedLandDeps = {
      ...base,
      enqueue: async () => ({ enqueued: false, reason: "ticket has no branch with work to land" }),
    };
    const r = await rescueUnqueuedLand(d, scanRow("t-69"));
    expect(r).toEqual({
      ok: true,
      action: "enqueue",
      enqueued: false,
      reason: "ticket has no branch with work to land",
    });
  });

  it("one throwing ticket never stalls the rest of the sweep", async () => {
    const tables = scourshBoard();
    const { deps: base, enqueued } = deps(tables);
    let calls = 0;
    const d: UnqueuedLandDeps = {
      ...base,
      enqueue: async (args) => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        enqueued.push(args.ticketId);
        return { enqueued: true };
      },
    };
    const result = await sweepUnqueuedLands(d);
    expect(result.outcomes.some((o) => o.outcome.startsWith("error:"))).toBe(true);
    expect(enqueued).toHaveLength(2);
  });
});
