// Tenant scoping of the per-agent × per-project model WRITE path.
//
// `agent_project_models` denies every JWT write, so `upsertRoleModel` /
// `clearRoleModel` run SERVICE-ROLE with RLS off. Nothing keeps a caller from
// repointing another tenant's agents at a different model except:
//   • the delete's co-located `.eq("tenant_id", …)`, and
//   • the upsert carrying `tenant_id` in BOTH the payload and the conflict
//     target (so a conflicting foreign row is not matched and cannot be updated).
//
// The fake below ACTUALLY APPLIES `.eq` and ACTUALLY RESOLVES the conflict
// target. That is the whole point: a fake that ignored `.eq` would make every
// assertion here pass with or without the predicate in the code, reporting a
// boundary it never checked. Each property is additionally pinned by a CONTROL
// test that neuters the guard and asserts the foreign row WOULD be clobbered —
// so deleting the predicate turns this suite red rather than leaving it vacuous.

import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENT_PROJECT_MODEL_CONFLICT,
  clearRoleModel,
  upsertRoleModel,
} from "@/lib/llm/role-model-write";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Row = Record<string, unknown>;

let table: Row[] = [];

/** A fake that applies filters and resolves an upsert conflict target for real.
 *  `honourTenantEq: false` is the CONTROL — it drops the tenant predicate so a
 *  test can prove the guard is what does the work. */
function client(opts: { honourTenantEq?: boolean; honourConflictTenant?: boolean } = {}) {
  const honourTenantEq = opts.honourTenantEq ?? true;
  const honourConflictTenant = opts.honourConflictTenant ?? true;
  return {
    from: () => {
      const filters: Array<[string, unknown]> = [];
      const self: Record<string, unknown> = {};
      self.delete = () => self;
      self.eq = (col: string, val: unknown) => {
        if (col === "tenant_id" && !honourTenantEq) return self;
        filters.push([col, val]);
        return self;
      };
      self.upsert = (row: Row, opt: { onConflict: string }) => {
        const keys = opt.onConflict
          .split(",")
          .filter((k) => honourConflictTenant || k !== "tenant_id");
        const idx = table.findIndex((r) => keys.every((k) => r[k] === row[k]));
        if (idx >= 0) table[idx] = { ...table[idx], ...row };
        else table.push({ ...row });
        return Promise.resolve({ error: null });
      };
      self.then = (resolve: (v: { error: null }) => unknown) => {
        table = table.filter((r) => !filters.every(([c, v]) => r[c] === v));
        return resolve({ error: null });
      };
      return self;
    },
  } as unknown as SupabaseClient;
}

const ours = (): Row => ({
  tenant_id: TENANT,
  project_id: PROJECT,
  role_slug: "engineer",
  provider: "anthropic",
  model: "sonnet",
});
const theirs = (): Row => ({
  tenant_id: FOREIGN,
  project_id: PROJECT,
  role_slug: "engineer",
  provider: "anthropic",
  model: "haiku",
});

beforeEach(() => {
  table = [ours(), theirs()];
});

describe("clearRoleModel", () => {
  it("deletes only OUR override, leaving the foreign tenant's row untouched", async () => {
    const res = await clearRoleModel(client(), {
      tenantId: TENANT,
      projectId: PROJECT,
      roleSlug: "engineer",
    });
    expect(res.ok).toBe(true);
    expect(table).toEqual([theirs()]);
  });

  it("CONTROL: without the tenant predicate it would delete the foreign row too", async () => {
    await clearRoleModel(client({ honourTenantEq: false }), {
      tenantId: TENANT,
      projectId: PROJECT,
      roleSlug: "engineer",
    });
    // Proves the assertion above is not vacuous: the project/role filters alone
    // match BOTH tenants' rows.
    expect(table).toEqual([]);
  });
});

describe("upsertRoleModel", () => {
  it("updates OUR row and never the foreign tenant's", async () => {
    const res = await upsertRoleModel(client(), {
      tenantId: TENANT,
      projectId: PROJECT,
      roleSlug: "engineer",
      provider: "anthropic",
      model: "opus",
      createdBy: null,
      now: "2026-07-18T00:00:00.000Z",
    });
    expect(res.ok).toBe(true);
    expect(table).toHaveLength(2);
    expect(table.find((r) => r.tenant_id === TENANT)?.model).toBe("opus");
    // Untouched.
    expect(table.find((r) => r.tenant_id === FOREIGN)?.model).toBe("haiku");
  });

  it("CONTROL: a conflict target without tenant_id CLOBBERS the foreign row", async () => {
    // The foreign row FIRST, so a tenant-less conflict target — which keys only
    // on (project_id, role_slug), a pair both tenants share — matches theirs.
    table = [theirs(), ours()];
    await upsertRoleModel(client({ honourConflictTenant: false }), {
      tenantId: TENANT,
      projectId: PROJECT,
      roleSlug: "engineer",
      provider: "anthropic",
      model: "opus",
      createdBy: null,
    });
    // Their row was overwritten — tenant AND model rewritten to ours. This is
    // exactly what dropping tenant_id from the conflict target buys, and it is
    // why the assertion above is a real boundary check and not decoration.
    expect(table).toHaveLength(2);
    expect(table[0]).toMatchObject({ tenant_id: TENANT, model: "opus" });
    expect(table.some((r) => r.tenant_id === FOREIGN)).toBe(false);
  });

  it("with the real conflict target, the foreign row survives an identical key", async () => {
    // Same fixture order as the control, so ordering is not what makes the
    // guarded case pass.
    table = [theirs(), ours()];
    await upsertRoleModel(client(), {
      tenantId: TENANT,
      projectId: PROJECT,
      roleSlug: "engineer",
      provider: "anthropic",
      model: "opus",
      createdBy: null,
    });
    expect(table.find((r) => r.tenant_id === FOREIGN)?.model).toBe("haiku");
    expect(table.find((r) => r.tenant_id === TENANT)?.model).toBe("opus");
  });

  it("writes tenant_id into the payload as well as the conflict target", async () => {
    table = [];
    await upsertRoleModel(client(), {
      tenantId: TENANT,
      projectId: PROJECT,
      roleSlug: "qa",
      provider: "anthropic",
      model: "haiku",
      createdBy: "user-1",
    });
    expect(table[0]!.tenant_id).toBe(TENANT);
    expect(AGENT_PROJECT_MODEL_CONFLICT.split(",")).toContain("tenant_id");
  });
});
