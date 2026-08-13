// Tenant scoping of the GLOBAL agent scoreboard rollup.
//
// `loadAgentScoreboard` is a SERVICE-ROLE read, so RLS is off and the only thing
// keeping another tenant's runs and mistakes off this tenant's leaderboard is the
// `.eq("tenant_id", …)` written into each query. Contamination is invisible in
// the output — a poisoned board looks exactly like a correct one, just with a
// different agent on top — so it needs a test with foreign rows in the fixture.
//
// The fake builder below ACTUALLY APPLIES `.eq` / `.range` / `.order`. That is
// the whole point: a fake that ignored `.eq` would make every assertion here pass
// with or without the tenant predicate in the code, reporting a boundary it never
// checked (see the same warning in lib/export/__tests__/ticket-audit.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UNRELATED_TENANT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {
  runs: [],
  agents: [],
  agent_mistakes: [],
  agent_project_models: [],
};

/** Records every table read that carried no tenant predicate. */
const unscopedReads: string[] = [];

function builder(table: string) {
  let rows = [...(db[table] ?? [])];
  let sawTenantPredicate = false;
  const self: Record<string, unknown> = {};
  self.select = () => self;
  self.eq = (col: string, val: unknown) => {
    if (col === "tenant_id") sawTenantPredicate = true;
    rows = rows.filter((r) => r[col] === val);
    return self;
  };
  self.in = (col: string, vals: readonly unknown[]) => {
    rows = rows.filter((r) => vals.includes(r[col]));
    return self;
  };
  self.order = (col: string) => {
    rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
    return self;
  };
  self.range = (from: number, to: number) => {
    rows = rows.slice(from, to + 1);
    return self;
  };
  self.then = (resolve: (v: { data: Row[]; error: null }) => unknown) => {
    if (!sawTenantPredicate) unscopedReads.push(table);
    return resolve({ data: rows, error: null });
  };
  return self;
}

vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({ from: (t: string) => builder(t) }),
}));

const { loadAgentScoreboard } = await import("@/lib/metrics/agents");

const run = (id: string, tenantId: string, over: Row = {}): Row => ({
  id,
  tenant_id: tenantId,
  agent_id: null,
  fan_out_role: "engineer",
  ticket_id: `ticket-${id}`,
  ...over,
});

const mistakeRow = (id: string, tenantId: string, over: Row = {}): Row => ({
  id,
  tenant_id: tenantId,
  role: "engineer",
  type: "run_failed",
  counts_against_score: true,
  run_id: null,
  ticket_id: null,
  ...over,
});

beforeEach(() => {
  unscopedReads.length = 0;
  db.runs = [
    ...Array.from({ length: 10 }, (_, i) => run(`mine-${i}`, TENANT)),
    // Tenant B's runs. Nothing about a run's shape says whose it is except
    // tenant_id — which is exactly why the predicate is the boundary.
    ...Array.from({ length: 40 }, (_, i) => run(`theirs-${i}`, FOREIGN_TENANT)),
  ];
  db.agents = [
    { id: "agent-mine", tenant_id: TENANT, name: "Our Engineer", role: "engineer" },
    { id: "agent-theirs", tenant_id: FOREIGN_TENANT, name: "Their Engineer", role: "engineer" },
  ];
  db.agent_mistakes = [
    mistakeRow("m-mine", TENANT, { run_id: "mine-0" }),
    // Foreign mistakes, planted on OUR run ids and OUR role — the attack shape:
    // a hostile row that names our work but carries their tenant.
    mistakeRow("m-theirs-1", FOREIGN_TENANT, { run_id: "mine-1" }),
    mistakeRow("m-theirs-2", FOREIGN_TENANT, { run_id: "mine-2" }),
    mistakeRow("m-theirs-3", FOREIGN_TENANT, { run_id: "mine-3" }),
  ];
  db.agent_project_models = [];
});

describe("loadAgentScoreboard tenant scoping", () => {
  it("counts only this tenant's runs", async () => {
    const board = await loadAgentScoreboard(TENANT);
    expect(board.totals.runs).toBe(10);
    const engineer = board.overall.find((r) => r.role === "engineer");
    expect(engineer?.totalRuns).toBe(10);
  });

  it("never attributes a foreign tenant's mistake, even when it names our run", async () => {
    const board = await loadAgentScoreboard(TENANT);
    const engineer = board.overall.find((r) => r.role === "engineer")!;
    // Only our own single mistake — the three planted ones are filtered out.
    expect(engineer.mistakeCount).toBe(1);
    expect(engineer.scoringMistakeCount).toBe(1);
    expect(engineer.faultedRuns).toBe(1);
    expect(engineer.cleanRuns).toBe(9);
    expect(board.totals.mistakes).toBe(1);
  });

  it("never resolves a display name through a foreign tenant's agent row", async () => {
    const board = await loadAgentScoreboard(TENANT);
    const engineer = board.overall.find((r) => r.role === "engineer")!;
    expect(engineer.displayName).toBe("Our Engineer");
    expect(engineer.displayName).not.toBe("Their Engineer");
  });

  it("returns an empty board for a tenant with nothing", async () => {
    const board = await loadAgentScoreboard(UNRELATED_TENANT);
    expect(board.totals.runs).toBe(0);
    expect(board.totals.mistakes).toBe(0);
    expect(board.overall).toEqual([]);
    expect(board.needsMoreData).toEqual([]);
    expect(board.leaderboards).toEqual([]);
  });

  it("the fixture is a real attack: the foreign tenant sees its own rows", async () => {
    // Sanity on the fixture itself — proves the foreign rows genuinely exist and
    // that the predicate, not an empty table, is what separates them.
    const board = await loadAgentScoreboard(FOREIGN_TENANT);
    expect(board.totals.runs).toBe(40);
    expect(board.totals.mistakes).toBe(3);
  });

  it("issues no read without a tenant_id predicate", async () => {
    // The structural half: catches a NEW unscoped read added later, which the
    // value assertions above would only catch if it happened to change a number.
    await loadAgentScoreboard(TENANT);
    expect(unscopedReads).toEqual([]);
  });
});

describe("loadAgentScoreboard — per-agent × per-project model overrides", () => {
  // The override read is keyed on `tenant_id` and its rows are then matched on
  // (project_id, role_slug) — an attacker-nominated pair. A foreign override
  // planted on OUR project and OUR role would relabel our own agent's model:
  // a wrong label driving a bad upgrade decision, and entirely plausible-looking.
  const PROJECT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  beforeEach(() => {
    db.projects = [
      {
        id: PROJECT,
        tenant_id: TENANT,
        name: "Ours",
        llm_provider: "anthropic",
        llm_model: "sonnet",
        llm_base_url: null,
        llm_credential_ref: null,
      },
    ];
    db.tickets = (db.runs ?? []).map((r) => ({
      id: r.ticket_id,
      tenant_id: r.tenant_id,
      project_id: PROJECT,
    }));
  });

  it("applies OUR override — the value actually reaches the label", async () => {
    db.agent_project_models = [
      {
        id: "apm-mine",
        tenant_id: TENANT,
        project_id: PROJECT,
        role_slug: "engineer",
        provider: "anthropic",
        model: "opus",
      },
    ];
    const board = await loadAgentScoreboard(TENANT);
    const model = board.modelByRole.engineer!;
    expect(model.kind).toBe("resolved");
    if (model.kind !== "resolved") throw new Error("unreachable");
    // Not the project's "sonnet" — the override won. This is the property that
    // `role_config.modelTier` never had.
    expect(model.label).toBe("Opus");
  });

  it("never applies a FOREIGN tenant's override, even on our own project and role", async () => {
    db.agent_project_models = [
      {
        id: "apm-theirs",
        tenant_id: FOREIGN_TENANT,
        project_id: PROJECT,
        role_slug: "engineer",
        provider: "anthropic",
        model: "opus",
      },
    ];
    const board = await loadAgentScoreboard(TENANT);
    const model = board.modelByRole.engineer!;
    if (model.kind !== "resolved") throw new Error("unreachable");
    // The project's own model, untouched by the planted row.
    expect(model.label).toBe("Sonnet");
    expect(model.label).not.toBe("Opus");
  });

  it("issues no override read without a tenant_id predicate", async () => {
    await loadAgentScoreboard(TENANT);
    expect(unscopedReads).not.toContain("agent_project_models");
    expect(unscopedReads).toEqual([]);
  });
});

describe("loadAgentScoreboard paging", () => {
  it("reads past PostgREST's 1000-row cap instead of silently truncating", async () => {
    // db.max_rows = 1000 (supabase/config.toml) truncates SILENTLY, which would
    // render as a smaller, entirely plausible scoreboard.
    db.runs = Array.from({ length: 2_300 }, (_, i) =>
      run(`big-${String(i).padStart(5, "0")}`, TENANT),
    );
    db.agent_mistakes = [];
    const board = await loadAgentScoreboard(TENANT);
    expect(board.totals.runs).toBe(2_300);
  });
});
