// The 29.9 GB log, as a test.
//
// The headline case is the measured one: 4,992,566 copies of
// `could not check constraints to lease item`. It must collapse to a single
// line plus a count, and the count must survive — "this happened five million
// times" is the fact that diagnoses a wedged dev server, so a collapse that
// discarded it would trade one defect for another.

import { describe, expect, it } from "vitest";
import {
  INNGEST_LOG_MAX_BYTES_DEFAULT,
  RepeatCollapser,
  normalizeLogLine,
  renderRepeat,
  resolveLogMaxBytes,
  shouldRotate,
} from "@/lib/dev/inngest-log";

describe("rotation — the actual disk ceiling", () => {
  it("rotates at the cap", () => {
    expect(shouldRotate(INNGEST_LOG_MAX_BYTES_DEFAULT, INNGEST_LOG_MAX_BYTES_DEFAULT)).toBe(true);
    expect(shouldRotate(INNGEST_LOG_MAX_BYTES_DEFAULT + 1, INNGEST_LOG_MAX_BYTES_DEFAULT)).toBe(
      true,
    );
  });

  it("does not rotate below the cap", () => {
    expect(shouldRotate(0, INNGEST_LOG_MAX_BYTES_DEFAULT)).toBe(false);
    expect(shouldRotate(1024, INNGEST_LOG_MAX_BYTES_DEFAULT)).toBe(false);
  });

  it("the 29.9 GB file would have rotated", () => {
    expect(shouldRotate(29.9 * 1024 ** 3, INNGEST_LOG_MAX_BYTES_DEFAULT)).toBe(true);
  });

  it("a bad env value falls back to the default, NEVER to unbounded", () => {
    for (const raw of [undefined, "", "abc", "0", "-1", "NaN"]) {
      expect(resolveLogMaxBytes(raw)).toBe(INNGEST_LOG_MAX_BYTES_DEFAULT);
    }
    expect(resolveLogMaxBytes("1048576")).toBe(1024 * 1024);
  });
});

describe("repeat collapsing — the readability half", () => {
  const LEASE_ERROR = "12:00:01 ERROR could not check constraints to lease item queue=default";

  function run(lines: string[]): string[] {
    const c = new RepeatCollapser();
    const out: string[] = [];
    for (const l of lines) {
      for (const e of c.push(l)) {
        out.push(e.kind === "line" ? e.text : renderRepeat(e.count));
      }
    }
    for (const e of c.flush()) {
      out.push(e.kind === "line" ? e.text : renderRepeat(e.count));
    }
    return out;
  }

  it("collapses the measured flood to one line plus a count", () => {
    // Same message, different timestamps — exactly how the real flood looked.
    const flood = Array.from({ length: 5000 }, (_, i) => {
      const s = String(i % 60).padStart(2, "0");
      return `12:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${s} ERROR could not check constraints to lease item queue=default`;
    });
    const out = run(flood);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("could not check constraints to lease item");
    expect(out[1]).toContain("repeated 4,999 more times");
  });

  it("ALWAYS emits the first occurrence verbatim — nothing is ever hidden", () => {
    const out = run([LEASE_ERROR, LEASE_ERROR, LEASE_ERROR]);
    expect(out[0]).toBe(LEASE_ERROR);
  });

  it("preserves the count, which is the diagnosis", () => {
    const out = run(Array(1_000_000).fill(LEASE_ERROR));
    expect(out[1]).toContain("999,999");
  });

  it("leaves a healthy log of DISTINCT lines completely untouched", () => {
    const lines = [
      "12:00:01 INFO function registered id=ticket-dispatcher",
      "12:00:02 INFO function registered id=run-agent",
      "12:00:03 INFO executor started workers=100",
    ];
    expect(run(lines)).toEqual(lines);
  });

  it("only collapses CONSECUTIVE duplicates", () => {
    const out = run([LEASE_ERROR, LEASE_ERROR, "12:00:05 INFO recovered", LEASE_ERROR]);
    expect(out).toEqual([LEASE_ERROR, renderRepeat(1), "12:00:05 INFO recovered", LEASE_ERROR]);
  });

  it("flushes a run still in progress at end of stream", () => {
    const c = new RepeatCollapser();
    c.push(LEASE_ERROR);
    c.push(LEASE_ERROR);
    c.push(LEASE_ERROR);
    const tail = c.flush();
    expect(tail).toEqual([{ kind: "repeat", count: 2, sample: LEASE_ERROR }]);
  });

  it("never collapses blank lines — they are structure, not content", () => {
    const out = run(["", "", ""]);
    expect(out).toEqual(["", "", ""]);
  });

  it("singular vs plural, because a log that says '1 more times' looks broken", () => {
    expect(renderRepeat(1)).toContain("1 more time");
    expect(renderRepeat(1)).not.toContain("times");
    expect(renderRepeat(2)).toContain("2 more times");
  });
});

describe("normalizeLogLine — what counts as 'the same line'", () => {
  it("blanks timestamps in both formats the dev server emits", () => {
    expect(normalizeLogLine("12:00:01 ERROR boom")).toBe(normalizeLogLine("23:59:59 ERROR boom"));
    expect(normalizeLogLine('{"time":"2026-08-03T12:00:01.123Z","msg":"boom"}')).toBe(
      normalizeLogLine('{"time":"2026-08-03T18:44:02.987Z","msg":"boom"}'),
    );
  });

  it("blanks the per-item ids that make one error look like a million", () => {
    expect(normalizeLogLine("ERROR lease item 01HQ8ZK4M9N7P2R5T8V1X3Y6W0")).toBe(
      normalizeLogLine("ERROR lease item 01HQ8ZK4M9N7P2R5T8V1X3Y6W1"),
    );
    expect(normalizeLogLine("ERROR run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed")).toBe(
      normalizeLogLine("ERROR run 550e8400-e29b-41d4-a716-446655440000 failed"),
    );
  });

  it("does NOT merge genuinely different messages", () => {
    // The property that keeps the collapse safe: differing text never collapses,
    // however similar the surrounding shape.
    expect(normalizeLogLine("12:00:01 ERROR could not lease item")).not.toBe(
      normalizeLogLine("12:00:01 ERROR could not reach executor"),
    );
    expect(normalizeLogLine("ERROR queue=default")).not.toBe(
      normalizeLogLine("ERROR queue=system"),
    );
  });

  it("does not blank short numbers that carry meaning", () => {
    expect(normalizeLogLine("INFO workers=100")).toContain("100");
  });
});
