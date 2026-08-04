// Stack advisor — the ranking / ecosystem-coherence engine (Stage 3).
//
// PURE. No DB, no LLM, no UI. Takes the capability keys the (later) inference
// step decided the project needs, plus the ecosystem the operator committed
// to, and turns them into ranked service options — the native/committed-cloud
// pick pre-selected, an open-source alternative always present.
//
// The model never reaches this file. It emits capability keys (Stage 1); this
// module reads a hand-written catalog (Stage 2) and picks services with plain
// arithmetic. There is no function here that accepts model-authored text.
//
// Security posture, mirrored from the design doc's invariants:
//   - No hard block, anywhere. `checkCoherence` returns advisory copy only —
//     a preference, never a prohibition (same stance WI-15 states for the
//     plan hard-frame: "a frame, deliberately NOT a ban").
//   - Every string a caller can render (`reasons`, coherence `message`) is
//     built from `ServiceCatalogEntry` fields. No caller ever passes in free
//     text and gets it echoed back.

import type { StackProvider } from "@/lib/plan/types";
import {
  type CapabilityEntry,
  type CapabilityKey,
  toCapabilityEntries,
} from "@/lib/stack/capabilities";
import {
  SERVICE_CATALOG,
  deriveStackFlavor,
  type FreeTier,
  type ServiceCatalogEntry,
} from "@/lib/stack/service-catalog";

/**
 * The project's ecosystem commitment. WIDER than `StackProvider` on purpose:
 * a project can be `mixed` or `unset`; a single SERVICE cannot.
 */
export type EcosystemChoice = "aws" | "azure" | "gcp" | "oss" | "mixed" | "unset";

export const ECOSYSTEM_CHOICES: readonly EcosystemChoice[] = [
  "aws",
  "azure",
  "gcp",
  "oss",
  "mixed",
  "unset",
];

export const DEFAULT_ECOSYSTEM: EcosystemChoice = "unset";

/** Narrow an untrusted value (DB row, form field) to an `EcosystemChoice`.
 *  Same contract as `isLlmProvider`/`isProjectType`: unknown/absent values
 *  are the caller's problem to default, never this function's. */
export function isEcosystemChoice(value: unknown): value is EcosystemChoice {
  return typeof value === "string" && (ECOSYSTEM_CHOICES as readonly string[]).includes(value);
}

/** The single cloud the project committed to, or `null` for oss/mixed/unset. */
export function committedCloud(ecosystem: EcosystemChoice): "aws" | "azure" | "gcp" | null {
  return ecosystem === "aws" || ecosystem === "azure" || ecosystem === "gcp" ? ecosystem : null;
}

/**
 * Collapse an ecosystem commitment into the closest `StackFlavor`, so the two
 * framings on a plan session can't silently disagree - the same reasoning
 * `deriveStackFlavor` states for the tag set it derives from. A committed
 * cloud is unambiguous ("industry"); `oss` is unambiguous ("oss"); `mixed`
 * and `unset` fall through to the existing tag-derived heuristic, which is
 * exactly today's behaviour for a project that hasn't committed to one.
 */
export function deriveStackFlavorFromEcosystem(
  ecosystem: EcosystemChoice,
  tags: ReadonlyArray<{ provider: StackProvider }>,
): "industry" | "mixed" | "oss" {
  if (ecosystem === "oss") return "oss";
  if (committedCloud(ecosystem)) return "industry";
  return deriveStackFlavor(tags);
}

export type RankedOption = {
  service: ServiceCatalogEntry;
  score: number;
  /** Slot 1: what the advisor pre-selects. Exactly one per capability. */
  isRecommended: boolean;
  /** The service is a cloud service from a DIFFERENT cloud than the committed one. */
  crossCloud: boolean;
  /** Catalog-derived justification lines. NEVER model text. Rendered under the card. */
  reasons: string[];
};

export type CapabilityPlan = {
  capability: CapabilityEntry;
  options: RankedOption[]; // length 0..optionsPerCapability
  /** service_key of options[0]. Empty string when the catalog has nothing yet. */
  preselectedKey: string;
};

export type ServiceSelection = { capability: CapabilityKey; serviceKey: string };

const DEFAULT_OPTIONS_PER_CAPABILITY = 3;

const CLOUD_LABEL: Record<"aws" | "azure" | "gcp", string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "Google Cloud",
};

// ─── Scoring (§6.2) ─────────────────────────────────────────────────────────
//
// Deterministic integer score. Every term is documented so a later change to
// the weights is a deliberate one, not drift.

function providerFit(provider: StackProvider, ecosystem: EcosystemChoice): number {
  const committed = committedCloud(ecosystem);
  if (committed) {
    if (provider === committed) return 100; // native-first
    if (provider === "oss") return 40; // always in contention
    return 10; // a different cloud — eligible, never preferred
  }
  if (ecosystem === "oss") {
    return provider === "oss" ? 100 : 10;
  }
  // mixed | unset — near-parity; rank + free tier decide, oss gets a
  // free-tier-shaped tilt per the brief.
  return provider === "oss" ? 60 : 50;
}

function freeTierBonus(freeTier: FreeTier): number {
  switch (freeTier.kind) {
    case "free_forever":
      return 8;
    case "limited_free":
      return 5;
    case "trial_credits":
      return 2;
    case "none":
      return 0;
  }
}

// ─── D8: the vector_db <-> relational_db cross-capability affinity ────────
//
// Approved design decision: when ranking `vector_db`, if the project already
// selected a Postgres-flavored service for `relational_db`, a pgvector-style
// entry ("just enable the extension") should win the oss slot; otherwise a
// standalone vector-DB SaaS (Pinecone-style) should. This is the one place
// ranking a capability is aware of another capability's pick, and it is
// scoped narrowly to vector_db so it can never affect any other capability's
// ordering.
//
// Recognition is by name (key/displayName), not a dedicated catalog field —
// the design doc leaves this as a curation-time affinity rather than new
// schema, and it only matters once Stage 6 adds vector_db catalog entries.

const AFFINITY_BONUS = 20; // enough to reorder within the oss bucket; never
// enough to overtake a committed cloud's native-first
// lead (100 vs 40 = a 60-point gap).

function isPostgresFlavored(entry: ServiceCatalogEntry): boolean {
  return /postgres/i.test(entry.key) || /postgres/i.test(entry.displayName);
}

function isPgvectorFlavored(entry: ServiceCatalogEntry): boolean {
  return /pgvector/i.test(entry.key) || /pgvector/i.test(entry.displayName);
}

function isStandaloneVectorSaas(entry: ServiceCatalogEntry): boolean {
  return /pinecone/i.test(entry.key) || /pinecone/i.test(entry.displayName);
}

function projectHasPostgres(
  currentSelections: readonly ServiceSelection[],
  catalog: readonly ServiceCatalogEntry[],
): boolean {
  return currentSelections.some((sel) => {
    if (sel.capability !== "relational_db") return false;
    const entry = catalog.find((e) => e.key === sel.serviceKey);
    return entry !== undefined && isPostgresFlavored(entry);
  });
}

function vectorDbAffinityBonus(
  capability: CapabilityKey,
  entry: ServiceCatalogEntry,
  currentSelections: readonly ServiceSelection[],
  catalog: readonly ServiceCatalogEntry[],
): number {
  if (capability !== "vector_db" || entry.provider !== "oss") return 0;
  const hasPostgres = projectHasPostgres(currentSelections, catalog);
  if (hasPostgres && isPgvectorFlavored(entry)) return AFFINITY_BONUS;
  if (!hasPostgres && isStandaloneVectorSaas(entry)) return AFFINITY_BONUS;
  return 0;
}

// ─── reasons() — why a card says what it says (§6.5) ───────────────────────
//
// Catalog-derived, never model-authored. Shared by the UI card and (in a
// later stage) nothing else — `why` from the LLM inference step is
// deliberately never routed through here or into any prompt.

export function reasons(args: {
  service: ServiceCatalogEntry;
  ecosystem: EcosystemChoice;
  crossCloud: boolean;
}): string[] {
  const { service, ecosystem, crossCloud } = args;
  const committed = committedCloud(ecosystem);
  const lines: string[] = [];

  if (committed && service.provider === committed) {
    lines.push(
      `Native to your ${CLOUD_LABEL[committed]} ecosystem - same IAM, same VPC, one bill.`,
    );
  } else if (crossCloud && committed) {
    lines.push(
      `Not a ${CLOUD_LABEL[committed]} service - a separate cloud account, billing, and IAM.`,
    );
  } else if (service.provider === "oss" && !service.managed) {
    lines.push("Open source - self-hosted, no vendor bill.");
  } else if (service.provider === "oss" && service.managed) {
    lines.push(
      "Third-party managed service - no infrastructure to operate, but a separate vendor bill.",
    );
  } else if (!committed) {
    lines.push(`A ${CLOUD_LABEL[service.provider as "aws" | "azure" | "gcp"]} managed service.`);
  }

  switch (service.freeTier.kind) {
    case "free_forever":
      lines.push(`Free forever - ${service.freeTier.note}`);
      break;
    case "limited_free":
      lines.push(`Free tier: ${service.freeTier.note}`);
      break;
    case "trial_credits":
      lines.push(`Trial credits: ${service.freeTier.note}`);
      break;
    case "none":
      lines.push("No free tier - you'll pay from day one.");
      break;
  }

  return lines;
}

// ─── rankCapability (§6.2-§6.3, §6.6) ──────────────────────────────────────

export function rankCapability(args: {
  capability: CapabilityKey;
  ecosystem: EcosystemChoice;
  optionsPerCapability?: number;
  catalog?: readonly ServiceCatalogEntry[];
  currentSelections?: readonly ServiceSelection[];
}): RankedOption[] {
  const optionsPerCapability = args.optionsPerCapability ?? DEFAULT_OPTIONS_PER_CAPABILITY;
  const catalog = args.catalog ?? SERVICE_CATALOG;
  const currentSelections = args.currentSelections ?? [];
  const committed = committedCloud(args.ecosystem);

  const candidates = catalog.filter((e) => e.capabilities.includes(args.capability));
  if (candidates.length === 0) return [];

  const scored = candidates.map((service) => {
    const affinity = vectorDbAffinityBonus(args.capability, service, currentSelections, catalog);
    const score =
      providerFit(service.provider, args.ecosystem) +
      freeTierBonus(service.freeTier) -
      service.rank +
      affinity;
    const crossCloud =
      committed !== null && service.provider !== "oss" && service.provider !== committed;
    return { service, score, crossCloud };
  });

  // Stable sort: score DESC, then key ASC as the tiebreak — so the ranking
  // is deterministic and snapshot-testable.
  scored.sort((a, b) => b.score - a.score || a.service.key.localeCompare(b.service.key));

  // Slot reservation (§6.3): an OSS alternative next to the native pick is a
  // STRUCTURAL guarantee, not an emergent property of the scores.
  const placed = new Set<string>();
  const ordered: typeof scored = [];

  const top = scored[0]!;
  ordered.push(top);
  placed.add(top.service.key);

  const ossPick = scored.find((s) => s.service.provider === "oss" && !placed.has(s.service.key));
  if (ossPick) {
    ordered.push(ossPick);
    placed.add(ossPick.service.key);
  }

  for (const s of scored) {
    if (ordered.length >= optionsPerCapability) break;
    if (placed.has(s.service.key)) continue;
    ordered.push(s);
    placed.add(s.service.key);
  }

  return ordered.slice(0, optionsPerCapability).map((s, i) => ({
    service: s.service,
    score: s.score,
    isRecommended: i === 0,
    crossCloud: s.crossCloud,
    reasons: reasons({ service: s.service, ecosystem: args.ecosystem, crossCloud: s.crossCloud }),
  }));
}

// ─── planStackSelection (§2.2, §6.1) ───────────────────────────────────────
//
// One service per capability (D6): the ranked plan the advisor UI renders.
// Capabilities are processed in catalog order (`CapabilityEntry.order`) so
// that, when the D8 affinity applies, `relational_db` (order 0) is always
// ranked — and its pick threaded forward — before `vector_db` (order 2) sees
// it.

export function planStackSelection(args: {
  capabilities: readonly CapabilityKey[];
  ecosystem: EcosystemChoice;
  optionsPerCapability?: number;
  catalog?: readonly ServiceCatalogEntry[];
  currentSelections?: readonly ServiceSelection[];
}): CapabilityPlan[] {
  const optionsPerCapability = args.optionsPerCapability ?? DEFAULT_OPTIONS_PER_CAPABILITY;
  const catalog = args.catalog ?? SERVICE_CATALOG;
  const capabilityEntries = toCapabilityEntries(args.capabilities);

  // Threaded forward as each capability is ranked, so a later capability's
  // affinity bonus (D8) can see an earlier capability's pick. Starts from
  // whatever the caller already knows the project has selected.
  const selections: ServiceSelection[] = [...(args.currentSelections ?? [])];

  const plans: CapabilityPlan[] = [];
  for (const capability of capabilityEntries) {
    const options = rankCapability({
      capability: capability.key,
      ecosystem: args.ecosystem,
      optionsPerCapability,
      catalog,
      currentSelections: selections,
    });
    const preselectedKey = options[0]?.service.key ?? "";
    plans.push({ capability, options, preselectedKey });
    if (preselectedKey) {
      selections.push({ capability: capability.key, serviceKey: preselectedKey });
    }
  }
  return plans;
}

// ─── resolveSelectedServiceKey (Stage 8) ───────────────────────────────────
//
// Which service a capability row is actually SET to, given the ranked plan and
// whatever the project already has selected (a saved advisor row, or a service
// the import bridge detected from the repo's manifests).
//
// The validity test is "can this service fill this capability AT ALL" — the
// whole catalog — deliberately NOT "is it in the ranked top-3 we render". A
// detected or previously-saved service can legitimately rank 4th for the
// project's ecosystem and still be the service the project runs; validating
// against the rendered options would silently reset an operator-confirmed
// choice back to the ranker's pick, with nothing in the UI to say it happened.
// The caller is responsible for RENDERING an out-of-top-3 pick (the panel
// appends its card), so the selection is always visible as well as honoured.

export function resolveSelectedServiceKey(args: {
  capability: CapabilityKey;
  preselectedKey: string;
  override?: string;
  catalog?: readonly ServiceCatalogEntry[];
}): string {
  const catalog = args.catalog ?? SERVICE_CATALOG;
  const valid =
    args.override !== undefined &&
    catalog.some((e) => e.key === args.override && e.capabilities.includes(args.capability));
  return valid ? args.override! : args.preselectedKey;
}

// ─── checkCoherence (§6.4) ──────────────────────────────────────────────────
//
// No hard block, anywhere (D2). `mixed_ecosystem` is deliberately never
// emitted here: per the design doc it is a single informational line on the
// EcosystemPicker itself ("not a per-row warning"), independent of any
// selection, so it belongs to that UI component (a later stage) rather than
// to this pure, selection-driven function.

export type CoherenceWarning = {
  kind: "cross_cloud" | "second_cloud" | "mixed_ecosystem";
  capability: CapabilityKey;
  serviceKey: string;
  message: string;
};

export function checkCoherence(args: {
  ecosystem: EcosystemChoice;
  selections: readonly ServiceSelection[];
  catalog?: readonly ServiceCatalogEntry[];
}): CoherenceWarning[] {
  const catalog = args.catalog ?? SERVICE_CATALOG;
  const resolved = args.selections
    .map((sel) => ({ sel, entry: catalog.find((e) => e.key === sel.serviceKey) }))
    .filter(
      (r): r is { sel: ServiceSelection; entry: ServiceCatalogEntry } => r.entry !== undefined,
    );
  const cloudPicks = resolved.filter((r) => r.entry.provider !== "oss");

  const committed = committedCloud(args.ecosystem);
  if (committed) {
    // Per-selection: every pick that is a native service of a DIFFERENT
    // cloud than the one the project committed to.
    return cloudPicks
      .filter((r) => r.entry.provider !== committed)
      .map((r) => ({
        kind: "cross_cloud",
        capability: r.sel.capability,
        serviceKey: r.sel.serviceKey,
        message:
          `${r.entry.displayName} is not an ${CLOUD_LABEL[committed]} service. ` +
          "You'll run a second cloud account: separate billing, separate IAM, and cross-cloud " +
          "egress on every query. That's allowed - we just won't assume it when planning.",
      }));
  }

  // No single committed cloud (mixed | unset): escalate when the actual
  // selections span two or more distinct clouds — the case the brief calls
  // "strongly discouraged".
  const distinctClouds = new Set(cloudPicks.map((r) => r.entry.provider));
  if (distinctClouds.size < 2) return [];

  const firstCloud = cloudPicks[0]!.entry.provider as "aws" | "azure" | "gcp";
  return cloudPicks
    .filter((r) => r.entry.provider !== firstCloud)
    .map((r) => ({
      kind: "second_cloud",
      capability: r.sel.capability,
      serviceKey: r.sel.serviceKey,
      message:
        `This stack now spans ${CLOUD_LABEL[firstCloud]} and ${CLOUD_LABEL[r.entry.provider as "aws" | "azure" | "gcp"]}. ` +
        "Two clouds means two bills, two IAM models, two on-call surfaces, and egress charges " +
        "between them. Committing to one cloud - or going all open-source on free tiers - is " +
        "almost always the better call. You can proceed anyway.",
    }));
}
