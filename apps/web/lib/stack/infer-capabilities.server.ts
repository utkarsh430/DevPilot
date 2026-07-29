import "server-only";

// Stack advisor — AI inference (Stage 5). IO half: the actual model call.
//
// Copies `lib/engine/dep-suggest.ts`'s shape almost verbatim — the canonical
// grounded-to-a-closed-set caller in this repo: Haiku, temperature 0, a sharp
// Zod schema, a bounded timeout, and a post-filter of the model's output
// against the candidate set (here, the capability taxonomy).
//
// `generateObjectForTenant` is the ONLY way this module talks to a model —
// never a vendor SDK, never `generateObject`/`models.*` directly (AGENTS.md:
// that crashes with the raw env error in `claude_code` mode). It is also
// auth-mode- and WI-12-provider-aware: passing `projectId` makes the advisor
// honour the project's configured LLM provider for free.
//
// Fallback ladder (§4.5): this function's result type has NO `{ok: false}`
// branch. LLM error, timeout, an unparseable reply, or an empty suggestion
// list all degrade to `fallbackCapabilities()` with `degraded: true` — a
// downed runner or a rate limit must never be able to block a project from
// planning.

import { z } from "zod";
import { CAPABILITY_ENUM } from "@/lib/stack/capabilities";
import {
  buildInferencePrompt,
  buildInferenceSystemPrompt,
  fallbackCapabilities,
  normalizeSuggestions,
  type CapabilitySuggestion,
} from "@/lib/stack/infer-capabilities";
import type { EcosystemChoice } from "@/lib/stack/rank";
import type { ProjectType } from "@/lib/projects/project-type";
import { generateObjectForTenant } from "@/lib/llm/generate.server";

export type InferCapabilitiesResult =
  | { ok: true; suggestions: CapabilitySuggestion[]; degraded: false }
  | { ok: true; suggestions: CapabilitySuggestion[]; degraded: true; reason: string };

const inferenceSchema = z.object({
  capabilities: z
    .array(
      z.object({
        key: z.enum(CAPABILITY_ENUM), // the grounding — enforced by Zod on BOTH LLM routes
        confidence: z.number().int().min(0).max(10),
        why: z.string().max(120),
      }),
    )
    .max(CAPABILITY_ENUM.length),
});

export async function inferCapabilities(args: {
  tenantId: string;
  projectId: string; // WI-12: an openai_compatible project routes to the API path
  projectName: string;
  projectType: ProjectType | null;
  description: string;
  answers: ReadonlyArray<{ q: string; a: string }>;
  ecosystem: EcosystemChoice;
}): Promise<InferCapabilitiesResult> {
  const fallback = () => fallbackCapabilities(args.projectType);

  let result: Awaited<ReturnType<typeof generateObjectForTenant<z.infer<typeof inferenceSchema>>>>;
  try {
    result = await generateObjectForTenant({
      tenantId: args.tenantId,
      projectId: args.projectId,
      featureName: "Stack advisor",
      tier: "cheap", // Haiku (D7) — a closed-set multi-label classification
      schema: inferenceSchema,
      schemaHint:
        '{"capabilities":[{"key":"<one of the listed capability keys, verbatim>",' +
        '"confidence":<integer 0-10>,"why":"<one short clause, max 120 chars>"}]}',
      system: buildInferenceSystemPrompt(),
      prompt: buildInferencePrompt({
        projectName: args.projectName,
        projectType: args.projectType,
        description: args.description,
        answers: args.answers,
        ecosystem: args.ecosystem,
      }),
      maxTokens: 900,
      temperature: 0,
      // Bounded: a downed runner must not hang the PlanSheet's "Suggest my
      // stack" click.
      timeoutMs: 60_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[stack-advisor] inferCapabilities threw for project ${args.projectId}: ${msg}`);
    return { ok: true, suggestions: fallback(), degraded: true, reason: msg.slice(0, 200) };
  }

  if (!result.ok) {
    return { ok: true, suggestions: fallback(), degraded: true, reason: result.error };
  }

  // Layer 2 of the grounding (§4.4): re-derive every returned key through
  // getCapability() regardless of the schema's z.enum having already run.
  const suggestions = normalizeSuggestions(result.object.capabilities);
  if (suggestions.length === 0) {
    // An empty stack is never a valid answer for an app about to be built.
    return {
      ok: true,
      suggestions: fallback(),
      degraded: true,
      reason: "The model returned no capabilities.",
    };
  }

  return { ok: true, suggestions, degraded: false };
}
