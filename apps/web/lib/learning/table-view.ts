// Pure filter / sort / search / bulk-selection logic for the lessons TABLE view
// on `(app)/learnings`. Extracted from the "use client" component for the same
// reason `queue-nav.ts` was: it can be unit-tested under the node vitest env,
// while the table itself pulls in React + server actions and cannot load there.
//
// ── The load-bearing rule in this file ──
// `confidence` is NULLABLE — null means "not yet graded by the grader", not
// "low". So an ungraded row must never be swept up by a confidence-based bulk
// approval: `confidenceBulkTargets` only ever returns rows whose confidence is a
// real grade the operator asked for. The filter mirrors that: selecting `high`
// returns no ungraded rows; an operator who wants them asks for the explicit
// `ungraded` pseudo-value. Both properties are asserted in
// `__tests__/table-view.test.ts`.

import { LESSON_CONFIDENCES, type LessonConfidence } from "@/lib/learning/confidence";
import { LESSON_SCOPES, type LessonScope } from "@/lib/learning/extract";

/* ────────────────────────────── vocabulary ────────────────────────────── */

// The grade vocabulary has ONE home — the grader's own `lib/learning/confidence.ts`.
// Re-exported (not re-declared) so the view can never offer a level the grader
// cannot produce. NULL in the DB = ungraded and is deliberately NOT a member of
// that union, which is what makes the ungraded guard below expressible in types.
export { LESSON_CONFIDENCES };
export type { LessonConfidence };

/** The filter vocabulary adds an explicit `ungraded` bucket for the NULLs, so
 *  "show me what still needs grading" is expressible without ever letting a
 *  grade-named filter (or a grade-driven bulk action) reach an ungraded row. */
export const CONFIDENCE_FILTER_VALUES = ["high", "medium", "low", "ungraded"] as const;
export type ConfidenceFilterValue = (typeof CONFIDENCE_FILTER_VALUES)[number];

export const LEARNING_STATUSES = ["candidate", "active", "rejected", "archived"] as const;
export type LearningStatus = (typeof LEARNING_STATUSES)[number];

const CONFIDENCE_SET: ReadonlySet<string> = new Set(LESSON_CONFIDENCES);
const CONFIDENCE_FILTER_SET: ReadonlySet<string> = new Set(CONFIDENCE_FILTER_VALUES);
const STATUS_SET: ReadonlySet<string> = new Set(LEARNING_STATUSES);
const SCOPE_SET: ReadonlySet<string> = new Set(LESSON_SCOPES);

/**
 * Ground a stored DB / URL value to a real grade, or `null` for ungraded.
 *
 * NOT a duplicate of the grader's `normalizeConfidence`, and the two must not be
 * merged: that one grounds MODEL OUTPUT and resolves anything unparseable to
 * `low` ("grade downward when uncertain"). This one grounds a STORED value,
 * where the same input means something different — a missing/unrecognised
 * confidence is a row the grader never successfully graded, so it must read as
 * UNGRADED and stay out of every confidence-based bulk action. Defaulting it to
 * `low` here would silently make ungraded rows sweepable by "high + medium"'s
 * sibling filters; defaulting it to `high` would be far worse.
 */
export function toLessonConfidence(raw: unknown): LessonConfidence | null {
  return typeof raw === "string" && CONFIDENCE_SET.has(raw) ? (raw as LessonConfidence) : null;
}

export function isLearningStatus(raw: unknown): raw is LearningStatus {
  return typeof raw === "string" && STATUS_SET.has(raw);
}

/** Sort weight. Ungraded sits after every real grade in ascending order (and
 *  before them descending) — one predictable rule, no special-casing. */
const CONFIDENCE_RANK: Record<ConfidenceFilterValue, number> = {
  high: 0,
  medium: 1,
  low: 2,
  ungraded: 3,
};

/* ──────────────────────────────── row shape ───────────────────────────── */

export type LessonTableMistake = {
  id: string;
  type: string;
  role: string;
  runId: string | null;
  ticketId: string | null;
  ticketKey: string | null;
  evidenceSummary: string;
};

export type LessonTableRow = {
  id: string;
  scope: LessonScope;
  roleSlug: string | null;
  category: string;
  body: string;
  status: LearningStatus;
  createdAt: string;
  /** NULL ⇒ not yet graded. Never assume a value. */
  confidence: LessonConfidence | null;
  confidenceReason: string | null;
  mistake: LessonTableMistake | null;
};

/* ──────────────────────────────── the query ───────────────────────────── */

export const SORT_KEYS = [
  "confidence",
  "scope",
  "role",
  "category",
  "body",
  "mistake",
  "status",
  "created",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

/** An empty facet array means "no constraint on this facet" (show everything),
 *  which is what makes the URL short: only narrowed facets are serialized. */
export type LessonQuery = {
  search: string;
  confidence: ConfidenceFilterValue[];
  scope: LessonScope[];
  role: string[];
  category: string[];
  status: LearningStatus[];
  sortKey: SortKey;
  sortDir: SortDir;
};

/** The queue's job is reviewing candidates, so that is the landing filter. */
export const DEFAULT_LESSON_QUERY: LessonQuery = {
  search: "",
  confidence: [],
  scope: [],
  role: [],
  category: [],
  status: ["candidate"],
  sortKey: "confidence",
  sortDir: "asc",
};

/* ─────────────────────────────── filtering ────────────────────────────── */

/** The bucket a row falls in for confidence filtering. */
export function confidenceBucket(row: LessonTableRow): ConfidenceFilterValue {
  return row.confidence ?? "ungraded";
}

/** Free-text haystack: the operator searches what they can SEE plus the reason
 *  behind the grade (it is the thing that explains a surprising `low`). */
function haystack(row: LessonTableRow): string {
  return [
    row.body,
    row.category,
    row.roleSlug ?? "",
    row.confidenceReason ?? "",
    row.mistake?.type ?? "",
    row.mistake?.role ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

/** Every non-empty term must appear somewhere (AND across whitespace-split
 *  terms) — the behaviour people expect from a search box. */
function matchesSearch(row: LessonTableRow, search: string): boolean {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = haystack(row);
  return terms.every((t) => hay.includes(t));
}

export function matchesLessonQuery(row: LessonTableRow, q: LessonQuery): boolean {
  if (q.status.length > 0 && !q.status.includes(row.status)) return false;
  // The ungraded guard: `confidence: ["high"]` can only ever match a row whose
  // confidence IS "high" — a null lands in the `ungraded` bucket and is out.
  if (q.confidence.length > 0 && !q.confidence.includes(confidenceBucket(row))) return false;
  if (q.scope.length > 0 && !q.scope.includes(row.scope)) return false;
  if (q.role.length > 0 && !q.role.includes(row.roleSlug ?? "")) return false;
  if (q.category.length > 0 && !q.category.includes(row.category)) return false;
  return matchesSearch(row, q.search);
}

/* ──────────────────────────────── sorting ─────────────────────────────── */

function sortValue(row: LessonTableRow, key: SortKey): string | number {
  switch (key) {
    case "confidence":
      return CONFIDENCE_RANK[confidenceBucket(row)];
    case "scope":
      return row.scope;
    case "role":
      return row.roleSlug ?? "";
    case "category":
      return row.category;
    case "body":
      return row.body.toLowerCase();
    case "mistake":
      return row.mistake?.type ?? "";
    case "status":
      return row.status;
    case "created":
      return Date.parse(row.createdAt) || 0;
  }
}

/** Stable sort: ties break on `id`, so a re-sort never shuffles equal rows and
 *  the operator's eye keeps its place. */
export function sortLessonRows(
  rows: readonly LessonTableRow[],
  key: SortKey,
  dir: SortDir,
): LessonTableRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    let cmp: number;
    if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb));
    if (cmp !== 0) return cmp * sign;
    return a.id.localeCompare(b.id);
  });
}

/** Filter then sort — the one function the table renders from. */
export function applyLessonQuery(
  rows: readonly LessonTableRow[],
  q: LessonQuery,
): LessonTableRow[] {
  return sortLessonRows(
    rows.filter((r) => matchesLessonQuery(r, q)),
    q.sortKey,
    q.sortDir,
  );
}

/* ─────────────────────────── bulk selection rules ─────────────────────── */

/** "Select all matching the current filter" — EXACTLY the visible set, so what
 *  the operator sees and what they act on can never diverge. */
export function selectAllMatchingIds(rows: readonly LessonTableRow[], q: LessonQuery): string[] {
  return applyLessonQuery(rows, q).map((r) => r.id);
}

/**
 * Targets for the headline "Accept all high confidence" / "Accept all high +
 * medium" buttons.
 *
 * Three constraints, all deliberate:
 *  1. `levels` must be REAL grades — an ungraded row is structurally excluded
 *     (`confidence` null never equals a level), which is the whole safety point.
 *  2. Only `candidate` rows: bulk approval is a review action, so it must not
 *     resurrect something already rejected or archived.
 *  3. Scoped to the CURRENT query, so the count in the confirm dialog matches
 *     what is on screen rather than a hidden global set.
 */
export function confidenceBulkTargets(
  rows: readonly LessonTableRow[],
  levels: readonly LessonConfidence[],
  q: LessonQuery,
): string[] {
  const wanted = new Set<LessonConfidence>(levels);
  return applyLessonQuery(rows, q)
    .filter((r) => r.status === "candidate" && r.confidence !== null && wanted.has(r.confidence))
    .map((r) => r.id);
}

/** Drop selections that are no longer visible, so a filter change can't leave
 *  invisible rows armed for a bulk action. */
export function pruneSelection(
  selected: ReadonlySet<string>,
  visible: readonly LessonTableRow[],
): Set<string> {
  const ids = new Set(visible.map((r) => r.id));
  return new Set([...selected].filter((id) => ids.has(id)));
}

/* ───────────────────────────── URL round-trip ─────────────────────────── */

const FACET_PARAM: Record<"confidence" | "scope" | "role" | "category" | "status", string> = {
  confidence: "conf",
  scope: "scope",
  role: "role",
  category: "cat",
  status: "status",
};

type ParamsLike = { get(name: string): string | null };

function readList(params: ParamsLike, name: string): string[] {
  const raw = params.get(name);
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

/**
 * Parse the query out of the URL. Every value is re-derived through the closed
 * vocabularies, so a hand-edited/stale URL degrades to a valid narrower view
 * instead of rendering an impossible filter — the same grounding discipline the
 * catalog readers use.
 *
 * Note `status`: an explicit `status=` (empty) means "all statuses", which is
 * distinguishable from an absent param (⇒ the `candidate` default).
 */
export function parseLessonQuery(params: ParamsLike): LessonQuery {
  const statusRaw = params.get(FACET_PARAM.status);
  const sortKeyRaw = params.get("sort");
  const dirRaw = params.get("dir");
  return {
    search: (params.get("q") ?? "").slice(0, 200),
    confidence: readList(params, FACET_PARAM.confidence).filter((v): v is ConfidenceFilterValue =>
      CONFIDENCE_FILTER_SET.has(v),
    ),
    scope: readList(params, FACET_PARAM.scope).filter((v): v is LessonScope => SCOPE_SET.has(v)),
    role: readList(params, FACET_PARAM.role),
    category: readList(params, FACET_PARAM.category),
    status:
      statusRaw === null
        ? DEFAULT_LESSON_QUERY.status
        : readList(params, FACET_PARAM.status).filter(isLearningStatus),
    sortKey: (SORT_KEYS as readonly string[]).includes(sortKeyRaw ?? "")
      ? (sortKeyRaw as SortKey)
      : DEFAULT_LESSON_QUERY.sortKey,
    sortDir: dirRaw === "asc" || dirRaw === "desc" ? dirRaw : DEFAULT_LESSON_QUERY.sortDir,
  };
}

/**
 * Serialize back to a query string, omitting anything at its default so a
 * pristine view has a clean URL. `view` is carried through because the view
 * toggle shares the same URL (a shared link lands on the same mode).
 */
export function serializeLessonQuery(q: LessonQuery, view?: "cards" | "table"): string {
  const out = new URLSearchParams();
  if (view === "table") out.set("view", "table");
  if (q.search.trim()) out.set("q", q.search.trim());
  if (q.confidence.length) out.set(FACET_PARAM.confidence, q.confidence.join(","));
  if (q.scope.length) out.set(FACET_PARAM.scope, q.scope.join(","));
  if (q.role.length) out.set(FACET_PARAM.role, q.role.join(","));
  if (q.category.length) out.set(FACET_PARAM.category, q.category.join(","));
  // Serialize status whenever it differs from the default — including the empty
  // "all statuses" case, which needs an explicit empty param to survive a reload.
  const statusDefault =
    q.status.length === DEFAULT_LESSON_QUERY.status.length &&
    q.status.every((s) => DEFAULT_LESSON_QUERY.status.includes(s));
  if (!statusDefault) out.set(FACET_PARAM.status, q.status.join(","));
  if (q.sortKey !== DEFAULT_LESSON_QUERY.sortKey) out.set("sort", q.sortKey);
  if (q.sortDir !== DEFAULT_LESSON_QUERY.sortDir) out.set("dir", q.sortDir);
  return out.toString();
}

/** Toggle one value in a facet array (the checkbox/chip interaction). */
export function toggleFacet<T extends string>(current: readonly T[], value: T): T[] {
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

/** Click-a-column-header sorting: same key flips direction, a new key starts
 *  ascending (and `created` starts newest-first, which is what people mean). */
export function nextSort(q: LessonQuery, key: SortKey): { sortKey: SortKey; sortDir: SortDir } {
  if (q.sortKey === key) return { sortKey: key, sortDir: q.sortDir === "asc" ? "desc" : "asc" };
  return { sortKey: key, sortDir: key === "created" ? "desc" : "asc" };
}

/** Facet options present in the loaded data, so the UI never offers a filter
 *  that would yield nothing. */
export function facetOptions(rows: readonly LessonTableRow[]): {
  roles: string[];
  categories: string[];
} {
  const roles = new Set<string>();
  const categories = new Set<string>();
  for (const r of rows) {
    if (r.roleSlug) roles.add(r.roleSlug);
    categories.add(r.category);
  }
  return {
    roles: [...roles].sort((a, b) => a.localeCompare(b)),
    categories: [...categories].sort((a, b) => a.localeCompare(b)),
  };
}
