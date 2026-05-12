// Pure helpers for the replay/resume primitive (lib/engine/replay.ts):
// resolve what prompt, system prompt, role, and model a replay clone should
// resume with, from the original run's recorded steps plus fallbacks.
//
// Kept free of server-only imports (no supabase / inngest / next) so the
// resume-prompt behaviour is unit-testable — this is the seam that caused
// the stuck-in_progress bug: resume-replays used to drop the role's system
// prompt entirely, so tool-driven roles (qa et al.) were replayed without
// their `devpilot_move_ticket` mandate and never advanced their ticket.

export type ResumeStep = {
  run_id: string;
  idx: number;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type ResumeOverrides = {
  promptOverride?: string;
  systemPromptOverride?: string;
};

export type ResumeFallbacks = {
  /**
   * The role config's system prompt (built-in or custom), resolved by the
   * caller the same way the dispatcher resolves it. Used whenever the
   * operator didn't supply an explicit systemPromptOverride — a replay
   * without its role mandate is how tickets get stranded.
   */
  roleSystemPrompt?: string | null;
  /**
   * Freshly rendered ticket context (buildTicketContext → renderTicketPrompt)
   * used when the original recorded nothing to resume from — the shape of a
   * run that failed before persisting its first step.
   */
  ticketContextPrompt?: string | null;
};

/**
 * Resolve the first turn's prompt + systemPrompt to feed the resumed loop.
 * Prompt priority: override → the original step recorded AT fromStepIdx →
 * carry-over text of the step immediately before → rebuilt ticket context →
 * legacy placeholder.
 * System-prompt priority: override → role config → undefined.
 */
export function pickResumePrompts(
  steps: ResumeStep[],
  fromStepIdx: number,
  overrides: ResumeOverrides,
  fallbacks: ResumeFallbacks = {},
): { prompt: string; systemPrompt: string | undefined } {
  const systemPrompt = overrides.systemPromptOverride ?? fallbacks.roleSystemPrompt ?? undefined;
  if (overrides.promptOverride) {
    return { prompt: overrides.promptOverride, systemPrompt };
  }
  // Look for the original's step at exactly `fromStepIdx` first — its payload
  // carries the prompt the original used at that turn. This makes
  // "replay from step N with no override" idempotent against the original.
  const at = steps.find((s) => s.idx === fromStepIdx);
  const before = [...steps].filter((s) => s.idx < fromStepIdx).sort((a, b) => b.idx - a.idx)[0];
  const promptFromStep =
    (at?.payload as { prompt?: string } | undefined)?.prompt ??
    (before?.payload as { text?: string } | undefined)?.text;
  return {
    prompt:
      promptFromStep ?? fallbacks.ticketContextPrompt ?? "(replay resumed with no recorded prompt)",
    systemPrompt,
  };
}

/**
 * Roll the role + model forward from the original run's recorded steps. The
 * first role-stamped think step is the canonical source (matches
 * `deriveRoleFromSteps` in lib/runs/queries.ts). Returns nulls for a run
 * that persisted no productive steps — the caller must then fall back to the
 * run row's agent (runs.agent_id → agents.role).
 */
export function deriveSeedFromSteps(steps: ResumeStep[]): {
  role: string | null;
  modelId: string | null;
} {
  const seedStep = steps.find((s) => s.kind === "think" && (s.payload as { role?: string }).role);
  return {
    role: (seedStep?.payload as { role?: string } | undefined)?.role ?? null,
    modelId: (seedStep?.payload as { model?: string } | undefined)?.model ?? null,
  };
}
