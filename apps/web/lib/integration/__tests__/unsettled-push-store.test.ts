// The unsettled-push scan, driven against a filter-APPLYING fake Supabase
// client.
//
// A fake that ignores `.eq()` makes every tenant-scope assertion vacuous, so
// this one really applies its predicates and each scope test carries a CONTROL
// that neuters the predicate and asserts the wrong answer WOULD come back.
//
// Tenant scope matters unusually much here, and in an unusual direction: what a
// missing predicate produces is not a disclosure. It is a `pushed_at` stamped on
// ANOTHER tenant's genuinely unpushed work, which drops it off their Changes
// badge and RELEASES THEIR REAP GUARD - i.e. a route to deleting the only copy
// of one of their commits.

import { describe, expect, it } from "vitest";
import { scanUnsettledLandedPushes } from "@/lib/integration/unsettled-push-store";
import {
  NOTHING_TO_LAND_AUTHOR_ID,
  NOTHING_TO_LAND_METADATA_KIND,
} from "@/lib/integration/land-outcome";

const OURS = "tenant-ours";
const THEIRS = "tenant-theirs";
const P1 = "project-1";

type Row = Record<string, unknown>;

type FakeOpts = {
  tables: Record<string, Row[]>;
  /** Drop the tenant predicate to prove an assertion is not vacuous. */
  ignoreEq?: boolean;
  failTable?: string;
};

/** Minimal PostgREST-shaped fake that ACTUALLY filters. */
function fakeDb(opts: FakeOpts) {
  function builder(table: string) {
    let rows = [...(opts.tables[table] ?? [])];
    function finish() {
      if (opts.failTable === table) return { data: null, error: { message: `${table} exploded` } };
      return { data: rows, error: null };
    }
    const api: Record<string, unknown> = {
      select: () => api,
      eq(col: string, val: unknown) {
        // Only the tenant predicate is neutered by the control - dropping every
        // `.eq` would break the fake's ability to find anything at all and the
        // control would prove nothing.
        if (opts.ignoreEq && col === "tenant_id") return api;
        rows = rows.filter((r) => r[col] === val);
        return api;
      },
      in(col: string, vals: unknown[]) {
        rows = rows.filter((r) => vals.includes(r[col]));
        return api;
      },
      is(col: string, val: unknown) {
        rows = rows.filter((r) => (r[col] ?? null) === val);
        return api;
      },
      not(col: string, _op: string, _val: unknown) {
        rows = rows.filter((r) => (r[col] ?? null) !== null);
        return api;
      },
      // `order` and `limit` are REAL here, not no-ops. `resolveTicketPush`'s
      // whole contract is "the ticket's NEWEST push", so a fake that ignored
      // ordering would let the scope test below pass for the wrong reason.
      order(col: string, o?: { ascending?: boolean }) {
        const dir = o?.ascending === false ? -1 : 1;
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -dir : dir));
        return api;
      },
      limit(n: number) {
        rows = rows.slice(0, n);
        return api;
      },
      maybeSingle() {
        const out = finish();
        return { data: (out.data as Row[] | null)?.[0] ?? null, error: out.error };
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(finish()).then(resolve);
      },
    };
    return api;
  }
  return { from: (t: string) => builder(t) } as never;
}

function push(over: Row = {}): Row {
  return {
    id: "push-1",
    tenant_id: OURS,
    project_id: P1,
    ticket_id: "ticket-1",
    branch: "devpilot/thing",
    workspace_path: "/w/ticket-1",
    pushed_at: null,
    head_sha: "abc123",
    merger_ticket_id: null,
    updated_at: "2026-08-04T00:00:00.000Z",
    ...over,
  };
}

function ticket(over: Row = {}): Row {
  return {
    id: "ticket-1",
    tenant_id: OURS,
    project_id: P1,
    parent_ticket_id: null,
    landed_sha: "abc123",
    ...over,
  };
}

function notice(ticketId: string, over: Row = {}): Row {
  return {
    ticket_id: ticketId,
    tenant_id: OURS,
    author_type: "system",
    author_id: NOTHING_TO_LAND_AUTHOR_ID,
    metadata: { kind: NOTHING_TO_LAND_METADATA_KIND },
    ...over,
  };
}

const scan = (db: never) => scanUnsettledLandedPushes(db, { tenantId: OURS, projectIds: [P1] });

// ───────────────────────────────────────────────────────────────────────────
// The case it exists for, and the control that matters.
// ───────────────────────────────────────────────────────────────────────────

describe("scanUnsettledLandedPushes", () => {
  it("finds a landed ticket whose push row was never settled", async () => {
    const db = fakeDb({
      tables: { pending_pushes: [push()], tickets: [ticket()], comments: [] },
    });
    const out = await scan(db);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({
      tenantId: OURS,
      ticketId: "ticket-1",
      pushId: "push-1",
      landedSha: "abc123",
      via: "direct",
    });
  });

  // THE CONTROL. A sweep that acts on everything is indistinguishable from a
  // correct one on a healthy board - until it releases the reap guard on live
  // work. Every ordinary in-flight push row looks exactly like this.
  it("returns NOTHING for a ticket that has not landed", async () => {
    const db = fakeDb({
      tables: {
        pending_pushes: [push()],
        tickets: [ticket({ landed_sha: null })],
        comments: [],
      },
    });
    const out = await scan(db);
    expect(out.candidates).toEqual([]);
    expect(out.scanned).toBe(1);
    expect(out.standDowns).toMatchObject({ "not-landed": 1 });
  });

  it("returns nothing for the 'backfill' sentinel", async () => {
    const db = fakeDb({
      tables: {
        pending_pushes: [push()],
        tickets: [ticket({ landed_sha: "backfill" })],
        comments: [],
      },
    });
    const out = await scan(db);
    expect(out.candidates).toEqual([]);
    expect(out.standDowns).toMatchObject({ "backfill-sentinel": 1 });
  });

  it("returns nothing for a ticket that closed as nothing-to-land", async () => {
    const db = fakeDb({
      tables: {
        pending_pushes: [push()],
        tickets: [ticket()],
        comments: [notice("ticket-1")],
      },
    });
    const out = await scan(db);
    expect(out.candidates).toEqual([]);
    expect(out.standDowns).toMatchObject({ "nothing-to-land": 1 });
  });

  // The `author_type = 'system'` clause is the one an agent cannot satisfy. Here
  // a forgery runs the SAFE way (it would only SUPPRESS a repair), but the check
  // is written identically to `landing-records.ts` so the two readers cannot
  // drift into disagreeing about what the record is.
  it("ignores a comment that only looks like the notice", async () => {
    const db = fakeDb({
      tables: {
        pending_pushes: [push()],
        tickets: [ticket()],
        comments: [notice("ticket-1", { author_type: "agent" })],
      },
    });
    expect((await scan(db)).candidates).toHaveLength(1);
  });

  it("skips a row that is already settled", async () => {
    const db = fakeDb({
      tables: {
        pending_pushes: [push({ pushed_at: "2026-08-04T01:00:00.000Z" })],
        tickets: [ticket()],
        comments: [],
      },
    });
    // Filtered out in SQL by `.is("pushed_at", null)`, so it is never even
    // scanned - the policy's `already-settled` arm is the second line.
    expect((await scan(db)).candidates).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Only the row the landing itself would have settled.
// ───────────────────────────────────────────────────────────────────────────

describe("scanUnsettledLandedPushes - scope", () => {
  // #156's rule, inherited: ONE row, by id. A ticket carrying a second push on
  // another branch keeps it, and keeps being counted, correctly. Here the newest
  // row (what `resolveTicketPush` returns) is already settled, so the older one
  // is NOT ours to settle - we have no evidence its branch shipped.
  it("does not settle an older row when the landing resolved a newer one", async () => {
    const db = fakeDb({
      tables: {
        pending_pushes: [
          push({ id: "push-old", branch: "devpilot/old", updated_at: "2026-08-01T00:00:00.000Z" }),
          push({
            id: "push-new",
            branch: "devpilot/new",
            pushed_at: "2026-08-04T02:00:00.000Z",
            updated_at: "2026-08-03T00:00:00.000Z",
          }),
        ],
        tickets: [ticket()],
        comments: [],
      },
    });
    const out = await scan(db);
    expect(out.candidates).toEqual([]);
    expect(out.standDowns).toMatchObject({ "not-the-landings-row": 1 });
  });

  it("only scans projects that opted in to supervision", async () => {
    const db = fakeDb({
      tables: {
        pending_pushes: [push({ project_id: "project-unsupervised" })],
        tickets: [ticket()],
        comments: [],
      },
    });
    const out = await scanUnsettledLandedPushes(db, { tenantId: OURS, projectIds: [P1] });
    expect(out.candidates).toEqual([]);
    expect(out.scanned).toBe(0);
  });

  it("does nothing at all when no project opted in", async () => {
    const db = fakeDb({
      tables: { pending_pushes: [push()], tickets: [ticket()], comments: [] },
    });
    const out = await scanUnsettledLandedPushes(db, { tenantId: OURS, projectIds: [] });
    expect(out).toMatchObject({ candidates: [], scanned: 0 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// TENANT ISOLATION - with a control per predicate.
// ───────────────────────────────────────────────────────────────────────────

describe("scanUnsettledLandedPushes - tenant isolation", () => {
  const foreign = {
    pending_pushes: [push({ id: "push-theirs", tenant_id: THEIRS })],
    tickets: [ticket()],
    comments: [],
  };

  // `scanned` as well as `candidates`, and the distinction is what makes this
  // test pin the predicate it names. The later reads carry their own
  // `.eq("tenant_id", …)`, so a foreign row stands down anyway once it is
  // scanned - asserting only `candidates` would stay green with the FIRST
  // predicate deleted (verified: it does). A foreign row must not be looked at
  // at all.
  it("never even scans another tenant's push row", async () => {
    const out = await scan(fakeDb({ tables: foreign }));
    expect(out.scanned).toBe(0);
    expect(out.candidates).toEqual([]);
  });

  // CONTROL: without the predicate the foreign row IS returned as a candidate,
  // i.e. the supervisor would go on to stamp `pushed_at` on it.
  it("control: neutering the tenant predicate reaches the foreign row", async () => {
    const out = await scan(fakeDb({ tables: foreign, ignoreEq: true }));
    expect(out.scanned).toBe(1);
    expect(out.candidates.map((c) => c.pushId)).toContain("push-theirs");
  });

  it("never reads another tenant's ticket to justify our row", async () => {
    const db = fakeDb({
      tables: {
        pending_pushes: [push()],
        // Same id, foreign tenant, and it HAS landed. Only the tenant predicate
        // on the ticket read keeps it from vouching for our push row.
        tickets: [ticket({ tenant_id: THEIRS })],
        comments: [],
      },
    });
    expect((await scan(db)).candidates).toEqual([]);
  });

  it("control: neutering the tenant predicate lets the foreign ticket vouch", async () => {
    const db = fakeDb({
      tables: {
        pending_pushes: [push()],
        tickets: [ticket({ tenant_id: THEIRS })],
        comments: [],
      },
      ignoreEq: true,
    });
    expect((await scan(db)).candidates).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Failures degrade to fewer candidates, never to a wrong one.
// ───────────────────────────────────────────────────────────────────────────

describe("scanUnsettledLandedPushes - failure posture", () => {
  it("returns nothing when the push read fails", async () => {
    const db = fakeDb({ tables: { pending_pushes: [push()] }, failTable: "pending_pushes" });
    await expect(scan(db)).resolves.toMatchObject({ candidates: [] });
  });

  it("returns nothing when the ticket read fails", async () => {
    const db = fakeDb({
      tables: { pending_pushes: [push()], tickets: [ticket()], comments: [] },
      failTable: "tickets",
    });
    await expect(scan(db)).resolves.toMatchObject({ candidates: [] });
  });

  // FAIL CLOSED. An unreadable comments table means we cannot tell a landing
  // from a nothing-to-land closure, and the second must never be settled.
  it("stands down on every candidate when the notice read fails", async () => {
    const db = fakeDb({
      tables: { pending_pushes: [push()], tickets: [ticket()], comments: [] },
      failTable: "comments",
    });
    const out = await scan(db);
    expect(out.candidates).toEqual([]);
    expect(out.standDowns).toMatchObject({ "notice-read-failed": 1 });
  });
});
