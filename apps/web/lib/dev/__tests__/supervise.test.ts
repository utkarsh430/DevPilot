import { describe, expect, it } from "vitest";
import { CHILD_ORDER, planOnChildExit, prefixLine } from "@/lib/dev/supervise";

describe("planOnChildExit", () => {
  it("a child exiting while the stack is running is a crash, even with code 0", () => {
    const plan = planOnChildExit({ name: "runner", code: 0, signal: null }, false);
    expect(plan.kind).toBe("crash");
    expect(plan).toMatchObject({ exitCode: 1 });
    expect(plan.message).toContain("runner");
    expect(plan.message).toContain("stopping the rest");
  });

  it("a non-zero exit names the code", () => {
    const plan = planOnChildExit({ name: "web", code: 1, signal: null }, false);
    expect(plan.kind).toBe("crash");
    expect(plan.message).toContain("code 1");
  });

  it("a child killed by SIGTERM while running is a crash (someone killed it)", () => {
    const plan = planOnChildExit({ name: "inngest", code: null, signal: "SIGTERM" }, false);
    expect(plan.kind).toBe("crash");
    expect(plan.message).toContain("SIGTERM");
  });

  it("an exit after shutdown was requested is not a crash", () => {
    const plan = planOnChildExit({ name: "web", code: 1, signal: null }, true);
    expect(plan.kind).toBe("shutdown");
  });

  it("a child killed by SIGINT before the supervisor's handler ran counts as shutdown", () => {
    // Ctrl-C hits the whole foreground process group; the child's exit event
    // can arrive before the parent's own SIGINT handler flips the flag.
    const plan = planOnChildExit({ name: "web", code: null, signal: "SIGINT" }, false);
    expect(plan.kind).toBe("shutdown");
    expect(planOnChildExit({ name: "web", code: null, signal: "SIGHUP" }, false).kind).toBe(
      "shutdown",
    );
  });
});

describe("prefixLine", () => {
  it("pads to the widest name so the three streams line up", () => {
    expect(prefixLine("web", "x", CHILD_ORDER)).toBe("[web]     x");
    expect(prefixLine("inngest", "x", CHILD_ORDER)).toBe("[inngest] x");
    expect(prefixLine("runner", "x", CHILD_ORDER)).toBe("[runner]  x");
  });
});
