import { describe, expect, it } from "vitest";
import { deriveRailState, RAIL_STEPS, type RailStep } from "@/lib/plan/stage-rail";
import type { PlanStatus } from "@/lib/plan/types";

describe("deriveRailState - 1:1 status→step mapping", () => {
  const cases: ReadonlyArray<[PlanStatus | null, RailStep, number]> = [
    [null, "describe", 0],
    ["discussing", "refine", 1],
    ["planning", "build", 2],
    ["planned", "review", 3],
  ];

  it.each(cases)("status %s → step %s at index %i", (status, step, index) => {
    const state = deriveRailState(status);
    expect(state.kind).toBe("steps");
    if (state.kind !== "steps") return;
    expect(state.current).toBe(step);
    expect(state.currentIndex).toBe(index);
    // The index must agree with the ordered spine.
    expect(RAIL_STEPS[index]?.key).toBe(step);
  });
});

describe("deriveRailState - terminal collapse", () => {
  it("committed collapses to the Committed chip, not the 4-dot rail", () => {
    const state = deriveRailState("committed");
    expect(state.kind).toBe("terminal");
    if (state.kind !== "terminal") return;
    expect(state.terminal).toBe("committed");
    expect(state.label).toBe("Committed");
  });

  it("discarded collapses to the Discarded chip, not the 4-dot rail", () => {
    const state = deriveRailState("discarded");
    expect(state.kind).toBe("terminal");
    if (state.kind !== "terminal") return;
    expect(state.terminal).toBe("discarded");
    expect(state.label).toBe("Discarded");
  });
});

describe("RAIL_STEPS spine", () => {
  it("is exactly the four ordered steps", () => {
    expect(RAIL_STEPS.map((s) => s.key)).toEqual(["describe", "refine", "build", "review"]);
    expect(RAIL_STEPS.map((s) => s.label)).toEqual(["Describe", "Refine", "Build", "Review"]);
  });
});
