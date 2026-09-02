// Pure filter / sort / search / bulk-selection rules for the lessons table view.
//
// The load-bearing assertions here are the two safety properties:
//   1. A confidence FILTER never returns an ungraded (confidence null) row.
//   2. A confidence-driven BULK APPROVAL never targets one either — a null
//      confidence means "the grader hasn't looked at this yet", and sweeping it
//      into an approval would activate an ungraded lesson into every future run.
// Everything else (URL round-trip, sort stability, select-all-matching) is
// behaviour the operator can see and correct; those two are silent if wrong.

import { describe, expect, it } from "vitest";
import {
  applyLessonQuery,
  confidenceBulkTargets,
  DEFAULT_LESSON_QUERY,
  facetOptions,
  type LessonQuery,
  type LessonTableRow,
  matchesLessonQuery,
  nextSort,
  parseLessonQuery,
  pruneSelection,
  selectAllMatchingIds,
  serializeLessonQuery,
  sortLessonRows,
  toggleFacet,
  toLessonConfidence,
} from "@/lib/learning/table-view";

function row(over: Partial<LessonTableRow> & { id: string }): LessonTableRow {
  return {
    scope: "global",
    roleSlug: null,
    category: "testing",
    body: "Run the test suite before handing off to QA.",
    status: "candidate",
    createdAt: "2026-07-01T00:00:00.000Z",
    confidence: null,
    confidenceReason: null,
    mistake: null,
    ...over,
  };
}

/** A representative mixed set: graded and ungraded, several scopes/statuses. */
const ROWS: LessonTableRow[] = [
  row({ id: "a1", confidence: "high", category: "testing", createdAt: "2026-07-01T00:00:00Z" }),
  row({
    id: "b2",
    confidence: "medium",
    scope: "role",
    roleSlug: "engineer",
    category: "build",
    body: "Prefer pnpm over npm in this workspace.",
    createdAt: "2026-07-02T00:00:00Z",
  }),
  row({
    id: "c3",
    confidence: "low",
    scope: "user",
    category: "preference",
    body: "Always deploy to Vercel.",
    createdAt: "2026-07-03T00:00:00Z",
  }),
  // UNGRADED — the confidence grader hasn't reached it. The row that must never be
  // swept up by anything confidence-named.
  row({ id: "d4", confidence: null, category: "scope", createdAt: "2026-07-04T00:00:00Z" }),
  row({ id: "e5", confidence: "high", status: "active", createdAt: "2026-07-05T00:00:00Z" }),
  row({ id: "f6", confidence: "high", status: "rejected", createdAt: "2026-07-06T00:00:00Z" }),
];

const ALL_STATUSES: LessonQuery = { ...DEFAULT_LESSON_QUERY, status: [] };

describe("toLessonConfidence — grounding", () => {
  it("accepts the three real grades", () => {
    expect(toLessonConfidence("high")).toBe("high");
    expect(toLessonConfidence("medium")).toBe("medium");
    expect(toLessonConfidence("low")).toBe("low");
  });

  it("fails toward ungraded for null/unknown, never toward high", () => {
    for (const bad of [null, undefined, "", "HIGH", "very_high", 1, {}]) {
      expect(toLessonConfidence(bad)).toBeNull();
    }
  });
});

describe("confidence filtering — the ungraded guard", () => {
  it("a grade-named filter NEVER returns an ungraded row", () => {
    for (const level of ["high", "medium", "low"] as const) {
      const q: LessonQuery = { ...ALL_STATUSES, confidence: [level] };
      const got = applyLessonQuery(ROWS, q);
      expect(got.length).toBeGreaterThan(0);
      expect(got.every((r) => r.confidence === level)).toBe(true);
      expect(got.some((r) => r.confidence === null)).toBe(false);
      expect(got.map((r) => r.id)).not.toContain("d4");
    }
  });

  it("selecting several grades still excludes ungraded", () => {
    const got = applyLessonQuery(ROWS, { ...ALL_STATUSES, confidence: ["high", "medium", "low"] });
    expect(got.map((r) => r.id).sort()).toEqual(["a1", "b2", "c3", "e5", "f6"]);
  });

  it("the explicit `ungraded` bucket is the ONLY way to see null rows", () => {
    const got = applyLessonQuery(ROWS, { ...ALL_STATUSES, confidence: ["ungraded"] });
    expect(got.map((r) => r.id)).toEqual(["d4"]);
  });

  it("no confidence filter shows graded and ungraded alike", () => {
    expect(applyLessonQuery(ROWS, ALL_STATUSES)).toHaveLength(ROWS.length);
  });
});

describe("facet filtering", () => {
  it("defaults to candidates only", () => {
    const got = applyLessonQuery(ROWS, DEFAULT_LESSON_QUERY);
    expect(got.map((r) => r.id).sort()).toEqual(["a1", "b2", "c3", "d4"]);
  });

  it("filters by scope, role and category", () => {
    expect(applyLessonQuery(ROWS, { ...ALL_STATUSES, scope: ["role"] }).map((r) => r.id)).toEqual([
      "b2",
    ]);
    expect(
      applyLessonQuery(ROWS, { ...ALL_STATUSES, role: ["engineer"] }).map((r) => r.id),
    ).toEqual(["b2"]);
    expect(
      applyLessonQuery(ROWS, { ...ALL_STATUSES, category: ["preference"] }).map((r) => r.id),
    ).toEqual(["c3"]);
  });

  it("an empty facet array means no constraint on that facet", () => {
    expect(matchesLessonQuery(ROWS[0]!, ALL_STATUSES)).toBe(true);
  });

  it("stacks facets with AND", () => {
    const got = applyLessonQuery(ROWS, {
      ...ALL_STATUSES,
      confidence: ["high"],
      status: ["candidate"],
    });
    expect(got.map((r) => r.id)).toEqual(["a1"]);
  });
});

describe("search", () => {
  it("matches the body case-insensitively", () => {
    expect(applyLessonQuery(ROWS, { ...ALL_STATUSES, search: "VERCEL" }).map((r) => r.id)).toEqual([
      "c3",
    ]);
  });

  it("ANDs whitespace-separated terms", () => {
    expect(
      applyLessonQuery(ROWS, { ...ALL_STATUSES, search: "pnpm npm" }).map((r) => r.id),
    ).toEqual(["b2"]);
    expect(applyLessonQuery(ROWS, { ...ALL_STATUSES, search: "pnpm vercel" })).toHaveLength(0);
  });

  it("searches the confidence reason and the mistake type too", () => {
    const rows = [
      row({ id: "x", confidence: "low", confidenceReason: "sweeping and vague" }),
      row({
        id: "y",
        mistake: {
          id: "m",
          type: "qa_reject",
          role: "engineer",
          runId: null,
          ticketId: null,
          ticketKey: null,
          evidenceSummary: "",
        },
      }),
    ];
    expect(
      applyLessonQuery(rows, { ...ALL_STATUSES, search: "sweeping" }).map((r) => r.id),
    ).toEqual(["x"]);
    expect(
      applyLessonQuery(rows, { ...ALL_STATUSES, search: "qa_reject" }).map((r) => r.id),
    ).toEqual(["y"]);
  });

  it("blank / whitespace search is a no-op", () => {
    expect(applyLessonQuery(ROWS, { ...ALL_STATUSES, search: "   " })).toHaveLength(ROWS.length);
  });
});

describe("sorting", () => {
  it("orders confidence high → medium → low → ungraded ascending", () => {
    const got = sortLessonRows(ROWS, "confidence", "asc").map((r) => r.confidence);
    expect(got).toEqual(["high", "high", "high", "medium", "low", null]);
  });

  it("descending reverses it, putting ungraded first", () => {
    expect(sortLessonRows(ROWS, "confidence", "desc")[0]!.confidence).toBeNull();
  });

  it("sorts by created date", () => {
    expect(sortLessonRows(ROWS, "created", "desc")[0]!.id).toBe("f6");
    expect(sortLessonRows(ROWS, "created", "asc")[0]!.id).toBe("a1");
  });

  it("is stable: equal rows break ties on id, so a re-sort never shuffles", () => {
    const ties = [row({ id: "z" }), row({ id: "m" }), row({ id: "a" })];
    expect(sortLessonRows(ties, "confidence", "asc").map((r) => r.id)).toEqual(["a", "m", "z"]);
    expect(sortLessonRows(ties, "confidence", "desc").map((r) => r.id)).toEqual(["a", "m", "z"]);
  });

  it("nextSort flips direction on the same key and restarts on a new one", () => {
    const q = { ...DEFAULT_LESSON_QUERY, sortKey: "body" as const, sortDir: "asc" as const };
    expect(nextSort(q, "body")).toEqual({ sortKey: "body", sortDir: "desc" });
    expect(nextSort(q, "category")).toEqual({ sortKey: "category", sortDir: "asc" });
    // `created` is the one key people mean newest-first by default.
    expect(nextSort(q, "created")).toEqual({ sortKey: "created", sortDir: "desc" });
  });
});

describe("bulk selection", () => {
  it("select-all-matching selects EXACTLY the filtered set, no more", () => {
    const q: LessonQuery = { ...ALL_STATUSES, confidence: ["high"] };
    const visible = applyLessonQuery(ROWS, q);
    const ids = selectAllMatchingIds(ROWS, q);
    expect(ids).toEqual(visible.map((r) => r.id));
    expect(ids.sort()).toEqual(["a1", "e5", "f6"]);
    // Nothing outside the filter leaked in.
    expect(ids).not.toContain("d4");
    expect(ids).not.toContain("b2");
  });

  it("select-all-matching under the default filter is the candidate set", () => {
    expect(selectAllMatchingIds(ROWS, DEFAULT_LESSON_QUERY).sort()).toEqual([
      "a1",
      "b2",
      "c3",
      "d4",
    ]);
  });

  it("pruneSelection drops ids that are no longer visible", () => {
    const visible = applyLessonQuery(ROWS, { ...ALL_STATUSES, confidence: ["high"] });
    expect([...pruneSelection(new Set(["a1", "d4", "nope"]), visible)]).toEqual(["a1"]);
  });
});

describe("confidenceBulkTargets — the headline Accept-all buttons", () => {
  it("targets high-confidence candidates only", () => {
    expect(confidenceBulkTargets(ROWS, ["high"], DEFAULT_LESSON_QUERY)).toEqual(["a1"]);
  });

  it("high + medium widens to both grades", () => {
    expect(confidenceBulkTargets(ROWS, ["high", "medium"], DEFAULT_LESSON_QUERY).sort()).toEqual([
      "a1",
      "b2",
    ]);
  });

  it("NEVER targets an ungraded row, under any level combination", () => {
    for (const levels of [
      ["high"],
      ["medium"],
      ["low"],
      ["high", "medium"],
      ["high", "medium", "low"],
    ] as const) {
      const ids = confidenceBulkTargets(ROWS, levels, ALL_STATUSES);
      expect(ids).not.toContain("d4");
    }
  });

  it("an all-ungraded board yields ZERO targets (never a silent sweep)", () => {
    const ungraded = [row({ id: "u1" }), row({ id: "u2" }), row({ id: "u3" })];
    expect(confidenceBulkTargets(ungraded, ["high", "medium"], DEFAULT_LESSON_QUERY)).toEqual([]);
  });

  it("never resurrects an already-settled row (active / rejected / archived)", () => {
    // e5 and f6 are high-confidence but already active/rejected.
    expect(confidenceBulkTargets(ROWS, ["high"], ALL_STATUSES)).toEqual(["a1"]);
  });

  it("is scoped to the current query, so the dialog count matches the screen", () => {
    const q: LessonQuery = { ...DEFAULT_LESSON_QUERY, category: ["build"] };
    expect(confidenceBulkTargets(ROWS, ["high", "medium"], q)).toEqual(["b2"]);
  });
});

describe("URL round-trip", () => {
  function parse(qs: string) {
    return parseLessonQuery(new URLSearchParams(qs));
  }

  it("a pristine query serializes to an empty string", () => {
    expect(serializeLessonQuery(DEFAULT_LESSON_QUERY)).toBe("");
  });

  it("round-trips a narrowed query", () => {
    const q: LessonQuery = {
      search: "vercel deploy",
      confidence: ["high", "ungraded"],
      scope: ["role"],
      role: ["engineer"],
      category: ["build"],
      status: ["active", "candidate"],
      sortKey: "created",
      sortDir: "desc",
    };
    expect(parse(serializeLessonQuery(q))).toEqual(q);
  });

  it("survives the empty 'all statuses' case (distinct from an absent param)", () => {
    const q: LessonQuery = { ...DEFAULT_LESSON_QUERY, status: [] };
    expect(parse(serializeLessonQuery(q)).status).toEqual([]);
    expect(parse("").status).toEqual(["candidate"]);
  });

  it("carries the view mode so a shared link lands in the same view", () => {
    expect(serializeLessonQuery(DEFAULT_LESSON_QUERY, "table")).toBe("view=table");
    expect(serializeLessonQuery(DEFAULT_LESSON_QUERY, "cards")).toBe("");
  });

  it("grounds hostile / stale URL values instead of rendering an impossible filter", () => {
    const q = parse(
      "conf=high,VERY_HIGH,ungraded&scope=role,root&status=candidate,nuked&sort=hack&dir=sideways",
    );
    expect(q.confidence).toEqual(["high", "ungraded"]);
    expect(q.scope).toEqual(["role"]);
    expect(q.status).toEqual(["candidate"]);
    expect(q.sortKey).toBe(DEFAULT_LESSON_QUERY.sortKey);
    expect(q.sortDir).toBe(DEFAULT_LESSON_QUERY.sortDir);
  });

  it("dedupes repeated facet values and bounds the search string", () => {
    expect(parse("conf=high,high,high").confidence).toEqual(["high"]);
    expect(parse(`q=${"x".repeat(500)}`).search).toHaveLength(200);
  });
});

describe("facetOptions / toggleFacet", () => {
  it("offers only roles and categories present in the data", () => {
    expect(facetOptions(ROWS)).toEqual({
      roles: ["engineer"],
      categories: ["build", "preference", "scope", "testing"],
    });
  });

  it("toggleFacet adds then removes", () => {
    expect(toggleFacet<string>([], "high")).toEqual(["high"]);
    expect(toggleFacet(["high", "low"], "high")).toEqual(["low"]);
  });
});
