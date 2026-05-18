// Regression coverage for the replay half of the stuck-ticket bug: the
// resume-replay of a failed run used to emit `agent/run.requested` with
// systemPrompt=undefined (the role's system prompt is built at dispatch time
// and was never reconstructed) and, for runs that failed before persisting a
// step, prompt="(replay resumed with no recorded prompt)" and role=undefined.
// A QA replay without its system prompt never calls `devpilot_move_ticket`, so its
// ticket never advances.

import { describe, expect, it } from "vitest";
import { qaRole } from "@/lib/roles/qa";
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";
import {
  deriveSeedFromSteps,
  pickResumePrompts,
  type ResumeStep,
} from "@/lib/engine/replay-prompts";

// What `replay.ts` actually hands to `pickResumePrompts`: the COMPOSED base, not
// the raw style half. Phase 4 split `devpilot_move_ticket` out of
// `qaRole.systemPrompt` and into `qaRole.safetyContract`, so a fixture reading
// the raw field would assert against a prompt no replay ever emits — and would
// have made the `toContain("devpilot_move_ticket")` check below (the whole point
// of this file) go quietly red for the wrong reason.
const QA_SYSTEM_PROMPT = composeRoleSystemPrompt(qaRole, [], true, null);

function thinkStep(idx: number, payload: Record<string, unknown>): ResumeStep {
  return {
    run_id: "run-1",
    idx,
    kind: "think",
    payload,
    created_at: new Date(2026, 0, 1, 0, idx).toISOString(),
  };
}

describe("pickResumePrompts — system prompt reconstruction", () => {
  it("a QA resume-replay with no recorded steps regains the role system prompt and a real ticket prompt", () => {
    // The captain's case: the failed qa run persisted zero productive steps
    // (runner disconnected mid `claude -p`), so fromStepIdx=0 and nothing is
    // recorded. The replay must fall back to the role config's system prompt
    // (which mandates the devpilot_move_ticket verdict) and the rebuilt ticket
    // context, not a placeholder.
    const { prompt, systemPrompt } = pickResumePrompts(
      [],
      0,
      {},
      {
        roleSystemPrompt: QA_SYSTEM_PROMPT,
        ticketContextPrompt: "Ticket abc: verify the recipe seeder.",
      },
    );
    expect(systemPrompt).toBe(QA_SYSTEM_PROMPT);
    expect(systemPrompt).toContain("devpilot_move_ticket");
    expect(prompt).toBe("Ticket abc: verify the recipe seeder.");
  });

  it("an explicit systemPromptOverride still wins over the role fallback", () => {
    const { systemPrompt } = pickResumePrompts(
      [],
      0,
      { systemPromptOverride: "override wins" },
      { roleSystemPrompt: QA_SYSTEM_PROMPT, ticketContextPrompt: null },
    );
    expect(systemPrompt).toBe("override wins");
  });

  it("the role fallback also applies when a promptOverride is given", () => {
    const { prompt, systemPrompt } = pickResumePrompts(
      [],
      0,
      { promptOverride: "operator prompt" },
      { roleSystemPrompt: QA_SYSTEM_PROMPT, ticketContextPrompt: null },
    );
    expect(prompt).toBe("operator prompt");
    expect(systemPrompt).toBe(QA_SYSTEM_PROMPT);
  });

  it("recorded prompts keep their original precedence over the ticket-context fallback", () => {
    const steps = [
      thinkStep(0, { prompt: "turn-0 prompt", text: "turn-0 output", role: "qa" }),
      thinkStep(1, { prompt: "turn-1 prompt", text: "turn-1 output", role: "qa" }),
    ];
    // Replay AT step 1 → uses step 1's recorded prompt.
    expect(
      pickResumePrompts(steps, 1, {}, { roleSystemPrompt: null, ticketContextPrompt: "ctx" })
        .prompt,
    ).toBe("turn-1 prompt");
    // Resume PAST the last step → carries the prior step's output text.
    expect(
      pickResumePrompts(steps, 2, {}, { roleSystemPrompt: null, ticketContextPrompt: "ctx" })
        .prompt,
    ).toBe("turn-1 output");
  });

  it("keeps the legacy placeholder only when nothing at all is available", () => {
    const { prompt, systemPrompt } = pickResumePrompts(
      [],
      0,
      {},
      {
        roleSystemPrompt: null,
        ticketContextPrompt: null,
      },
    );
    expect(prompt).toBe("(replay resumed with no recorded prompt)");
    expect(systemPrompt).toBeUndefined();
  });
});

describe("deriveSeedFromSteps — role/model carried forward from the original run", () => {
  it("reads role + model from the first role-stamped think step", () => {
    const steps = [
      thinkStep(0, { text: "no role here" }),
      thinkStep(1, { role: "qa", model: "claude-sonnet-5", text: "…" }),
    ];
    expect(deriveSeedFromSteps(steps)).toEqual({
      role: "qa",
      modelId: "claude-sonnet-5",
    });
  });

  it("returns nulls for a run that persisted no productive steps (the failed-run shape)", () => {
    expect(deriveSeedFromSteps([])).toEqual({ role: null, modelId: null });
  });
});
