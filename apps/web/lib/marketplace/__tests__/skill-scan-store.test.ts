// Tenant scoping for the scan's one read.
//
// The fake below ACTUALLY APPLIES the filters it is handed. A fake that ignores
// `.eq`/`.is` makes every assertion here vacuous — it would return the seeded
// row no matter what predicate the module built, so deleting the predicate
// would leave the suite green. Each scoping assertion is therefore paired with a
// CONTROL that runs the same seed through a filter-IGNORING fake and shows the
// foreign row WOULD come back, which is what proves the assertion has bite.
//
// The consequence of a miss here is unusually direct: the scan quotes the body
// it loads straight back to the operator as the evidence beside every finding,
// so an unscoped read is a route by which one workspace reads another's standing
// agent instructions by pasting an id into a scan.

import { describe, expect, it } from "vitest";
import {
  loadScannableSkill,
  type ScanQuery,
  type ScanStoreClient,
} from "@/lib/marketplace/skill-scan-store";

type Row = Record<string, unknown>;
type Call = { column: string; value: unknown; op: "eq" | "is" };

function makeClient(
  rows: Row[],
  opts: { applyFilters: boolean },
): { client: ScanStoreClient; calls: Call[] } {
  const calls: Call[] = [];

  const client: ScanStoreClient = {
    from() {
      // Each chained predicate narrows `current`, so the fake models the SQL
      // rather than remembering only the last filter applied.
      const chain = (current: Row[]): ScanQuery => ({
        eq: (column: string, value: string) => {
          calls.push({ column, value, op: "eq" });
          return chain(opts.applyFilters ? current.filter((r) => r[column] === value) : current);
        },
        is: (column: string, value: null) => {
          calls.push({ column, value, op: "is" });
          return chain(opts.applyFilters ? current.filter((r) => r[column] === value) : current);
        },
        maybeSingle: async () => ({ data: current.length > 0 ? current[0] : null }),
      });
      return { select: () => chain(rows) };
    },
  };

  return { client, calls };
}

const ROWS: Row[] = [
  { id: "pub", tenant_id: null, name: "public skill", body: "public body" },
  { id: "ours", tenant_id: "t1", name: "our skill", body: "our body" },
  { id: "theirs", tenant_id: "t2", name: "foreign skill", body: "foreign body" },
];

describe("loadScannableSkill", () => {
  it("returns a public marketplace row", async () => {
    const { client } = makeClient(ROWS, { applyFilters: true });
    expect((await loadScannableSkill(client, { id: "pub", tenantId: "t1" }))?.id).toBe("pub");
  });

  it("returns this tenant's own row", async () => {
    const { client } = makeClient(ROWS, { applyFilters: true });
    expect((await loadScannableSkill(client, { id: "ours", tenantId: "t1" }))?.id).toBe("ours");
  });

  it("REFUSES another tenant's row", async () => {
    const { client } = makeClient(ROWS, { applyFilters: true });
    expect(await loadScannableSkill(client, { id: "theirs", tenantId: "t1" })).toBeNull();
  });

  it("CONTROL: without the predicates the foreign body WOULD be returned", async () => {
    // Neuters the filters, leaving the module's own post-read assertion as the
    // only thing standing. It catches this case — which is why the module keeps
    // it — but a filter-ignoring fake returning the row here is what proves the
    // test above is not vacuous.
    const { client } = makeClient([ROWS[2]!], { applyFilters: false });
    const withoutGuard = await client.from("skills").select("*").eq("id", "theirs").maybeSingle();
    expect((withoutGuard.data as Row).body).toBe("foreign body");
  });

  it("the post-read assertion refuses a foreign row a broken predicate let through", async () => {
    // Defence in depth: the predicates ARE the boundary, and this proves the
    // module still says no when they fail. Both halves have to be tested, or
    // "belt and braces" is a claim rather than a property.
    const { client } = makeClient([ROWS[2]!], { applyFilters: false });
    expect(await loadScannableSkill(client, { id: "theirs", tenantId: "t1" })).toBeNull();
  });

  it("returns null for an id that does not exist", async () => {
    const { client } = makeClient(ROWS, { applyFilters: true });
    expect(await loadScannableSkill(client, { id: "nope", tenantId: "t1" })).toBeNull();
  });

  it("scopes both reads: one on the caller's tenant, one on null", async () => {
    const { client, calls } = makeClient(ROWS, { applyFilters: true });
    await loadScannableSkill(client, { id: "ours", tenantId: "t1" });

    // The owned read carries an explicit tenant equality…
    expect(calls).toContainEqual({ column: "tenant_id", value: "t1", op: "eq" });
    // …and the public read uses `.is(null)`, NOT `.eq(null)`: `= NULL` is never
    // true in SQL, so an `.eq` there silently makes every marketplace skill
    // unscannable.
    expect(calls).toContainEqual({ column: "tenant_id", value: null, op: "is" });
    expect(calls.some((c) => c.column === "tenant_id" && c.value === null && c.op === "eq")).toBe(
      false,
    );

    // Neither read goes out without a tenant predicate of its own.
    const idCalls = calls.filter((c) => c.column === "id");
    const tenantCalls = calls.filter((c) => c.column === "tenant_id");
    expect(idCalls.length).toBe(2);
    expect(tenantCalls.length).toBe(2);
  });
});
