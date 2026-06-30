// The auto-approve THRESHOLD normaliser + the grade gate.
//
// Two properties are load-bearing and everything here exists to pin them:
//   1. BACK-COMPAT — the setting used to be a boolean. A legacy `true` must read
//      as `'high_only'` (STRICTLY SAFER than the blanket approve it used to
//      mean), and anything unrecognised must read as `'off'`, so a malformed or
//      legacy config can never silently widen the auto-approval.
//   2. UNGRADED NEVER AUTO-APPROVES — grading is fail-open, so a downed grader
//      leaves rows ungraded. If ungraded cleared a threshold, the fail-open
//      grader would be a fail-OPEN safety gate.

import { describe, expect, it } from "vitest";
import {
  clearsAutoApproveThreshold,
  DEFAULT_LEARNING_AUTO_APPROVE_THRESHOLD,
  isAutoApproveEnabled,
  isLearningAutoApproveThreshold,
  LEARNING_AUTO_APPROVE_THRESHOLDS,
  normalizeLearningAutoApproveThreshold,
} from "@/lib/learning/auto-approve";

describe("normalizeLearningAutoApproveThreshold", () => {
  it("defaults to off (review gate fully on)", () => {
    expect(DEFAULT_LEARNING_AUTO_APPROVE_THRESHOLD).toBe("off");
    expect(normalizeLearningAutoApproveThreshold(undefined)).toBe("off");
    expect(normalizeLearningAutoApproveThreshold(null)).toBe("off");
  });

  it("passes through each recognised threshold", () => {
    for (const t of LEARNING_AUTO_APPROVE_THRESHOLDS) {
      expect(normalizeLearningAutoApproveThreshold(t)).toBe(t);
    }
  });

  // Back-compat: `true` used to mean "approve EVERYTHING unreviewed". Reading it
  // as high_only is deliberately stricter than the old behaviour — keeping the
  // blanket approve would waste the entire safety upgrade.
  it("maps the LEGACY boolean true to high_only (not a blanket approve)", () => {
    expect(normalizeLearningAutoApproveThreshold(true)).toBe("high_only");
    expect(normalizeLearningAutoApproveThreshold(true)).not.toBe("high_and_medium");
  });

  it("maps legacy false — and every malformed value — to off", () => {
    for (const v of [
      false,
      null,
      undefined,
      "",
      "true", // the STRING true must NOT enable anything
      "TRUE",
      "High_Only", // wrong case is not a threshold
      "high", // a GRADE is not a threshold
      "all",
      0,
      1,
      "1",
      "on",
      {},
      [],
      "yes",
    ]) {
      expect(normalizeLearningAutoApproveThreshold(v)).toBe("off");
    }
  });
});

describe("isLearningAutoApproveThreshold", () => {
  it("accepts only the exact threshold literals", () => {
    for (const t of LEARNING_AUTO_APPROVE_THRESHOLDS) {
      expect(isLearningAutoApproveThreshold(t)).toBe(true);
    }
    for (const v of [true, false, null, undefined, "high", "HIGH_ONLY", "", 1, {}]) {
      expect(isLearningAutoApproveThreshold(v)).toBe(false);
    }
  });
});

describe("clearsAutoApproveThreshold", () => {
  it("off never auto-approves anything", () => {
    for (const c of ["high", "medium", "low"] as const) {
      expect(clearsAutoApproveThreshold("off", c)).toBe(false);
    }
  });

  it("high_only clears high and nothing else", () => {
    expect(clearsAutoApproveThreshold("high_only", "high")).toBe(true);
    expect(clearsAutoApproveThreshold("high_only", "medium")).toBe(false);
    expect(clearsAutoApproveThreshold("high_only", "low")).toBe(false);
  });

  it("high_and_medium clears high and medium, never low", () => {
    expect(clearsAutoApproveThreshold("high_and_medium", "high")).toBe(true);
    expect(clearsAutoApproveThreshold("high_and_medium", "medium")).toBe(true);
    expect(clearsAutoApproveThreshold("high_and_medium", "low")).toBe(false);
  });

  // THE safety invariant.
  it("an UNGRADED lesson never auto-approves, at any threshold", () => {
    for (const t of LEARNING_AUTO_APPROVE_THRESHOLDS) {
      expect(clearsAutoApproveThreshold(t, null)).toBe(false);
      expect(clearsAutoApproveThreshold(t, undefined)).toBe(false);
    }
  });
});

describe("isAutoApproveEnabled", () => {
  it("is the legacy boolean view of the threshold", () => {
    expect(isAutoApproveEnabled("off")).toBe(false);
    expect(isAutoApproveEnabled("high_only")).toBe(true);
    expect(isAutoApproveEnabled("high_and_medium")).toBe(true);
  });
});
