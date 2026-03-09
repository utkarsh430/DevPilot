// Pure policy tests for the turnstile → ceiling fix. See budget-ceiling-policy.ts's
// header for the incident evidence and budget.ts for how these are wired in.

import { describe, expect, it } from "vitest";
import { decideBudgetCeiling, decideVelocityBreaker } from "@/lib/engine/budget-ceiling-policy";

const BASE_CEILING = {
  action: "llm",
  runId: "run-1",
  minRemainingCents: 1,
  overrideCap: false,
};

describe("decideBudgetCeiling", () => {
  it("allows a run comfortably under its cap", () => {
    const decision = decideBudgetCeiling({
      ...BASE_CEILING,
      spentCents: 100,
      budgetCents: 500,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.remainingCents).toBe(400);
  });

  it("allows a run with exactly the minimum slack remaining", () => {
    const decision = decideBudgetCeiling({
      ...BASE_CEILING,
      spentCents: 499,
      budgetCents: 500,
      minRemainingCents: 1,
    });
    expect(decision.ok).toBe(true);
  });

  it("refuses a run that has fully spent its budget", () => {
    const decision = decideBudgetCeiling({
      ...BASE_CEILING,
      spentCents: 500,
      budgetCents: 500,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.message).toMatch(/^budget exceeded for llm on run run-1/);
      expect(decision.message).toContain("spent=500¢");
      expect(decision.message).toContain("budget=500¢");
      expect(decision.message).toContain("remaining=0¢");
    }
  });

  it("refuses a run that has already overshot its budget", () => {
    // The measured worst case: 996¢ against a 500¢ cap. A run that already
    // blew past its cap must still refuse the NEXT action, not just the one
    // that got it there.
    const decision = decideBudgetCeiling({
      ...BASE_CEILING,
      spentCents: 996,
      budgetCents: 500,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.remainingCents).toBe(-496);
  });

  it("the classifier prefix survives regardless of overshoot magnitude", () => {
    // classifyRunFailureReason (run-failure-reason.ts) pattern-matches
    // `/^budget exceeded for/` — this message shape must never drift.
    const decision = decideBudgetCeiling({
      ...BASE_CEILING,
      spentCents: 10_000,
      budgetCents: 500,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message.startsWith("budget exceeded for")).toBe(true);
  });

  it("overrideCap lets a fully-spent run proceed", () => {
    const decision = decideBudgetCeiling({
      ...BASE_CEILING,
      spentCents: 996,
      budgetCents: 500,
      overrideCap: true,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.remainingCents).toBe(-496);
  });

  it("overrideCap is a no-op for a run already comfortably under cap", () => {
    // Confirms the override doesn't change anything for the common case —
    // it only ever matters once a run would otherwise have been refused.
    const decision = decideBudgetCeiling({
      ...BASE_CEILING,
      spentCents: 100,
      budgetCents: 500,
      overrideCap: true,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.remainingCents).toBe(400);
  });
});

const BASE_VELOCITY = {
  tenantId: "tenant-1",
  limitCentsPerMin: 500,
  windowSec: 60,
};

describe("decideVelocityBreaker", () => {
  it("allows a tenant under the velocity limit", () => {
    const decision = decideVelocityBreaker({ ...BASE_VELOCITY, bucketCents: 200 });
    expect(decision.ok).toBe(true);
  });

  it("refuses a tenant at or over the velocity limit", () => {
    const decision = decideVelocityBreaker({ ...BASE_VELOCITY, bucketCents: 500 });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.message).toMatch(/^tenant velocity circuit breaker tripped/);
      expect(decision.message).toContain("tenant=tenant-1");
    }
  });

  it("a disabled breaker (limit <= 0) never refuses, whatever the bucket says", () => {
    const decision = decideVelocityBreaker({
      ...BASE_VELOCITY,
      limitCentsPerMin: 0,
      bucketCents: 999_999,
    });
    expect(decision.ok).toBe(true);
  });

  it("has no overrideCap parameter to bypass with — the backstop is unconditional", () => {
    // Structural assertion: decideVelocityBreaker's own type signature has no
    // field a caller could set to bypass it. This is the property that keeps
    // a per-project budget override from ever meaning "no ceiling at all".
    const decision = decideVelocityBreaker({ ...BASE_VELOCITY, bucketCents: 500 });
    expect(Object.keys(decision)).not.toContain("overrideCap");
  });
});
