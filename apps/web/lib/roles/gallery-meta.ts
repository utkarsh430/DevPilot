// Presentation metadata for the role gallery (agents page) + shared with the
// marketplace so both surfaces read as one system. Derived from the catalog's
// own structure — no hand-maintained per-slug mapping to drift out of sync.
//
// CLIENT-SAFE: imports only `ROLE_CATALOG` (the client-safe catalog module,
// same chain `effective-catalog.ts` already relies on) and the `ModelTier`
// type. Never pulls in `lib/db/server` / `next/headers`.

import { ROLE_CATALOG } from "@/lib/roles/catalog";
import type { ModelTier } from "@/lib/llm/models";

/** The model backing each tier, surfaced on role cards. */
export const MODEL_TIER_LABEL: Record<ModelTier, string> = {
  heavy: "Opus",
  default: "Sonnet",
  cheap: "Haiku",
};

/** Badge tone per tier — reuses the design-system Badge tones (no raw colors). */
export const MODEL_TIER_TONE: Record<ModelTier, "violet" | "info" | "muted"> = {
  heavy: "violet",
  default: "info",
  cheap: "muted",
};

/** Category grouping used when an agent's slug has no catalog entry. */
export const CUSTOM_CATEGORY = "Custom agents";

/**
 * The catalog's categories, in the order they are first declared in
 * `ROLE_CATALOG`. This is the canonical section order for the gallery; the
 * "Custom agents" bucket always sorts last (appended by consumers).
 */
export const CATEGORY_ORDER: string[] = (() => {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const entry of ROLE_CATALOG) {
    if (!seen.has(entry.category)) {
      seen.add(entry.category);
      order.push(entry.category);
    }
  }
  return order;
})();

// Chart accents from globals.css (--chart-1..5). Full literal class strings so
// Tailwind's JIT keeps them; category → accent is assigned by declaration order
// so the mapping follows the catalog instead of a hand-maintained table.
const ACCENTS = [
  "bg-chart-1/10 text-chart-1 border-chart-1/30",
  "bg-chart-2/10 text-chart-2 border-chart-2/30",
  "bg-chart-3/10 text-chart-3 border-chart-3/30",
  "bg-chart-4/10 text-chart-4 border-chart-4/30",
  "bg-chart-5/10 text-chart-5 border-chart-5/30",
] as const;

const NEUTRAL_ACCENT = "bg-muted text-muted-foreground border-border";

/** Accent classes (icon tile + chip) for a category. Custom → neutral. */
export function categoryAccent(category: string): string {
  const idx = CATEGORY_ORDER.indexOf(category);
  if (idx < 0) return NEUTRAL_ACCENT;
  return ACCENTS[idx % ACCENTS.length] ?? NEUTRAL_ACCENT;
}
