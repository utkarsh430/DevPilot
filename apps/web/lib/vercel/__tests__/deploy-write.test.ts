// Tenant scoping on the deploy ledger.
//
// These statements run SERVICE-ROLE (RLS off). The action derives the tenant
// from the session; the poller has no session at all and trusts the tenant id
// stamped on its event. Either way the co-located `.eq("tenant_id", …)` is the
// entire app-layer boundary, and both directions are severe: a missing predicate
// on the WRITE stamps `vercel_production_url` on another tenant's project (the
// URL their operators click to see what is live), and on the READ it discloses
// their deployment ids, commit SHAs and build-log links — the exact inventory
// PR 5 promotes from.
//
// The fake below ACTUALLY APPLIES `.eq`, and every property is paired with a
// CONTROL that neuters the predicate and asserts the foreign row WOULD be
// reached. A filter-ignoring fake would make this whole file vacuous; this repo
// has shipped that mistake before.

import { describe, expect, it } from "vitest";
import {
  getDeploymentRecord,
  listProjectDeployments,
  mapDeploymentRow,
  upsertDeploymentRecord,
  writeProductionUrl,
  type DeploymentUpsert,
} from "@/lib/vercel/deploy-write";

type Row = Record<string, unknown> & { tenant_id: string };

/** A Supabase double whose `.eq()` really filters, for both reads and writes. */
function fakeDb(rows: Row[], opts?: { ignoreTenantFilter?: boolean }) {
  const seen = { filters: [] as [string, unknown][], upserted: null as Row | null };
  const from = () => {
    const filters: [string, unknown][] = [];
    let patch: Record<string, unknown> = {};
    const match = () => rows.filter((r) => filters.every(([c, v]) => r[c] === v));
    const b: Record<string, unknown> = {
      upsert(row: Row) {
        seen.upserted = row;
        rows.push(row);
        return Promise.resolve({ error: null });
      },
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
      maybeSingle() {
        return Promise.resolve({ data: match()[0] ?? null, error: null });
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

const UPSERT: DeploymentUpsert = {
  projectId: "p_ours",
  vercelDeploymentId: "dpl_1",
  target: "production",
  readyState: "READY",
  url: "https://x.vercel.app",
  inspectorUrl: "https://vercel.com/i/1",
  errorMessage: null,
  branch: "dev",
  commitSha: "abc",
  ticketId: null,
  triggeredBy: "u_1",
  triggerSource: "human",
  readyAt: null,
  becameProductionAt: "2026-07-18T00:00:00.000Z",
  polledAt: "2026-07-18T00:00:00.000Z",
};

describe("upsertDeploymentRecord", () => {
  it("stamps tenant_id on the row itself", async () => {
    // This is what the `assert_tenant_matches_parent` triggers compare against
    // `projects`/`tickets`, so a mismatched row cannot be written at all.
    const { client, seen } = fakeDb([]);
    await upsertDeploymentRecord(client, "t_ours", UPSERT);
    expect(seen.upserted).toMatchObject({ tenant_id: "t_ours", project_id: "p_ours" });
  });

  it("carries the full deploy record, including the build-log link", async () => {
    const { client, seen } = fakeDb([]);
    await upsertDeploymentRecord(client, "t_ours", UPSERT);
    expect(seen.upserted).toMatchObject({
      vercel_deployment_id: "dpl_1",
      target: "production",
      ready_state: "READY",
      inspector_url: "https://vercel.com/i/1",
      branch: "dev",
      trigger_source: "human",
      // PR 5's inventory field.
      became_production_at: "2026-07-18T00:00:00.000Z",
    });
  });

  it("returns the DB error rather than throwing", async () => {
    const client = {
      from: () => ({ upsert: async () => ({ error: { message: "boom" } }) }),
    } as never;
    await expect(upsertDeploymentRecord(client, "t", UPSERT)).resolves.toEqual({
      ok: false,
      error: "boom",
    });
  });
});

describe("writeProductionUrl", () => {
  const ours = (): Row => ({ id: "p_ours", tenant_id: "t_ours" });
  const theirs = (): Row => ({ id: "p_theirs", tenant_id: "t_theirs" });

  it("filters on tenant_id as well as id", async () => {
    const { client, seen } = fakeDb([ours()]);
    await writeProductionUrl(client, "t_ours", "p_ours", "https://a");
    expect(seen.filters).toContainEqual(["tenant_id", "t_ours"]);
    expect(seen.filters).toContainEqual(["id", "p_ours"]);
  });

  it("does NOT stamp a project belonging to another tenant", async () => {
    const row = theirs();
    const { client } = fakeDb([row]);
    await writeProductionUrl(client, "t_ours", "p_theirs", "https://attacker");
    expect(row.vercel_production_url).toBeUndefined();
  });

  it("CONTROL: without the tenant predicate the foreign project IS clobbered", async () => {
    const row = theirs();
    const { client } = fakeDb([row], { ignoreTenantFilter: true });
    await writeProductionUrl(client, "t_ours", "p_theirs", "https://attacker");
    expect(row.vercel_production_url).toBe("https://attacker");
  });
});

describe("listProjectDeployments", () => {
  const rows = (): Row[] => [
    { id: "d1", tenant_id: "t_ours", project_id: "p_ours", vercel_deployment_id: "dpl_ours" },
    { id: "d2", tenant_id: "t_theirs", project_id: "p_theirs", vercel_deployment_id: "dpl_theirs" },
  ];

  it("filters on tenant_id as well as project_id", async () => {
    const { client, seen } = fakeDb(rows());
    await listProjectDeployments(client, "t_ours", "p_ours");
    expect(seen.filters).toContainEqual(["tenant_id", "t_ours"]);
    expect(seen.filters).toContainEqual(["project_id", "p_ours"]);
  });

  it("does NOT return another tenant's deployments for a forged project id", async () => {
    const { client } = fakeDb(rows());
    const out = await listProjectDeployments(client, "t_ours", "p_theirs");
    expect(out).toEqual([]);
  });

  it("CONTROL: without the tenant predicate the foreign deployments ARE returned", async () => {
    const { client } = fakeDb(rows(), { ignoreTenantFilter: true });
    const out = await listProjectDeployments(client, "t_ours", "p_theirs");
    expect(out.map((d) => d.vercelDeploymentId)).toEqual(["dpl_theirs"]);
  });

  it("degrades to an empty list on a DB error rather than throwing", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({ limit: async () => ({ data: null, error: { message: "x" } }) }),
            }),
          }),
        }),
      }),
    } as never;
    await expect(listProjectDeployments(client, "t", "p")).resolves.toEqual([]);
  });
});

describe("getDeploymentRecord", () => {
  const rows = (): Row[] => [
    { id: "d1", tenant_id: "t_theirs", vercel_deployment_id: "dpl_shared", target: "production" },
  ];

  it("does NOT return another tenant's row for a known deployment id", async () => {
    // Vercel deployment ids are guessable-ish and appear in URLs, so this read
    // takes an attacker-nominated pointer.
    const { client } = fakeDb(rows());
    await expect(getDeploymentRecord(client, "t_ours", "dpl_shared")).resolves.toBeNull();
  });

  it("CONTROL: without the tenant predicate the foreign row IS returned", async () => {
    const { client } = fakeDb(rows(), { ignoreTenantFilter: true });
    const got = await getDeploymentRecord(client, "t_ours", "dpl_shared");
    expect(got?.vercelDeploymentId).toBe("dpl_shared");
  });
});

describe("mapDeploymentRow", () => {
  it("is total over missing fields", () => {
    const r = mapDeploymentRow({});
    expect(r.url).toBeNull();
    expect(r.promotedAt).toBeNull();
    // An unrecognised target degrades to preview — the less-privileged reading.
    expect(r.target).toBe("preview");
  });

  it("only 'production' reads as production", () => {
    expect(mapDeploymentRow({ target: "production" }).target).toBe("production");
    for (const t of ["Production", "prod", "", null]) {
      expect(mapDeploymentRow({ target: t }).target, String(t)).toBe("preview");
    }
  });
});
