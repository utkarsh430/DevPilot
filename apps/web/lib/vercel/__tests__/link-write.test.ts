// Tenant scoping on the Vercel link writes.
//
// These writes run SERVICE-ROLE (RLS off) and take a `projectId` straight from a
// browser-reachable server action argument, so the co-located
// `.eq("tenant_id", …)` is the entire boundary. Writing `vercel_project_id` for
// a foreign tenant repoints their deploy target — and, from PR 3, every
// environment variable DevPilot pushes — at an attacker's Vercel account.
//
// The fake below ACTUALLY APPLIES `.eq`. That is the difference between this
// suite meaning something and meaning nothing: a filter-ignoring fake makes
// every assertion here vacuously true. Each property is therefore paired with a
// CONTROL that runs the same write with the tenant predicate neutered and
// asserts the foreign row WOULD be clobbered — so deleting the predicate in the
// source turns this file red.

import { describe, expect, it } from "vitest";
import {
  clearVercelLink,
  writeDesiredProductionBranch,
  writeProdDeployMode,
  writeVercelLink,
  type VercelLinkWrite,
} from "@/lib/vercel/link-write";

type Row = Record<string, unknown> & { id: string; tenant_id: string };

/** A Supabase double whose `.eq()` really filters. */
function fakeDb(rows: Row[], opts?: { ignoreTenantFilter?: boolean }) {
  const filters: [string, unknown][] = [];
  const builder = {
    update(patch: Record<string, unknown>) {
      builder._patch = patch;
      return builder;
    },
    eq(col: string, val: unknown) {
      // The control switch: drop the tenant predicate to prove the assertions
      // below actually depend on it.
      if (!(opts?.ignoreTenantFilter && col === "tenant_id")) filters.push([col, val]);
      return builder;
    },
    _patch: {} as Record<string, unknown>,
    then(resolve: (v: { error: null }) => void) {
      for (const row of rows) {
        if (filters.every(([c, v]) => row[c] === v)) Object.assign(row, builder._patch);
      }
      resolve({ error: null });
    },
  };
  return {
    client: { from: () => builder } as never,
    filters,
  };
}

// Factories, not shared constants: these rows are MUTATED by the fake, so a
// shared object would let one test's write leak into the next one's assertions.
const ours = (): Row => ({ id: "p_ours", tenant_id: "t_ours" });
const theirs = (): Row => ({ id: "p_theirs", tenant_id: "t_theirs" });

const LINK: VercelLinkWrite = {
  projectId: "p_theirs", // the forged id an attacker would send
  vercelProjectId: "prj_attacker",
  vercelProjectName: "attacker",
  productionBranch: "main",
  prodDeployMode: "git_auto",
  desiredProductionBranch: "main",
  linkedBy: "u_1",
  linkedAt: "2026-07-18T00:00:00.000Z",
};

describe("writeVercelLink", () => {
  it("filters on tenant_id as well as id", async () => {
    const row = ours();
    const { client, filters } = fakeDb([row]);
    await writeVercelLink(client, "t_ours", { ...LINK, projectId: "p_ours" });
    expect(filters).toContainEqual(["tenant_id", "t_ours"]);
    expect(filters).toContainEqual(["id", "p_ours"]);
  });

  it("does NOT write a project belonging to another tenant", async () => {
    const row = theirs();
    const { client } = fakeDb([row]);
    await writeVercelLink(client, "t_ours", LINK);
    expect(row.vercel_project_id).toBeUndefined();
  });

  it("CONTROL: without the tenant predicate the foreign row IS clobbered", async () => {
    const row = theirs();
    const { client } = fakeDb([row], { ignoreTenantFilter: true });
    await writeVercelLink(client, "t_ours", LINK);
    // Proves the assertion above is load-bearing rather than an artefact of the
    // fake ignoring filters.
    expect(row.vercel_project_id).toBe("prj_attacker");
  });

  it("persists the expected-branch intent alongside the link", async () => {
    const row = ours();
    const { client } = fakeDb([row]);
    await writeVercelLink(client, "t_ours", {
      ...LINK,
      projectId: "p_ours",
      desiredProductionBranch: "dev",
    });
    expect(row.vercel_production_branch_desired).toBe("dev");
    expect(row.vercel_prod_deploy_mode).toBe("git_auto");
  });
});

describe("clearVercelLink", () => {
  it("clears the stale production URL too", async () => {
    // A production URL for a project we no longer track is a link the operator
    // would click believing DevPilot still knows what is deployed there.
    const row: Row = {
      ...ours(),
      vercel_project_id: "prj_1",
      vercel_production_url: "https://x.vercel.app",
    };
    const { client } = fakeDb([row]);
    await clearVercelLink(client, "t_ours", "p_ours");
    expect(row.vercel_project_id).toBe(null);
    expect(row.vercel_production_url).toBe(null);
    expect(row.vercel_production_branch_desired).toBe(null);
  });

  it("does not unlink another tenant's project", async () => {
    const row: Row = { ...theirs(), vercel_project_id: "prj_live" };
    const { client } = fakeDb([row]);
    await clearVercelLink(client, "t_ours", "p_theirs");
    expect(row.vercel_project_id).toBe("prj_live");
  });

  it("CONTROL: without the tenant predicate it IS unlinked", async () => {
    const row: Row = { ...theirs(), vercel_project_id: "prj_live" };
    const { client } = fakeDb([row], { ignoreTenantFilter: true });
    await clearVercelLink(client, "t_ours", "p_theirs");
    expect(row.vercel_project_id).toBe(null);
  });
});

describe("writeProdDeployMode / writeDesiredProductionBranch", () => {
  it("do not touch a foreign tenant's row", async () => {
    const row: Row = { ...theirs(), vercel_prod_deploy_mode: "devpilot_gated" };
    const { client } = fakeDb([row]);
    await writeProdDeployMode(client, "t_ours", "p_theirs", "git_auto");
    await writeDesiredProductionBranch(client, "t_ours", "p_theirs", "attacker-branch");
    expect(row.vercel_prod_deploy_mode).toBe("devpilot_gated");
    expect(row.vercel_production_branch_desired).toBeUndefined();
  });

  it("CONTROL: without the tenant predicate the gate IS flipped for them", async () => {
    // The severity: this is the switch that decides whether another tenant's
    // agents can deploy to their own production without approval.
    const row: Row = { ...theirs(), vercel_prod_deploy_mode: "devpilot_gated" };
    const { client } = fakeDb([row], { ignoreTenantFilter: true });
    await writeProdDeployMode(client, "t_ours", "p_theirs", "git_auto");
    expect(row.vercel_prod_deploy_mode).toBe("git_auto");
  });

  it("write only their own field", async () => {
    const row: Row = ours();
    const { client } = fakeDb([row]);
    await writeProdDeployMode(client, "t_ours", "p_ours", "devpilot_gated");
    expect(row.vercel_prod_deploy_mode).toBe("devpilot_gated");
    // The mode write must not rewrite the link itself.
    expect(row.vercel_project_id).toBeUndefined();
  });
});
