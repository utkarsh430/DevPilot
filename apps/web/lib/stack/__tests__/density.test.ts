import { describe, expect, it } from "vitest";
import {
  bandForPlan,
  defaultDensityForTier,
  INFRA_CAPABILITIES,
  isFullCard,
  type DensityView,
} from "@/lib/stack/density";
import { CAPABILITY_CATALOG, type CapabilityKey } from "@/lib/stack/capabilities";

// A mock included-capability set spanning all bands + baselines. The saved set
// is exactly these keys (confidence >= 5 floor); Optional (< 5) capabilities are
// NOT included — they live in the add-more list, out of the saved set.
const INCLUDED: Record<string, number> = {
  relational_db: 10, // named        → Essential (app-defining)
  auth: 8, //           strongly implied → Essential (app-defining)
  object_storage: 9, // strongly implied → Essential (app-defining)
  realtime: 6, //       implied (5-7)    → Recommended
  compute_container: 8, // high confidence BUT infra-shaped → folds on essentials
  observability: 5, //  baseline         → Recommended
  secrets: 5, //        baseline         → Recommended
  cicd: 5, //           baseline         → Recommended
};
const INCLUDED_KEYS = Object.keys(INCLUDED) as CapabilityKey[];

function baselineOf(key: CapabilityKey): boolean {
  return CAPABILITY_CATALOG.find((e) => e.key === key)!.baseline;
}

function partition(view: DensityView) {
  const full: CapabilityKey[] = [];
  const folded: CapabilityKey[] = [];
  for (const key of INCLUDED_KEYS) {
    const band = bandForPlan(baselineOf(key), INCLUDED[key]);
    if (isFullCard(band, key, view)) full.push(key);
    else folded.push(key);
  }
  return { full, folded };
}

describe("stack advisor density (Phase 3)", () => {
  it("dial defaults from the team tier", () => {
    expect(defaultDensityForTier("quick")).toBe("essentials");
    expect(defaultDensityForTier("standard")).toBe("recommended");
    expect(defaultDensityForTier("thorough")).toBe("everything");
  });

  it("bandForPlan: baseline → recommended regardless of confidence", () => {
    expect(bandForPlan(true, 10)).toBe("recommended");
    expect(bandForPlan(true, undefined)).toBe("recommended");
  });

  it("bandForPlan: non-baseline confidence >= 8 → essential, else recommended", () => {
    expect(bandForPlan(false, 8)).toBe("essential");
    expect(bandForPlan(false, 10)).toBe("essential");
    expect(bandForPlan(false, 7)).toBe("recommended");
    expect(bandForPlan(false, 5)).toBe("recommended");
    // no live suggestion (manual add / reloaded-from-DB) → recommended
    expect(bandForPlan(false, undefined)).toBe("recommended");
  });

  it("Essentials view: only app-defining full cards; baseline + infra fold", () => {
    const { full, folded } = partition("essentials");
    expect([...full].sort()).toEqual(["auth", "object_storage", "relational_db"].sort());
    // High-confidence but infra-shaped compute_container folds.
    expect(folded).toContain("compute_container");
    // 5-7 realtime folds.
    expect(folded).toContain("realtime");
    // Baselines fold.
    for (const k of ["observability", "secrets", "cicd"]) expect(folded).toContain(k);
  });

  it("Recommended view: essential band expands; baseline + 5-7 still fold", () => {
    const { full, folded } = partition("recommended");
    // compute_container (conf 8, !baseline) is essential now → full card.
    expect(full).toContain("compute_container");
    expect(full).toContain("relational_db");
    expect(folded).toContain("realtime");
    expect(folded).toContain("observability");
  });

  it("Everything view: folds nothing", () => {
    const { full, folded } = partition("everything");
    expect(folded).toEqual([]);
    expect([...full].sort()).toEqual([...INCLUDED_KEYS].sort());
  });

  it("PRESENTATION-ONLY INVARIANT: the saved set is identical across every dial setting", () => {
    // The saved set is the union of full + folded — it never depends on `view`.
    for (const view of ["essentials", "recommended", "everything"] as DensityView[]) {
      const { full, folded } = partition(view);
      expect([...full, ...folded].sort()).toEqual([...INCLUDED_KEYS].sort());
    }
  });

  it("infra capability set matches decision #3", () => {
    expect([...INFRA_CAPABILITIES].sort()).toEqual(
      [
        "cicd",
        "observability",
        "secrets",
        "queue",
        "event_stream",
        "cdn",
        "compute_container",
      ].sort(),
    );
  });
});
