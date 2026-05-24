import { describe, expect, it } from "vitest";
import { classifyRunFailureReason } from "@/lib/engine/run-failure-reason";

describe("classifyRunFailureReason", () => {
  it("gives a timed-out waitForEvent its own distinct code", () => {
    const reason = classifyRunFailureReason("local-cc step 3 timed out after 3600000");
    expect(reason).toMatch(/^step-timeout:/);
    expect(reason).toContain("timed out after 3600000");
  });

  it("gives a runner-reported step failure a different code from a timeout", () => {
    const reason = classifyRunFailureReason(
      "local-cc step 0 reported failure: workspace clone failed",
    );
    expect(reason).toMatch(/^runner-reported-failure:/);
    expect(reason).not.toMatch(/^step-timeout:/);
    expect(reason).toContain("workspace clone failed");
  });

  it("gives a refused workspace precondition its own code", () => {
    const reason = classifyRunFailureReason(
      "workspace precondition failed (no-repo-url): project has no repository configured",
    );
    expect(reason).toMatch(/^workspace-precondition:/);
  });

  it("gives an unrecognised runner policy its own code", () => {
    const reason = classifyRunFailureReason("unknown runnerPolicy: bogus-policy");
    expect(reason).toMatch(/^unknown-runner-policy:/);
  });

  it("gives an init failure its own code", () => {
    const reason = classifyRunFailureReason("init failed: duplicate key value");
    expect(reason).toMatch(/^init-failed:/);
  });

  it("gives a tripped tenant velocity circuit breaker its own code, distinct from a per-run budget", () => {
    const reason = classifyRunFailureReason(
      "tenant velocity circuit breaker tripped: tenant=abc bucket=520¢ limit=500¢/min. Wait 60s for the window to roll, then retry; raise DEVPILOT_TENANT_VELOCITY_CENTS_PER_MIN if this is expected load.",
    );
    expect(reason).toMatch(/^velocity-breaker-tripped:/);
    expect(reason).not.toMatch(/^budget-exceeded:/);
  });

  it("gives a Redis-unreachable velocity check its own code", () => {
    const reason = classifyRunFailureReason(
      "velocity breaker failing closed: Redis unreachable, cannot verify spend velocity for tenant abc: ECONNREFUSED",
    );
    expect(reason).toMatch(/^velocity-breaker-unreachable:/);
  });

  it("gives a per-run budget exhaustion its own code", () => {
    const reason = classifyRunFailureReason(
      "budget exceeded for llm on run abc: spent=100¢ budget=100¢ remaining=0¢",
    );
    expect(reason).toMatch(/^budget-exceeded:/);
  });

  it("gives a refused budget check (run not found / already terminal) its own code", () => {
    expect(classifyRunFailureReason("budget check failed: run abc not found")).toMatch(
      /^budget-check-refused:/,
    );
    expect(classifyRunFailureReason("budget check failed: run abc already done")).toMatch(
      /^budget-check-refused:/,
    );
  });

  it("gives a failed run_steps persist its own code, distinct from a failed finish", () => {
    expect(classifyRunFailureReason("persist step failed: connection reset")).toMatch(
      /^persist-step-failed:/,
    );
    expect(classifyRunFailureReason("finish failed: connection reset")).toMatch(
      /^finish-step-failed:/,
    );
  });

  it("preserves an unrecognised crash message rather than collapsing to a blanket unknown", () => {
    const reason = classifyRunFailureReason("TypeError: cannot read properties of undefined");
    expect(reason).toMatch(/^uncaught-exception:/);
    expect(reason).toContain("cannot read properties of undefined");
  });

  it("is explicit — never blank — when genuinely nothing was captured", () => {
    expect(classifyRunFailureReason("")).toBe("unknown:no error message was captured");
    expect(classifyRunFailureReason("   ")).toBe("unknown:no error message was captured");
  });

  it("truncates a very long message rather than storing it unbounded", () => {
    const long = "x".repeat(1000);
    const reason = classifyRunFailureReason(long);
    expect(reason.length).toBeLessThan(320);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("every known code is mutually exclusive on its own canonical message", () => {
    const cases: Array<[string, string]> = [
      ["local-cc step 1 timed out after 60000", "step-timeout"],
      ["local-cc step 1 reported failure: boom", "runner-reported-failure"],
      ["workspace precondition failed (x): y", "workspace-precondition"],
      ["unknown runnerPolicy: x", "unknown-runner-policy"],
      ["init failed: x", "init-failed"],
      [
        "tenant velocity circuit breaker tripped: tenant=abc bucket=520¢ limit=500¢/min",
        "velocity-breaker-tripped",
      ],
      ["velocity breaker failing closed: Redis unreachable", "velocity-breaker-unreachable"],
      ["budget exceeded for llm on run abc: spent=100¢", "budget-exceeded"],
      ["budget check failed: run abc not found", "budget-check-refused"],
      ["persist step failed: x", "persist-step-failed"],
      ["finish failed: x", "finish-step-failed"],
    ];
    for (const [message, code] of cases) {
      expect(classifyRunFailureReason(message).split(":")[0]).toBe(code);
    }
  });
});
