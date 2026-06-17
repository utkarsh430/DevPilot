// Tenant scoping for the marketplace's listing reads.
//
// The fake below ACTUALLY APPLIES the filters it is handed. A fake that ignores
// `.eq`/`.is` makes every assertion here vacuous — it would return the seeded
// rows no matter what predicate the module built, so deleting the predicate
// would leave the suite green. Each scoping assertion is therefore paired with
// a CONTROL that runs the same seed through a filter-IGNORING fake and shows
// the foreign row WOULD come back, which is what proves the assertion has bite.

import { describe, expect, it } from "vitest";
import { loadMarketplaceListings, type ListingsClient } from "@/lib/marketplace/listings";

type Row = Record<string, unknown>;

type Call = { table: string; column: string; value: unknown; op: "eq" | "is" };

function makeClient(
  tables: Record<string, Row[]>,
  opts: { applyFilters: boolean },
): { client: ListingsClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: ListingsClient = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const build = (op: "eq" | "is", column: string, value: unknown) => {
        calls.push({ table, column, value, op });
        return {
          order: async () => ({
            data: opts.applyFilters ? rows.filter((r) => r[column] === value) : rows,
          }),
        };
      };
      return {
        select: () => ({
          is: (column: string, value: null) => build("is", column, value),
          eq: (column: string, value: string) => build("eq", column, value),
        }),
      };
    },
  };
  return { client, calls };
}

const SKILLS: Row[] = [
  { id: "pub", tenant_id: null, name: "public skill" },
  { id: "ours", tenant_id: "t1", name: "our skill" },
  { id: "theirs", tenant_id: "t2", name: "foreign skill" },
];
const TOOLS: Row[] = [
  { id: "pub-tool", tenant_id: null, name: "public tool" },
  { id: "our-tool", tenant_id: "t1", name: "our tool" },
  { id: "their-tool", tenant_id: "t2", name: "foreign tool" },
];

describe("loadMarketplaceListings", () => {
  it("never returns another tenant's skills or tool packages", async () => {
    const { client } = makeClient({ skills: SKILLS, tool_packages: TOOLS }, { applyFilters: true });
    const out = await loadMarketplaceListings(client, "t1");

    expect(out.installedSkills.map((s) => s.id)).toEqual(["ours"]);
    expect(out.installedToolPackages.map((t) => t.id)).toEqual(["our-tool"]);
    // And the public lists must not sweep tenant rows in either.
    expect(out.publicSkills.map((s) => s.id)).toEqual(["pub"]);
    expect(out.publicToolPackages.map((t) => t.id)).toEqual(["pub-tool"]);
  });

  it("CONTROL: without the filters the foreign rows come back", async () => {
    // Non-vacuity. If this returned only our rows, the assertion above would
    // pass for a module with no tenant predicate at all.
    const { client } = makeClient(
      { skills: SKILLS, tool_packages: TOOLS },
      { applyFilters: false },
    );
    const out = await loadMarketplaceListings(client, "t1");
    expect(out.installedSkills.map((s) => s.id)).toContain("theirs");
    expect(out.installedToolPackages.map((t) => t.id)).toContain("their-tool");
  });

  it("scopes every tenant read by tenant_id and every public read by IS NULL", async () => {
    const { client, calls } = makeClient(
      { skills: SKILLS, tool_packages: TOOLS },
      { applyFilters: true },
    );
    await loadMarketplaceListings(client, "t1");

    // Structural: no read went out unscoped, on either table.
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.column).toBe("tenant_id");
    }
    expect(calls.filter((c) => c.op === "eq").every((c) => c.value === "t1")).toBe(true);
    // `.is(null)`, not `.eq(null)` — `= NULL` is never true in SQL and would
    // silently return an empty public catalog.
    expect(calls.filter((c) => c.op === "is")).toHaveLength(2);
    expect(calls.filter((c) => c.op === "is").every((c) => c.value === null)).toBe(true);
  });

  it("degrades to empty lists rather than throwing when a read returns nothing", async () => {
    const { client } = makeClient({}, { applyFilters: true });
    const out = await loadMarketplaceListings(client, "t1");
    expect(out).toEqual({
      publicSkills: [],
      installedSkills: [],
      publicToolPackages: [],
      installedToolPackages: [],
    });
  });
});
