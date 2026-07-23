// Phase 2.5++ / WI-15 — import-time stack detection (pure).
//
// Given the contents of a repo's manifest files, work out which catalog
// services the project already uses, so the create form can pre-tick them for
// the operator instead of making them hand-pick from a 30-entry list.
//
// ─── Threat model (AGENTS.md principle 6) ─────────────────────────────────
//
// Everything this module reads is ATTACKER-CONTROLLED: a repo the operator is
// connecting can contain anything, including a `package.json` whose dependency
// name is a prompt-injection payload. The output of detection flows into a
// HARD frame at the top of the plan prompt — the strongest position there is.
// Three properties keep that safe, and all three are enforced here:
//
//   1. **Catalog-only output.** We never emit a string read from the repo. We
//      emit catalog KEYS (`detectStackTags` returns `ServiceCatalogEntry`s from
//      SERVICE_CATALOG); a fingerprint that maps to nothing is discarded. The
//      label the model eventually sees is the catalog's, not the repo's.
//   2. **Operator-confirmable.** This function's output only PRE-TICKS boxes in
//      the create form. Nothing is persisted, and nothing reaches a prompt,
//      until the operator submits — they can untick anything wrong.
//   3. **No parsing of untrusted content.** Substring fingerprinting against a
//      lowercased, byte-capped body. No JSON.parse of a lockfile, no HCL/YAML
//      parser dependency, no eval/exec/dynamic require. There is no code path
//      here where repo content is interpreted rather than searched.
//
// The scan set is a FIXED list of manifest paths (`SCAN_PATHS`) — we never
// enumerate the tree, and we never read prose files like the README, where a
// substring hit would mean nothing anyway.

import {
  SERVICE_CATALOG,
  getServiceEntry,
  type ServiceCatalogEntry,
} from "@/lib/stack/service-catalog";

/** Fixed manifest paths we look at, in fetch order. Nothing else is read. */
export const SCAN_PATHS: readonly string[] = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Gemfile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "main.tf",
  "terraform/main.tf",
  "infra/main.tf",
];

/**
 * Per-file cap applied BEFORE fingerprinting. Lockfiles are routinely multi-MB;
 * the signal we want (which packages appear at all) is dense at the top and we
 * would rather scan 64 KB of every file than 4 MB of one.
 */
export const SCAN_FILE_MAX_BYTES = 64_000;

export type ScannedFile = {
  /** Repo-relative path. Matched as part of the haystack — a file named
   *  `Dockerfile` is itself the Docker signal; its body may not say "docker". */
  path: string;
  content: string;
};

/**
 * Fingerprint the scanned files against the static catalog.
 *
 * Returns catalog ENTRIES (never repo strings), deduplicated, in catalog order
 * so the picker's pre-ticked boxes read top-to-bottom in the same order the
 * operator sees them.
 */
export function detectStackTags(files: ScannedFile[]): ServiceCatalogEntry[] {
  const hits = new Set<string>();
  for (const file of files) {
    // Path + body: `Dockerfile` and `terraform/main.tf` carry their signal in
    // the name. Lowercased once per file, capped defensively in case a caller
    // hands us an uncapped body.
    const haystack = `${file.path}\n${file.content.slice(0, SCAN_FILE_MAX_BYTES)}`.toLowerCase();
    for (const entry of SERVICE_CATALOG) {
      if (hits.has(entry.key)) continue;
      if (entry.fingerprints.some((f) => f.length > 0 && haystack.includes(f))) {
        hits.add(entry.key);
      }
    }
  }
  // Rebuild from the catalog rather than from the loop's iteration order, so
  // the result is catalog-ordered and — belt and braces — every emitted entry
  // is provably a catalog entry.
  return SERVICE_CATALOG.filter((e) => hits.has(e.key));
}

/**
 * Normalise a set of service keys from an UNTRUSTED source (a form submission,
 * a stale DB row) into catalog entries, dropping anything unknown. The one
 * gate every write and every read passes through.
 */
export function toCatalogEntries(keys: readonly string[]): ServiceCatalogEntry[] {
  const wanted = new Set(keys);
  const known = new Set<string>();
  for (const key of wanted) {
    if (getServiceEntry(key)) known.add(key);
  }
  return SERVICE_CATALOG.filter((e) => known.has(e.key));
}
