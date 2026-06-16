// Settling the push row a landing made moot — and, just as importantly, NOT
// settling one that still represents real unpushed work.
//
// The fake below ACTUALLY APPLIES `.eq` / `.is`. That is the whole point: a fake
// that ignores filters makes every assertion here vacuous. Each guard is paired
// with a CONTROL that neuters the predicate and asserts the row WOULD have been
// touched, so deleting a predicate turns these red rather than leaving them
// silently green.
//
// Severity is unusually high for a "badge" fix: `pushed_at` non-null is also
// what releases the unpushed-work reap guard (`lib/workspace/unpushed-work.ts`),
// so settling a row we have not proved is on the remote is a route to deleting
// the only copy of a commit. Hence the deliberately narrow scope — one row, by
// id, tenant-scoped, CAS-guarded.

import { describe, expect, it } from "vitest";
import { settleLandedPush } from "@/lib/integration/landed-push";

const OURS = "tenant-ours";
const THEIRS = "tenant-theirs";

type Row = Record<string, unknown>;

type Opts = { ignoreTenantFilter?: boolean; ignorePushedAtCas?: boolean };

/** A query builder that really filters, and really mutates the backing rows. */
function makeDb(rows: Row[], opts: Opts = {}) {
  const db = {
    from() {
      let matched = [...rows];
      let patch: Row = {};
      const builder = {
        update(values: Row) {
          patch = values;
          return builder;
        },
        eq(col: string, val: unknown) {
          if (col === "tenant_id" && opts.ignoreTenantFilter) return builder;
          matched = matched.filter((r) => r[col] === val);
          return builder;
        },
        is(col: string, val: unknown) {
          if (col === "pushed_at" && opts.ignorePushedAtCas) return builder;
          matched = matched.filter((r) => (r[col] ?? null) === val);
          return builder;
        },
        select() {
          for (const r of matched) Object.assign(r, patch);
          return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return db;
}

/** `rows[i]` is `Row | undefined` under noUncheckedIndexedAccess; assertions
 *  read through this so a missing row fails loudly instead of being asserted on. */
const settledAt = (rows: Row[], i: number): string | null =>
  (rows[i]?.pushed_at as string | null | undefined) ?? null;

function push(over: Partial<Row> = {}): Row {
  return { id: "pp-1", tenant_id: OURS, branch: "devpilot/ours", pushed_at: null, ...over };
}

describe("settleLandedPush", () => {
  it("settles the landing's own row", async () => {
    const rows = [push()];
    const moved = await settleLandedPush(makeDb(rows), {
      pendingPushId: "pp-1",
      tenantId: OURS,
    });
    expect(moved).toBe(true);
    expect(settledAt(rows, 0)).toEqual(expect.any(String));
  });

  // THE "did you fix the badge by making it blind?" test. A landing settles the
  // ONE row it resolved. Any other unpushed row — a second branch, another
  // ticket's work — is still unpushed and must still be counted.
  it("leaves every other unpushed row alone", async () => {
    const rows = [
      push({ id: "pp-1" }),
      push({ id: "pp-2", branch: "devpilot/other-branch" }),
      push({ id: "pp-3", branch: "devpilot/someone-elses" }),
    ];
    await settleLandedPush(makeDb(rows), { pendingPushId: "pp-1", tenantId: OURS });

    expect(settledAt(rows, 0)).not.toBeNull();
    expect(settledAt(rows, 1)).toBeNull();
    expect(settledAt(rows, 2)).toBeNull();
  });

  it("is a no-op for a branchless ticket", async () => {
    const rows = [push()];
    const moved = await settleLandedPush(makeDb(rows), { pendingPushId: null, tenantId: OURS });
    expect(moved).toBe(false);
    expect(settledAt(rows, 0)).toBeNull();
  });

  it("never settles another tenant's row", async () => {
    const rows = [push({ id: "pp-1", tenant_id: THEIRS })];
    const moved = await settleLandedPush(makeDb(rows), {
      pendingPushId: "pp-1",
      tenantId: OURS,
    });
    expect(moved).toBe(false);
    expect(settledAt(rows, 0)).toBeNull();
  });

  it("CONTROL: without the tenant predicate the foreign row WOULD be settled", async () => {
    const rows = [push({ id: "pp-1", tenant_id: THEIRS })];
    const moved = await settleLandedPush(makeDb(rows, { ignoreTenantFilter: true }), {
      pendingPushId: "pp-1",
      tenantId: OURS,
    });
    expect(moved).toBe(true);
    expect(settledAt(rows, 0)).not.toBeNull();
  });

  it("does not overwrite an earlier, genuine push timestamp", async () => {
    const already = "2026-07-10T12:00:00Z";
    const row = push({ pushed_at: already });
    const moved = await settleLandedPush(makeDb([row]), {
      pendingPushId: "pp-1",
      tenantId: OURS,
    });
    expect(moved).toBe(false);
    expect(row.pushed_at).toBe(already);
  });

  it("CONTROL: without the pushed_at CAS the earlier timestamp WOULD be clobbered", async () => {
    const already = "2026-07-10T12:00:00Z";
    const row = push({ pushed_at: already });
    await settleLandedPush(makeDb([row], { ignorePushedAtCas: true }), {
      pendingPushId: "pp-1",
      tenantId: OURS,
    });
    expect(row.pushed_at).not.toBe(already);
  });

  it("surfaces a write error rather than reporting a settle that did not happen", async () => {
    const db = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              is: () => ({
                select: () => Promise.resolve({ data: null, error: { message: "boom" } }),
              }),
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(settleLandedPush(db, { pendingPushId: "pp-1", tenantId: OURS })).rejects.toThrow(
      /settleLandedPush: boom/,
    );
  });
});
