// Tenant scoping on the rollback inventory.
//
// These statements run SERVICE-ROLE (RLS off) — the action derives the tenant
// from the session and then uses `supabaseService()` — so the co-located
// `.eq("tenant_id", …)` is the entire app-layer boundary.
//
// The severity is higher here than on PR 4's ledger, and specifically so. This
// list is the PROMOTION INVENTORY: a missing predicate does not merely disclose
// another tenant's deployments, it OFFERS them as rollback targets, and the next
// click points production at one of them. Disclosure and a live production
// change are not the same severity.
//
// The fake below ACTUALLY APPLIES `.eq`, and every property is paired with a
// CONTROL that neuters the predicate and asserts the foreign row WOULD be
// reached. A filter-ignoring fake would make this whole file vacuous.

import { describe, expect, it } from "vitest";
import { listProductionDeployments, recordProductionPointer } from "@/lib/vercel/rollback-write";

type Row = Record<string, unknown> & { tenant_id: string };

function fakeDb(rows: Row[], opts?: { ignoreTenantFilter?: boolean }) {
  const seen = { filters: [] as [string, unknown][] };
  const from = () => {
    const filters: [string, unknown][] = [];
    let patch: Record<string, unknown> = {};
    const match = () => rows.filter((r) => filters.every(([c, v]) => r[c] === v));
    const b: Record<string, unknown> = {
      update(p: Record<string, unknown>) {
        patch = p;
        return b;
      },
      select() {
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return Promise.resolve({ data: match(), error: null });
      },
      eq(col: string, val: unknown) {
        // The control switch.
        if (!(opts?.ignoreTenantFilter && col === "tenant_id")) {
          filters.push([col, val]);
          seen.filters.push([col, val]);
        }
        return b;
      },
      then(resolve: (v: { error: null }) => void) {
        for (const r of match()) Object.assign(r, patch);
        resolve({ error: null });
      },
    };
    return b;
  };
  return { client: { from } as never, seen };
}

describe("listProductionDeployments", () => {
  const rows = (): Row[] => [
    {
      id: "d1",
      tenant_id: "t_ours",
      project_id: "p_ours",
      target: "production",
      vercel_deployment_id: "dpl_ours",
    },
    {
      id: "d2",
      tenant_id: "t_theirs",
      project_id: "p_theirs",
      target: "production",
      vercel_deployment_id: "dpl_theirs",
    },
    {
      id: "d3",
      tenant_id: "t_ours",
      project_id: "p_ours",
      target: "preview",
      vercel_deployment_id: "dpl_preview",
    },
  ];

  it("filters on tenant_id as well as project_id", () => {
    const { client, seen } = fakeDb(rows());
    return listProductionDeployments(client, "t_ours", "p_ours").then(() => {
      expect(seen.filters).toContainEqual(["tenant_id", "t_ours"]);
      expect(seen.filters).toContainEqual(["project_id", "p_ours"]);
    });
  });

  it("never offers another tenant's deployments for a forged project id", async () => {
    const { client } = fakeDb(rows());
    await expect(listProductionDeployments(client, "t_ours", "p_theirs")).resolves.toEqual([]);
  });

  it("CONTROL: without the tenant predicate the foreign deployment IS offered", async () => {
    // This is the shape of the bug the predicate prevents — and note that what
    // comes back is a promotable target, not just a disclosed id.
    const { client } = fakeDb(rows(), { ignoreTenantFilter: true });
    const out = await listProductionDeployments(client, "t_ours", "p_theirs");
    expect(out.map((d) => d.vercelDeploymentId)).toEqual(["dpl_theirs"]);
  });

  it("excludes previews — they have never been aliased to a production domain", async () => {
    const { client } = fakeDb(rows());
    const out = await listProductionDeployments(client, "t_ours", "p_ours");
    expect(out.map((d) => d.vercelDeploymentId)).toEqual(["dpl_ours"]);
  });

  it("degrades to an empty list on a DB error rather than throwing", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({ limit: async () => ({ data: null, error: { message: "x" } }) }),
              }),
            }),
          }),
        }),
      }),
    } as never;
    await expect(listProductionDeployments(client, "t", "p")).resolves.toEqual([]);
  });
});

describe("recordProductionPointer", () => {
  const ours = (): Row => ({ tenant_id: "t_ours", vercel_deployment_id: "dpl_shared" });
  const theirs = (): Row => ({ tenant_id: "t_theirs", vercel_deployment_id: "dpl_shared" });

  it("filters on tenant_id as well as the deployment id", async () => {
    const { client, seen } = fakeDb([ours()]);
    await recordProductionPointer(client, "t_ours", {
      vercelDeploymentId: "dpl_shared",
      becameProductionAt: "2026-07-18T00:00:00.000Z",
    });
    expect(seen.filters).toContainEqual(["tenant_id", "t_ours"]);
    expect(seen.filters).toContainEqual(["vercel_deployment_id", "dpl_shared"]);
  });

  it("does NOT stamp a row belonging to another tenant", async () => {
    // Vercel deployment ids appear in URLs and build logs, so this write takes
    // an attacker-nominated pointer.
    const row = theirs();
    const { client } = fakeDb([row]);
    await recordProductionPointer(client, "t_ours", {
      vercelDeploymentId: "dpl_shared",
      becameProductionAt: "2026-07-18T00:00:00.000Z",
    });
    expect(row.became_production_at).toBeUndefined();
  });

  it("CONTROL: without the tenant predicate the foreign row IS clobbered", async () => {
    const row = theirs();
    const { client } = fakeDb([row], { ignoreTenantFilter: true });
    await recordProductionPointer(client, "t_ours", {
      vercelDeploymentId: "dpl_shared",
      becameProductionAt: "2026-07-18T00:00:00.000Z",
    });
    expect(row.became_production_at).toBe("2026-07-18T00:00:00.000Z");
  });

  it("does NOT stamp promoted_at on the ROLLBACK path", async () => {
    // Load-bearing rather than bookkeeping: `promoted_at` records that Vercel
    // would refuse to promote this deployment again. Stamping it after a
    // rollback would mark a perfectly valid future rollback target as one to
    // warn about.
    const row = ours();
    const { client } = fakeDb([row]);
    await recordProductionPointer(client, "t_ours", {
      vercelDeploymentId: "dpl_shared",
      becameProductionAt: "2026-07-18T00:00:00.000Z",
    });
    expect(row.became_production_at).toBe("2026-07-18T00:00:00.000Z");
    expect(row.promoted_at).toBeUndefined();
    expect(row.promoted_by).toBeUndefined();
  });

  it("stamps promoted_at AND promoted_by on the promote path", async () => {
    const row = ours();
    const { client } = fakeDb([row]);
    await recordProductionPointer(client, "t_ours", {
      vercelDeploymentId: "dpl_shared",
      becameProductionAt: "2026-07-18T00:00:00.000Z",
      promotedAt: "2026-07-18T00:00:00.000Z",
      promotedBy: "u_1",
    });
    expect(row.promoted_at).toBe("2026-07-18T00:00:00.000Z");
    expect(row.promoted_by).toBe("u_1");
  });

  it("returns the DB error rather than throwing", async () => {
    const client = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: { message: "boom" } }),
          }),
        }),
      }),
    } as never;
    await expect(
      recordProductionPointer(client, "t", {
        vercelDeploymentId: "dpl",
        becameProductionAt: "2026-07-18T00:00:00.000Z",
      }),
    ).resolves.toEqual({ ok: false, error: "boom" });
  });
});
