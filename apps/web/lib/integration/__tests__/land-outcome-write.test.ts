// Tenant isolation for the two `pending_pushes` accesses on the landing path.
//
// Both run on the SERVICE client (the land worker is an Inngest function with no
// session, so RLS is off), which makes the co-located `.eq("tenant_id", …)` the
// ENTIRE boundary. It matters unusually much here: `pending_pushes.branch` is
// the ref the land worker MERGES into the integration branch, so a foreign row
// that could be stamped `resolved` is a foreign branch declared safe to land.
//
// The fake below ACTUALLY APPLIES `.eq` against a shared store — a
// filter-ignoring fake would make every assertion vacuous. The CONTROL at the
// bottom proves non-vacuity directly: with `.eq` neutered (i.e. what deleting
// the tenant predicate looks like) the foreign row IS clobbered, so if the
// predicate ever disappears the earlier tests go red.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadPendingPushConflictState,
  markConflictResolved,
} from "@/lib/integration/land-outcome-write";

type Row = Record<string, unknown>;

function fakeClient(store: Row[], opts: { honourEq?: boolean } = {}) {
  const honourEq = opts.honourEq ?? true;
  const seen: Array<{ columns: string[] }> = [];

  function builder() {
    const filters: Array<(r: Row) => boolean> = [];
    const columns: string[] = [];
    let patch: Row | null = null;
    const self: Record<string, unknown> = {};

    self.update = (p: Row) => {
      patch = p;
      return self;
    };
    self.eq = (c: string, v: unknown) => {
      columns.push(c);
      if (honourEq) filters.push((r) => r[c] === v);
      return self;
    };
    const run = () => {
      seen.push({ columns });
      const matched = store.filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of matched) Object.assign(r, patch);
      return matched;
    };
    // `.select()` is chainable in BOTH orders the real client allows: a read is
    // `.select().eq().eq().maybeSingle()`, a write is `.update().eq()….select()`.
    // So it stays on the same builder and evaluation is deferred to `then` /
    // `maybeSingle`, or the read's filters would be applied after the fact.
    self.select = () => self;
    self.maybeSingle = () => {
      const matched = run();
      return Promise.resolve({
        data: matched.length > 0 ? { ...matched[0] } : null,
        error: null,
      });
    };
    self.then = (
      resolve: (v: { data: Row[]; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) =>
      Promise.resolve()
        .then(() => ({ data: run().map((r) => ({ ...r })), error: null as null }))
        .then(resolve, reject);
    return self;
  }

  return { client: { from: () => builder() } as unknown as SupabaseClient, seen };
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const PUSH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function push(tenantId: string, over: Row = {}): Row {
  return {
    id: PUSH,
    tenant_id: tenantId,
    branch: "devpilot/ci-deploy",
    conflict_state: "conflict",
    rebased_onto_sha: null,
    ...over,
  };
}

describe("markConflictResolved", () => {
  it("clears the conflict and records the replayed sha on our own row", async () => {
    const store = [push(T1)];
    const { client } = fakeClient(store);

    const moved = await markConflictResolved(client, {
      pendingPushId: PUSH,
      tenantId: T1,
      rebasedOntoSha: "c0ffee1",
    });

    expect(moved).toBe(true);
    expect(store[0]!.conflict_state).toBe("resolved");
    expect(store[0]!.rebased_onto_sha).toBe("c0ffee1");
  });

  it("never touches another tenant's row", async () => {
    const store = [push(T2)];
    const { client } = fakeClient(store);

    const moved = await markConflictResolved(client, {
      pendingPushId: PUSH,
      tenantId: T1,
      rebasedOntoSha: "c0ffee1",
    });

    expect(moved).toBe(false);
    expect(store[0]!.conflict_state).toBe("conflict");
    expect(store[0]!.rebased_onto_sha).toBeNull();
  });

  // CAS: a second land attempt may have re-stamped `conflict_state='conflict'`
  // to something else between the read and this write. Only the state we decided
  // against may be moved.
  it("is CAS-guarded on the conflict state", async () => {
    const store = [push(T1, { conflict_state: "clean" })];
    const { client } = fakeClient(store);

    const moved = await markConflictResolved(client, {
      pendingPushId: PUSH,
      tenantId: T1,
      rebasedOntoSha: "c0ffee1",
    });

    expect(moved).toBe(false);
    expect(store[0]!.conflict_state).toBe("clean");
  });

  it("scopes on tenant_id, id AND conflict_state", async () => {
    const { client, seen } = fakeClient([push(T1)]);
    await markConflictResolved(client, {
      pendingPushId: PUSH,
      tenantId: T1,
      rebasedOntoSha: "c0ffee1",
    });
    expect(seen[0]!.columns).toEqual(expect.arrayContaining(["id", "tenant_id", "conflict_state"]));
  });

  // NON-VACUITY CONTROL — with `.eq` neutered the foreign row IS clobbered.
  it("CONTROL: without the tenant predicate the foreign row would be clobbered", async () => {
    const store = [push(T2)];
    const { client } = fakeClient(store, { honourEq: false });

    await markConflictResolved(client, {
      pendingPushId: PUSH,
      tenantId: T1,
      rebasedOntoSha: "c0ffee1",
    });

    expect(store[0]!.conflict_state).toBe("resolved");
  });
});

describe("loadPendingPushConflictState", () => {
  it("reads our own row", async () => {
    const { client } = fakeClient([push(T1)]);
    await expect(
      loadPendingPushConflictState(client, { pendingPushId: PUSH, tenantId: T1 }),
    ).resolves.toEqual({ conflictState: "conflict" });
  });

  it("returns null for another tenant's row", async () => {
    const { client } = fakeClient([push(T2)]);
    await expect(
      loadPendingPushConflictState(client, { pendingPushId: PUSH, tenantId: T1 }),
    ).resolves.toBeNull();
  });

  it("CONTROL: without the tenant predicate the foreign row would be readable", async () => {
    const { client } = fakeClient([push(T2)], { honourEq: false });
    await expect(
      loadPendingPushConflictState(client, { pendingPushId: PUSH, tenantId: T1 }),
    ).resolves.toEqual({ conflictState: "conflict" });
  });
});
