// Truncation must never emit half a character.
//
// `slice` counts UTF-16 code units, so it splits a surrogate pair whenever a
// non-BMP character straddles the limit. The export's three fixed-index
// truncations all run over agent-authored ticket titles, which routinely carry
// emoji — so this is reachable from ordinary data, not from an attack.

import { describe, expect, it } from "vitest";
import { truncateChars, oneLineTruncated } from "@/lib/export/truncate";

/** True if any code unit is an unpaired surrogate — i.e. not valid text. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // a low surrogate with no high surrogate before it
    }
  }
  return false;
}

describe("truncateChars", () => {
  it("leaves a short string untouched", () => {
    expect(truncateChars("hello", 90)).toBe("hello");
  });

  it("truncates with an ellipsis and respects the budget", () => {
    expect(truncateChars("abcdef", 4)).toBe("abc…");
    expect(Array.from(truncateChars("abcdef", 4))).toHaveLength(4);
  });

  it("never splits a surrogate pair, at any boundary", () => {
    // Walk an emoji across the limit so some offset would land mid-pair.
    for (let pad = 0; pad < 12; pad += 1) {
      const s = `${"a".repeat(pad)}🚀${"b".repeat(12)}`;
      for (let max = 1; max <= 16; max += 1) {
        const out = truncateChars(s, max);
        expect(hasLoneSurrogate(out), `pad=${pad} max=${max} -> ${JSON.stringify(out)}`).toBe(
          false,
        );
      }
    }
  });

  it("counts an emoji as ONE character, not two", () => {
    // The bug in one line: `"🚀🚀🚀".slice(0, 2)` keeps one emoji plus half of
    // another. Code-point truncation keeps whole characters.
    expect(truncateChars("🚀🚀🚀", 2)).toBe("🚀…");
    expect(truncateChars("🚀🚀", 5)).toBe("🚀🚀");
  });

  it("returns empty for a non-positive budget rather than a bare ellipsis", () => {
    expect(truncateChars("abc", 0)).toBe("");
  });
});

describe("oneLineTruncated", () => {
  it("collapses newlines and runs of whitespace", () => {
    // A title carrying a newline wrapped the running header into two rows.
    expect(oneLineTruncated("a\nb   c\t d", 90)).toBe("a b c d");
  });

  it("trims before measuring, so padding does not eat the budget", () => {
    expect(oneLineTruncated("   hi   ", 90)).toBe("hi");
  });

  it("stays surrogate-safe after collapsing", () => {
    const out = oneLineTruncated(`${"a ".repeat(40)}🚀 tail`, 70);
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});
