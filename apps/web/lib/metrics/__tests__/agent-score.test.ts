// The captain's locked scoring rules, asserted concretely.
//
// Every `it` here maps to one decision in the plan's "Scoring design" section.
// If a future tune changes α/β or MIN_RANKED_RUNS, these are the properties that
// must survive the change — the exact numbers may move, the ORDERING may not.

import { describe, expect, it } from "vitest";
import {
  MIN_RANKED_RUNS,
  buildRoleScoreRows,
  groupIntoCategoryLeaderboards,
  isRanked,
  rawSuccessRate,
  smoothedScore,
  type MistakeFact,
  type RunFact,
} from "@/lib/metrics/agent-score";

const runsFor = (role: string, n: number, prefix = role): RunFact[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-run-${i}`,
    role,
    ticketId: `${prefix}-ticket-${i}`,
  }));

const mistake = (over: Partial<MistakeFact> & Pick<MistakeFact, "role" | "type">): MistakeFact => ({
  countsAgainstScore: over.type !== "human_correction",
  runId: null,
  ticketId: null,
  ...over,
});

const build = (runs: RunFact[], mistakes: MistakeFact[]) =>
  buildRoleScoreRows({
    runs,
    mistakes,
    displayNameFor: (r) => r,
    categoryFor: () => null,
  });

describe("smoothedScore — the confidence adjustment", () => {
  it("ranks a 2-run 100% agent BELOW a 100-run 95% agent", () => {
    const lucky = smoothedScore(2, 2);
    const proven = smoothedScore(95, 100);
    expect(lucky).toBeLessThan(proven);
  });

  it("still ranks the 100-run agent above a 5-run perfect one, but only just", () => {
    // ~5 clean runs should APPROACH the top without eclipsing real volume.
    const five = smoothedScore(5, 5);
    const proven = smoothedScore(95, 100);
    expect(five).toBeLessThan(proven);
    expect(proven - five).toBeLessThan(0.1);
    expect(five).toBeGreaterThan(0.85);
  });

  it("never lets a zero-work agent reach the top of the band", () => {
    expect(smoothedScore(0, 0)).toBeLessThan(smoothedScore(5, 5));
    expect(smoothedScore(0, 0)).toBeLessThan(smoothedScore(95, 100));
  });

  it("keeps rewarding volume: 20/20 outranks 100/100 at 95%", () => {
    expect(smoothedScore(20, 20)).toBeGreaterThan(smoothedScore(95, 100));
  });

  it("is monotone in clean runs at fixed volume", () => {
    expect(smoothedScore(10, 20)).toBeLessThan(smoothedScore(15, 20));
  });
});

describe("minimum volume", () => {
  it(`ranks at ${MIN_RANKED_RUNS} runs and not below`, () => {
    expect(isRanked(MIN_RANKED_RUNS - 1)).toBe(false);
    expect(isRanked(MIN_RANKED_RUNS)).toBe(true);
  });

  it("excludes a perfect low-volume agent from the ranked list", () => {
    const rows = build(
      [...runsFor("engineer", 20), ...runsFor("qa", 2)],
      [mistake({ role: "engineer", type: "run_failed", runId: "engineer-run-0" })],
    );
    const qa = rows.find((r) => r.role === "qa")!;
    const engineer = rows.find((r) => r.role === "engineer")!;

    // The 2-run agent is perfect on raw rate…
    expect(qa.rawSuccessRate).toBe(1);
    // …and still is neither ranked nor ahead of the proven one.
    expect(qa.ranked).toBe(false);
    expect(engineer.ranked).toBe(true);
    expect(qa.score).toBeLessThan(engineer.score);
    expect(rows.filter((r) => r.ranked).map((r) => r.role)).toEqual(["engineer"]);
  });

  it("gives a zero-run agent a row but never the #1 ranked slot", () => {
    // A role that only ever appears on a mistake (its run rows are gone).
    const rows = build(runsFor("engineer", 10), [mistake({ role: "ghost", type: "qa_reject" })]);
    const ghost = rows.find((r) => r.role === "ghost")!;
    expect(ghost.totalRuns).toBe(0);
    expect(ghost.ranked).toBe(false);
    expect(rows.filter((r) => r.ranked)[0]?.role).toBe("engineer");
  });
});

describe("which mistakes count", () => {
  const scoringTypes = ["qa_reject", "run_failed", "verification_fail", "gate_refusal"] as const;

  for (const type of scoringTypes) {
    it(`a ${type} lowers the score`, () => {
      const clean = build(runsFor("engineer", 10), [])[0]!;
      const dirty = build(runsFor("engineer", 10), [
        mistake({ role: "engineer", type, runId: "engineer-run-3" }),
      ])[0]!;
      expect(dirty.score).toBeLessThan(clean.score);
      expect(dirty.cleanRuns).toBe(9);
      expect(dirty.scoringMistakeCount).toBe(1);
    });
  }

  it("a human_correction does NOT lower the score, but is still shown", () => {
    const clean = build(runsFor("engineer", 10), [])[0]!;
    const redirected = build(runsFor("engineer", 10), [
      mistake({
        role: "engineer",
        type: "human_correction",
        countsAgainstScore: false,
        runId: "engineer-run-3",
      }),
    ])[0]!;

    expect(redirected.score).toBe(clean.score);
    expect(redirected.cleanRuns).toBe(10);
    expect(redirected.scoringMistakeCount).toBe(0);
    // Visible as context — the count is surfaced, it just never moves the score.
    expect(redirected.mistakeCount).toBe(1);
    expect(redirected.mistakesByType.human_correction).toBe(1);
  });

  it("honours counts_against_score over the type name", () => {
    // The DB column is the gate, not a hard-coded type list here.
    const rows = build(runsFor("engineer", 10), [
      mistake({
        role: "engineer",
        type: "qa_reject",
        countsAgainstScore: false,
        runId: "engineer-run-1",
      }),
    ]);
    expect(rows[0]!.cleanRuns).toBe(10);
    expect(rows[0]!.scoringMistakeCount).toBe(0);
  });

  it("counts a run faulted once even with several mistakes on it", () => {
    const row = build(runsFor("engineer", 10), [
      mistake({ role: "engineer", type: "qa_reject", runId: "engineer-run-2" }),
      mistake({ role: "engineer", type: "verification_fail", runId: "engineer-run-2" }),
    ])[0]!;
    expect(row.faultedRuns).toBe(1);
    expect(row.cleanRuns).toBe(9);
    expect(row.scoringMistakeCount).toBe(2);
  });

  it("a mistake with no run_id is counted but faults no run", () => {
    // Comment-derived signals carry no run FK. Guessing a run would invent a
    // failure, so they are visible in the counts and absent from the score.
    const row = build(runsFor("engineer", 10), [
      mistake({ role: "engineer", type: "gate_refusal", runId: null }),
    ])[0]!;
    expect(row.mistakeCount).toBe(1);
    expect(row.scoringMistakeCount).toBe(1);
    expect(row.faultedRuns).toBe(0);
    expect(row.cleanRuns).toBe(10);
  });

  it("a mistake naming a run outside the window cannot drive clean runs negative", () => {
    const row = build(runsFor("engineer", 2), [
      mistake({ role: "engineer", type: "run_failed", runId: "not-in-window-1" }),
      mistake({ role: "engineer", type: "run_failed", runId: "not-in-window-2" }),
      mistake({ role: "engineer", type: "run_failed", runId: "not-in-window-3" }),
    ])[0]!;
    expect(row.cleanRuns).toBe(2);
    expect(row.cleanRuns).toBeGreaterThanOrEqual(0);
  });
});

describe("per-role bucketing", () => {
  it("keeps roles separate — a QA mistake never touches the engineer's score", () => {
    const rows = build(
      [...runsFor("engineer", 10), ...runsFor("qa", 10)],
      [
        mistake({ role: "qa", type: "run_failed", runId: "qa-run-0" }),
        mistake({ role: "qa", type: "run_failed", runId: "qa-run-1" }),
      ],
    );
    const engineer = rows.find((r) => r.role === "engineer")!;
    const qa = rows.find((r) => r.role === "qa")!;

    expect(engineer.cleanRuns).toBe(10);
    expect(engineer.mistakeCount).toBe(0);
    expect(qa.cleanRuns).toBe(8);
    expect(qa.mistakeCount).toBe(2);
    expect(engineer.score).toBeGreaterThan(qa.score);
  });

  it("counts distinct tickets touched per role", () => {
    const rows = build(runsFor("engineer", 3), []);
    expect(rows[0]!.ticketsTouched).toBe(3);
  });

  it("rawSuccessRate is the honest unsmoothed number", () => {
    expect(rawSuccessRate(9, 10)).toBeCloseTo(0.9);
    expect(rawSuccessRate(0, 0)).toBe(0);
  });
});

describe("groupIntoCategoryLeaderboards", () => {
  const rows = buildRoleScoreRows({
    runs: [...runsFor("engineer", 10), ...runsFor("qa", 10), ...runsFor("weirdo", 10)],
    mistakes: [mistake({ role: "engineer", type: "run_failed", runId: "engineer-run-0" })],
    displayNameFor: (r) => r,
    categoryFor: (r) =>
      r === "engineer" ? "Engineering" : r === "qa" ? "Quality + Security" : null,
  });

  it("puts comparable peers on their own board with their own top agent", () => {
    const boards = groupIntoCategoryLeaderboards(rows, ["Engineering", "Quality + Security"]);
    const eng = boards.find((b) => b.category === "Engineering")!;
    const qa = boards.find((b) => b.category === "Quality + Security")!;
    expect(eng.top?.role).toBe("engineer");
    expect(qa.top?.role).toBe("qa");
    // QA is never ranked against Engineering.
    expect(eng.rows.map((r) => r.role)).toEqual(["engineer"]);
  });

  it("buckets catalog-less custom roles separately and sorts them last", () => {
    const boards = groupIntoCategoryLeaderboards(rows, ["Engineering", "Quality + Security"]);
    expect(boards.at(-1)!.category).toBe("Custom agents");
    expect(boards.at(-1)!.top?.role).toBe("weirdo");
  });

  it("separates a category's unranked members from its ranked field", () => {
    const mixed = buildRoleScoreRows({
      runs: [...runsFor("engineer", 10), ...runsFor("intern", 2)],
      mistakes: [],
      displayNameFor: (r) => r,
      categoryFor: () => "Engineering",
    });
    const board = groupIntoCategoryLeaderboards(mixed, ["Engineering"])[0]!;
    expect(board.rows.map((r) => r.role)).toEqual(["engineer"]);
    expect(board.unranked.map((r) => r.role)).toEqual(["intern"]);
    expect(board.top?.role).toBe("engineer");
  });
});
