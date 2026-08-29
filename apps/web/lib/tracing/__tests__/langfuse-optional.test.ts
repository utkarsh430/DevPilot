// The first ticket a fresh local install ever filed died with
// `Missing required env var: LANGFUSE_PUBLIC_KEY` before its first step. Blank
// Langfuse keys must mean "no spans", never "no runs".
//
// `langfuse.ts` itself reaches `server-only` through the platform-secrets
// resolver and cannot load here - which is precisely the gap the defect lived
// in - so the decision and the no-op client are tested through `./optional`,
// and the wiring in `langfuse.ts` is pinned by reading its source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TRACING_DISABLED_NOTICE, decideTracing, disabledLangfuse } from "@/lib/tracing/optional";

describe("decideTracing", () => {
  it("both keys → enabled; none or one → disabled, with the reason", () => {
    expect(decideTracing({ publicKey: "pk", secretKey: "sk" })).toEqual({ enabled: true });
    expect(decideTracing({ publicKey: "", secretKey: "" })).toEqual({
      enabled: false,
      reason: "no-keys",
    });
    expect(decideTracing({ publicKey: "pk", secretKey: "  " })).toEqual({
      enabled: false,
      reason: "partial-keys",
    });
  });
});

describe("the disabled client", () => {
  it("runs every call the span wrappers make, sends nothing, announces once", async () => {
    const warnings: string[] = [];
    const a = disabledLangfuse((m) => warnings.push(m));
    const b = disabledLangfuse((m) => warnings.push(m));
    expect(b).toBe(a);
    expect(warnings).toEqual([TRACING_DISABLED_NOTICE]);

    // The exact call shapes withRunSpan / withStepSpan / withToolSpan /
    // withLLMSpan make, in order.
    const trace = a.trace({ id: "run-1", name: "agent.run", metadata: { tenantId: "t" } });
    const span = trace.span({ name: "think", input: "x" });
    const tool = span.span({ name: "tool:t" });
    tool.update({ output: "ok" });
    tool.end();
    const gen = span.generation({ name: "llm.call", model: "m", input: "hi" });
    gen.update({ output: "o", usage: { input: 1, output: 1, total: 2, unit: "TOKENS" } });
    gen.end();
    span.update({ level: "ERROR", statusMessage: "boom" });
    span.end();
    trace.update({ metadata: { error: "boom" } });
    await expect(a.flushAsync()).resolves.toBeUndefined();
  });
});

describe("langfuse.ts wiring", () => {
  const src = readFileSync(fileURLToPath(new URL("../langfuse.ts", import.meta.url)), "utf8");

  it("never reads the THROWING env getters for the two keys", () => {
    // `process.env.X` (raw, never throws) is fine; `env.X` from lib/env is not.
    expect(src).not.toMatch(/(?<!process\.)\benv\.LANGFUSE_PUBLIC_KEY/);
    expect(src).not.toMatch(/(?<!process\.)\benv\.LANGFUSE_SECRET_KEY/);
    // CONTROL: the raw reads ARE there, so the assertion above is not vacuous.
    expect(src).toMatch(/process\.env\.LANGFUSE_PUBLIC_KEY/);
  });

  it("falls back to the disabled client through decideTracing, on both client paths", () => {
    expect((src.match(/disabledLangfuse\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((src.match(/decideTracing\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
