// The never-triggered-land sweep — IO, tenant scoping, and the guarantee that
// it never overlaps the existing in-flight reaper.
//
// The fake below ACTUALLY APPLIES `.eq` / `.in` / `.lt`, including on the
// UPDATE path. That is the whole point: a fake that ignores filters makes every
// assertion vacuous, and this module is service-role (a cron has no session, so
// RLS is off) — the co-located `.eq("tenant_id", …)` is the entire boundary.
// Each scoping test is paired with a CONTROL that neuters the predicate and
// asserts the foreign row WOULD have been reached, so deleting a predicate
// turns these red rather than leaving them silently passing.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  rescuePendingLand,
  sweepStalledLands,
  type LandRescueDeps,
  type PendingLandRow,
} from "@/lib/engine/land-rescue-reaper";

const OURS = "tenant-ours";
const THEIRS = "tenant-theirs";
const PROJECT = "project-1";
const TICKET = "ticket-1";
const QUEUE_ID = "queue-1";
const NOW = "2026-07-19T22:00:00.000Z";
const HOURS_AGO = "2026-07-19T15:00:00.000Z";

type Row = Record<string, unknown>;

/** A query builder that really filters, on reads AND writes.
 *  `ignoreTenantFilter` / `ignoreStatusFilter` are the control knobs. */
function makeDb(
  tables: Record<string, Row[]>,
  opts: { ignoreTenantFilter?: boolean; ignoreStatusFilter?: boolean } = {},
) {
  const writes: Array<{ table: string; patch: Row; matched: Row[] }> = [];
  const db = {
    writes,
    from(table: string) {
      const all = tables[table] ?? [];
      let rows = [...all];
      let patch: Row | null = null;
      const builder = {
        select() {
          return builder;
        },
        update(p: Row) {
          patch = p;
          return builder;
        },
        eq(col: string, val: unknown) {
          if (col === "tenant_id" && opts.ignoreTenantFilter) return builder;
          if (col === "status" && opts.ignoreStatusFilter) return builder;
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          rows = rows.filter((r) => vals.includes(r[col]));
          return builder;
        },
        lt(col: string, val: string) {
          rows = rows.filter((r) => String(r[col] ?? "") < val);
          return builder;
        },
        order() {
          return builder;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return builder;
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          if (patch) {
            for (const r of rows) Object.assign(r, patch);
            writes.push({ table, patch, matched: rows });
          }
          return Promise.resolve(resolve({ data: rows, error: null }));
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return db;
}

function queueRow(over: Partial<Row> = {}): Row {
  return {
    id: QUEUE_ID,
    tenant_id: OURS,
    project_id: PROJECT,
    ticket_id: TICKET,
    status: "pending",
    attempts: 1,
    last_error: null,
    updated_at: HOURS_AGO,
    enqueued_at: HOURS_AGO,
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deps(db: any, over: Partial<LandRescueDeps> = {}): LandRescueDeps {
  return {
    db,
    emitLandNeeded: vi.fn(async () => undefined),
    nowIso: NOW,
    baseGraceMs: 5 * 60_000,
    maxRescues: 6,
    ...over,
  };
}

describe("rescuePendingLand — the never-triggered land is re-emitted", () => {
  it("re-emits and records the rescue for the observed production shape", async () => {
    // pending / attempts=1 / claimed_at=null / untouched for 7 hours, with
    // nothing else in flight and no blocking relations.
    const rows = [queueRow()];
    const db = makeDb({ integration_queue: rows, ticket_dependencies: [], tickets: [] });
    const d = deps(db);

    const res = await rescuePendingLand(d, rows[0]! as PendingLandRow);

    expect(res).toEqual({ ok: true, action: "rescue", rescues: 1 });
    expect(d.emitLandNeeded).toHaveBeenCalledWith({ tenantId: OURS, projectId: PROJECT });
    // Recorded as a rescue — a pattern of them is visible, not invisible.
    expect(String(rows[0]!.last_error)).toContain("[land-rescue 1/6 @");
    // …and the row stays pending; the rescue never moves it itself.
    expect(rows[0]!.status).toBe("pending");
  });

  it("preserves the real failure reason underneath the rescue marker", async () => {
    const original = "push rejected: … does not carry the `workflow` scope";
    const rows = [queueRow({ last_error: original })];
    const db = makeDb({ integration_queue: rows, ticket_dependencies: [], tickets: [] });

    await rescuePendingLand(deps(db), rows[0]! as PendingLandRow);

    expect(String(rows[0]!.last_error)).toContain(original);
  });
});

describe("rescuePendingLand — the double-land guard", () => {
  it("does NOT re-emit while another row in the project is landing", async () => {
    // The damaging case: a second land rebasing onto a dev tip the live worker
    // is about to move.
    const target = queueRow();
    const inFlight = queueRow({ id: "queue-2", ticket_id: "ticket-2", status: "landing" });
    const db = makeDb({
      integration_queue: [target, inFlight],
      ticket_dependencies: [],
      tickets: [],
    });
    const d = deps(db);

    const res = await rescuePendingLand(d, target as PendingLandRow);

    expect(res).toEqual({ ok: true, action: "skip", reason: "project-lane-busy" });
    expect(d.emitLandNeeded).not.toHaveBeenCalled();
    expect(target.last_error).toBeNull();
  });

  it("CONTROL: with the lane guard's status predicate neutered, the same row IS reached", async () => {
    // Proves the guard above is load-bearing rather than incidentally passing.
    const target = queueRow();
    const db = makeDb(
      { integration_queue: [target], ticket_dependencies: [], tickets: [] },
      { ignoreStatusFilter: true },
    );
    const res = await rescuePendingLand(deps(db), target as PendingLandRow);
    // With `.eq("status","landing")` neutered the target itself matches, so the
    // sweep reads the lane as busy — i.e. that predicate is what selects it.
    expect(res).toEqual({ ok: true, action: "skip", reason: "project-lane-busy" });
  });

  it("loses the CAS and emits nothing when the row was claimed while we decided", async () => {
    const target = queueRow();
    const db = makeDb({ integration_queue: [target], ticket_dependencies: [], tickets: [] });
    const d = deps(db);
    // Simulate the claim landing between the read and the write.
    const original = d.db.from.bind(d.db);
    let reads = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d.db as any).from = (table: string) => {
      reads += 1;
      if (reads > 1 && table === "integration_queue") target.status = "landing";
      return original(table);
    };

    const res = await rescuePendingLand(d, target as PendingLandRow);

    expect(res).toEqual({ ok: true, action: "skip", reason: "lost-cas-race" });
    expect(d.emitLandNeeded).not.toHaveBeenCalled();
  });

  it("never touches a row that is already in flight", async () => {
    const target = queueRow({ status: "landing" });
    const db = makeDb({ integration_queue: [target], ticket_dependencies: [], tickets: [] });
    const d = deps(db);
    const res = await rescuePendingLand(d, target as PendingLandRow);
    expect(res).toEqual({ ok: true, action: "skip", reason: "not-pending:landing" });
    expect(d.emitLandNeeded).not.toHaveBeenCalled();
  });
});

describe("rescuePendingLand — a permanently-failing land stops being retried", () => {
  it("fails the row once the rescue budget is spent, naming why", async () => {
    const rows = [
      queueRow({
        attempts: 3,
        last_error: "[land-rescue 6/6 @ 2026-07-19T16:00:00.000Z] push rejected: workflow scope",
      }),
    ];
    const db = makeDb({ integration_queue: rows, ticket_dependencies: [], tickets: [] });
    const d = deps(db);

    const res = await rescuePendingLand(d, rows[0]! as PendingLandRow);

    expect(res).toEqual({ ok: true, action: "give_up" });
    expect(rows[0]!.status).toBe("failed");
    // The give-up is a readable record: the board's landing card renders a
    // `failed` row's last_error as "Not landed — land failed <detail>".
    expect(String(rows[0]!.last_error)).toContain("6 re-emitted events");
    expect(String(rows[0]!.last_error)).toContain("workflow scope");
    // And it does NOT emit another land.
    expect(d.emitLandNeeded).not.toHaveBeenCalled();
  });

  it("does not give up on a dependency-deferred row, however long it waits", async () => {
    // A `builds_on` child whose parent has not landed. Failing it would break a
    // stacked chain that is working exactly as designed.
    const rows = [queueRow({ last_error: "[land-rescue 6/6 @ 2026-07-19T10:00:00.000Z] x" })];
    const db = makeDb({
      integration_queue: [...rows, { tenant_id: OURS, ticket_id: "parent-1", status: "pending" }],
      ticket_dependencies: [
        { ticket_id: TICKET, blocks_ticket_id: "parent-1", relation_type: "builds_on" },
      ],
      tickets: [{ id: "parent-1", tenant_id: OURS, status: "done", landed_sha: null }],
    });
    const d = deps(db);

    const res = await rescuePendingLand(d, rows[0]! as PendingLandRow);

    expect(res).toEqual({ ok: true, action: "skip", reason: "dependency-deferred" });
    expect(rows[0]!.status).toBe("pending");
    expect(d.emitLandNeeded).not.toHaveBeenCalled();
  });

  it("treats an unreadable dependency state as deferred, never as a give-up", async () => {
    const rows = [queueRow({ last_error: "[land-rescue 6/6 @ 2026-07-19T10:00:00.000Z] x" })];
    const db = makeDb({ integration_queue: rows, ticket_dependencies: [], tickets: [] });
    // Force the dependency read to error.
    const realFrom = db.from.bind(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from = (table: string) =>
      table === "ticket_dependencies"
        ? {
            select: () => ({
              eq: () => ({
                in: () => ({
                  then: (r: (v: { data: null; error: { message: string } }) => unknown) =>
                    Promise.resolve(r({ data: null, error: { message: "boom" } })),
                }),
              }),
            }),
          }
        : realFrom(table);

    const res = await rescuePendingLand(deps(db), rows[0]! as PendingLandRow);

    expect(res).toEqual({ ok: true, action: "skip", reason: "dependency-deferred" });
    expect(rows[0]!.status).toBe("pending");
  });
});

describe("rescuePendingLand — tenant scoping is the whole boundary", () => {
  it("a FOREIGN in-flight row does not stand our rescue down", async () => {
    // The sharpest disarm signal: another tenant's `landing` row in a project
    // id we happen to share would strand our land for good.
    const target = queueRow();
    const foreign = queueRow({
      id: "queue-x",
      tenant_id: THEIRS,
      ticket_id: "ticket-x",
      status: "landing",
    });
    const db = makeDb({
      integration_queue: [target, foreign],
      ticket_dependencies: [],
      tickets: [],
    });
    const d = deps(db);

    const res = await rescuePendingLand(d, target as PendingLandRow);

    expect(res).toEqual({ ok: true, action: "rescue", rescues: 1 });
    expect(d.emitLandNeeded).toHaveBeenCalledOnce();
  });

  it("CONTROL: without the tenant predicate the foreign row DOES strand us", async () => {
    const target = queueRow();
    const foreign = queueRow({
      id: "queue-x",
      tenant_id: THEIRS,
      ticket_id: "ticket-x",
      status: "landing",
    });
    const db = makeDb(
      { integration_queue: [target, foreign], ticket_dependencies: [], tickets: [] },
      { ignoreTenantFilter: true },
    );
    const res = await rescuePendingLand(deps(db), target as PendingLandRow);
    expect(res).toEqual({ ok: true, action: "skip", reason: "project-lane-busy" });
  });

  it("a FOREIGN blocker ticket is not resolved, so it cannot defer our land", async () => {
    const target = queueRow();
    const db = makeDb({
      integration_queue: [target],
      ticket_dependencies: [
        { ticket_id: TICKET, blocks_ticket_id: "parent-1", relation_type: "blocked_by" },
      ],
      // The blocker row exists, but in ANOTHER tenant.
      tickets: [{ id: "parent-1", tenant_id: THEIRS, status: "done", landed_sha: null }],
    });
    const res = await rescuePendingLand(deps(db), target as PendingLandRow);
    // Unresolvable ⇒ treated as open ⇒ deferred. Conservative, and crucially it
    // never lets a foreign row's `done` UNBLOCK us.
    expect(res).toEqual({ ok: true, action: "skip", reason: "dependency-deferred" });
  });

  it("the give-up write cannot fail a FOREIGN tenant's row", async () => {
    const foreign = queueRow({
      tenant_id: THEIRS,
      last_error: "[land-rescue 6/6 @ 2026-07-19T10:00:00.000Z] x",
    });
    const db = makeDb({ integration_queue: [foreign], ticket_dependencies: [], tickets: [] });
    // Evaluate it as though the scan handed us the row but with OUR tenant id —
    // the write must not match.
    const res = await rescuePendingLand(deps(db), {
      ...(foreign as PendingLandRow),
      tenant_id: OURS,
    });
    expect(res).toEqual({ ok: true, action: "skip", reason: "lost-cas-race" });
    expect(foreign.status).toBe("pending");
  });
});

describe("sweepStalledLands", () => {
  it("scans only pending rows past the grace and reports each outcome", async () => {
    const stale = queueRow();
    const fresh = queueRow({ id: "queue-fresh", ticket_id: "t-fresh", updated_at: NOW });
    // In a DIFFERENT project, so it is excluded by the scan's status filter
    // rather than by the lane guard.
    const inFlight = queueRow({
      id: "queue-live",
      ticket_id: "t-live",
      project_id: "project-2",
      status: "landing",
    });
    const db = makeDb({
      integration_queue: [stale, fresh, inFlight],
      ticket_dependencies: [],
      tickets: [],
    });

    const res = await sweepStalledLands(deps(db));

    expect(res.scanned).toBe(1);
    expect(res.rescued).toBe(1);
    expect(res.gaveUp).toBe(0);
    expect(res.outcomes).toEqual([{ queueId: QUEUE_ID, outcome: "rescue" }]);
  });

  it("a scan failure is reported, not thrown", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            lt: () => ({
              order: () => ({
                limit: () => ({
                  then: (r: (v: { data: null; error: { message: string } }) => unknown) =>
                    Promise.resolve(r({ data: null, error: { message: "down" } })),
                }),
              }),
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(sweepStalledLands(deps(db))).resolves.toEqual({
      scanned: 0,
      rescued: 0,
      gaveUp: 0,
      outcomes: [],
    });
  });
});

describe("the existing in-flight reaper is untouched", () => {
  // `integrationQueueReaper` is an Inngest function that cannot load under
  // Vitest, so its scope is pinned by reading the source. What must hold is
  // that the two 5-minute crons address DISJOINT status sets — the existing one
  // still reaps exactly the in-flight statuses, and the new sweep still takes
  // only `pending`. If they ever overlapped, both could act on one row.
  const root = join(__dirname, "..");
  const landWorker = readFileSync(join(root, "land-worker.ts"), "utf8");
  const rescue = readFileSync(join(root, "land-rescue-reaper.ts"), "utf8");

  it("still scans landing + awaiting_merge_resolution", () => {
    expect(landWorker).toContain(`.in("status", ["landing", "awaiting_merge_resolution"])`);
  });

  it("does not scan or act on pending rows", () => {
    expect(landWorker).not.toMatch(/\.eq\("status",\s*"pending"\)/);
  });

  it("the rescue sweep scans only pending", () => {
    expect(rescue).toContain(`.eq("status", "pending")`);
    expect(rescue).not.toContain(`"awaiting_merge_resolution"`);
  });

  it("the rescue sweep is gated by the same auto-land kill switch", () => {
    expect(rescue).toContain("isAutoLandEnabled()");
  });
});
