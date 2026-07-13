// Tenant isolation for the BULK status flip behind `bulkApproveLearningsAction`.
//
// `agent_learnings` denies all JWT writes, so this path runs on the SERVICE
// client with RLS off and the co-located `.eq("tenant_id", tenantId)` is the
// ENTIRE write-side tenant boundary. The id list is CLIENT-SUPPLIED, which makes
// this strictly more exposed than the single-row path: a forged uuid list is the
// obvious attack, and without the tenant predicate it would flip another
// tenant's lessons to `active` — i.e. inject chosen text into that tenant's
// every future agent run (PR 4 feed-forward).
//
// The fake client below ACTUALLY APPLIES `.in`/`.eq` against a shared store. A
// filter-ignoring fake would make every assertion here vacuous — the exact trap
// `lib/export/__tests__/ticket-audit.test.ts` warns about. The last test proves
// non-vacuity directly: it runs the same scenario through a client whose `.eq`
// is a no-op (i.e. what removing the tenant predicate would look like) and
// asserts the foreign row IS clobbered there — so if the predicate ever
// disappears from `bulk.ts`, the earlier tests go red.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BULK_MAX_IDS, bulkTransitionLearnings } from "@/lib/learning/bulk";

type Row = Record<string, unknown>;

/** PostgREST-ish fake: applies filters, mutates the store on update, and returns
 *  the affected rows from `.select()`. `honourEq` exists ONLY for the
 *  non-vacuity control at the bottom of this file. */
function fakeClient(store: Record<string, Row[]>, opts: { honourEq?: boolean } = {}) {
  const honourEq = opts.honourEq ?? true;
  const seen: Array<{ table: string; columns: string[] }> = [];

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const columns: string[] = [];
    let patch: Row | null = null;
    const self: Record<string, unknown> = {};

    self.update = (p: Row) => {
      patch = p;
      return self;
    };
    self.in = (c: string, vs: readonly unknown[]) => {
      columns.push(c);
      filters.push((r) => vs.includes(r[c]));
      return self;
    };
    self.eq = (c: string, v: unknown) => {
      columns.push(c);
      if (honourEq) filters.push((r) => r[c] === v);
      return self;
    };
    self.select = () => {
      seen.push({ table, columns });
      const matched = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of matched) Object.assign(r, patch);
      return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
    };
    return self;
  }

  return {
    client: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    seen,
  };
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function lesson(id: string, tenantId: string, over: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    scope: "global",
    category: "testing",
    body: "Run the tests before handing off.",
    status: "candidate",
    approved_by: null,
    ...over,
  };
}

describe("bulkTransitionLearnings — tenant isolation", () => {
  it("approves the caller's own rows and stamps the approver", async () => {
    const store = { agent_learnings: [lesson("a", T1), lesson("b", T1)] };
    const { client } = fakeClient(store);
    const res = await bulkTransitionLearnings(client, {
      ids: ["a", "b"],
      tenantId: T1,
      status: "active",
      approvedBy: "cap@example.com",
    });
    expect(res).toEqual({ ok: true, updated: 2 });
    for (const r of store.agent_learnings) {
      expect(r).toMatchObject({ status: "active", approved_by: "cap@example.com" });
    }
  });

  it("FORGED FOREIGN IDS: a list of another tenant's ids updates NOTHING", async () => {
    const store = { agent_learnings: [lesson("x", T2), lesson("y", T2)] };
    const { client } = fakeClient(store);
    const res = await bulkTransitionLearnings(client, {
      ids: ["x", "y"],
      tenantId: T1,
      status: "active",
      approvedBy: "attacker@example.com",
    });
    expect(res).toEqual({ ok: true, updated: 0 });
    // Both foreign rows byte-for-byte untouched — no cross-tenant write.
    for (const r of store.agent_learnings) {
      expect(r).toMatchObject({ status: "candidate", approved_by: null });
    }
  });

  it("MIXED LIST: only the caller's rows flip; the foreign ones are left alone", async () => {
    const store = {
      agent_learnings: [lesson("mine", T1), lesson("theirs", T2)],
    };
    const { client } = fakeClient(store);
    const res = await bulkTransitionLearnings(client, {
      ids: ["mine", "theirs"],
      tenantId: T1,
      status: "active",
      approvedBy: "cap@example.com",
    });
    // The count reported back is the count that ACTUALLY changed, not requested.
    expect(res).toEqual({ ok: true, updated: 1 });
    expect(store.agent_learnings[0]).toMatchObject({ status: "active" });
    expect(store.agent_learnings[1]).toMatchObject({ status: "candidate", approved_by: null });
  });

  it("bulk reject is tenant-scoped too and never stamps approved_by", async () => {
    const store = { agent_learnings: [lesson("a", T1), lesson("x", T2)] };
    const { client } = fakeClient(store);
    const res = await bulkTransitionLearnings(client, {
      ids: ["a", "x"],
      tenantId: T1,
      status: "rejected",
    });
    expect(res).toEqual({ ok: true, updated: 1 });
    expect(store.agent_learnings[0]).toMatchObject({ status: "rejected", approved_by: null });
    expect(store.agent_learnings[1]!.status).toBe("candidate");
  });

  it("STRUCTURAL: the update carries a tenant_id predicate alongside the id list", async () => {
    const store = { agent_learnings: [lesson("a", T1)] };
    const { client, seen } = fakeClient(store);
    await bulkTransitionLearnings(client, { ids: ["a"], tenantId: T1, status: "active" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.columns).toContain("tenant_id");
    expect(seen[0]!.columns).toContain("id");
  });

  it("an empty id list is a no-op that never issues a write", async () => {
    const store = { agent_learnings: [lesson("a", T1)] };
    const { client, seen } = fakeClient(store);
    expect(
      await bulkTransitionLearnings(client, { ids: [], tenantId: T1, status: "active" }),
    ).toEqual({ ok: true, updated: 0 });
    expect(seen).toHaveLength(0);
    expect(store.agent_learnings[0]!.status).toBe("candidate");
  });

  it("dedupes ids and bounds the list at BULK_MAX_IDS", async () => {
    const rows = Array.from({ length: BULK_MAX_IDS + 50 }, (_, i) => lesson(`id-${i}`, T1));
    const store = { agent_learnings: rows };
    const { client } = fakeClient(store);
    const res = await bulkTransitionLearnings(client, {
      ids: [...rows.map((r) => r.id as string), "id-0", "id-0"],
      tenantId: T1,
      status: "active",
    });
    expect(res).toEqual({ ok: true, updated: BULK_MAX_IDS });
  });

  it("surfaces a DB error rather than reporting a phantom success", async () => {
    const client = {
      from: () => ({
        update: () => ({
          in: () => ({
            eq: () => ({ select: async () => ({ data: null, error: { message: "boom" } }) }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    expect(
      await bulkTransitionLearnings(client, { ids: ["a"], tenantId: T1, status: "active" }),
    ).toEqual({ ok: false, error: "boom" });
  });

  // ── Non-vacuity control ────────────────────────────────────────────────
  // Proves the fake's filters are what protect the foreign row: with `.eq`
  // neutered (what deleting the tenant predicate from bulk.ts would produce),
  // the SAME forged-id call clobbers the other tenant's rows. If this ever stops
  // failing-open, the tests above have stopped testing anything.
  it("CONTROL: without an honoured tenant predicate the foreign rows WOULD be flipped", async () => {
    const store = { agent_learnings: [lesson("x", T2), lesson("y", T2)] };
    const { client } = fakeClient(store, { honourEq: false });
    const res = await bulkTransitionLearnings(client, {
      ids: ["x", "y"],
      tenantId: T1,
      status: "active",
      approvedBy: "attacker@example.com",
    });
    expect(res).toEqual({ ok: true, updated: 2 });
    expect(store.agent_learnings[0]).toMatchObject({ status: "active" });
  });
});
