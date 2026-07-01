// Tenant scoping of the AGENT-WIDE model write paths.
//
// `agent_project_models` denies every JWT write, so `upsertGlobalRoleModel` /
// `clearGlobalRoleModel` / `clearProjectRoleModels` run SERVICE-ROLE with RLS
// off. The co-located `.eq("tenant_id", …)` on every statement is the ENTIRE
// boundary, and two of these paths are more exposed than the single-row one:
//
//   • `upsertGlobalRoleModel` is a DELETE-then-INSERT (a partial unique index
//     cannot be a PostgREST conflict target), so an unscoped delete would wipe
//     every tenant's agent-wide default for that role before inserting ours.
//   • `clearProjectRoleModels` takes a CLIENT-SUPPLIED project id list, so a
//     forged list of known-foreign uuids is the obvious attack.
//
// The fake below ACTUALLY APPLIES `.eq` / `.is` / `.in`. A fake that ignored
// them would make every assertion here pass with the predicate deleted, i.e.
// report a boundary it never checked. Each property is therefore also pinned by
// a CONTROL that neuters the guard and asserts the foreign rows WOULD be
// clobbered — so removing a predicate turns this suite red, not green.

import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  clearGlobalRoleModel,
  clearProjectRoleModels,
  upsertGlobalRoleModel,
} from "@/lib/llm/role-model-write";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const P2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

let table: Row[] = [];

/** Applies eq / is / in for real. `honourTenantEq: false` is the CONTROL. */
function client(opts: { honourTenantEq?: boolean } = {}) {
  const honourTenantEq = opts.honourTenantEq ?? true;
  return {
    from: () => {
      const filters: Filter[] = [];
      const self: Record<string, unknown> = {};
      self.delete = () => self;
      self.eq = (col: string, val: unknown) => {
        if (col === "tenant_id" && !honourTenantEq) return self;
        filters.push((r) => r[col] === val);
        return self;
      };
      self.is = (col: string, val: unknown) => {
        filters.push((r) => (r[col] ?? null) === val);
        return self;
      };
      self.in = (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return self;
      };
      self.insert = (row: Row) => {
        table.push({ ...row });
        return Promise.resolve({ error: null });
      };
      self.then = (resolve: (v: { error: null }) => unknown) => {
        table = table.filter((r) => !filters.every((f) => f(r)));
        return resolve({ error: null });
      };
      return self;
    },
  } as unknown as SupabaseClient;
}

const globalRow = (tenant: string, model: string): Row => ({
  tenant_id: tenant,
  project_id: null,
  role_slug: "engineer",
  provider: "anthropic",
  model,
});
const projectRow = (tenant: string, project: string, model: string): Row => ({
  tenant_id: tenant,
  project_id: project,
  role_slug: "engineer",
  provider: "anthropic",
  model,
});

beforeEach(() => {
  table = [
    globalRow(TENANT, "sonnet"),
    globalRow(FOREIGN, "haiku"),
    projectRow(TENANT, P1, "sonnet"),
    projectRow(FOREIGN, P1, "haiku"),
  ];
});

describe("clearGlobalRoleModel", () => {
  it("clears only OUR agent-wide default", async () => {
    const res = await clearGlobalRoleModel(client(), { tenantId: TENANT, roleSlug: "engineer" });
    expect(res.ok).toBe(true);
    expect(table.filter((r) => r.project_id === null)).toEqual([globalRow(FOREIGN, "haiku")]);
    // The project-scoped rows are a different scope and are not touched.
    expect(table.filter((r) => r.project_id === P1)).toHaveLength(2);
  });

  it("CONTROL: without the tenant predicate the foreign global goes too", async () => {
    await clearGlobalRoleModel(client({ honourTenantEq: false }), {
      tenantId: TENANT,
      roleSlug: "engineer",
    });
    expect(table.filter((r) => r.project_id === null)).toEqual([]);
  });
});

describe("upsertGlobalRoleModel", () => {
  it("replaces OUR global and leaves the foreign tenant's intact", async () => {
    const res = await upsertGlobalRoleModel(client(), {
      tenantId: TENANT,
      roleSlug: "engineer",
      provider: "anthropic",
      model: "opus",
      createdBy: "user-1",
      now: "2026-07-18T00:00:00.000Z",
    });
    expect(res.ok).toBe(true);
    const globals = table.filter((r) => r.project_id === null);
    // Exactly one per tenant — the delete-then-insert must not duplicate ours.
    expect(globals).toHaveLength(2);
    expect(globals.find((r) => r.tenant_id === TENANT)?.model).toBe("opus");
    expect(globals.find((r) => r.tenant_id === FOREIGN)?.model).toBe("haiku");
  });

  it("does NOT clear this role's per-project rows", async () => {
    // The load-bearing UX rule: a global never silently deletes the operator's
    // per-project choices. They keep winning and are surfaced instead.
    await upsertGlobalRoleModel(client(), {
      tenantId: TENANT,
      roleSlug: "engineer",
      provider: "anthropic",
      model: "opus",
      createdBy: null,
    });
    expect(table.find((r) => r.tenant_id === TENANT && r.project_id === P1)?.model).toBe("sonnet");
  });

  it("writes tenant_id and a NULL project_id — never a sentinel", async () => {
    table = [];
    await upsertGlobalRoleModel(client(), {
      tenantId: TENANT,
      roleSlug: "qa",
      provider: "anthropic",
      model: "haiku",
      createdBy: null,
    });
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ tenant_id: TENANT, project_id: null, role_slug: "qa" });
  });

  it("CONTROL: an unscoped delete step would wipe the foreign tenant's global", async () => {
    await upsertGlobalRoleModel(client({ honourTenantEq: false }), {
      tenantId: TENANT,
      roleSlug: "engineer",
      provider: "anthropic",
      model: "opus",
      createdBy: null,
    });
    expect(table.some((r) => r.project_id === null && r.tenant_id === FOREIGN)).toBe(false);
  });
});

describe("clearProjectRoleModels — the client-supplied id list", () => {
  it("clears only OUR rows for the named projects", async () => {
    const res = await clearProjectRoleModels(client(), {
      tenantId: TENANT,
      roleSlug: "engineer",
      projectIds: [P1, P2],
    });
    expect(res.ok).toBe(true);
    expect(table.some((r) => r.tenant_id === TENANT && r.project_id === P1)).toBe(false);
    // Foreign tenant's row for the SAME project id survives.
    expect(table.find((r) => r.tenant_id === FOREIGN && r.project_id === P1)?.model).toBe("haiku");
    // Globals are a different scope and are untouched.
    expect(table.filter((r) => r.project_id === null)).toHaveLength(2);
  });

  it("CONTROL: a forged id list without the tenant predicate clobbers foreign rows", async () => {
    await clearProjectRoleModels(client({ honourTenantEq: false }), {
      tenantId: TENANT,
      roleSlug: "engineer",
      projectIds: [P1],
    });
    expect(table.some((r) => r.project_id === P1)).toBe(false);
  });

  it("an empty list is a no-op, never an unfiltered delete", async () => {
    const before = [...table];
    const res = await clearProjectRoleModels(client(), {
      tenantId: TENANT,
      roleSlug: "engineer",
      projectIds: [],
    });
    expect(res.ok).toBe(true);
    expect(table).toEqual(before);
  });
});
