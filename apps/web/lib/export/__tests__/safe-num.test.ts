// `safeNum` and the Bar clamp.
//
// The vendored pdfkit patch stops a bad number from CRASHING the export, but it
// does so by drawing the element at 0 and logging. That is a last-resort net.
// Where we compute a number ourselves we should degrade to a value we chose,
// and not rely on the net at all.

import { describe, expect, it } from "vitest";
import { safeNum } from "@/lib/export/components/primitives";

describe("safeNum", () => {
  it("passes an ordinary number through untouched", () => {
    expect(safeNum(120, 0)).toBe(120);
    expect(safeNum(0, 7)).toBe(0);
    expect(safeNum(-3.5, 0)).toBe(-3.5);
  });

  it("rejects the values pdfkit refuses", () => {
    expect(safeNum(NaN, 5)).toBe(5);
    expect(safeNum(Infinity, 5)).toBe(5);
    expect(safeNum(-Infinity, 5)).toBe(5);
    expect(safeNum(1e30, 5)).toBe(5);
    expect(safeNum(-3e21, 5)).toBe(5);
    // The exact value that took the export down.
    expect(safeNum(-2.996737976248788e21, 5)).toBe(5);
  });

  it("accepts values just inside pdfkit's range and rejects the boundary", () => {
    expect(safeNum(1e20, 0)).toBe(1e20);
    expect(safeNum(1e21, 0)).toBe(0);
    expect(safeNum(-1e21, 0)).toBe(0);
  });

  it("rejects non-numbers rather than coercing them", () => {
    // A `"120"` reaching a style prop is a bug, not a width — coercing it would
    // hide the bug and draw something plausible.
    expect(safeNum("120", 9)).toBe(9);
    expect(safeNum(null, 9)).toBe(9);
    expect(safeNum(undefined, 9)).toBe(9);
  });

  it("is the guard Math.min/Math.max cannot be", () => {
    // The Bar bug in one line: a clamp built from Math.min/Math.max does NOT
    // sanitise, because every comparison against NaN is false and both
    // functions propagate it. This is why `Bar` sanitises before clamping.
    expect(Math.max(0, Math.min(1, NaN))).toBeNaN();
    expect(safeNum(Math.max(0, Math.min(1, NaN)), 0)).toBe(0);
  });
});
