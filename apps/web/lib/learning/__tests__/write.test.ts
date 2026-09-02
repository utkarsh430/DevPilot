// Write-path tenant isolation. Because `agent_learnings` writes run on the
// SERVICE client (RLS off), the `.eq("tenant_id", tenantId)` on every update /
// insert is the ENTIRE tenant boundary — so the load-bearing test is the
// FORGED-FOREIGN-ROW one: a status flip / edit / archive for a row whose
// tenant_id differs from the caller's must touch ZERO rows and return not-found.
//
// The fake client ACTUALLY APPLIES `.eq`/`.in`/`.is` and mutates a shared store
// on update/insert — a fake that ignored the filters would make every assertion
// here vacuous (the exact failure mode the export tenant-scope tests warn about).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createUserLesson,
  editLearningBody,
  setTenantConfigKey,
  transitionLearningStatus,
} from "@/lib/learning/write";

type Row = Record<string, unknown>;

/** A PostgREST-ish fake that applies filters and honours update/insert against a
 *  shared in-memory store. Supports the exact chains write.ts builds. */
function fakeClient(store: Record<string, Row[]>): SupabaseClient {
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "update" | "insert" = "select";
    let patch: Row | null = null;
    let insertRows: Row[] = [];
    const self: Record<string, unknown> = {};

    self.select = () => self;
    self.eq = (c: string, v: unknown) => {
      filters.push((r) => r[c] === v);
      return self;
    };
    self.in = (c: string, vs: readonly unknown[]) => {
      filters.push((r) => vs.includes(r[c]));
      return self;
    };
    self.is = (c: string, v: unknown) => {
      filters.push((r) => (r[c] ?? null) === v);
      return self;
    };
    self.order = () => self;
    self.limit = () => self;
    self.update = (p: Row) => {
      mode = "update";
      patch = p;
      return self;
    };
    self.insert = (r: Row | Row[]) => {
      mode = "insert";
      insertRows = Array.isArray(r) ? r : [r];
      return self;
    };

    function matched(): Row[] {
      return (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }
    // Apply the write side-effect (if any) and return the affected/selected rows.
    function terminal(): { data: Row[]; error: null } {
      if (mode === "update") {
        const ms = matched();
        for (const r of ms) Object.assign(r, patch);
        return { data: ms, error: null };
      }
      if (mode === "insert") {
        const withIds = insertRows.map((r, i) => ({
          id: r.id ?? `gen-${(store[table]?.length ?? 0) + i}`,
          ...r,
        }));
        (store[table] ??= []).push(...withIds);
        return { data: withIds, error: null };
      }
      return { data: matched(), error: null };
    }

    self.maybeSingle = () => {
      const { data } = terminal();
      return Promise.resolve({ data: data[0] ?? null, error: null });
    };
    self.then = (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve(terminal());
    return self;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const L = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function seedLearning(tenantId: string, over: Row = {}): Row {
  return {
    id: L,
    tenant_id: tenantId,
    scope: "user",
    role_slug: null,
    category: "preference",
    body: "Deploy new services to Vercel by default.",
    status: "candidate",
    created_by: "lesson_extractor",
    approved_by: null,
    source_mistake_id: null,
    ...over,
  };
}

describe("transitionLearningStatus — tenant isolation", () => {
  it("approves a row that belongs to the caller's tenant", async () => {
    const store = { agent_learnings: [seedLearning(T1)] };
    const res = await transitionLearningStatus(fakeClient(store), {
      id: L,
      tenantId: T1,
      status: "active",
      approvedBy: "cap@example.com",
    });
    expect(res).toEqual({ ok: true, id: L });
    expect(store.agent_learnings[0]).toMatchObject({
      status: "active",
      approved_by: "cap@example.com",
    });
  });

  it("FORGED FOREIGN ROW: a foreign-tenant row is never written and returns not-found", async () => {
    // The row belongs to T2; the caller is T1.
    const store = { agent_learnings: [seedLearning(T2)] };
    const res = await transitionLearningStatus(fakeClient(store), {
      id: L,
      tenantId: T1,
      status: "active",
      approvedBy: "attacker@example.com",
    });
    expect(res).toEqual({ ok: false, error: "not found" });
    // The foreign row is byte-for-byte untouched — no cross-tenant write.
    expect(store.agent_learnings[0]).toMatchObject({ status: "candidate", approved_by: null });
  });

  it("reject and archive are also tenant-scoped no-ops across tenants", async () => {
    for (const status of ["rejected", "archived"] as const) {
      const store = { agent_learnings: [seedLearning(T2)] };
      const res = await transitionLearningStatus(fakeClient(store), {
        id: L,
        tenantId: T1,
        status,
      });
      expect(res).toEqual({ ok: false, error: "not found" });
      expect(store.agent_learnings[0]!.status).toBe("candidate");
    }
  });

  it("does not stamp approved_by on reject/archive", async () => {
    const store = { agent_learnings: [seedLearning(T1)] };
    await transitionLearningStatus(fakeClient(store), { id: L, tenantId: T1, status: "rejected" });
    expect(store.agent_learnings[0]).toMatchObject({ status: "rejected", approved_by: null });
  });
});

describe("editLearningBody — tenant isolation + provenance", () => {
  it("edits body only for the caller's tenant, leaving provenance untouched", async () => {
    const store = { agent_learnings: [seedLearning(T1, { status: "active" })] };
    const res = await editLearningBody(fakeClient(store), {
      id: L,
      tenantId: T1,
      body: "Prefer Fly.io for new services.",
    });
    expect(res).toEqual({ ok: true, id: L });
    expect(store.agent_learnings[0]).toMatchObject({
      body: "Prefer Fly.io for new services.",
      status: "active", // untouched
      created_by: "lesson_extractor", // untouched
      source_mistake_id: null, // untouched
    });
  });

  it("FORGED FOREIGN ROW: an edit for a foreign-tenant row is a not-found no-op", async () => {
    const store = { agent_learnings: [seedLearning(T2)] };
    const res = await editLearningBody(fakeClient(store), {
      id: L,
      tenantId: T1,
      body: "malicious rewrite",
    });
    expect(res).toEqual({ ok: false, error: "not found" });
    expect(store.agent_learnings[0]!.body).toBe("Deploy new services to Vercel by default.");
  });

  it("rejects an empty body after sanitisation", async () => {
    const store = { agent_learnings: [seedLearning(T1)] };
    const res = await editLearningBody(fakeClient(store), { id: L, tenantId: T1, body: "   " });
    expect(res.ok).toBe(false);
  });
});

describe("createUserLesson", () => {
  it("creates an active user-scope lesson with the operator as author", async () => {
    const store: Record<string, Row[]> = { agent_learnings: [] };
    const res = await createUserLesson(fakeClient(store), {
      tenantId: T1,
      body: "Always write a design doc before a large refactor.",
      createdBy: "user-1",
    });
    expect(res.ok).toBe(true);
    expect(store.agent_learnings).toHaveLength(1);
    expect(store.agent_learnings![0]).toMatchObject({
      tenant_id: T1,
      scope: "user",
      role_slug: null,
      status: "active",
      created_by: "user-1",
      source_mistake_id: null,
    });
  });

  it("surfaces a near-duplicate instead of double-inserting", async () => {
    const store: Record<string, Row[]> = {
      agent_learnings: [
        seedLearning(T1, {
          id: "existing",
          status: "active",
          body: "Deploy new services to Vercel by default.",
        }),
      ],
    };
    const res = await createUserLesson(fakeClient(store), {
      tenantId: T1,
      body: "By default deploy new services to Vercel.",
      createdBy: "user-1",
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ duplicate: true });
    expect((res as { existingBody?: string }).existingBody).toContain("Vercel");
    // No second row inserted.
    expect(store.agent_learnings).toHaveLength(1);
  });

  it("does NOT dedupe against another tenant's identical lesson", async () => {
    const store: Record<string, Row[]> = {
      agent_learnings: [
        seedLearning(T2, { id: "foreign", status: "active" }), // T2's Vercel lesson
      ],
    };
    const res = await createUserLesson(fakeClient(store), {
      tenantId: T1,
      body: "Deploy new services to Vercel by default.",
      createdBy: "user-1",
    });
    expect(res.ok).toBe(true); // T1 gets its own copy; T2's is invisible under the tenant filter
    expect(store.agent_learnings).toHaveLength(2);
  });
});

describe("setTenantConfigKey — read-merge-write", () => {
  it("merges the key without clobbering sibling config keys", async () => {
    const store: Record<string, Row[]> = {
      tenants: [{ id: T1, config: { llm_auth_mode: "api_key", default_agent_id: "a-1" } }],
    };
    const res = await setTenantConfigKey(fakeClient(store), {
      tenantId: T1,
      key: "learning_auto_approve",
      value: true,
    });
    expect(res).toEqual({ ok: true });
    expect(store.tenants![0]!.config).toEqual({
      llm_auth_mode: "api_key", // survived
      default_agent_id: "a-1", // survived
      learning_auto_approve: true, // added
    });
  });

  it("returns not-found for an unknown tenant without writing", async () => {
    const store: Record<string, Row[]> = { tenants: [{ id: T1, config: {} }] };
    const res = await setTenantConfigKey(fakeClient(store), {
      tenantId: T2,
      key: "learning_auto_approve",
      value: true,
    });
    expect(res).toEqual({ ok: false, error: "tenant not found" });
    expect(store.tenants![0]!.config).toEqual({});
  });
});
