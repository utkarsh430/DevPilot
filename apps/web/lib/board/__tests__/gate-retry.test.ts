// B2 — the DEDICATED QA-gate retry ceiling.
//
// The load-bearing property under test is not the arithmetic, it is the
// SEPARATION: this counter must never be `tickets.retry_count`. That column is
// the engineer<->QA reject loop's, with three live consumers (dispatcher
// re-dispatch on `retry_count > 0`, the F2 loop-guard's G5 stand-down, and
// `enforceQaRetryCeiling`'s park). A shared counter would fake QA rejects that
// never happened and spend the QA loop's budget on tickets QA has never seen.
//
// Source-level assertions are used for that property deliberately: it is a
// claim about which COLUMN the seam writes, and no amount of pure-function
// testing can observe that. The arithmetic half is tested directly.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideGateRetryCeiling,
  getQaGateMaxRetries,
  qaGateCeilingCommentBody,
  QA_GATE_CEILING_AUTHOR,
  DEFAULT_QA_GATE_MAX_RETRIES,
} from "@/lib/board/gate-retry";

const ORIGINAL = process.env.DEVPILOT_QA_GATE_MAX_RETRIES;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DEVPILOT_QA_GATE_MAX_RETRIES;
  else process.env.DEVPILOT_QA_GATE_MAX_RETRIES = ORIGINAL;
});

describe("decideGateRetryCeiling", () => {
  it("is not exhausted below the ceiling", () => {
    expect(decideGateRetryCeiling({ gateRetryCount: 1, maxRetries: 3 }).exhausted).toBe(false);
    expect(decideGateRetryCeiling({ gateRetryCount: 2, maxRetries: 3 }).exhausted).toBe(false);
  });

  it("is exhausted AT the ceiling — the count includes the refusal being handled", () => {
    expect(decideGateRetryCeiling({ gateRetryCount: 3, maxRetries: 3 }).exhausted).toBe(true);
  });

  it("stays exhausted above the ceiling (a bump that raced past it still parks)", () => {
    expect(decideGateRetryCeiling({ gateRetryCount: 9, maxRetries: 3 }).exhausted).toBe(true);
  });

  it("carries a reason naming both numbers", () => {
    const d = decideGateRetryCeiling({ gateRetryCount: 3, maxRetries: 3 });
    expect(d.reason).toContain("3");
    expect(d.reason).toContain("ceiling");
  });
});

describe("getQaGateMaxRetries — a circuit breaker cannot be switched off by a bad value", () => {
  it("defaults when unset", () => {
    delete process.env.DEVPILOT_QA_GATE_MAX_RETRIES;
    expect(getQaGateMaxRetries()).toBe(DEFAULT_QA_GATE_MAX_RETRIES);
  });

  it("honours a valid override", () => {
    process.env.DEVPILOT_QA_GATE_MAX_RETRIES = "7";
    expect(getQaGateMaxRetries()).toBe(7);
  });

  it("falls back on non-numeric, zero and negative values rather than disabling itself", () => {
    for (const bad of ["off", "", "0", "-1", "NaN"]) {
      process.env.DEVPILOT_QA_GATE_MAX_RETRIES = bad;
      expect(getQaGateMaxRetries()).toBe(DEFAULT_QA_GATE_MAX_RETRIES);
    }
  });

  it("floors a fractional value", () => {
    process.env.DEVPILOT_QA_GATE_MAX_RETRIES = "2.9";
    expect(getQaGateMaxRetries()).toBe(2);
  });
});

describe("the ceiling park is authored distinctly", () => {
  it("is NOT devpilot_move_ticket — the reconciler reads that author as a rendered verdict", () => {
    expect(QA_GATE_CEILING_AUTHOR).not.toBe("devpilot_move_ticket");
  });

  it("is NOT ticket-reconciler — that would consume a reconcile-cap slot", () => {
    expect(QA_GATE_CEILING_AUTHOR).not.toBe("ticket-reconciler");
  });

  it("is distinct from the per-refusal qa-gate author", () => {
    expect(QA_GATE_CEILING_AUTHOR).not.toBe("devpilot_qa_gate");
  });

  it("explains the park, names the env var, and quotes the underlying refusal", () => {
    const body = qaGateCeilingCommentBody(3, 3, "Hand-off to QA refused: <the reason>");
    expect(body).toContain("DEVPILOT_QA_GATE_MAX_RETRIES");
    expect(body).toContain("blocked");
    expect(body).toContain("<the reason>");
  });
});

describe("SEPARATION from tickets.retry_count (the invariant this feature is built on)", () => {
  const transitions = readFileSync(join(process.cwd(), "lib/board/transitions.ts"), "utf8");
  // The gate block: from the QA-gate guard to the safety gate that follows it.
  const gateBlock = transitions.slice(
    transitions.indexOf('input.to === "in_review" && input.actor !== "human"'),
    transitions.indexOf("const safety = decideSafetyGate("),
  );

  it("the gate block is actually located (guards against a vacuous slice)", () => {
    expect(gateBlock.length).toBeGreaterThan(200);
    expect(gateBlock).toContain("decideQaGate");
  });

  it("the gate's refusal path bumps gate_retry_count", () => {
    expect(gateBlock).toContain("gate_retry_count");
  });

  it("the gate's refusal path NEVER touches the reject-loop retry_count", () => {
    // The reject-loop counter is written only by the QA-reject `retryDelta`
    // path and cleared by the human reset — never by a gate refusal.
    //
    // Matched with a negative lookbehind because `gate_retry_count` CONTAINS
    // `retry_count` as a substring: a plain `not.toContain` here is not just
    // wrong, it fails on the very code it is meant to bless.
    const bare = /(?<!gate_)\bretry_count\b/;
    const code = gateBlock
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(bare.test(code)).toBe(false);
    expect(code).not.toContain("retryDelta");
  });

  it("the regex used above would actually catch a bare retry_count (non-vacuous)", () => {
    const bare = /(?<!gate_)\bretry_count\b/;
    expect(bare.test("patch.retry_count = 0;")).toBe(true);
    expect(bare.test("{ retry_count: n }")).toBe(true);
    expect(bare.test("{ gate_retry_count: n }")).toBe(false);
  });

  it("gate-retry.ts owns no reference to the reject-loop counter or its env var", () => {
    const mod = readFileSync(join(process.cwd(), "lib/board/gate-retry.ts"), "utf8");
    const code = mod
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(code).not.toContain("DEVPILOT_QA_MAX_RETRIES");
    expect(code).toContain("DEVPILOT_QA_GATE_MAX_RETRIES");
  });
});
