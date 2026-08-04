// Stack -> plan provenance (Phase 4 of the plan-component revamp). Pure,
// presentation-only helpers that turn the advisor's ALREADY-loaded saved stack
// into the small display artifacts the Build and Review moments surface:
//
//   • the service run "Building on your stack: <services>" (Build), and
//   • the "Planned on: <ecosystem> - <services>" banner (Review),
//   • plus the optional per-ticket stack chips (client-side substring match).
//
// This module READS the saved selection the operator already pinned (via the
// `useStackAdvisor` self-load) and formats it. It NEVER fetches, never writes,
// and never recomputes ranking/inference — the hard-frame injection lives in
// `stackTagsBlock`/the consolidator and is unchanged. Extracted from the plan
// components so the substring-match + name-derivation logic is unit-testable
// (component `.tsx` files can't load under Vitest), mirroring how Phase 3
// extracted `density.ts`.

import type { CapabilityKey } from "@/lib/stack/capabilities";
import type { StackAdviceStatus } from "@/lib/plan/types";
import { getServiceEntry } from "@/lib/stack/service-catalog";
import type { EcosystemChoice } from "@/lib/stack/rank";

/** Readable ecosystem label for the provenance banner. `unset` returns null so
 *  the caller omits the ecosystem clause entirely rather than printing a
 *  meaningless "No ecosystem" chip in a "Planned on:" line. */
const ECOSYSTEM_DISPLAY: Record<EcosystemChoice, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "GCP",
  oss: "OSS (self-hosted)",
  mixed: "Mixed cloud",
  unset: "",
};

export function ecosystemLabel(ecosystem: EcosystemChoice): string | null {
  return ECOSYSTEM_DISPLAY[ecosystem] || null;
}

/** Minimal structural view of a `CapabilityPlan` — just the capability key,
 *  which is all the name derivation reads. Keeps the helper testable without
 *  constructing a full `CapabilityPlan`. */
type PlanLike = { capability: { key: CapabilityKey } };

/**
 * The saved services, as display names, in the SAME order the Stack Strip
 * renders them: one per included capability (in plan/catalog order), then the
 * "extra" (capability-less) services. Unknown keys fall back to the raw key
 * rather than throwing. This is the shared source for the strip pills, the
 * Build run, and the Review banner so the three can never drift.
 */
export function savedStackServiceNames(input: {
  plans: readonly PlanLike[];
  selectedByCapability: ReadonlyMap<CapabilityKey, string>;
  extraServiceKeys: Iterable<string>;
}): string[] {
  const out: string[] = [];
  for (const plan of input.plans) {
    const key = input.selectedByCapability.get(plan.capability.key);
    if (!key) continue;
    out.push(getServiceEntry(key)?.displayName ?? key);
  }
  for (const key of input.extraServiceKeys) {
    out.push(getServiceEntry(key)?.displayName ?? key);
  }
  return out;
}

/** What the Build/Review provenance surfaces read. Derived once, off the
 *  advisor hook, and threaded down as a plain data prop so the consuming
 *  components stay decoupled from the advisor's shape. */
export type StackProvenance = {
  /** Advisor self-load finished — gate rendering on this to avoid a
   *  "no stack" flash before the saved tags land. */
  loaded: boolean;
  /** A stack is actually PINNED (`status === "accepted"`). Only an accepted
   *  selection is the hard frame in the plan prompt; a merely-suggested
   *  (`ready`) or skipped/unrun stack drives nothing, so it reads as "no stack
   *  pinned" everywhere. */
  accepted: boolean;
  /** Non-null only for a committed ecosystem worth naming. */
  ecosystemLabel: string | null;
  /** Empty unless `accepted`. */
  serviceNames: string[];
};

/** Advisor-hook fields the provenance derivation needs. A structural subset of
 *  `StackAdvisor` so the builder is callable in tests with a hand-built object. */
export type StackProvenanceInput = {
  loaded: boolean;
  status: StackAdviceStatus;
  ecosystem: EcosystemChoice;
  plans: readonly PlanLike[];
  selectedByCapability: ReadonlyMap<CapabilityKey, string>;
  extraServiceKeys: Iterable<string>;
};

export function buildStackProvenance(advisor: StackProvenanceInput): StackProvenance {
  const accepted = advisor.status === "accepted";
  return {
    loaded: advisor.loaded,
    accepted,
    ecosystemLabel: ecosystemLabel(advisor.ecosystem),
    serviceNames: accepted ? savedStackServiceNames(advisor) : [],
  };
}

/**
 * Per-ticket stack chips (adopted decision #4 — client-side v1, zero migration).
 * Case-insensitive substring match of each saved service display name against a
 * ticket's text (title + description). Cheap and defensive: empty/missing text
 * or an empty stack yields no chips and never throws; matches are de-duped and
 * capped so a ticket that name-drops the whole stack doesn't flood its row.
 *
 * This is a NOTICE, not provenance-of-record: the exact consolidator
 * `service_keys[]` version stays deferred (spec §6).
 */
export function matchStackChips(input: {
  text: string | null | undefined;
  serviceNames: readonly string[];
  /** Max visible chips before overflowing to "+N". Default 3. */
  max?: number;
}): { visible: string[]; overflow: number } {
  const haystack = (input.text ?? "").toLowerCase();
  if (haystack.length === 0) return { visible: [], overflow: 0 };
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const name of input.serviceNames) {
    if (!name) continue;
    const needle = name.toLowerCase();
    if (seen.has(needle)) continue;
    if (haystack.includes(needle)) {
      matched.push(name);
      seen.add(needle);
    }
  }
  const max = input.max ?? 3;
  const visible = matched.slice(0, max);
  return { visible, overflow: matched.length - visible.length };
}
