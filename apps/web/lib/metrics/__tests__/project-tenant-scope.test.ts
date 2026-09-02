// Tenant scoping of the per-project rollups.
//
// These are SERVICE-ROLE reads, so RLS is off and the only thing keeping another
// tenant's rows out of a project's totals is the `.eq("tenant_id", …)` written
// into each query. That is invisible in the output: contaminated tiles look
// exactly like correct ones, just with bigger numbers. So it needs a test with a
// foreign row in the fixture.
//
// The gap being defended: `tickets_member_write` (core.sql) constrains a row's
// own `tenant_id` and NOTHING else, so tenant B can legally insert
// `{tenant_id: B, project_id: <A's project>}` — the policy passes. A
// `tickets WHERE project_id = P` scan then sweeps it, and its runs, into A's
// spend / ticket / run / retry tiles and by-role bars, on the project page and
// in the audit PDF.

import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** A tenant with nothing at all in this project. */
const UNRELATED_TENANT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Row = Record<string, unknown>;

/** The fake DB the mocked `supabaseService()` reads from. Reset per test. */
const db: Record<string, Row[]> = { tickets: [], runs: [], agents: [] };

/**
 * A fake PostgREST builder that ACTUALLY APPLIES `.eq()` / `.in()` / `.gte()`.
 *
 * Applying the filters is the entire point: a fake that ignored `.eq` would make
 * every assertion below pass whether or not the tenant predicate exists in the
 * code, which is worse than having no test — it would report a boundary it never
 * checked.
 */
function builder(table: string) {
  let rows = [...(db[table] ?? [])];
  const self: Record<string, unknown> = {};
  self.select = () => self;
  self.eq = (col: string, val: unknown) => {
    rows = rows.filter((r) => r[col] === val);
    return self;
  };
  self.in = (col: string, vals: readonly unknown[]) => {
    rows = rows.filter((r) => vals.includes(r[col]));
    return self;
  };
  self.gte = (col: string, val: string) => {
    rows = rows.filter((r) => String(r[col]) >= val);
    return self;
  };
  self.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
    resolve({ data: rows, error: null });
  return self;
}

vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({ from: (t: string) => builder(t) }),
}));

const { loadProjectStats, loadRoleUsage, loadDailySpend, loadTicketMetricsForProject } =
  await import("@/lib/metrics/project");

const ticket = (id: string, tenantId: string, over: Row = {}): Row => ({
  id,
  tenant_id: tenantId,
  // BOTH tickets claim the same project. That is the whole attack: the write
  // policy never checks `project_id`.
  project_id: PROJECT,
  status: "done",
  retry_count: 0,
  created_at: "2026-07-15T08:00:00.000Z",
  updated_at: "2026-07-15T09:00:00.000Z",
  ...over,
});

const run = (
  id: string,
  ticketId: string,
  cents: number,
  tenantId: string,
  over: Row = {},
): Row => ({
  id,
  ticket_id: ticketId,
  // A run carries its OWN tenant_id, independent of its ticket's — which is the
  // whole attack (see the foreign-run test below).
  tenant_id: tenantId,
  agent_id: null,
  fan_out_role: "engineer",
  status: "done",
  spent_cents: cents,
  created_at: "2026-07-15T08:00:00.000Z",
  last_event_at: "2026-07-15T08:10:00.000Z",
  ...over,
});

beforeEach(() => {
  db.tickets = [
    ticket("mine", TENANT, { retry_count: 2 }),
    // Tenant B's ticket, pointed at OUR project.
    ticket("theirs", FOREIGN_TENANT, { retry_count: 7 }),
  ];
  db.runs = [run("r-mine", "mine", 100, TENANT), run("r-theirs", "theirs", 9_999, FOREIGN_TENANT)];
  db.agents = [];
});

describe("loadProjectStats", () => {
  it("counts only this tenant's tickets and runs", async () => {
    const stats = await loadProjectStats(TENANT, PROJECT);
    expect(stats.totalTickets).toBe(1);
    expect(stats.totalRuns).toBe(1);
    // The foreign run's 9999 cents must not appear in the headline spend.
    expect(stats.totalSpendCents).toBe(100);
    // Nor its retries.
    expect(stats.totalRetries).toBe(2);
  });

  it("returns empty totals for a tenant with no tickets in this project", async () => {
    // A third tenant that shares nothing with the project sees zeros — not the
    // project's real numbers.
    const stats = await loadProjectStats(UNRELATED_TENANT, PROJECT);
    expect(stats.totalSpendCents).toBe(0);
    expect(stats.totalTickets).toBe(0);
    expect(stats.totalRuns).toBe(0);
  });

  it("would otherwise include the foreign ticket (the fixture is a real attack)", async () => {
    // Sanity on the fixture itself: from the FOREIGN tenant's side the same
    // project scan returns THEIR ticket, which proves both rows really do carry
    // this project_id and the filter is what separates them.
    const stats = await loadProjectStats(FOREIGN_TENANT, PROJECT);
    expect(stats.totalTickets).toBe(1);
    expect(stats.totalSpendCents).toBe(9_999);
  });
});

describe("loadRoleUsage", () => {
  it("excludes runs belonging to a foreign tenant's ticket", async () => {
    const usage = await loadRoleUsage(TENANT, PROJECT);
    const engineer = usage.find((u) => u.role === "engineer");
    expect(engineer?.runs).toBe(1);
    expect(engineer?.totalCents).toBe(100);
  });
});

describe("loadDailySpend", () => {
  it("excludes a foreign tenant's spend from the timeline", async () => {
    const series = await loadDailySpend(TENANT, PROJECT, 400);
    const total = series.reduce((sum, p) => sum + p.cents, 0);
    expect(total).toBe(100);
  });
});

describe("loadTicketMetricsForProject", () => {
  it("does not return metrics for a foreign tenant's ticket", async () => {
    // Not the blocker (the export only reads back ids from its own tenant-clean
    // index), but scoped anyway — a map keyed by ticket id that contains foreign
    // ids is a trap for the next caller who trusts it.
    const metrics = await loadTicketMetricsForProject(TENANT, PROJECT);
    expect([...metrics.keys()]).toEqual(["mine"]);
  });
});
