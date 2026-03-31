// The rescue worker, driven against a filter-APPLYING fake Supabase client.
//
// A fake that ignores `.eq()` makes every tenant-scope assertion below vacuous,
// so this one really applies its predicates and each scope test carries a
// CONTROL that neuters the predicate and asserts the wrong answer WOULD come
// back. Tenant scope matters unusually much here because the run count is a
// disarm signal in one direction and an arm signal in the other: foreign runs
// counted against our agent hold our queue shut for good, and our agent
// measured against a foreign empty run set releases a queue that is legitimately
// full.

import { describe, expect, it, vi } from "vitest";
import {
  loadDispatchQueueGroups,
  releaseGroup,
  sweepStalledDispatches,
  type DispatchRescueDeps,
} from "@/lib/engine/dispatch-rescue-store";
import { DISPATCH_RESCUE_GRACE_SECONDS_DEFAULT } from "@/lib/engine/dispatch-rescue-policy";

const NOW = "2026-08-03T12:00:00.000Z";
const GRACE = DISPATCH_RESCUE_GRACE_SECONDS_DEFAULT;

function agoMinutes(m: number): string {
  return new Date(Date.parse(NOW) - m * 60_000).toISOString();
}

type Row = Record<string, unknown>;

type FakeOpts = {
  dispatch_queue?: Row[];
  runs?: Row[];
  agents?: Row[];
  /** Drop a predicate to prove the assertion is not vacuous. */
  ignoreEq?: boolean;
  /** Make a table's read fail, to exercise fail-closed. */
  failTable?: string;
};

/** Minimal PostgREST-shaped fake that ACTUALLY filters. */
function fakeDb(opts: FakeOpts) {
  const tables: Record<string, Row[]> = {
    dispatch_queue: opts.dispatch_queue ?? [],
    runs: opts.runs ?? [],
    agents: opts.agents ?? [],
  };

  function builder(table: string) {
    let rows = [...(tables[table] ?? [])];
    let headCount = false;
    const api: Record<string, unknown> = {
      select(_cols: string, cfg?: { count?: string; head?: boolean }) {
        headCount = Boolean(cfg?.head);
        return api;
      },
      eq(col: string, val: unknown) {
        if (!opts.ignoreEq) rows = rows.filter((r) => r[col] === val);
        return api;
      },
      order(col: string, cfg?: { ascending?: boolean }) {
        const asc = cfg?.ascending !== false;
        rows.sort((a, b) =>
          asc
            ? String(a[col]).localeCompare(String(b[col]))
            : String(b[col]).localeCompare(String(a[col])),
        );
        return api;
      },
      limit(n: number) {
        rows = rows.slice(0, n);
        return finish();
      },
      maybeSingle() {
        return finish();
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(finish()).then(resolve);
      },
    };
    function finish() {
      if (opts.failTable === table) {
        return { data: null, count: null, error: { message: `${table} exploded` } };
      }
      if (headCount) return { data: null, count: rows.length, error: null };
      if (rows.length === 0) return { data: table === "agents" ? null : [], count: 0, error: null };
      return { data: rows, count: rows.length, error: null };
    }
    return api;
  }

  return { from: (table: string) => builder(table) } as never;
}

function deps(
  over: Partial<DispatchRescueDeps> & { db: DispatchRescueDeps["db"] },
): DispatchRescueDeps {
  return {
    emitDispatch: vi.fn(async () => {}),
    claim: vi.fn(async () => null),
    nowIso: NOW,
    graceSeconds: GRACE,
    ...over,
  };
}

// The incident, as fixture data: four tickets queued behind an "engineer at
// WIP limit (3/3)" that has no live runs at all.
const INCIDENT = {
  dispatch_queue: [
    { tenant_id: "t1", agent_id: "eng", enqueued_at: agoMinutes(420), status: "pending" },
    { tenant_id: "t1", agent_id: "eng", enqueued_at: agoMinutes(400), status: "pending" },
    { tenant_id: "t1", agent_id: "eng", enqueued_at: agoMinutes(380), status: "pending" },
    { tenant_id: "t1", agent_id: "eng", enqueued_at: agoMinutes(300), status: "pending" },
  ],
  agents: [{ id: "eng", tenant_id: "t1", config: { wip_limit: 3 } }],
  // Five dead runs — exactly what the operator measured.
  runs: [
    { id: "r1", tenant_id: "t1", agent_id: "eng", status: "failed" },
    { id: "r2", tenant_id: "t1", agent_id: "eng", status: "cancelled" },
    { id: "r3", tenant_id: "t1", agent_id: "eng", status: "failed" },
    { id: "r4", tenant_id: "t1", agent_id: "eng", status: "failed" },
    { id: "r5", tenant_id: "t1", agent_id: "eng", status: "failed" },
  ],
};

describe("loadDispatchQueueGroups", () => {
  it("folds pending rows into one group per (tenant, agent) with live run counts", async () => {
    const groups = await loadDispatchQueueGroups({ db: fakeDb(INCIDENT) });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      tenantId: "t1",
      agentId: "eng",
      wipLimit: 3,
      runningRuns: 0,
      waitingRuns: 0,
      pendingRows: 4,
    });
    // Oldest-first ordering means the first row seen IS the oldest.
    expect(groups[0]!.oldestPendingIso).toBe(agoMinutes(420));
  });

  it("only counts PENDING queue rows", async () => {
    const groups = await loadDispatchQueueGroups({
      db: fakeDb({
        ...INCIDENT,
        dispatch_queue: [
          ...INCIDENT.dispatch_queue,
          { tenant_id: "t1", agent_id: "eng", enqueued_at: agoMinutes(999), status: "cancelled" },
          { tenant_id: "t1", agent_id: "eng", enqueued_at: agoMinutes(998), status: "dispatched" },
        ],
      }),
    });
    expect(groups[0]!.pendingRows).toBe(4);
  });

  it("counts only THIS tenant's runs against the agent", async () => {
    const withForeign = {
      ...INCIDENT,
      runs: [
        ...INCIDENT.runs,
        // Another tenant's live runs, aimed at an agent id of ours. Counted,
        // they would read as 3/3 and hold our queue shut forever.
        { id: "x1", tenant_id: "EVIL", agent_id: "eng", status: "running" },
        { id: "x2", tenant_id: "EVIL", agent_id: "eng", status: "running" },
        { id: "x3", tenant_id: "EVIL", agent_id: "eng", status: "running" },
      ],
    };
    const groups = await loadDispatchQueueGroups({ db: fakeDb(withForeign) });
    expect(groups[0]!.runningRuns).toBe(0);

    // CONTROL: without the tenant predicate the foreign runs WOULD be counted.
    const unscoped = await loadDispatchQueueGroups({
      db: fakeDb({ ...withForeign, ignoreEq: true }),
    });
    expect(unscoped[0]!.runningRuns).toBeGreaterThan(0);
  });

  it("narrows the queue scan to one tenant when asked (the system-health probe)", async () => {
    // The probe renders on an operator's topbar dot, so a foreign tenant's
    // stall must never reach it. Scoping is done in the QUERY, not by
    // filtering afterwards, so one busy tenant also cannot exhaust the scan
    // cap and blind another tenant's probe.
    const twoTenants = {
      ...INCIDENT,
      dispatch_queue: [
        ...INCIDENT.dispatch_queue,
        { tenant_id: "OTHER", agent_id: "eng", enqueued_at: agoMinutes(500), status: "pending" },
        { tenant_id: "OTHER", agent_id: "eng", enqueued_at: agoMinutes(499), status: "pending" },
      ],
    };
    const mine = await loadDispatchQueueGroups({ db: fakeDb(twoTenants) }, "t1");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.tenantId).toBe("t1");
    expect(mine[0]!.pendingRows).toBe(4);

    // CONTROL 1: unscoped (the cron's own mode) DOES see both tenants, so the
    // assertion above is about the predicate and not about the fixture.
    const all = await loadDispatchQueueGroups({ db: fakeDb(twoTenants) });
    expect(all).toHaveLength(2);

    // CONTROL 2: with `.eq` neutered, the foreign tenant's rows WOULD reach a
    // probe that asked for t1 — surfacing as an extra GROUP, which is what a
    // stall belonging to someone else looks like on this operator's dot.
    const leaked = await loadDispatchQueueGroups(
      { db: fakeDb({ ...twoTenants, ignoreEq: true }) },
      "t1",
    );
    expect(leaked.map((g) => g.tenantId)).toContain("OTHER");
  });

  it("counts only runs belonging to THIS agent", async () => {
    const groups = await loadDispatchQueueGroups({
      db: fakeDb({
        ...INCIDENT,
        runs: [
          ...INCIDENT.runs,
          { id: "o1", tenant_id: "t1", agent_id: "qa", status: "running" },
          { id: "o2", tenant_id: "t1", agent_id: "qa", status: "running" },
          { id: "o3", tenant_id: "t1", agent_id: "qa", status: "running" },
        ],
      }),
    });
    expect(groups[0]!.runningRuns).toBe(0);
  });

  it("separates running from awaiting_human so the detector can tell them apart", async () => {
    const groups = await loadDispatchQueueGroups({
      db: fakeDb({
        ...INCIDENT,
        runs: [
          { id: "a", tenant_id: "t1", agent_id: "eng", status: "running" },
          { id: "b", tenant_id: "t1", agent_id: "eng", status: "awaiting_human" },
          { id: "c", tenant_id: "t1", agent_id: "eng", status: "awaiting_human" },
        ],
      }),
    });
    expect(groups[0]!.runningRuns).toBe(1);
    expect(groups[0]!.waitingRuns).toBe(2);
  });

  it("falls back to the dispatcher's own default when wip_limit is unset", async () => {
    const groups = await loadDispatchQueueGroups({
      db: fakeDb({ ...INCIDENT, agents: [{ id: "eng", tenant_id: "t1", config: {} }] }),
    });
    expect(groups[0]!.wipLimit).toBe(3);
  });

  it("FAILS CLOSED when the run count is unreadable", async () => {
    // A capacity number we do not have must never be inferred as free.
    const groups = await loadDispatchQueueGroups({
      db: fakeDb({ ...INCIDENT, failTable: "runs" }),
    });
    expect(groups[0]!.runningRuns).toBe(Number.POSITIVE_INFINITY);
    const d = await releaseGroup(deps({ db: fakeDb(INCIDENT) }), groups[0]!);
    expect(d.released).toBe(0);
  });
});

describe("releaseGroup", () => {
  const group = {
    tenantId: "t1",
    agentId: "eng",
    wipLimit: 3,
    runningRuns: 0,
    waitingRuns: 0,
    pendingRows: 4,
    oldestPendingIso: agoMinutes(420),
  };

  it("claims and re-emits exactly the free capacity", async () => {
    let n = 0;
    const claim = vi.fn(async () => ({ queueId: `q${++n}`, ticketId: `tk${n}` }));
    const emitDispatch = vi.fn(async () => {});
    const r = await releaseGroup(deps({ db: fakeDb({}), claim, emitDispatch }), group);
    expect(r.released).toBe(3);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(emitDispatch).toHaveBeenCalledTimes(3);
    expect(emitDispatch).toHaveBeenCalledWith({ ticketId: "tk1", tenantId: "t1" });
  });

  it("claims BEFORE emitting, so an overlapping tick cannot double-release", async () => {
    const order: string[] = [];
    const claim = vi.fn(async () => {
      order.push("claim");
      return { queueId: "q", ticketId: "tk" };
    });
    const emitDispatch = vi.fn(async () => {
      order.push("emit");
    });
    await releaseGroup(deps({ db: fakeDb({}), claim, emitDispatch }), {
      ...group,
      pendingRows: 1,
      wipLimit: 1,
    });
    expect(order).toEqual(["claim", "emit"]);
  });

  it("releases nothing when the agent is genuinely at capacity", async () => {
    const claim = vi.fn(async () => ({ queueId: "q", ticketId: "tk" }));
    const r = await releaseGroup(deps({ db: fakeDb({}), claim }), { ...group, runningRuns: 3 });
    expect(r.released).toBe(0);
    expect(claim).not.toHaveBeenCalled();
  });

  it("stops early when the queue drains underneath it", async () => {
    let n = 0;
    const claim = vi.fn(async () => (++n === 1 ? { queueId: "q", ticketId: "tk" } : null));
    const r = await releaseGroup(deps({ db: fakeDb({}), claim }), group);
    expect(r.released).toBe(1);
  });

  it("never throws, and a partial release survives an emit failure", async () => {
    let n = 0;
    const claim = vi.fn(async () => ({ queueId: `q${++n}`, ticketId: `tk${n}` }));
    const emitDispatch = vi.fn(async () => {
      if (n === 2) throw new Error("inngest down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await releaseGroup(deps({ db: fakeDb({}), claim, emitDispatch }), group);
    expect(r.released).toBe(1);
    warn.mockRestore();
  });
});

describe("sweepStalledDispatches — the incident end to end", () => {
  it("releases the wedged board and reports the contradiction", async () => {
    let n = 0;
    const claim = vi.fn(async () => ({ queueId: `q${++n}`, ticketId: `tk${n}` }));
    const emitDispatch = vi.fn(async () => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await sweepStalledDispatches(
      deps({ db: fakeDb(INCIDENT), claim, emitDispatch }),
    );

    expect(summary.released).toBe(3);
    expect(summary.stall.contradiction).toBe(true);
    expect(summary.stall.stalledRows).toBe(4);
    // Loud: greppable, and stating the impossibility rather than the symptom.
    expect(err).toHaveBeenCalledWith(expect.stringContaining("STALLED DISPATCH QUEUE"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("nothing is running"));
    err.mockRestore();
  });

  it("reports the state that was WRONG, not the state after repair", async () => {
    let n = 0;
    const summary = await sweepStalledDispatches(
      deps({
        db: fakeDb(INCIDENT),
        claim: vi.fn(async () => ({ queueId: `q${++n}`, ticketId: `tk${n}` })),
      }),
    );
    // The sweep just released three tickets; the signal must still say the
    // queue was stalled, or a self-healing outage stays invisible forever.
    expect(summary.stall.contradiction).toBe(true);
  });

  it("is quiet and releases nothing on a healthy busy board", async () => {
    const claim = vi.fn(async () => ({ queueId: "q", ticketId: "tk" }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = await sweepStalledDispatches(
      deps({
        db: fakeDb({
          ...INCIDENT,
          runs: [
            { id: "a", tenant_id: "t1", agent_id: "eng", status: "running" },
            { id: "b", tenant_id: "t1", agent_id: "eng", status: "running" },
            { id: "c", tenant_id: "t1", agent_id: "eng", status: "running" },
          ],
        }),
        claim,
      }),
    );
    expect(summary.released).toBe(0);
    expect(summary.stall.contradiction).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("does not throw when the queue scan fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const summary = await sweepStalledDispatches(
      deps({ db: fakeDb({ ...INCIDENT, failTable: "dispatch_queue" }) }),
    );
    expect(summary).toMatchObject({ groups: 0, released: 0 });
    warn.mockRestore();
  });
});
