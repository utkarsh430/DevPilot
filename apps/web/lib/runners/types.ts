// The Runner interface. Every agent step in DevPilot goes through exactly one
// runner — never a direct vendor SDK call from feature code. Phase 0 ships
// two implementations:
//   - ApiRunner   (M4): stateless, calls the LLM via the Vercel AI SDK
//   - LocalCCRunner (M5): subprocess `claude -p`, full file/bash/git toolset
//
// Both produce the same StepResult shape so the Inngest agent loop is
// runner-agnostic.

import type { ModelTier } from "@/lib/llm/models";

export type RunnerKind = "api" | "local-cc";

export type AgentStep = {
  runId: string;
  tenantId: string;
  iterationIdx: number;
  modelTier: ModelTier;
  systemPrompt?: string;
  prompt: string;
  /** Optional name pinned to the step for tracing — defaults to `think-${iterationIdx}`. */
  spanName?: string;
  /**
   * WI-12 — the project this step runs for, when it has one. The runner resolves
   * the LLM provider (endpoint + credential + model) from (tenantId, projectId)
   * SERVER-SIDE. Only the ID travels: the config itself is never passed in, so a
   * caller can't name its own endpoint or credential.
   */
  projectId?: string | null;
  /**
   * The ROLE this step runs as, when it has one. Feeds the per-agent ×
   * per-project model override (`agent_project_models`), which is keyed on the
   * role slug — fan-out siblings carry no `agent_id`, so the slug is the only
   * attribution present on every run. Like `projectId`, only the id travels and
   * the config is resolved server-side; the caller cannot name a model.
   */
  role?: string | null;
};

export type StepResult = {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?:
    | "stop"
    | "length"
    | "tool-calls"
    | "content-filter"
    | "error"
    | "other"
    | "unknown";
  /** Phase 1 fills this in for tool-call agents. */
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  /** Snapshot of which model the runner actually used (for the trace). */
  modelId?: string;
  /**
   * Phase 1 / M0 — Engineer git workspace. Absolute path on the runner host
   * where this step executed (cwd of `claude -p`). `null` for runners that
   * have no workspace concept (e.g. the API runner) or when the local runner
   * skipped workspace prep (no ticketId, or `ENGINEER_REPO_URL` unset).
   * Persisted into `run_steps.payload.workspace_path` for the Run Inspector.
   */
  workspacePath: string | null;
};

export interface Runner {
  readonly id: string;
  readonly kind: RunnerKind;
  readonly capabilities: ReadonlyArray<string>;
  execute(step: AgentStep): Promise<StepResult>;
}
