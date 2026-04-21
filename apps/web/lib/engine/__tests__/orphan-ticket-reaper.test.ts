// The IO half of the orphaned-ticket reaper.
//
// Two things are proved here that the pure-policy suite cannot:
//
//  1. THE NEVER-DAMAGE GUARANTEE END-TO-END. The policy tests assert that a
//     `hasLiveRun` flag stands the reaper down; these assert that a live `runs`
//     row actually PRODUCES that flag - i.e. that the query which feeds the
//     guard is the query that reads liveness. A guard wired to the wrong column
//     passes the pure suite and reaps live work in production.
//
//  2. TENANT SCOPING. This runs on the service client (a cron has no session,
//     so RLS is off) and the co-located `.eq("tenant_id", …)` is the entire
//     boundary. It matters unusually much here because all four reads are
//     DISARM signals: a foreign-tenant `runs` row visible to us would make the
//     reaper stand down and strand our ticket permanently, and a foreign ticket
//     in the scan would get recovered on someone else's board.
//
// The fake client below ACTUALLY APPLIES `.eq`/`.in`/`.lt`/`.limit`/`.order`. A
// filter-ignoring fake would make every assertion vacuous - the trap
// `lib/export/__tests__/ticket-audit.test.ts` documents. The last block is the
// non-vacuity CONTROL: it re-runs the scenarios through a client whose `.eq` is
// a no-op (what deleting the tenant predicate would look like) and asserts the
// behaviour flips there, so if a predicate ever disappears the earlier tests go
// red rather than passing for the wrong reason.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/engine/inngest", () => ({
  inngest: { createFunction: () => ({}), send: vi.fn() },
}));
vi.mock("@/lib/db/server", () => ({ supabaseService: () => ({}) }));
vi.mock("@/lib/engine/automation-state", () => ({
  getEffectivePauseForTicket: async () => ({ paused: false }),
}));
vi.mock("@/lib/board/transitions", () => ({
  transitionTicket: async () => ({ transitioned: true }),
  addComment: async () => {},
}));

import {
  recoverOrphanedTicket,
  sweepOrphanedTickets,
  type OrphanCandidate,
  type OrphanReaperDeps,
} from "@/lib/engine/orphan-ticket-reaper";
import { ORPHAN_GRACE_SECONDS_DEFAULT } from "@/lib/engine/orphan-ticket-policy";

type Row = Record<string, unknown>;

const NOW = "2026-07-19T12:00:00.000Z";
const LONG_AGO = "2026-07-19T10:00:00.000Z";
const JUST_NOW = "2026-07-19T11:59:30.000Z";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const TICKET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** PostgREST-ish fake that applies its filters. `honourEq` exists ONLY for the
 *  non-vacuity control at the bottom of this file. */
function fakeDb(store: Record<string, Row[]>, opts: { honourEq?: boolean } = {}) {
  const honourEq = opts.honourEq ?? true;
  const seen: Array<{ table: string; columns: string[] }> = [];

  function builder(table: string) {
    let rows = [...(store[table] ?? [])];
    const columns: string[] = [];
    const self: Record<string, unknown> = {};

    self.select = () => {
      seen.push({ table, columns });
      return self;
    };
    self.eq = (c: string, v: unknown) => {
      columns.push(c);
      if (honourEq) rows = rows.filter((r) => r[c] === v);
      return self;
    };
    self.in = (c: string, vs: readonly unknown[]) => {
      columns.push(c);
      rows = rows.filter((r) => vs.includes(r[c]));
      return self;
    };
    self.lt = (c: string, v: string) => {
      rows = rows.filter((r) => String(r[c]) < v);
      return self;
    };
    self.order = (c: string, o?: { ascending?: boolean }) => {
      const asc = o?.ascending ?? true;
      rows = [...rows].sort((a, b) =>
        String(a[c]) < String(b[c])
          ? asc
            ? -1
            : 1
          : String(a[c]) > String(b[c])
            ? asc
              ? 1
              : -1
            : 0,
      );
      return self;
    };
    self.limit = (n: number) => {
      rows = rows.slice(0, n);
      return self;
    };
    self.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null });
    return self;
  }

  return { db: { from: (t: string) => builder(t) } as unknown as SupabaseClient, seen };
}

type Calls = {
  transitions: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
};

function deps(
  db: SupabaseClient,
  over: Partial<OrphanReaperDeps> = {},
): { deps: OrphanReaperDeps; calls: Calls } {
  const calls: Calls = { transitions: [], comments: [] };
  return {
    calls,
    deps: {
      db,
      nowIso: NOW,
      graceSeconds: ORPHAN_GRACE_SECONDS_DEFAULT,
      isAutomationPaused: async () => false,
      transition: async (args) => {
        calls.transitions.push(args);
        return { transitioned: true };
      },
      comment: async (args) => {
        calls.comments.push(args);
      },
      ...over,
    },
  };
}

const candidate = (over: Partial<OrphanCandidate> = {}): OrphanCandidate => ({
  id: TICKET,
  tenant_id: T1,
  status: "in_progress",
  updated_at: LONG_AGO,
  ...over,
});

type Store = { tickets: Row[]; runs: Row[]; dispatch_queue: Row[]; comments: Row[] };

/** The incident: one ticket, one long-dead failed run, no queue rows. Note
 *  `status_reason` is deliberately ABSENT here - this is the 2026-08-06/07
 *  shape (AGENTS.md), where the run that stranded the ticket carried no
 *  reason at all. */
function orphanStore(): Store {
  return {
    tickets: [{ id: TICKET, tenant_id: T1, status: "in_progress", updated_at: LONG_AGO }],
    runs: [
      {
        id: "run-1",
        ticket_id: TICKET,
        tenant_id: T1,
        status: "failed",
        fan_out_group: null,
        created_at: LONG_AGO,
        last_event_at: LONG_AGO,
      },
    ],
    dispatch_queue: [],
    comments: [],
  };
}

describe("recoverOrphanedTicket - the orphan is detected and recovered", () => {
  it("moves the incident ticket to input_required and explains itself", async () => {
    const { db } = fakeDb(orphanStore());
    const { deps: d, calls } = deps(db);

    const res = await recoverOrphanedTicket(d, candidate());

    expect(res).toEqual({ ok: true, recovered: true, to: "input_required" });
    expect(calls.transitions).toHaveLength(1);
    expect(calls.transitions[0]).toMatchObject({
      ticketId: TICKET,
      tenantId: T1,
      to: "input_required",
      actor: "system",
      // CAS on the status we evaluated - a concurrent move wins over us.
      expectedFrom: "in_progress",
      // Rule 3: hand back to the human, never re-run work that already failed.
      emitDispatch: false,
    });
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]).toMatchObject({
      ticketId: TICKET,
      tenantId: T1,
      authorType: "system",
      // Its OWN author - never `devpilot_move_ticket`, which the reconciler
      // string-matches as a rendered verdict.
      authorId: "devpilot_orphan_reaper",
    });
    expect(String(calls.comments[0]!.body)).toContain("no live run");
    // The incident this reaper's comment builder must not paper over: the
    // stranding run recorded no `status_reason`, so the comment must say so
    // honestly rather than inventing a cause.
    expect(String(calls.comments[0]!.body)).toContain("We do not know why the work stopped");
  });

  it("quotes the run's failure reason in the recovery comment when one was recorded", async () => {
    const store = orphanStore();
    store.runs[0]!.status_reason = "step-timeout:local-cc step 3 timed out after 3600000";
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);

    const res = await recoverOrphanedTicket(d, candidate());

    expect(res).toMatchObject({ recovered: true, to: "input_required" });
    const body = String(calls.comments[0]!.body);
    expect(body).toContain("step-timeout:local-cc step 3 timed out after 3600000");
    expect(body).not.toContain("We do not know why the work stopped");
  });

  it("recovers a ticket with no runs at all", async () => {
    const store = orphanStore();
    store.runs = [];
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);

    const res = await recoverOrphanedTicket(d, candidate());
    expect(res).toMatchObject({ recovered: true, to: "input_required" });
    expect(String(calls.comments[0]!.body)).toContain("no runs at all");
  });

  it("parks a stranded in_review to blocked", async () => {
    const store = orphanStore();
    store.tickets[0]!.status = "in_review";
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);

    const res = await recoverOrphanedTicket(d, candidate({ status: "in_review" }));
    expect(res).toMatchObject({ recovered: true, to: "blocked" });
    // emitDispatch:false is load-bearing here: transitionTicket does NOT
    // suppress the dispatch for `blocked` by default, so without it we would
    // re-run the very work that just failed.
    expect(calls.transitions[0]).toMatchObject({ to: "blocked", emitDispatch: false });
  });
});

describe("recoverOrphanedTicket - never touches work in flight", () => {
  it("does NOT touch a ticket with a live run", async () => {
    for (const status of ["running", "awaiting_human"]) {
      const store = orphanStore();
      store.runs.push({
        id: `live-${status}`,
        ticket_id: TICKET,
        tenant_id: T1,
        status,
        fan_out_group: null,
        // Deliberately OLD: staleness must not override liveness.
        created_at: LONG_AGO,
        last_event_at: LONG_AGO,
      });
      const { db } = fakeDb(store);
      const { deps: d, calls } = deps(db);

      const res = await recoverOrphanedTicket(d, candidate());
      expect(res).toEqual({ ok: true, recovered: false, reason: "live-run" });
      expect(calls.transitions).toHaveLength(0);
      expect(calls.comments).toHaveLength(0);
    }
  });

  it("does NOT touch a ticket with a queued dispatch", async () => {
    const store = orphanStore();
    store.dispatch_queue = [{ id: "q1", ticket_id: TICKET, tenant_id: T1, status: "pending" }];
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);

    const res = await recoverOrphanedTicket(d, candidate());
    expect(res).toEqual({ ok: true, recovered: false, reason: "pending-dispatch" });
    expect(calls.transitions).toHaveLength(0);
  });

  it("a SETTLED queue row does not disarm it (only `pending` is a live dispatch)", async () => {
    const store = orphanStore();
    store.dispatch_queue = [
      { id: "q1", ticket_id: TICKET, tenant_id: T1, status: "cancelled" },
      { id: "q2", ticket_id: TICKET, tenant_id: T1, status: "dispatched" },
    ];
    const { db } = fakeDb(store);
    const { deps: d } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({ recovered: true });
  });

  it("does NOT reap inside the grace window - a run created moments ago", async () => {
    // The near-race: a run row that has only just appeared. Even though it is
    // not yet `running` in this store, the clock is max(ticket, run) so the
    // fresh event restarts the whole window.
    const store = orphanStore();
    store.runs[0]!.last_event_at = JUST_NOW;
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);

    const res = await recoverOrphanedTicket(d, candidate());
    expect(res).toEqual({ ok: true, recovered: false, reason: "within-grace" });
    expect(calls.transitions).toHaveLength(0);
  });

  it("does NOT reap a ticket that was just touched, with no runs yet at all", async () => {
    // The dispatch→run write race in its purest form: the transition has fired
    // `ticket/dispatch-needed` and no `runs` row exists yet.
    const store = orphanStore();
    store.runs = [];
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);

    const res = await recoverOrphanedTicket(d, candidate({ updated_at: JUST_NOW }));
    expect(res).toEqual({ ok: true, recovered: false, reason: "within-grace" });
    expect(calls.transitions).toHaveLength(0);
  });

  it("stands down when the latest run is done (that is the stuck-ticket sweeper's ticket)", async () => {
    const store = orphanStore();
    store.runs[0]!.status = "done";
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);

    expect(await recoverOrphanedTicket(d, candidate())).toEqual({
      ok: true,
      recovered: false,
      reason: "latest-run-done",
    });
    expect(calls.transitions).toHaveLength(0);
  });

  it("reads the NEWEST run, not just any run, when deciding whose ticket this is", async () => {
    // An older failed run must not make a ticket whose latest run succeeded
    // look like ours.
    const store = orphanStore();
    store.runs.push({
      id: "run-2",
      ticket_id: TICKET,
      tenant_id: T1,
      status: "done",
      fan_out_group: null,
      created_at: "2026-07-19T11:00:00.000Z",
      last_event_at: "2026-07-19T11:00:00.000Z",
    });
    const { db } = fakeDb(store);
    const { deps: d } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({
      reason: "latest-run-done",
    });
  });

  it("stands down when automation is paused", async () => {
    const { db } = fakeDb(orphanStore());
    const { deps: d, calls } = deps(db, { isAutomationPaused: async () => true });
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({
      reason: "automation-paused",
    });
    expect(calls.transitions).toHaveLength(0);
  });

  it("does not comment when it lost the CAS race", async () => {
    const { db } = fakeDb(orphanStore());
    const { deps: d, calls } = deps(db, {
      transition: async () => ({ transitioned: false }),
    });
    expect(await recoverOrphanedTicket(d, candidate())).toEqual({
      ok: true,
      recovered: false,
      reason: "lost-cas-race",
    });
    // An explanation of a recovery that did not happen is worse than silence.
    expect(calls.comments).toHaveLength(0);
  });

  it("does not repeat itself when it already recovered this stall", async () => {
    const store = orphanStore();
    store.comments = [
      {
        id: "c1",
        ticket_id: TICKET,
        tenant_id: T1,
        author_id: "devpilot_orphan_reaper",
        created_at: "2026-07-19T11:30:00.000Z",
      },
    ];
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({
      reason: "already-recovered",
    });
    expect(calls.transitions).toHaveLength(0);
  });
});

describe("recoverOrphanedTicket - never throws", () => {
  it("returns {ok:false,reason} when a read explodes", async () => {
    const db = {
      from: () => {
        throw new Error("db exploded");
      },
    } as unknown as SupabaseClient;
    const { deps: d } = deps(db);
    const res = await recoverOrphanedTicket(d, candidate());
    expect(res.ok).toBe(false);
  });

  it("returns {ok:false,reason} when the transition throws", async () => {
    const { db } = fakeDb(orphanStore());
    const { deps: d } = deps(db, {
      transition: async () => {
        throw new Error("gate refused");
      },
    });
    const res = await recoverOrphanedTicket(d, candidate());
    expect(res).toMatchObject({ ok: false });
  });

  it("still reports success when only the comment fails - the ticket is unstuck", async () => {
    const { db } = fakeDb(orphanStore());
    const { deps: d } = deps(db, {
      comment: async () => {
        throw new Error("comments table down");
      },
    });
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({ recovered: true });
  });

  it("refuses a status outside the orphanable set", async () => {
    const { db } = fakeDb(orphanStore());
    const { deps: d } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate({ status: "backlog" }))).toEqual({
      ok: false,
      reason: "not-orphanable-status:backlog",
    });
  });
});

describe("sweepOrphanedTickets - the scan", () => {
  it("finds the orphan and recovers it", async () => {
    const { db } = fakeDb(orphanStore());
    const { deps: d, calls } = deps(db);
    const res = await sweepOrphanedTickets(d);
    expect(res).toMatchObject({ scanned: 1, recovered: 1 });
    expect(calls.transitions).toHaveLength(1);
  });

  it("never even considers a ticket outside the orphanable states", async () => {
    const store = orphanStore();
    store.tickets = [
      { id: "t-backlog", tenant_id: T1, status: "backlog", updated_at: LONG_AGO },
      { id: "t-done", tenant_id: T1, status: "done", updated_at: LONG_AGO },
      { id: "t-assigned", tenant_id: T1, status: "assigned", updated_at: LONG_AGO },
      { id: "t-blocked", tenant_id: T1, status: "blocked", updated_at: LONG_AGO },
    ];
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);
    expect(await sweepOrphanedTickets(d)).toMatchObject({ scanned: 0, recovered: 0 });
    expect(calls.transitions).toHaveLength(0);
  });

  it("pre-filters on the grace window in SQL", async () => {
    const store = orphanStore();
    store.tickets[0]!.updated_at = JUST_NOW;
    const { db } = fakeDb(store);
    const { deps: d } = deps(db);
    expect(await sweepOrphanedTickets(d)).toMatchObject({ scanned: 0 });
  });

  it("keeps sweeping after one row errors - a bad ticket must not stall the tick", async () => {
    const store = orphanStore();
    const BAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    store.tickets.unshift({
      id: BAD,
      tenant_id: T1,
      status: "in_progress",
      updated_at: "2026-07-19T09:00:00.000Z", // sorts first
    });
    store.runs.push({
      id: "run-bad",
      ticket_id: BAD,
      tenant_id: T1,
      status: "failed",
      fan_out_group: null,
      created_at: "2026-07-19T09:00:00.000Z",
      last_event_at: "2026-07-19T09:00:00.000Z",
    });
    const { db } = fakeDb(store);
    const { deps: d } = deps(db, {
      transition: async (args) => {
        if (args.ticketId === BAD) throw new Error("boom");
        return { transitioned: true };
      },
    });

    const res = await sweepOrphanedTickets(d);
    expect(res.scanned).toBe(2);
    // The healthy ticket behind the bad one is still recovered.
    expect(res.recovered).toBe(1);
    expect(res.outcomes.find((o) => o.ticketId === BAD)!.outcome).toMatch(/^error:/);
    expect(res.outcomes.find((o) => o.ticketId === TICKET)!.outcome).toBe(
      "recovered:input_required",
    );
  });
});

describe("tenant scoping", () => {
  it("every read carries a co-located tenant_id predicate", async () => {
    const { db, seen } = fakeDb(orphanStore());
    const { deps: d } = deps(db);
    await recoverOrphanedTicket(d, candidate());
    // Four reads: live runs, dispatch_queue, latest run, prior comments.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const read of seen) {
      expect(read.columns, `${read.table} read is missing tenant_id`).toContain("tenant_id");
    }
  });

  it("a FOREIGN-tenant live run does not disarm the reaper", async () => {
    // The dangerous direction: a planted row that makes us stand down and
    // strand our tenant's ticket permanently.
    const store = orphanStore();
    store.runs.push({
      id: "foreign-live",
      ticket_id: TICKET,
      tenant_id: T2,
      status: "running",
      fan_out_group: null,
      created_at: NOW,
      last_event_at: NOW,
    });
    const { db } = fakeDb(store);
    const { deps: d } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({ recovered: true });
  });

  it("a FOREIGN-tenant pending dispatch does not disarm the reaper", async () => {
    const store = orphanStore();
    store.dispatch_queue = [
      { id: "q-foreign", ticket_id: TICKET, tenant_id: T2, status: "pending" },
    ];
    const { db } = fakeDb(store);
    const { deps: d } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({ recovered: true });
  });

  it("a FOREIGN-tenant recovery comment does not disarm the reaper", async () => {
    const store = orphanStore();
    store.comments = [
      {
        id: "c-foreign",
        ticket_id: TICKET,
        tenant_id: T2,
        author_id: "devpilot_orphan_reaper",
        created_at: NOW,
      },
    ];
    const { db } = fakeDb(store);
    const { deps: d } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({ recovered: true });
  });

  it("recovers under the tenant on the CANDIDATE row, never a caller-supplied one", async () => {
    const store = orphanStore();
    store.tickets[0]!.tenant_id = T2;
    store.runs[0]!.tenant_id = T2;
    const { db } = fakeDb(store);
    const { deps: d, calls } = deps(db);
    await sweepOrphanedTickets(d);
    expect(calls.transitions[0]).toMatchObject({ tenantId: T2 });
  });
});

describe("tenant scoping - non-vacuity control", () => {
  // Re-run the three disarm scenarios with `.eq` neutered - i.e. what deleting
  // the tenant predicates would look like. Each MUST flip to standing down,
  // proving the assertions above are not passing for the wrong reason.
  it("without the tenant predicate, a foreign live run WOULD disarm the reaper", async () => {
    const store = orphanStore();
    store.runs.push({
      id: "foreign-live",
      ticket_id: TICKET,
      tenant_id: T2,
      status: "running",
      fan_out_group: null,
      created_at: NOW,
      last_event_at: NOW,
    });
    const { db } = fakeDb(store, { honourEq: false });
    const { deps: d } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({ reason: "live-run" });
  });

  it("without the tenant predicate, a foreign pending dispatch WOULD disarm the reaper", async () => {
    const store = orphanStore();
    store.dispatch_queue = [
      { id: "q-foreign", ticket_id: TICKET, tenant_id: T2, status: "pending" },
    ];
    const { db } = fakeDb(store, { honourEq: false });
    const { deps: d } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({
      reason: "pending-dispatch",
    });
  });

  it("without the tenant predicate, a foreign recovery comment WOULD disarm the reaper", async () => {
    const store = orphanStore();
    store.comments = [
      {
        id: "c-foreign",
        ticket_id: TICKET,
        tenant_id: T2,
        author_id: "devpilot_orphan_reaper",
        created_at: NOW,
      },
    ];
    const { db } = fakeDb(store, { honourEq: false });
    const { deps: d } = deps(db);
    expect(await recoverOrphanedTicket(d, candidate())).toMatchObject({
      reason: "already-recovered",
    });
  });
});
