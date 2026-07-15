// Stack advisor — the capability taxonomy (Stage 1).
//
// The second closed vocabulary alongside the static service catalog
// (`service-catalog.ts`). Where the catalog answers "which service", this
// answers "which kind of service does the project need at all" — a project
// needs a relational database before it needs to know whether that means RDS,
// Cloud SQL, or self-hosted Postgres.
//
// This is the ONLY vocabulary the stack-advisor LLM inference step may emit
// (a later stage). The model picks capability keys from the closed list below;
// it never names a service. That split is the whole reason a prompt
// injection in a project description cannot get an attacker's endpoint into
// the plan prompt — there is no path from model output to a service name.
//
// Deliberately dependency-free (constants only, no imports), exactly like
// `lib/projects/project-type.ts` (WI-11's pattern): that is what lets a
// server-only loader, a pure ranker, and the prompt builders all import this
// module with no import cycle.
//
// Nothing in the codebase imports this module yet — it ships alone in this
// stage and is wired up by the catalog extension and the ranker.

export const CAPABILITY_KEYS = [
  "relational_db",
  "document_db",
  "vector_db",
  "cache",
  "object_storage",
  "queue",
  "event_stream",
  "realtime",
  "auth",
  "llm_inference",
  "search",
  "email",
  "cdn",
  "compute_serverless",
  "compute_container",
  "observability",
  "error_tracking",
  "secrets",
  "cicd",
  "analytics_warehouse",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type CapabilityEntry = {
  key: CapabilityKey;
  displayName: string;
  /** One line. The model's reasoning cue AND the UI's row subtitle. */
  purpose: string;
  /** Ordering in the advisor UI + the prompt frame. Lower = higher up. */
  order: number;
  /**
   * True when a typical production app needs this regardless of what the
   * description says. Drives the baseline floor (always suggested, at
   * confidence 5) and the LLM-free fallback set in a later stage.
   */
  baseline: boolean;
};

export const CAPABILITY_CATALOG: readonly CapabilityEntry[] = [
  {
    key: "relational_db",
    displayName: "Relational database",
    purpose: "Transactional store for structured, related records",
    order: 0,
    baseline: false,
  },
  {
    key: "document_db",
    displayName: "Document / key-value store",
    purpose: "Schemaless documents or high-throughput key-value lookups",
    order: 1,
    baseline: false,
  },
  {
    key: "vector_db",
    displayName: "Vector database",
    purpose: "Embedding storage + similarity search for RAG/semantic features",
    order: 2,
    baseline: false,
  },
  {
    key: "cache",
    displayName: "Cache",
    purpose: "Low-latency read cache, session store, distributed locks",
    order: 3,
    baseline: false,
  },
  {
    key: "object_storage",
    displayName: "Object storage",
    purpose: "Blobs: user uploads, generated files, backups",
    order: 4,
    baseline: false,
  },
  {
    key: "queue",
    displayName: "Task queue",
    purpose: "Async work handoff between services; retries; at-least-once delivery",
    order: 5,
    baseline: false,
  },
  {
    key: "event_stream",
    displayName: "Event stream / pub-sub",
    purpose: "Ordered, replayable event log fanning out to many consumers",
    order: 6,
    baseline: false,
  },
  {
    key: "realtime",
    displayName: "Realtime push",
    purpose: "Server-to-client push: presence, live updates, collaborative state",
    order: 7,
    baseline: false,
  },
  {
    key: "auth",
    displayName: "Authentication & identity",
    purpose: "User sign-in, sessions, tokens, social/SSO providers",
    order: 8,
    baseline: false,
  },
  {
    key: "llm_inference",
    displayName: "LLM / model inference",
    purpose: "Calls to a hosted or self-hosted language/embedding model",
    order: 9,
    baseline: false,
  },
  {
    key: "search",
    displayName: "Full-text search",
    purpose: "Keyword/faceted search over documents",
    order: 10,
    baseline: false,
  },
  {
    key: "email",
    displayName: "Transactional email",
    purpose: "Outbound email the product sends (verification, receipts, alerts)",
    order: 11,
    baseline: false,
  },
  {
    key: "cdn",
    displayName: "CDN / edge delivery",
    purpose: "Cached static asset + media delivery close to users",
    order: 12,
    baseline: false,
  },
  {
    key: "compute_serverless",
    displayName: "Serverless functions",
    purpose: "Event-driven, scale-to-zero function compute",
    order: 13,
    baseline: false,
  },
  {
    key: "compute_container",
    displayName: "Container runtime",
    purpose: "Long-running services from container images",
    order: 14,
    baseline: false,
  },
  {
    key: "observability",
    displayName: "Metrics, logs & traces",
    purpose: "Runtime visibility: dashboards, alerting, distributed tracing",
    order: 15,
    baseline: true,
  },
  {
    key: "error_tracking",
    displayName: "Error tracking",
    purpose: "Exception capture, grouping, and release regression alerts",
    order: 16,
    baseline: false,
  },
  {
    key: "secrets",
    displayName: "Secrets management",
    purpose: "Runtime storage + rotation of credentials",
    order: 17,
    baseline: true,
  },
  {
    key: "cicd",
    displayName: "CI / CD",
    purpose: "Build, test, and deploy pipeline",
    order: 18,
    baseline: true,
  },
  {
    key: "analytics_warehouse",
    displayName: "Analytics / warehouse",
    purpose: "Columnar store for product analytics and BI queries",
    order: 19,
    baseline: false,
  },
];

const BY_KEY: ReadonlyMap<string, CapabilityEntry> = new Map(
  CAPABILITY_CATALOG.map((e) => [e.key, e]),
);

/**
 * The ONLY way an untrusted capability string (model output, a stale DB row)
 * becomes a usable key. Returns `undefined` for anything not in the catalog —
 * same contract as `getServiceEntry` (service-catalog.ts).
 */
export function getCapability(key: string): CapabilityEntry | undefined {
  return BY_KEY.get(key);
}

export function isKnownCapability(key: string): boolean {
  return BY_KEY.has(key);
}

/**
 * Untrusted string[] -> catalog entries, unknowns dropped, deduplicated,
 * catalog-ordered. Twin of `toCatalogEntries` (detect-stack-tags.ts).
 */
export function toCapabilityEntries(keys: readonly string[]): CapabilityEntry[] {
  const wanted = new Set(keys);
  const known = new Set<string>();
  for (const key of wanted) {
    if (getCapability(key)) known.add(key);
  }
  return CAPABILITY_CATALOG.filter((e) => known.has(e.key));
}

/** Zod-enum tuple, for the inference schema (a later stage). */
export const CAPABILITY_ENUM = CAPABILITY_KEYS as unknown as [CapabilityKey, ...CapabilityKey[]];

// ─── Invariant guard ────────────────────────────────────────────────────
// Same shape as the SERVICE_CATALOG guard: loud in the logs, never throws
// (this module is imported from prerender/type-check contexts).
{
  const seen = new Set<string>();
  const dupes = CAPABILITY_CATALOG.filter((e) =>
    seen.has(e.key) ? true : (seen.add(e.key), false),
  );
  if (dupes.length > 0) {
    console.error(
      `[capabilities] duplicate capability keys: ${dupes.map((e) => e.key).join(", ")}. ` +
        "Keys are the primary identity of a capability (persisted in project_stack_tags.capability) — dedupe them.",
    );
  }
}
