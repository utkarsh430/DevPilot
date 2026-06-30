// The supervisor's IO half, driven against a filter-APPLYING fake Supabase
// client, plus a source scan for the two properties no runtime test can prove.
//
// A fake that ignores `.eq()` makes every tenant-scope assertion vacuous, so
// this one really applies its predicates and each scope test carries a CONTROL
// that neuters the predicate and asserts the wrong answer WOULD come back.
//
// Tenant scope matters unusually much here. What these reads produce is a list
// of tickets to MOVE and queue rows to RELEASE, so a foreign row reaching the
// plan is not a disclosure - it is another tenant's board being rearranged by a
// runner that was never told their tenant id. And the ledger read becomes an
// ACCUSATION shown to an operator, so foreign rows folded into it would
// manufacture a defect report about a board that is fine.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  executeSupervisionPlan,
  loadRecentSupervisorActions,
  loadSupervisedProjects,
  readEngineLiveness,
  recordSupervisorAction,
  type SupervisorDeps,
} from "@/lib/engine/supervisor-store";
import {
  assessEngineRecovery,
  type SupervisedDispatchGroup,
  type SupervisedTicket,
  type UnsettledLandedPush,
} from "@/lib/engine/supervisor-policy";

const NOW = "2026-08-03T18:00:00.000Z";
const OURS = "tenant-ours";
const THEIRS = "tenant-theirs";

function iso(minutesAgo: number): string {
  return new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
}

type Row = Record<string, unknown>;

type FakeOpts = {
  tables?: Record<string, Row[]>;
  /** Drop a predicate to prove the assertion is not vacuous. */
  ignoreEq?: boolean;
  failTable?: string;
  /** Captures every insert, so the ledger's tenant stamping is assertable. */
  inserts?: Row[];
};

/** Minimal PostgREST-shaped fake that ACTUALLY filters. */
function fakeDb(opts: FakeOpts) {
  const tables = opts.tables ?? {};

  function builder(table: string) {
    let rows = [...(tables[table] ?? [])];
    const api: Record<string, unknown> = {
      select() {
        return api;
      },
      insert(row: Row) {
        opts.inserts?.push({ __table: table, ...row });
        return { ...finish(), error: opts.failTable === table ? { message: "boom" } : null };
      },
      update() {
        return api;
      },
      is() {
        return api;
      },
      eq(col: string, val: unknown) {
        if (!opts.ignoreEq) rows = rows.filter((r) => r[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        rows = rows.filter((r) => vals.includes(r[col]));
        return api;
      },
      gte(col: string, val: string) {
        rows = rows.filter((r) => String(r[col]) >= val);
        return api;
      },
      lt(col: string, val: string) {
        rows = rows.filter((r) => String(r[col]) < val);
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return finish();
      },
      maybeSingle() {
        return { data: rows[0] ?? null, error: opts.failTable === table ? { message: "x" } : null };
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(finish()).then(resolve);
      },
    };
    function finish() {
      if (opts.failTable === table) return { data: null, error: { message: `${table} exploded` } };
      return { data: rows, error: null };
    }
    return api;
  }
  return { from: (t: string) => builder(t) } as never;
}

// ───────────────────────────────────────────────────────────────────────────
// Liveness reads
// ───────────────────────────────────────────────────────────────────────────

describe("readEngineLiveness", () => {
  it("reads the canary stamp and classifies it", async () => {
    const db = fakeDb({
      tables: { engine_liveness: [{ id: "recovery-cron", last_seen_at: iso(1) }] },
    });
    expect((await readEngineLiveness(db, NOW, 300)).state).toBe("alive");
  });

  // A database we just failed to read is the WORST moment to start moving
  // tickets, and it is not evidence about Inngest either way.
  it("reports unknown - never wedged - when the read fails", async () => {
    const db = fakeDb({ tables: { engine_liveness: [] }, failTable: "engine_liveness" });
    expect((await readEngineLiveness(db, NOW, 300)).state).toBe("unknown");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// TENANT ISOLATION
// ───────────────────────────────────────────────────────────────────────────

describe("loadRecentSupervisorActions - tenant isolation", () => {
  const ledger = [
    { tenant_id: OURS, cause: "stalled_ticket", created_at: iso(10) },
    { tenant_id: THEIRS, cause: "stalled_ticket", created_at: iso(10) },
    { tenant_id: THEIRS, cause: "board_deadlock", created_at: iso(10) },
  ];

  it("returns ONLY this tenant's remediations", async () => {
    const db = fakeDb({ tables: { supervisor_actions: ledger } });
    const rows = await loadRecentSupervisorActions(db, OURS, iso(120));
    expect(rows).toHaveLength(1);
  });

  // CONTROL: without the predicate the foreign rows WOULD come back and would
  // treble this tenant's apparent remediation count - an accusation about a
  // board that is fine.
  it("control: neutering the tenant predicate leaks the other tenant's rows", async () => {
    const db = fakeDb({ tables: { supervisor_actions: ledger }, ignoreEq: true });
    const rows = await loadRecentSupervisorActions(db, OURS, iso(120));
    expect(rows.length).toBeGreaterThan(1);
  });

  it("excludes rows older than the window", async () => {
    const db = fakeDb({
      tables: {
        supervisor_actions: [
          { tenant_id: OURS, cause: "stalled_ticket", created_at: iso(10) },
          { tenant_id: OURS, cause: "stalled_ticket", created_at: iso(10_000) },
        ],
      },
    });
    expect(await loadRecentSupervisorActions(db, OURS, iso(120))).toHaveLength(1);
  });
});

describe("loadSupervisedProjects", () => {
  it("returns only projects that opted in, carrying their own tenant", async () => {
    const db = fakeDb({
      tables: {
        projects: [
          { id: "p1", tenant_id: OURS, supervisor_enabled: true },
          { id: "p2", tenant_id: OURS, supervisor_enabled: false },
          { id: "p3", tenant_id: THEIRS, supervisor_enabled: true },
        ],
      },
    });
    const rows = await loadSupervisedProjects(db);
    // Instance-wide, exactly like the crons it stands in for - but every row
    // carries the tenant it was READ from, which is the only tenant any
    // downstream write is ever scoped to.
    expect(rows.map((r) => r.projectId).sort()).toEqual(["p1", "p3"]);
    expect(rows.find((r) => r.projectId === "p3")?.tenantId).toBe(THEIRS);
  });

  // The opt-in is a per-project gate, and it defaults OFF. A project that never
  // opted in must be invisible to remediation.
  it("control: an un-opted-in project is never returned", async () => {
    const db = fakeDb({
      tables: { projects: [{ id: "p2", tenant_id: OURS, supervisor_enabled: false }] },
    });
    expect(await loadSupervisedProjects(db)).toEqual([]);
  });
});

describe("recordSupervisorAction", () => {
  it("stamps the tenant derived from the row, never a caller-supplied one", async () => {
    const inserts: Row[] = [];
    const db = fakeDb({ tables: { supervisor_actions: [] }, inserts });
    await recordSupervisorAction(
      { db, nowIso: NOW },
      {
        tenantId: OURS,
        projectId: "p1",
        ticketId: "t1",
        cause: "stalled_ticket",
        action: "recover_ticket",
        detail: "d",
      },
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ tenant_id: OURS, cause: "stalled_ticket" });
  });

  // A repair that already happened must not be undone by a ledger write that
  // failed. Losing the record is bad; throwing here would be worse.
  it("never throws when the ledger write fails", async () => {
    const db = fakeDb({ tables: { supervisor_actions: [] }, failTable: "supervisor_actions" });
    await expect(
      recordSupervisorAction(
        { db, nowIso: NOW },
        {
          tenantId: OURS,
          projectId: null,
          ticketId: null,
          cause: "board_deadlock",
          action: "release_dispatch_queue",
          detail: "d",
        },
      ),
    ).resolves.toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The executor: observe vs remediate, end to end through the real deps shape.
// ───────────────────────────────────────────────────────────────────────────

function stalled(over: Partial<SupervisedTicket> = {}): SupervisedTicket {
  return {
    ticketId: "ticket-1",
    tenantId: OURS,
    projectId: "p1",
    runIds: ["run-dead"],
    evidence: {
      status: "in_progress",
      ticketUpdatedAtIso: iso(400),
      hasLiveRun: false,
      hasPendingDispatch: false,
      latestRunStatus: "failed",
      latestRunFanOutGroup: null,
      latestRunActivityIso: iso(400),
      automationPaused: false,
      lastRecoveryCommentIso: null,
      nowIso: NOW,
      graceSeconds: 1800,
    },
    ...over,
  };
}

function group(over: Partial<SupervisedDispatchGroup> = {}): SupervisedDispatchGroup {
  return {
    tenantId: OURS,
    agentId: "agent-1",
    wipLimit: 3,
    runningRuns: 0,
    waitingRuns: 0,
    pendingRows: 2,
    oldestPendingIso: iso(420),
    allRowsSupervised: true,
    ...over,
  };
}

function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  const inserts: Row[] = [];
  return {
    db: fakeDb({ tables: { supervisor_actions: [] }, inserts }),
    nowIso: NOW,
    // The two recovery primitives, stubbed. In production these ARE
    // `releaseGroup` and `recoverOrphanedTicket` - the crons' own functions -
    // so what these tests assert is that the supervisor calls them, and when.
    releaseQueue: vi.fn(async () => ({ reason: "released", released: 1 })),
    recoverTicket: vi.fn(async () => ({
      ok: true as const,
      recovered: true as const,
      to: "input_required" as const,
    })),
    loadQueueGroups: vi.fn(async () => []),
    settlePush: vi.fn(async () => true),
    isAutomationPaused: vi.fn(async () => false),
    comment: vi.fn(async () => undefined),
    staleSeconds: 300,
    dispatchGraceSeconds: 600,
    orphanGraceSeconds: 1800,
    indictWindowSeconds: 7200,
    indictThreshold: 5,
    ...over,
  };
}

describe("executeSupervisionPlan - the non-duplication rule", () => {
  // MUTATION: remove the observe gate in `planSupervision` and this goes red.
  it("touches NOTHING while the engine's own recovery is alive", async () => {
    const d = deps();
    const out = await executeSupervisionPlan(d, {
      liveness: assessEngineRecovery(iso(1), NOW, 300),
      dispatchGroups: [group()],
      stalledTickets: [stalled()],
      unsettledLandedPushes: [],
      supervisedProjects: 1,
    });
    expect(out.mode).toBe("observe");
    expect(out.applied).toEqual([]);
    expect(d.releaseQueue).not.toHaveBeenCalled();
    expect(d.recoverTicket).not.toHaveBeenCalled();
    // But it still SAW the problem - observing is not blindness.
    expect(out.findings.length).toBeGreaterThan(0);
  });

  it("releases a deadlocked queue once the crons are provably dead", async () => {
    const d = deps();
    const out = await executeSupervisionPlan(d, {
      liveness: assessEngineRecovery(iso(120), NOW, 300),
      dispatchGroups: [group()],
      stalledTickets: [],
      unsettledLandedPushes: [],
      supervisedProjects: 1,
    });
    expect(out.mode).toBe("remediate");
    expect(d.releaseQueue).toHaveBeenCalled();
    expect(out.applied.some((a) => a.action === "release_dispatch_queue")).toBe(true);
  });

  // Per-project opt-in, at the executor rather than only in the pure policy.
  it("never releases a queue whose rows span un-opted-in projects", async () => {
    const d = deps();
    await executeSupervisionPlan(d, {
      liveness: assessEngineRecovery(iso(120), NOW, 300),
      dispatchGroups: [group({ allRowsSupervised: false })],
      stalledTickets: [],
      unsettledLandedPushes: [],
      supervisedProjects: 1,
    });
    expect(d.releaseQueue).not.toHaveBeenCalled();
  });

  // The runner's report can only SUBTRACT. Here the DB says the run failed and
  // the runner says it is still executing; the process wins.
  it("does not recover a ticket a runner reports it is still executing", async () => {
    const d = deps();
    await executeSupervisionPlan(
      d,
      {
        liveness: assessEngineRecovery(iso(120), NOW, 300),
        dispatchGroups: [],
        stalledTickets: [stalled()],
        unsettledLandedPushes: [],
        supervisedProjects: 1,
      },
      new Set(["run-dead"]),
    );
    expect(d.recoverTicket).not.toHaveBeenCalled();
  });

  it("never throws when a remediation blows up mid-pass", async () => {
    const d = deps({
      releaseQueue: vi.fn(async () => {
        throw new Error("claim exploded");
      }),
    });
    await expect(
      executeSupervisionPlan(d, {
        liveness: assessEngineRecovery(iso(120), NOW, 300),
        dispatchGroups: [group()],
        stalledTickets: [],
        unsettledLandedPushes: [],
        supervisedProjects: 1,
      }),
    ).resolves.toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// COST - a claim about EVERY path, which a runtime test cannot make.
//
// The supervision loop runs forever on every runner. An LLM call anywhere on it
// would be a per-minute, per-runner, unbounded spend that nothing gates, and it
// would be invisible until a bill arrived. The brief's rule is that reasoning,
// if any, belongs behind a threshold and never in the loop.
//
// A source scan, not a spy: a spy proves only that THIS pass made no call. The
// claim being made is about every pass and every future edit.
// ───────────────────────────────────────────────────────────────────────────

const WEB_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function readSupervisorSources(): Array<{ rel: string; src: string }> {
  const files = [
    "lib/engine/supervisor-policy.ts",
    "lib/engine/supervisor-store.ts",
    "lib/engine/liveness.ts",
    "app/api/runners/supervision/route.ts",
  ];
  return files.map((rel) => ({ rel, src: readFileSync(join(WEB_ROOT, rel), "utf8") }));
}

describe("the supervision path performs no LLM work", () => {
  const LLM_MARKERS = [
    "generateObjectForTenant",
    "generateObject(",
    "generateText",
    "@ai-sdk/",
    "modelForTenant",
    "invokeLocalCcOneShot",
    "lib/llm/",
  ];

  it("no module on the supervision path references the LLM layer", () => {
    for (const { rel, src } of readSupervisorSources()) {
      for (const marker of LLM_MARKERS) {
        expect(src.includes(marker), `${rel} must not reference ${marker}`).toBe(false);
      }
    }
  });

  // The runner half, likewise. It is one HTTP POST per interval and nothing else
  // - in particular it must never grow an Upstash poll, which is the budget
  // `poll-backoff.ts` exists to protect.
  it("the runner loop touches neither an LLM nor Upstash", () => {
    const src = readFileSync(join(WEB_ROOT, "..", "runner", "src", "supervisor-loop.ts"), "utf8");
    for (const marker of [...LLM_MARKERS, "@upstash/redis", "redis.rpop", "redis.lpush"]) {
      expect(src.includes(marker), `supervisor-loop.ts must not reference ${marker}`).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The migration keeps `shell_bootstrap` in sync.
//
// `PROJECT_COLUMNS` and the RPC's own select list BOTH feed `mapProjectRow`, so
// a column in one and not the other comes back SILENTLY DEFAULTED on the
// shell-bootstrap path. For a safety opt-in that default is `false`, which fails
// quietly rather than loudly - the exact failure this asserts against.
// ───────────────────────────────────────────────────────────────────────────

describe("supervisor_enabled is readable on both project paths", () => {
  it("the migration that adds the column also rewrites shell_bootstrap", () => {
    const dir = join(WEB_ROOT, "..", "..", "supabase", "migrations");
    const file = readdirSync(dir).find((f) => f.includes("project_supervisor"));
    expect(file, "the supervisor migration must exist").toBeDefined();
    const sql = readFileSync(join(dir, file!), "utf8");
    expect(sql).toMatch(/add column if not exists supervisor_enabled/);
    expect(sql).toMatch(/create or replace function public\.shell_bootstrap/);
    // The column must appear inside the rewritten projects select list, not only
    // in the ALTER above it.
    const afterFn = sql.slice(sql.indexOf("create or replace function public.shell_bootstrap"));
    expect(afterFn).toMatch(/supervisor_enabled/);
  });

  it("PROJECT_COLUMNS names it too", () => {
    const src = readFileSync(join(WEB_ROOT, "lib/projects/load.ts"), "utf8");
    expect(src).toMatch(/supervisor_enabled/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE UNGATED REPAIR: a landed ticket whose push row was never settled.
//
// This is the one act on the supervision path that is NOT gated on the engine
// being wedged, and the reason is written on `SupervisorBookkeepingRepair`: it
// duplicates no cron (PR #156 deliberately refused a sweeper over
// `pending_pushes`, so there has never been one), it moves nothing on the board,
// and its defect only ever happens WHILE the engine is healthy - both routes
// found leaking on 2026-08-04 leaked with Inngest perfectly fine.
//
// So the tests here come in pairs: it must act on a healthy engine, and it must
// still leave the GATED remediations untouched on that same pass.
// ───────────────────────────────────────────────────────────────────────────

function unsettled(over: Partial<UnsettledLandedPush> = {}): UnsettledLandedPush {
  return {
    tenantId: OURS,
    projectId: "p1",
    ticketId: "ticket-landed",
    pushId: "push-1",
    detail: "landed at abc123 with its push row still unsettled",
    ...over,
  };
}

describe("executeSupervisionPlan - settling a landed ticket's stale push row", () => {
  it("repairs it AND files a ledger row carrying the cause", async () => {
    const inserts: Row[] = [];
    const d = deps({ db: fakeDb({ tables: { supervisor_actions: [] }, inserts }) });
    const out = await executeSupervisionPlan(d, {
      // ALIVE. The gated remediations must stand down; this one must not.
      liveness: assessEngineRecovery(iso(1), NOW, 300),
      dispatchGroups: [],
      stalledTickets: [],
      unsettledLandedPushes: [unsettled()],
      supervisedProjects: 1,
    });

    expect(d.settlePush).toHaveBeenCalledWith({ pendingPushId: "push-1", tenantId: OURS });
    expect(out.applied.map((a) => a.action)).toContain("settle_landed_push");

    // The indictment's raw material. A repair that left no trace here would be
    // exactly the silent sweeper #156 refused - the state gets fixed and the
    // write-path gap that produced it becomes invisible again.
    const ledger = inserts.filter((r) => r.__table === "supervisor_actions");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      tenant_id: OURS,
      ticket_id: "ticket-landed",
      cause: "landed_push_unsettled",
      action: "settle_landed_push",
    });
  });

  // MUTATION: move the repair loop below the `mode === "observe"` early return
  // and this goes red - which is the whole point, because a wedge-gated version
  // of this repair would fire approximately never.
  it("acts even though the engine's own crons are alive and well", async () => {
    const d = deps();
    const out = await executeSupervisionPlan(d, {
      liveness: assessEngineRecovery(iso(1), NOW, 300),
      dispatchGroups: [],
      stalledTickets: [],
      unsettledLandedPushes: [unsettled()],
      supervisedProjects: 1,
    });
    expect(out.mode).toBe("observe");
    expect(d.settlePush).toHaveBeenCalled();
  });

  // The structural property AGENTS.md records must survive intact: the two
  // remediations that DUPLICATE a cron are still gated, on the very same pass.
  it("still touches nothing the crons own, on that same healthy-engine pass", async () => {
    const d = deps();
    await executeSupervisionPlan(d, {
      liveness: assessEngineRecovery(iso(1), NOW, 300),
      dispatchGroups: [group()],
      stalledTickets: [stalled()],
      unsettledLandedPushes: [unsettled()],
      supervisedProjects: 1,
    });
    expect(d.settlePush).toHaveBeenCalled();
    expect(d.releaseQueue).not.toHaveBeenCalled();
    expect(d.recoverTicket).not.toHaveBeenCalled();
  });

  // THE CONTROL THAT MATTERS, at the executor. A pass with nothing to repair
  // must be indistinguishable from one that never ran - no write, no ledger row,
  // no accusation. A remediation that acts on everything looks identical to a
  // correct one on a healthy board until you check exactly this.
  it("writes nothing at all when there is nothing to repair", async () => {
    const inserts: Row[] = [];
    const d = deps({ db: fakeDb({ tables: { supervisor_actions: [] }, inserts }) });
    const out = await executeSupervisionPlan(d, {
      liveness: assessEngineRecovery(iso(1), NOW, 300),
      dispatchGroups: [],
      stalledTickets: [],
      unsettledLandedPushes: [],
      supervisedProjects: 1,
    });
    expect(d.settlePush).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(out.applied).toEqual([]);
    expect(out.indictments).toEqual([]);
  });

  // A row the landing path settled between the scan and now. The CAS in
  // `settleLandedPush` moves nothing, so the ledger must gain nothing - or the
  // indictment would count repairs that never happened.
  it("files no ledger row when the row was already settled", async () => {
    const inserts: Row[] = [];
    const d = deps({
      db: fakeDb({ tables: { supervisor_actions: [] }, inserts }),
      settlePush: vi.fn(async () => false),
    });
    const out = await executeSupervisionPlan(d, {
      liveness: assessEngineRecovery(iso(1), NOW, 300),
      dispatchGroups: [],
      stalledTickets: [],
      unsettledLandedPushes: [unsettled()],
      supervisedProjects: 1,
    });
    expect(inserts.filter((r) => r.__table === "supervisor_actions")).toEqual([]);
    expect(out.applied[0]?.outcome).toBe("skip:already-settled");
  });

  it("never throws when the settle blows up", async () => {
    const d = deps({
      settlePush: vi.fn(async () => {
        throw new Error("db exploded");
      }),
    });
    await expect(
      executeSupervisionPlan(d, {
        liveness: assessEngineRecovery(iso(1), NOW, 300),
        dispatchGroups: [],
        stalledTickets: [],
        unsettledLandedPushes: [unsettled()],
        supervisedProjects: 1,
      }),
    ).resolves.toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE INDICTMENT, end to end over the real ledger shape.
//
// This is the half that makes a sweeper acceptable at all. #156 refused one
// because "a reaper that hides a write-path bug is worse than the stale badge";
// what makes this one different is that every repair is COUNTED, and a cause
// that keeps needing the same fix is escalated as a suspected defect instead of
// absorbed as maintenance.
//
// Both halves are asserted, because either alone is a failure: an alarm that
// never fires is the silent sweeper, and an alarm that re-fires every pass is
// wallpaper - "implementing the alarm that way would defeat the feature with the
// feature".
// ───────────────────────────────────────────────────────────────────────────

/** A ledger the pass can actually write to and stamp, so repeat behaviour is
 *  observable rather than asserted from a mock. */
function ledgerDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const escalationStamps: Row[] = [];

  function builder(table: string) {
    let view = table === "supervisor_actions" ? [...rows] : [];
    let pendingUpdate: Row | null = null;
    const api: Record<string, unknown> = {
      select: () => api,
      insert(row: Row) {
        rows.push({ ...row });
        return { data: null, error: null };
      },
      update(patch: Row) {
        pendingUpdate = patch;
        return api;
      },
      eq(col: string, val: unknown) {
        view = view.filter((r) => r[col] === val);
        return api;
      },
      is(col: string, val: unknown) {
        view = view.filter((r) => (r[col] ?? null) === val);
        return api;
      },
      gte(col: string, val: string) {
        view = view.filter((r) => String(r[col]) >= val);
        return api;
      },
      order: () => api,
      limit: () => finish(),
      maybeSingle: () => ({ data: view[0] ?? null, error: null }),
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(finish()).then(resolve);
      },
    };
    function finish() {
      if (pendingUpdate) {
        for (const r of view) {
          Object.assign(r, pendingUpdate);
          escalationStamps.push(r);
        }
        pendingUpdate = null;
      }
      return { data: view, error: null };
    }
    return api;
  }

  return { db: { from: (t: string) => builder(t) } as never, rows, escalationStamps };
}

describe("indicting repeated push-row repairs", () => {
  /** One pass that repairs `n` distinct push rows. */
  async function pass(db: never, n: number, nowIso = NOW) {
    const d = deps({ db, nowIso });
    return await executeSupervisionPlan(d, {
      liveness: assessEngineRecovery(iso(1), nowIso, 300),
      dispatchGroups: [],
      stalledTickets: [],
      unsettledLandedPushes: Array.from({ length: n }, (_, i) =>
        unsettled({ pushId: `push-${i}`, ticketId: `ticket-${i}` }),
      ),
      supervisedProjects: 1,
    });
  }

  it("stays quiet below the threshold - a handful of repairs is maintenance", async () => {
    const { db, rows } = ledgerDb();
    const out = await pass(db, 4);
    expect(rows).toHaveLength(4);
    expect(out.indictments).toEqual([]);
  });

  it("accumulates by CAUSE and escalates once it crosses the threshold", async () => {
    const { db } = ledgerDb();
    const out = await pass(db, 5);
    expect(out.indictments).toHaveLength(1);
    expect(out.indictments[0]).toMatchObject({ cause: "landed_push_unsettled", count: 5 });
  });

  // THE EVENT, not the state. Without `selectUnescalatedIndictments`' gate a
  // ledger sitting over threshold would re-post the same accusation every pass,
  // once a minute, forever.
  it("does not re-accuse on the next pass while the ledger stays over threshold", async () => {
    const { db } = ledgerDb();
    expect((await pass(db, 5)).indictments).toHaveLength(1);
    // A second pass repairs one more row: six in the window, one already
    // escalated - not enough NEW evidence to say it again.
    expect((await pass(db, 1)).indictments).toEqual([]);
  });

  // …but it gets LOUDER as the defect gets worse: five MORE unescalated repairs
  // fire again, and the reported count is the FULL window total, because the
  // number an operator needs is how many times this has happened.
  it("fires again once another threshold's worth accumulates", async () => {
    const { db } = ledgerDb();
    await pass(db, 5);
    await pass(db, 4);
    const third = await pass(db, 1);
    expect(third.indictments).toHaveLength(1);
    expect(third.indictments[0]?.count).toBe(10);
  });

  // Grouped by CAUSE, never by instance - "ticket 47's row is stale" would make
  // every accusation a count of one and the whole escalation dead.
  it("groups every push-row repair under one cause however many tickets it spans", async () => {
    const { db, rows } = ledgerDb();
    const out = await pass(db, 5);
    expect(new Set(rows.map((r) => r.ticket_id)).size).toBe(5);
    expect(out.indictments.map((i) => i.cause)).toEqual(["landed_push_unsettled"]);
  });

  // Two unrelated one-offs are not a defect. A push-row repair must not be
  // counted towards a stalled-ticket accusation or vice versa.
  it("does not pool a different cause into the count", async () => {
    const { db } = ledgerDb([
      { tenant_id: OURS, cause: "stalled_ticket", created_at: iso(10), escalated_at: null },
      { tenant_id: OURS, cause: "stalled_ticket", created_at: iso(10), escalated_at: null },
      { tenant_id: OURS, cause: "stalled_ticket", created_at: iso(10), escalated_at: null },
      { tenant_id: OURS, cause: "stalled_ticket", created_at: iso(10), escalated_at: null },
    ]);
    expect((await pass(db, 4)).indictments).toEqual([]);
  });

  // The accusation lands where a human is looking, not only in a log.
  it("posts the accusation on a ticket the repair touched", async () => {
    const { db } = ledgerDb();
    const comment = vi.fn<SupervisorDeps["comment"]>(async () => undefined);
    const d = deps({ db, comment });
    await executeSupervisionPlan(d, {
      liveness: assessEngineRecovery(iso(1), NOW, 300),
      dispatchGroups: [],
      stalledTickets: [],
      unsettledLandedPushes: Array.from({ length: 5 }, (_, i) =>
        unsettled({ pushId: `push-${i}`, ticketId: `ticket-${i}` }),
      ),
      supervisedProjects: 1,
    });
    expect(comment).toHaveBeenCalledTimes(1);
    const body = comment.mock.calls[0]![0].body;
    expect(body).toMatch(/SUSPECTED DEFECT/);
    expect(body).toMatch(/landed_push_unsettled/);
  });
});
