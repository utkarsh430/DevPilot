// Guards for the reply-extraction half of the local-cc structured path.
//
// THE DEFECT THESE EXIST FOR (2026-08-04, live): the supervisor console asked
// "what ticket is it working on correctly?" and the operator was told
//
//   "The supervisor console answered, but the reply contained no readable
//    JSON — try again."
//
// The model HAD answered, and answered well - 1,453 characters, specific,
// grounded, honest about uncertainty. It was discarded because the extractor
// required the reply to be one clean object: it took `indexOf("{")` to
// `lastIndexOf("}")` as a single span, so ONE stray brace anywhere in the prose
// - a `{}` in a quoted command, a closing brace in a trailing sentence - made
// the whole span unparseable and the good answer went in the bin.
//
// Every case below is a reply that CONTAINS a usable object and that the old
// span-based extractor threw away. They are written as the shapes a narrative
// model actually produces, not as abstract fuzz.

import { describe, expect, it } from "vitest";
import {
  buildJsonContractSystemPrompt,
  buildJsonRetryPrompt,
  decideJsonRetry,
  extractJsonBlock,
  extractJsonCandidates,
  MIN_JSON_RETRY_BUDGET_MS,
} from "@/lib/llm/routing";

describe("extractJsonCandidates", () => {
  it("reads a bare object", () => {
    expect(extractJsonCandidates('{"answer":"hi"}')).toEqual([{ answer: "hi" }]);
  });

  it("reads a fenced object", () => {
    const text = 'Here you go:\n```json\n{"answer":"hi"}\n```\n';
    expect(extractJsonCandidates(text)).toContainEqual({ answer: "hi" });
  });

  it("reads an unlabelled fence", () => {
    expect(extractJsonCandidates('```\n{"answer":"hi"}\n```')).toContainEqual({ answer: "hi" });
  });

  // The old extractor took the FIRST fence only, so a reply that showed a
  // snippet before its answer lost the answer.
  it("reads past a first fence that is not JSON", () => {
    const text = [
      "Run this:",
      "```bash",
      "pnpm test",
      "```",
      "```json",
      '{"answer":"ok"}',
      "```",
    ].join("\n");
    expect(extractJsonCandidates(text)).toContainEqual({ answer: "ok" });
  });

  // ── The live shape. Prose first, with braces in it, then the object. ──────
  it("recovers the object from a prose-led reply whose prose contains braces", () => {
    const text = [
      "Captain, the honest answer is: none of them are confirmed working correctly right now.",
      "The payload it sent looked like {status: unknown} which is not a real record.",
      "",
      '{"answer":"DevPilot-1 is the only active ticket.","aboutTickets":["DevPilot-1"]}',
    ].join("\n");
    expect(extractJsonCandidates(text)).toContainEqual({
      answer: "DevPilot-1 is the only active ticket.",
      aboutTickets: ["DevPilot-1"],
    });
  });

  it("recovers the object when prose FOLLOWS it and closes a brace", () => {
    const text = [
      '{"answer":"done"}',
      "",
      "Let me know if you want the raw rows {they are long}.",
    ].join("\n");
    expect(extractJsonCandidates(text)).toContainEqual({ answer: "done" });
  });

  // A brace inside a JSON string must not end the scan. The fixture uses an
  // UNBALANCED brace on purpose: a naive depth counter survives `{ ok }` inside
  // a string because the pair cancels out, and a test written that way proves
  // nothing. A lone `}` inside a string closes the object one character early
  // for a counter that does not know it is in a string.
  it("does not end the object on an unbalanced brace inside a string", () => {
    const text = '{"answer":"close it with a } and move on","outOfScope":false}';
    expect(extractJsonCandidates(text)).toContainEqual({
      answer: "close it with a } and move on",
      outOfScope: false,
    });
  });

  it("does not end the object on an unbalanced OPENING brace inside a string", () => {
    const text = 'noise\n{"answer":"open it with a { like so","outOfScope":false}\n';
    expect(extractJsonCandidates(text)).toContainEqual({
      answer: "open it with a { like so",
      outOfScope: false,
    });
  });

  // An escaped quote must not be read as the end of the string, or everything
  // after it is scanned as structure.
  it("does not end the string on an escaped quote", () => {
    const text = '{"answer":"he said \\"stop } now\\" and left","outOfScope":false}';
    expect(extractJsonCandidates(text)).toContainEqual({
      answer: 'he said "stop } now" and left',
      outOfScope: false,
    });
  });

  it("returns candidates in document order so the outermost object wins", () => {
    const text = '{"answer":"outer","nested":{"answer":"inner"}}';
    const [first] = extractJsonCandidates(text);
    expect(first).toEqual({ answer: "outer", nested: { answer: "inner" } });
  });

  it("offers the inner object too, so a caller with a schema can pick it", () => {
    // A truncated outer wrapper is a real model failure; the inner object is
    // still the answer, and only the SCHEMA can tell which one is wanted.
    const text = '{"data": {"answer":"inner"}';
    expect(extractJsonCandidates(text)).toContainEqual({ answer: "inner" });
  });

  it("returns nothing for prose with no object at all", () => {
    expect(extractJsonCandidates("There is no JSON here, only a narrative.")).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(extractJsonCandidates("")).toEqual([]);
    expect(extractJsonCandidates("   \n ")).toEqual([]);
  });

  it("does not hang on a long run of unbalanced braces", () => {
    const text = "{".repeat(5000);
    const started = extractJsonCandidates(text);
    expect(started).toEqual([]);
  });

  it("de-duplicates identical candidates", () => {
    // The fence and the balanced scan both see the same object.
    const cands = extractJsonCandidates('```json\n{"answer":"hi"}\n```');
    expect(cands.filter((c) => JSON.stringify(c) === '{"answer":"hi"}')).toHaveLength(1);
  });
});

describe("extractJsonBlock", () => {
  it("still returns the first candidate", () => {
    expect(extractJsonBlock('prose {x} then {"answer":"hi"}')).toEqual({ answer: "hi" });
  });

  it("still returns null when there is nothing to read", () => {
    expect(extractJsonBlock("nothing here")).toBeNull();
  });
});

describe("buildJsonContractSystemPrompt", () => {
  const built = buildJsonContractSystemPrompt("You are a console.", '{"answer":"<markdown>"}');

  it("carries the caller's system prompt and schema hint", () => {
    expect(built).toContain("You are a console.");
    expect(built).toContain('{"answer":"<markdown>"}');
  });

  // The console's failure was a NARRATIVE answer. A contract that only says
  // "return JSON" is read by a model asked for an explanation as "explain, and
  // also return JSON"; it has to say where the narrative goes.
  it("tells the model its narrative belongs INSIDE a string field", () => {
    expect(built.toLowerCase()).toContain("inside");
    expect(built).toMatch(/narrative|prose|explanation/i);
  });

  it("forbids a prose preamble by name", () => {
    expect(built).toMatch(/preamble/i);
  });
});

describe("buildJsonRetryPrompt", () => {
  const retry = buildJsonRetryPrompt("Explain the board.", "Captain, the honest answer is: none.");

  it("keeps the original request", () => {
    expect(retry).toContain("Explain the board.");
  });

  it("says plainly that the last reply was not JSON", () => {
    expect(retry).toMatch(/was not JSON/i);
  });

  it("shows the model what it sent, bounded", () => {
    expect(retry).toContain("Captain, the honest answer is");
    const long = buildJsonRetryPrompt("q", "x".repeat(5000));
    expect(long.length).toBeLessThan(3000);
  });

  it("does not let the previous reply close the fence it is quoted in", () => {
    const retry2 = buildJsonRetryPrompt("q", "```json\n{}\n``` and then more");
    // Only the fences we opened and closed ourselves may appear.
    const fences = retry2.match(/```/g) ?? [];
    expect(fences.length % 2).toBe(0);
  });
});

describe("decideJsonRetry", () => {
  it("retries with what is LEFT of the budget, not a fresh one", () => {
    // THE PROPERTY. A retry that took a second full ceiling would silently
    // double every caller's timeout - the supervisor console's is 180s, and an
    // operator waiting six minutes for a diagnosis has been failed either way.
    expect(decideJsonRetry({ budgetMs: 180_000, elapsedMs: 40_000 })).toEqual({
      retry: true,
      timeoutMs: 140_000,
    });
  });

  it("skips the retry when too little is left to be worth spending", () => {
    expect(decideJsonRetry({ budgetMs: 180_000, elapsedMs: 179_000 })).toEqual({ retry: false });
    expect(decideJsonRetry({ budgetMs: 10_000, elapsedMs: 0 })).toEqual({ retry: false });
  });

  it("the floor is exactly the floor", () => {
    const budget = 100_000;
    expect(
      decideJsonRetry({ budgetMs: budget, elapsedMs: budget - MIN_JSON_RETRY_BUDGET_MS }).retry,
    ).toBe(true);
    expect(
      decideJsonRetry({ budgetMs: budget, elapsedMs: budget - MIN_JSON_RETRY_BUDGET_MS + 1 }).retry,
    ).toBe(false);
  });

  it("never returns a negative or non-finite timeout", () => {
    const cases: Array<[number, number]> = [
      [180_000, 200_000],
      [Number.NaN, 0],
      [180_000, Number.NaN],
    ];
    for (const [budgetMs, elapsedMs] of cases) {
      const d = decideJsonRetry({ budgetMs, elapsedMs });
      expect(d.retry, `${budgetMs}/${elapsedMs}`).toBe(false);
    }
  });
});
