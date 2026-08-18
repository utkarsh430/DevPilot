// The "unassigned was ranked #1" fix.
//
// The live board showed an agent called `unassigned` at #1 on BOTH the Custom-
// agents leaderboard and the overall list — 797 runs, 99.4%. It was not an agent:
// 638 of those runs were synthetic one-shot rows the platform inserts for its own
// internal LLM calls (lesson extraction, dep suggestion, plan distill, dispatch
// classifiers), and the remaining 159 were ticket-bound runs that genuinely
// resolve to no role. A trivial one-shot call essentially always succeeds, which
// is precisely why the pseudo-agent outscored every real one.
//
// Two independent properties are asserted here, because the fix has two halves:
//   (a) a synthetic one-shot run never reaches the board at all;
//   (b) an unattributable bucket is never a row, so it cannot be ranked, cannot
//       be a category's top agent, and cannot be the "Top agent" tile.
//
// The fake builder ACTUALLY APPLIES `.eq` / `.range` — a filter-ignoring fake
// would make the tenant-scoped reads here vacuous.

import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {
  runs: [],
  agents: [],
  agent_mistakes: [],
  tickets: [],
  projects: [],
  tenants: [],
};

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
  self.order = (col: string) => {
    rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
    return self;
  };
  self.range = (from: number, to: number) => {
    rows = rows.slice(from, to + 1);
    return self;
  };
  self.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
  self.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
    resolve({ data: rows, error: null });
  return self;
}

vi.mock("@/lib/db/server", () => ({
  supabaseService: () => ({ from: (t: string) => builder(t) }),
}));

const { loadAgentScoreboard } = await import("@/lib/metrics/agents");

/** The exact shape `invokeLocalCcOneShot` inserts: no ticket, no agent, no
 *  fan-out role, no parent, runner_kind local-cc. */
const syntheticRun = (id: string): Row => ({
  id,
  tenant_id: TENANT,
  agent_id: null,
  fan_out_role: null,
  ticket_id: null,
  runner_kind: "local-cc",
  parent_run_id: null,
});

/** Ticket-bound but role-less: real work, genuinely unattributable. */
const unattributableRun = (id: string, ticketId: string): Row => ({
  id,
  tenant_id: TENANT,
  agent_id: null,
  fan_out_role: null,
  ticket_id: ticketId,
  runner_kind: "local-cc",
  parent_run_id: null,
});

const realRun = (id: string, role: string): Row => ({
  id,
  tenant_id: TENANT,
  agent_id: null,
  fan_out_role: role,
  ticket_id: `ticket-${id}`,
  runner_kind: "local-cc",
  parent_run_id: null,
});

beforeEach(() => {
  for (const k of Object.keys(db)) db[k] = [];
  db.tenants = [{ id: TENANT, config: {} }];
});

describe("synthetic platform one-shot runs are excluded", () => {
  it("never reaches the board — not as a row, not in the totals", async () => {
    // The live shape, scaled down: many synthetic rows, a handful of real ones.
    db.runs = [
      ...Array.from({ length: 638 }, (_, i) => syntheticRun(`oneshot-${i}`)),
      ...Array.from({ length: 6 }, (_, i) => realRun(`eng-${i}`, "engineer")),
    ];

    const board = await loadAgentScoreboard(TENANT);

    expect(board.excludedSyntheticRuns).toBe(638);
    expect(board.totals.runs).toBe(6);
    // The whole bug in one assertion: no bucket exists for them at all.
    expect(board.overall.map((r) => r.role)).toEqual(["engineer"]);
    expect(board.needsMoreData).toEqual([]);
    expect(board.unattributed.runs).toBe(0);
  });

  it("drops mistakes harvested against an excluded synthetic run", async () => {
    db.runs = [
      syntheticRun("oneshot-0"),
      ...Array.from({ length: 6 }, (_, i) => realRun(`e-${i}`, "engineer")),
    ];
    db.agent_mistakes = [
      {
        id: "m-synth",
        tenant_id: TENANT,
        role: "engineer",
        type: "run_failed",
        counts_against_score: true,
        run_id: "oneshot-0",
        ticket_id: null,
      },
    ];
    const board = await loadAgentScoreboard(TENANT);
    // The run is gone, so its mistake must not fault a real agent either.
    expect(board.totals.mistakes).toBe(0);
    expect(board.overall[0]?.faultedRuns).toBe(0);
  });

  it("keeps runs that are only PARTLY one-shot shaped — each clause is load-bearing", async () => {
    db.runs = [
      // ticket-bound one-shot (audit-only ticketId) — attributable-ish, real.
      { ...syntheticRun("has-ticket"), ticket_id: "t-1" },
      // a supervisor child: ticket-less and agent-less, but genuine agent work.
      { ...syntheticRun("has-parent"), parent_run_id: "parent-run" },
      // an agent-bound run.
      { ...syntheticRun("has-agent"), agent_id: "agent-1" },
      // a fan-out sibling.
      { ...syntheticRun("has-role"), fan_out_role: "engineer" },
      // a non-local-cc runner.
      { ...syntheticRun("api-runner"), runner_kind: "api" },
    ];
    db.agents = [{ id: "agent-1", tenant_id: TENANT, name: "Eng", role: "engineer" }];

    const board = await loadAgentScoreboard(TENANT);
    expect(board.excludedSyntheticRuns).toBe(0);
    // 2 engineer runs (has-agent, has-role) + 3 unattributable.
    expect(board.totals.runs).toBe(2);
    expect(board.unattributed.runs).toBe(3);
  });
});

describe("unattributable runs are surfaced but never ranked", () => {
  beforeEach(() => {
    db.runs = [
      // Far more unattributable runs than real ones, all clean — the exact
      // conditions under which the old code put them at #1.
      ...Array.from({ length: 159 }, (_, i) => unattributableRun(`orphan-${i}`, `t-${i}`)),
      ...Array.from({ length: 8 }, (_, i) => realRun(`eng-${i}`, "engineer")),
    ];
    db.agent_mistakes = [
      {
        id: "m-eng",
        tenant_id: TENANT,
        role: "engineer",
        type: "run_failed",
        counts_against_score: true,
        run_id: "eng-0",
        ticket_id: null,
      },
    ];
  });

  it("is not a row on any board — overall, per-category or unranked", async () => {
    const board = await loadAgentScoreboard(TENANT);
    const everyRole = [
      ...board.overall,
      ...board.needsMoreData,
      ...board.leaderboards.flatMap((b) => [...b.rows, ...b.unranked]),
    ].map((r) => r.role);
    expect(everyRole).not.toContain("unassigned");
    expect(everyRole.every((r) => r === "engineer")).toBe(true);
  });

  it("is never #1 and never a category's top agent", async () => {
    const board = await loadAgentScoreboard(TENANT);
    // The "Top agent" tile reads overall[0].
    expect(board.overall[0]?.role).toBe("engineer");
    for (const b of board.leaderboards) {
      expect(b.top === null || b.top.role === "engineer").toBe(true);
    }
  });

  it("is still disclosed, as a flat summary with no score", async () => {
    const board = await loadAgentScoreboard(TENANT);
    expect(board.unattributed.runs).toBe(159);
    expect(board.unattributed.ticketsTouched).toBe(159);
    // A summary type, not a score row: nothing to rank.
    expect(board.unattributed).not.toHaveProperty("score");
    expect(board.unattributed).not.toHaveProperty("ranked");
  });

  it("leaves real role-bearing runs completely unaffected", async () => {
    const board = await loadAgentScoreboard(TENANT);
    const engineer = board.overall.find((r) => r.role === "engineer")!;
    expect(engineer.totalRuns).toBe(8);
    expect(engineer.faultedRuns).toBe(1);
    expect(engineer.cleanRuns).toBe(7);
    expect(board.totals.runs).toBe(8);
    expect(board.totals.mistakes).toBe(1);
  });
});
