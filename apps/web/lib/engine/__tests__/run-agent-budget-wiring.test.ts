// `run-agent.ts` reaches `next/headers` transitively (via `lib/db/server`,
// `lib/env`, and a long chain of project/GitHub/secrets loaders) and cannot
// be imported under Vitest — the same gap documented at the top of
// `vitest.config.ts` and exercised by every other `*-wiring.test.ts` in this
// directory (e.g. `bounded-send-wiring.test.ts`). This is therefore a SOURCE
// SCAN over the one file, pinning three properties that a behavioural test
// cannot reach:
//
//   1. Both PRE-step `assertCanProceed` calls thread the per-project
//      `overrideCap` through — a call site that silently drops it would make
//      `budget_cap_override_enabled` do nothing on that path, invisibly.
//   2. A POST-step check exists, inside the iteration loop, after the step's
//      spend is persisted — the actual "turnstile → ceiling" fix. Its
//      absence is exactly the historical bug: a run's one-and-only step could
//      overshoot its cap and the run would complete `done` regardless.
//   3. `resolve-provider` actually resolves `budgetCapOverrideEnabled` from
//      the loaded project, so the flag reaching the checks above is real
//      per-project state rather than a hardcoded default.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUN_AGENT_PATH = fileURLToPath(new URL("../run-agent.ts", import.meta.url));
const source = readFileSync(RUN_AGENT_PATH, "utf8");

describe("run-agent.ts budget step-boundary wiring", () => {
  it("resolves budgetCapOverrideEnabled from the ticket's project in resolve-provider", () => {
    expect(source).toMatch(
      /budgetCapOverrideEnabled:\s*project\?\.budgetCapOverrideEnabled\s*\?\?\s*false/,
    );
  });

  it("both pre-step assertCanProceed calls (api + local-cc) thread overrideCap", () => {
    const preStepCalls = [
      ...source.matchAll(
        /assertCanProceed\(runId,\s*"llm",\s*\{\s*overrideCap:\s*routing\.budgetCapOverrideEnabled,?\s*\}\s*\)/g,
      ),
    ];
    // Three call sites total once the wiring is correct: the api-path
    // `think-${i}` pre-check, the local-cc `lc-enqueue-${i}` pre-check, and
    // the new post-step `budget-stop-${i}` check below.
    expect(preStepCalls.length).toBe(3);
  });

  it("a dedicated post-step budget check runs inside the loop, after persist and before it exits", () => {
    const persistIdx = source.indexOf("await step.run(`persist-${i}`");
    const stopIdx = source.indexOf("await step.run(`budget-stop-${i}`");
    const loopEndIdx = source.indexOf("\n    }\n\n    // 2. Role-specific side effects");
    expect(persistIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(loopEndIdx).toBeGreaterThan(-1);
    // Ordering: persist records the step's actual spend, THEN the ceiling is
    // re-checked, all still inside the `for` loop body (before it closes and
    // falls through to postprocess).
    expect(stopIdx).toBeGreaterThan(persistIdx);
    expect(stopIdx).toBeLessThan(loopEndIdx);
  });

  it("the post-step check reuses assertCanProceed rather than reimplementing the ceiling logic", () => {
    const stopBlockStart = source.indexOf("await step.run(`budget-stop-${i}`");
    const stopBlock = source.slice(stopBlockStart, stopBlockStart + 300);
    expect(stopBlock).toContain('assertCanProceed(runId, "llm"');
    expect(stopBlock).toContain("overrideCap: routing.budgetCapOverrideEnabled");
  });
});
