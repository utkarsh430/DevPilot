// Stack advisor (Stage 8) — the import → advisor bridge. PURE.
//
// The WI-15 detector (`detect-stack-tags.ts`) answers "which catalog services
// does this repo already use". The advisor is keyed on "which service fills
// which CAPABILITY slot". This module is the join between the two, and it is
// the only place that join happens.
//
// ─── Trust chain (there is no new trust path here) ────────────────────────
//
// Every hop is key → capability → catalog:
//
//   1. The input is a set of SERVICE KEYS, and they are re-derived through
//      `toCatalogEntries` — the same gate every other write passes — so a key
//      that isn't in the static catalog is dropped, never carried forward.
//   2. The capability slots come from `ServiceCatalogEntry.capabilities`, a
//      `readonly CapabilityKey[]` off the hand-written catalog. Nothing read
//      from a repo manifest picks a capability; the catalog does.
//   3. Nothing here constructs a label. Callers persist KEYS, and
//      `persistStackSelection` re-validates both keys again through
//      `getCapability`/`getServiceEntry` before they land.
//
// So the worst a hostile repo can do is get a legitimate catalog service
// mis-fingerprinted into a capability slot — which the operator sees in the
// create form's picker and unticks before anything is written.
//
// ─── D6: one service per capability ───────────────────────────────────────
//
// `project_stack_tags` carries a partial unique index on (project_id,
// capability) where capability is not null, so two detected services that fill
// the SAME capability (a repo with both `postgres` and `supabase` → both fill
// `relational_db`) cannot both be advisor rows. The tiebreak is DETERMINISTIC
// and catalog-driven: lowest `rank` wins, service key ASC as the final
// tiebreak — the same ordering `buildCapabilityIndex` uses for the option
// lists, so the bridge never disagrees with the ranker about which entry is
// the canonical one.
//
// The LOSER IS NOT DROPPED. It falls back to the `capability IS NULL` partition
// (the "extra services" the manual picker already writes), so an
// operator-confirmed service always survives the import somewhere. Same for a
// catalog entry with no capabilities at all (Terraform, nginx): IaC is a
// preference, not an ecosystem-coherence slot, so it was never an advisor row.

import { toCatalogEntries } from "@/lib/stack/detect-stack-tags";
import { getCapability, type CapabilityKey } from "@/lib/stack/capabilities";
import type { ServiceCatalogEntry } from "@/lib/stack/service-catalog";
// Type-only (erased at compile) — this module stays pure and importable from a
// Vitest suite; the server-only writer it types against is never loaded here.
import type { StackSelectionInput } from "@/lib/stack/persist.server";

export type DetectedStackBridge = {
  /** One row per filled capability slot — the advisor's durable selection. */
  selections: StackSelectionInput[];
  /** Everything else: zero-capability services, and the losers of a
   *  same-capability tiebreak. Persisted as `capability IS NULL` extras. */
  extraServiceKeys: string[];
};

/**
 * Expand a set of detected catalog service keys into advisor capability rows.
 *
 * A multi-capability service fans OUT: `supabase` fills four slots
 * (relational_db, auth, object_storage, realtime), `redis` two (cache, queue).
 * That is the same `capabilities` field the ranker joins on, so a selection
 * produced here is indistinguishable from one the advisor UI would have
 * produced by hand.
 *
 * `recommendedServiceKey` is set to the detected key itself, so the row
 * persists with `overridden === false`: the operator didn't swap away from a
 * recommendation, there was no recommendation — the repo already told us.
 */
export function planDetectedStackSelection(serviceKeys: readonly string[]): DetectedStackBridge {
  // Gate 1: catalog-only. Returns entries in catalog order.
  const entries = toCatalogEntries(serviceKeys);

  const candidatesByCapability = new Map<CapabilityKey, ServiceCatalogEntry[]>();
  for (const entry of entries) {
    for (const capabilityKey of entry.capabilities) {
      // Gate 2: the closed capability taxonomy. A catalog entry pointing at a
      // capability that has since left the taxonomy contributes no row.
      if (!getCapability(capabilityKey)) continue;
      const list = candidatesByCapability.get(capabilityKey) ?? [];
      list.push(entry);
      candidatesByCapability.set(capabilityKey, list);
    }
  }

  const selections: StackSelectionInput[] = [];
  const placed = new Set<string>();
  for (const [capabilityKey, candidates] of candidatesByCapability) {
    const capability = getCapability(capabilityKey)!;
    const winner = [...candidates].sort(
      (a, b) => a.rank - b.rank || a.key.localeCompare(b.key),
    )[0]!;
    selections.push({
      capability: capability.key,
      serviceKey: winner.key,
      recommendedServiceKey: winner.key,
    });
    placed.add(winner.key);
  }
  // Capability catalog order — deterministic, and the same order the frame and
  // the advisor UI render in.
  selections.sort(
    (a, b) => getCapability(a.capability)!.order - getCapability(b.capability)!.order,
  );

  // Nothing an operator confirmed vanishes: a service that won no capability
  // slot (zero-capability entry, or the loser of a tiebreak) is still pinned,
  // just as a capability-less extra.
  const extraServiceKeys = entries.filter((e) => !placed.has(e.key)).map((e) => e.key);

  return { selections, extraServiceKeys };
}
