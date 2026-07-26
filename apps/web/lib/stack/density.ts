// Stack advisor — the essential-vs-optional density split (Phase 3 of the
// plan-component revamp). Pure, presentation-only logic, extracted from
// StackAdvisorBody so it is unit-testable (component `.tsx` files can't load
// under Vitest) and so the load-bearing invariant — the dial changes only what
// is SHOWN, never what is SAVED — can be asserted directly.
//
// These functions consume the per-suggestion `confidence` (the model's 0-10
// contract) and the capability's `baseline` flag; they never RECOMPUTE either
// (the baseline floor stays in `infer-capabilities.ts`, ranking stays in
// `rank.ts`). A capability's band + fold state affects rendering only; the
// saved selection set (`includedCapabilities`/`overrides` in use-stack-advisor)
// is independent of every value here.

import type { CapabilityKey } from "@/lib/stack/capabilities";
import type { TeamTier } from "@/lib/team-tiers/tiers";

/** The density dial's three settings. */
export type DensityView = "essentials" | "recommended" | "everything";

/**
 * The dial DEFAULTS from the project's team tier (decision #2 — decoupled: it
 * only seeds the local view, it never rewrites `team_tier` or the ticket cap).
 *   quick → Essentials · standard → Recommended · thorough → Everything.
 */
export function defaultDensityForTier(tier: TeamTier): DensityView {
  switch (tier) {
    case "quick":
      return "essentials";
    case "thorough":
      return "everything";
    case "standard":
    default:
      return "recommended";
  }
}

/**
 * Infra-shaped capabilities. On the aggressive `essentials` view (decision #3)
 * these fold into the "Production baseline" group ALONGSIDE the baseline
 * capabilities, so a quick app shows only its app-defining needs as full cards.
 */
export const INFRA_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "cicd",
  "observability",
  "secrets",
  "queue",
  "event_stream",
  "cdn",
  "compute_container",
]);

export type Band = "essential" | "recommended";

/**
 * Band for an INCLUDED capability (a `plan`). Optional (`confidence < 5`) never
 * reaches here — those are not in the saved set; they live in the add-more list.
 *   • baseline                       → recommended (assumed, not deliberated)
 *   • confidence >= 8 && !baseline   → essential (a named need)
 *   • otherwise (5-7, or a manual/DB inclusion with no live suggestion) →
 *     recommended, so an unrun-then-reloaded selection still reads sensibly.
 */
export function bandForPlan(baseline: boolean, confidence: number | undefined): Band {
  if (baseline) return "recommended";
  if (confidence !== undefined && confidence >= 8) return "essential";
  return "recommended";
}

/** Whether a plan renders as a full card at the given view (vs. folded). */
export function isFullCard(band: Band, key: CapabilityKey, view: DensityView): boolean {
  if (view === "everything") return true;
  if (view === "recommended") return band === "essential";
  // essentials — fold baseline + infra even when their confidence is high.
  return band === "essential" && !INFRA_CAPABILITIES.has(key);
}
