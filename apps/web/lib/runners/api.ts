// ApiRunner — the per-token API path via the Vercel AI SDK adapter. Stateless,
// horizontally scalable, multi-tenant safe. The default for any agent whose
// runner_policy is "api", and the ONLY path an OpenAI-compatible provider can
// take (the subscription runner is the Claude CLI — see lib/llm/provider.ts).

import { generateText } from "ai";
import { modelForProviderConfig } from "@/lib/llm/models-tenant";
import { resolveLlmProviderConfig } from "@/lib/llm/provider-config.server";
import { ensurePlatformSecretsLoaded } from "@/lib/platform-secrets/resolver";
import type { AgentStep, Runner, StepResult } from "@/lib/runners/types";

export class ApiRunner implements Runner {
  readonly id = "api";
  readonly kind = "api" as const;
  readonly capabilities = ["text"] as const;

  async execute(step: AgentStep): Promise<StepResult> {
    // Resolve the provider (endpoint + credential + model) from the step's own
    // tenant/project ids. Nothing about WHERE this call goes comes from the
    // caller — see provider-config.server.ts.
    await ensurePlatformSecretsLoaded(step.tenantId);
    const config = await resolveLlmProviderConfig({
      tenantId: step.tenantId,
      projectId: step.projectId ?? null,
      role: step.role ?? null,
    });
    const built = await modelForProviderConfig(config, step.modelTier);
    if (!built.ok) throw new Error(built.error);

    const res = await generateText({
      model: built.model,
      system: step.systemPrompt,
      prompt: step.prompt,
    });

    return {
      text: res.text,
      usage: res.usage,
      finishReason: res.finishReason as StepResult["finishReason"],
      modelId: built.modelId,
      // ApiRunner has no workspace concept — the LLM call is pure text in/out.
      workspacePath: null,
    };
  }
}
