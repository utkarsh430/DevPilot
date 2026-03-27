// Phase 2 / F3 — Effective role catalog (isomorphic surface).
//
// This module is CLIENT-SAFE: types + the pure grouping helper. Anything
// touching the database lives in `effective-catalog.server.ts` so importing
// the grouping helper from a `"use client"` component doesn't drag
// `lib/db/server` (and therefore `next/headers`) into the client bundle.
//
// Imports of this file are safe from server, client, and edge components.

import { ROLE_CATALOG } from "@/lib/roles/catalog";

export type EffectiveCatalogEntry = {
  slug: string;
  displayName: string;
  /** For built-ins: existing category. For custom agents: "Custom agents". */
  category: string;
  /** Short purpose phrase (built-ins) or the agent description fallback. */
  purpose: string;
  /** Source — drives the "custom" badge in the picker. */
  kind: "builtin" | "custom";
};

export const CUSTOM_CATEGORY = "Custom agents";

/**
 * Built-in projection of `ROLE_CATALOG` into the effective-catalog shape.
 * Stable across calls; importable from both server and client. The picker
 * uses this when no operator-loaded catalog has been threaded down.
 */
export const BUILTIN_EFFECTIVE_CATALOG: ReadonlyArray<EffectiveCatalogEntry> = ROLE_CATALOG.map(
  (entry) => ({
    slug: entry.slug,
    displayName: entry.displayName,
    category: entry.category,
    purpose: entry.purpose,
    kind: "builtin" as const,
  }),
);

/**
 * Mirrors `groupCatalogByCategory()` from `catalog.ts` but works on the
 * effective union. Returns a Map keyed by category; values preserve the
 * insertion order of `entries` (built-ins first, then any custom rows).
 */
export function groupEffectiveCatalogByCategory(
  entries: ReadonlyArray<EffectiveCatalogEntry>,
): Map<string, EffectiveCatalogEntry[]> {
  const grouped = new Map<string, EffectiveCatalogEntry[]>();
  for (const entry of entries) {
    let bucket = grouped.get(entry.category);
    if (!bucket) {
      bucket = [];
      grouped.set(entry.category, bucket);
    }
    bucket.push(entry);
  }
  return grouped;
}
