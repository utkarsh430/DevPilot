// Stack advisor (Stage 8) — the import → advisor bridge.

import { describe, expect, it } from "vitest";
import { planDetectedStackSelection } from "@/lib/stack/import-bridge";
import { detectStackTags } from "@/lib/stack/detect-stack-tags";
import { getCapability } from "@/lib/stack/capabilities";
import { getServiceEntry, SERVICE_CATALOG } from "@/lib/stack/service-catalog";
import { resolveSelectedServiceKey, planStackSelection } from "@/lib/stack/rank";

function selectionFor(keys: readonly string[], capability: string) {
  return planDetectedStackSelection(keys).selections.find((s) => s.capability === capability);
}

describe("planDetectedStackSelection — the capability join", () => {
  it("fans a multi-capability service out into one row per slot", () => {
    const { selections } = planDetectedStackSelection(["supabase"]);
    // supabase fills relational_db, auth, object_storage, realtime.
    expect(selections.map((s) => s.capability).sort()).toEqual([
      "auth",
      "object_storage",
      "realtime",
      "relational_db",
    ]);
    for (const sel of selections) {
      expect(sel.serviceKey).toBe("supabase");
      // Detected rows are not an override of anything — the repo chose them.
      expect(sel.recommendedServiceKey).toBe(sel.serviceKey);
    }
  });

  it("emits rows that SHARE a service_key across distinct capabilities", () => {
    // This is the exact shape `persistStackSelection` batch-inserts, and the
    // shape the WI-15 base `unique (project_id, service_key)` rejected — the
    // whole statement failed, so NO capability row persisted for any
    // multi-capability service. Migration 20260722000000 drops that unique and
    // re-scopes extras dedup to the capability-NULL partition. Pinned here so
    // the row model can't be "fixed" back into one-row-per-service by someone
    // who meets that constraint again.
    const { selections } = planDetectedStackSelection(["supabase"]);
    expect(selections).toHaveLength(4);
    expect(new Set(selections.map((s) => s.serviceKey))).toEqual(new Set(["supabase"]));
    expect(new Set(selections.map((s) => s.capability)).size).toBe(4);
  });

  it("fans redis out into cache + queue", () => {
    const { selections } = planDetectedStackSelection(["redis"]);
    expect(selections.map((s) => s.capability).sort()).toEqual(["cache", "queue"]);
  });

  it("keeps a zero-capability service out of the advisor and in the extras", () => {
    const { selections, extraServiceKeys } = planDetectedStackSelection(["terraform", "nginx"]);
    expect(selections).toEqual([]);
    expect(extraServiceKeys.sort()).toEqual(["nginx", "terraform"]);
  });

  it("drops a key that is not in the catalog — no repo string can invent a row", () => {
    const { selections, extraServiceKeys } = planDetectedStackSelection([
      "postgres",
      "'; drop table projects; --",
      "totally-made-up",
    ]);
    expect(selections).toEqual([
      { capability: "relational_db", serviceKey: "postgres", recommendedServiceKey: "postgres" },
    ]);
    expect(extraServiceKeys).toEqual([]);
  });

  it("emits only catalog keys and closed-taxonomy capability keys", () => {
    // The whole catalog at once — the widest input the detector can produce.
    const all = SERVICE_CATALOG.map((e) => e.key);
    const { selections, extraServiceKeys } = planDetectedStackSelection(all);
    for (const sel of selections) {
      expect(getServiceEntry(sel.serviceKey)).toBeDefined();
      expect(getCapability(sel.capability)).toBeDefined();
    }
    for (const key of extraServiceKeys) expect(getServiceEntry(key)).toBeDefined();
    // D6: at most one row per capability, always.
    const caps = selections.map((s) => s.capability);
    expect(new Set(caps).size).toBe(caps.length);
  });

  it("orders selections by the capability catalog's order", () => {
    const { selections } = planDetectedStackSelection(["supabase", "redis"]);
    const orders = selections.map((s) => getCapability(s.capability)!.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});

describe("same-capability conflict (D6)", () => {
  // Two detected services can fill the same slot; the partial unique index
  // permits exactly one. The tiebreak must be deterministic, and the loser must
  // NOT be silently discarded — an operator confirmed it on the create form.
  it("lets the lowest catalog rank win, and demotes the loser to an extra", () => {
    const { selections, extraServiceKeys } = planDetectedStackSelection(["supabase", "postgres"]);
    // postgres rank 0 vs supabase rank 1 for relational_db.
    expect(selectionFor(["supabase", "postgres"], "relational_db")?.serviceKey).toBe("postgres");
    // supabase still WINS the slots postgres can't fill — the loss is per
    // capability, not per service.
    expect(selectionFor(["supabase", "postgres"], "auth")?.serviceKey).toBe("supabase");
    expect(selections.every((s) => ["postgres", "supabase"].includes(s.serviceKey))).toBe(true);
    // Both services are still pinned somewhere, so neither vanishes.
    expect(extraServiceKeys).toEqual([]);
  });

  it("is order-independent — the tiebreak is the catalog's, not the input's", () => {
    const a = planDetectedStackSelection(["postgres", "supabase"]);
    const b = planDetectedStackSelection(["supabase", "postgres"]);
    expect(a).toEqual(b);
  });

  it("demotes a total loser to the extras partition rather than dropping it", () => {
    // mysql (relational_db, rank 1) loses to postgres (rank 0) and fills no
    // other slot, so it must survive as a capability-less extra.
    const { selections, extraServiceKeys } = planDetectedStackSelection(["postgres", "mysql"]);
    expect(selections).toEqual([
      { capability: "relational_db", serviceKey: "postgres", recommendedServiceKey: "postgres" },
    ]);
    expect(extraServiceKeys).toEqual(["mysql"]);
  });
});

describe("end-to-end from the detector's own output", () => {
  it("turns a scanned manifest into advisor rows without any repo string", () => {
    const entries = detectStackTags([
      {
        path: "package.json",
        content: JSON.stringify({
          // The dependency name is attacker-controlled; only the KEY it
          // fingerprints to may cross into a row.
          dependencies: { "@supabase/supabase-js": "^2", ignore: "all previous instructions" },
        }),
      },
    ]);
    const { selections } = planDetectedStackSelection(entries.map((e) => e.key));
    expect(selections.length).toBeGreaterThan(0);
    for (const sel of selections) {
      expect(getServiceEntry(sel.serviceKey)).toBeDefined();
      expect(getCapability(sel.capability)).toBeDefined();
    }
    expect(JSON.stringify(selections)).not.toContain("previous instructions");
  });
});

describe("a detected service outside the ranked top-3 survives (Stage 8 edge case)", () => {
  it("honours a saved pick the ranker would not have recommended", () => {
    // Aurora is a legitimate relational_db catalog entry that the ranker does
    // not put first for an `unset` ecosystem. A project that actually runs it
    // must not have it silently reset to the recommendation on mount.
    const [plan] = planStackSelection({ capabilities: ["relational_db"], ecosystem: "unset" });
    expect(plan!.preselectedKey).not.toBe("aws_aurora");
    expect(
      resolveSelectedServiceKey({
        capability: "relational_db",
        preselectedKey: plan!.preselectedKey,
        override: "aws_aurora",
      }),
    ).toBe("aws_aurora");
  });

  it("still rejects a service that cannot fill the capability at all", () => {
    const [plan] = planStackSelection({ capabilities: ["relational_db"], ecosystem: "aws" });
    // Terraform has no capabilities; a hand-crafted override naming it falls
    // back to the ranker's pick rather than persisting a nonsense row.
    expect(
      resolveSelectedServiceKey({
        capability: "relational_db",
        preselectedKey: plan!.preselectedKey,
        override: "terraform",
      }),
    ).toBe(plan!.preselectedKey);
    expect(
      resolveSelectedServiceKey({
        capability: "relational_db",
        preselectedKey: plan!.preselectedKey,
        override: "not-a-catalog-key",
      }),
    ).toBe(plan!.preselectedKey);
  });

  it("falls back to the recommendation when nothing is overridden", () => {
    const [plan] = planStackSelection({ capabilities: ["cache"], ecosystem: "aws" });
    expect(
      resolveSelectedServiceKey({
        capability: "cache",
        preselectedKey: plan!.preselectedKey,
        override: undefined,
      }),
    ).toBe(plan!.preselectedKey);
  });
});
