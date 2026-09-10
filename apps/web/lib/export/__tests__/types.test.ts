// The export's pure data rules: trust attribution, thread ordering, cost rollup.

import { describe, expect, it } from "vitest";
import {
  SPEND_CAVEAT_SHORT,
  spendCaveat,
  classifyVerification,
  formatCents,
  formatDurationMs,
  formatTimestamp,
  mergeThread,
  rollupCost,
  trustForAuthorType,
  untrusted,
  untrustedOrNull,
  type ExportComment,
  type ExportHandoff,
} from "@/lib/export/types";
import { makeComment, makeHandoff, makeRun } from "@/lib/export/__tests__/fixtures";

describe("untrusted carrier", () => {
  it("brands the value with its author", () => {
    const u = untrusted("agent", "hello");
    expect(u.trust).toBe("agent");
    expect(u.value).toBe("hello");
    expect(u.__untrusted).toBe(true);
  });

  it("treats anything that is not explicitly human as machine-written", () => {
    // The default LEANS SAFE: an author_type added later is attributed as
    // `system` rather than silently inheriting a human's credibility.
    expect(trustForAuthorType("human")).toBe("human");
    expect(trustForAuthorType("user")).toBe("human");
    expect(trustForAuthorType("agent")).toBe("agent");
    expect(trustForAuthorType("system")).toBe("system");
    expect(trustForAuthorType("some_future_author_type")).toBe("system");
  });

  it("untrustedOrNull collapses empty and whitespace to null", () => {
    expect(untrustedOrNull("human", null)).toBeNull();
    expect(untrustedOrNull("human", undefined)).toBeNull();
    expect(untrustedOrNull("human", "   ")).toBeNull();
    expect(untrustedOrNull("human", "x")?.value).toBe("x");
  });
});

describe("mergeThread", () => {
  const at = (iso: string, over: Partial<ExportComment> = {}): ExportComment =>
    makeComment({ id: `c-${iso}`, createdAt: iso, ...over });
  const ho = (iso: string, over: Partial<ExportHandoff> = {}): ExportHandoff =>
    makeHandoff({ id: `h-${iso}`, createdAt: iso, ...over });

  it("interleaves comments and handoffs chronologically", () => {
    const merged = mergeThread(
      [at("2026-07-15T10:00:00Z"), at("2026-07-15T12:00:00Z")],
      [ho("2026-07-15T11:00:00Z")],
    );
    expect(merged.map((e) => e.createdAt)).toEqual([
      "2026-07-15T10:00:00Z",
      "2026-07-15T11:00:00Z",
      "2026-07-15T12:00:00Z",
    ]);
  });

  it("is deterministic when a comment and a handoff share a timestamp", () => {
    // An agent posts both at the end of a turn, so same-millisecond pairs are
    // routine. A re-export of an unchanged ticket must be byte-identical, or the
    // artifact is not a record — so the tiebreak is specified, not incidental.
    const iso = "2026-07-15T10:00:00Z";
    const a = mergeThread([at(iso)], [ho(iso)]);
    const b = mergeThread([at(iso)], [ho(iso)]);
    expect(a.map((e) => e.kind)).toEqual(b.map((e) => e.kind));
    expect(a[0]?.kind).toBe("comment");
    expect(a[1]?.kind).toBe("handoff");
  });

  it("sorts an unparseable timestamp last instead of poisoning the comparator", () => {
    const merged = mergeThread([at("not-a-date"), at("2026-07-15T10:00:00Z")], []);
    expect(merged[0]?.createdAt).toBe("2026-07-15T10:00:00Z");
    expect(merged[1]?.createdAt).toBe("not-a-date");
  });

  it("returns an empty thread for no input", () => {
    expect(mergeThread([], [])).toEqual([]);
  });
});

describe("rollupCost", () => {
  it("takes cents from the run ledger, not from summed step costs", () => {
    // `runs.spent_cents` is the ledger `recordSpend` writes and the budget gate
    // reads. Re-deriving it from per-step `cost_cents` would disagree the moment
    // a step is written outside the think loop — so the fixture's per-turn cents
    // (100 + 0) deliberately do NOT equal its run's spent_cents (137).
    const run = makeRun();
    const rolled = rollupCost([run]);
    expect(rolled.totalCents).toBe(137);
    expect(rolled.runCount).toBe(1);
  });

  it("sums tokens from the step payloads", () => {
    const rolled = rollupCost([makeRun()]);
    expect(rolled.promptTokens).toBe(1200 + 800);
    expect(rolled.completionTokens).toBe(300 + 120);
    expect(rolled.totalTokens).toBe(1500 + 920);
  });

  it("falls back to prompt+completion when a runner omits totalTokens", () => {
    const run = makeRun();
    const first = run.turns[0];
    if (!first) throw new Error("fixture must have a turn");
    run.turns = [{ ...first, usage: { promptTokens: 10, completionTokens: 5, totalTokens: null } }];
    expect(rollupCost([run]).totalTokens).toBe(15);
  });

  it("marks the whole rollup unpriced when ANY turn is unpriced", () => {
    // A partially-priced total is not a number an auditor can act on, and a
    // self-hosted endpoint costing "$0.00" is a lie of omission. One unpriced
    // turn makes the total unpriced — the conservative direction.
    const rolled = rollupCost([makeRun()]);
    expect(rolled.costPriced).toBe(false);
    expect(rolled.unpricedTurns).toBe(1);
  });

  it("is priced when every turn is priced", () => {
    const run = makeRun();
    run.turns = run.turns.map((t) => ({ ...t, costPriced: true }));
    const rolled = rollupCost([run]);
    expect(rolled.costPriced).toBe(true);
    expect(rolled.unpricedTurns).toBe(0);
  });

  it("handles a ticket with no runs", () => {
    const rolled = rollupCost([]);
    expect(rolled).toMatchObject({
      totalCents: 0,
      totalTokens: 0,
      runCount: 0,
      costPriced: true,
      unpricedTurns: 0,
    });
  });

  it("sums across multiple runs", () => {
    const rolled = rollupCost([makeRun(), makeRun({ id: "r2", spentCents: 63 })]);
    expect(rolled.totalCents).toBe(200);
    expect(rolled.runCount).toBe(2);
  });
});

describe("spendCaveat", () => {
  it("says nothing when every turn was priced", () => {
    expect(spendCaveat({ costPriced: true, unpricedTurns: 0 })).toBeNull();
  });

  it("says the total is a LOWER BOUND when any turn was unpriced", () => {
    // The claim that matters: a self-hosted project reports `spent_cents = 0`,
    // and a bare "$0.00" on the headline tile reads as free. This is the text
    // that stops it, so it is asserted rather than left to a component.
    const caveat = spendCaveat({ costPriced: false, unpricedTurns: 12 });
    expect(caveat).toContain("12 model turns");
    expect(caveat).toContain("LOWER BOUND");
    expect(caveat).toContain("not zero");
  });

  it("is grammatical for a single turn", () => {
    expect(spendCaveat({ costPriced: false, unpricedTurns: 1 })).toContain("1 model turn ran");
  });

  it("is the SAME text for both scopes", () => {
    // Ticket scope and project scope render through this one function, so they
    // cannot come to describe the same situation differently.
    const rollup = { costPriced: false, unpricedTurns: 3 };
    expect(spendCaveat(rollup)).toBe(spendCaveat({ ...rollup }));
    expect(SPEND_CAVEAT_SHORT).toBe("partially unpriced");
  });
});

describe("classifyVerification", () => {
  it("treats ONLY exit 0 as a pass", () => {
    expect(classifyVerification(0)).toBe("passed");
  });

  it("treats a positive exit code as a failure", () => {
    expect(classifyVerification(1)).toBe("failed");
    expect(classifyVerification(127)).toBe("failed");
  });

  it("treats a NEGATIVE exit code as indeterminate, never a pass", () => {
    // This is the bug this classifier exists for: a `> 0` test alone folds every
    // negative code into "passed", so a killed / timed-out / unspawnable check
    // (producers write `code ?? -1`) printed a GREEN "verification passed · exit
    // -1" badge — laundering a check that never ran onto a signed-off record.
    // The live gate agrees: `decideQaGate` returns `verification-indeterminate`
    // for `exitCode < 0` and calls exit 0 "the only true pass".
    expect(classifyVerification(-1)).toBe("indeterminate");
    expect(classifyVerification(-9)).toBe("indeterminate");
    expect(classifyVerification(-137)).toBe("indeterminate");
  });

  it("treats a non-finite code as indeterminate rather than letting NaN read as a pass", () => {
    // `NaN > 0` is false and `NaN < 0` is false, so a naive comparison chain
    // silently classifies NaN as a pass.
    expect(classifyVerification(Number.NaN)).toBe("indeterminate");
    expect(classifyVerification(Number.POSITIVE_INFINITY)).toBe("indeterminate");
  });

  it("never returns 'passed' for anything but exactly 0", () => {
    for (const code of [-3, -2, -1, 1, 2, 3, 255, Number.NaN]) {
      expect(classifyVerification(code), `exit ${code}`).not.toBe("passed");
    }
  });
});

describe("formatters", () => {
  it("formats cents as dollars", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(137)).toBe("$1.37");
    expect(formatCents(4211)).toBe("$42.11");
    expect(formatCents(Number.NaN)).toBe("$0.00");
  });

  it("formats durations", () => {
    expect(formatDurationMs(0)).toBe("—");
    expect(formatDurationMs(5000)).toBe("5s");
    expect(formatDurationMs(90_000)).toBe("1m 30s");
    expect(formatDurationMs(7_200_000)).toBe("2h 0m");
  });

  it("formats timestamps in UTC — an audit needs one clock", () => {
    expect(formatTimestamp("2026-07-15T10:12:00.000Z")).toBe("2026-07-15 10:12 UTC");
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp("garbage")).toBe("—");
  });
});
