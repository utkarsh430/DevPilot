import "server-only";

// Document upload → project seed: the IO half of the LLM distill step.
//
// Copies `lib/stack/infer-capabilities.server.ts`'s shape: `generateObjectForTenant`
// (Haiku, temperature 0, a sharp Zod schema, a bounded timeout) is the ONLY way
// this module talks to a model — never a vendor SDK, never `generateObject` /
// `models.*` directly (AGENTS.md: that crashes with the raw env error in
// `claude_code` mode).
//
// Degrade contract (mirrors infer-capabilities' fallback ladder): this
// function's result type has NO `{ok:false}` branch. An LLM error, timeout,
// no-runner, an unparseable reply, or an empty distill all degrade to
// `seedFallback()` — the raw extracted text as the description, with
// `degraded: true`. Distilling a document must NEVER block project creation:
// during onboarding there is frequently no runner connected yet, and the
// operator can always edit the prefilled fields before submitting.

import { z } from "zod";
import { generateObjectForTenant } from "@/lib/llm/generate.server";
import {
  buildSeedPrompt,
  buildSeedSystemPrompt,
  normalizeSeed,
  seedFallback,
  SEED_DESCRIPTION_MAX,
  SEED_INSTRUCTIONS_MAX,
  SEED_NAME_MAX,
  type ProjectSeed,
} from "@/lib/projects/extract-seed";

export type ExtractProjectSeedResult =
  | { seed: ProjectSeed; degraded: false }
  | { seed: ProjectSeed; degraded: true; reason: string };

const seedSchema = z.object({
  name: z.string().max(SEED_NAME_MAX),
  description: z.string().max(SEED_DESCRIPTION_MAX),
  instructions: z.string().max(SEED_INSTRUCTIONS_MAX),
});

export async function distillProjectSeed(args: {
  tenantId: string;
  /** The bounded, already-extracted document text (see doc-extract.server.ts). */
  docText: string;
}): Promise<ExtractProjectSeedResult> {
  const fallback = () => seedFallback(args.docText);

  let result: Awaited<ReturnType<typeof generateObjectForTenant<z.infer<typeof seedSchema>>>>;
  try {
    result = await generateObjectForTenant({
      tenantId: args.tenantId,
      // Not project-scoped — the project doesn't exist yet. Resolves from the
      // tenant default down, same as any tenant-wide one-shot feature.
      projectId: null,
      featureName: "Document intake",
      tier: "cheap", // Haiku — a bounded summarise-into-a-fixed-shape task
      schema: seedSchema,
      schemaHint:
        '{"name":"<short project name or empty string>",' +
        '"description":"<one concrete paragraph>",' +
        '"instructions":"<distilled planning detail or empty string>"}',
      system: buildSeedSystemPrompt(),
      prompt: buildSeedPrompt(args.docText),
      maxTokens: 2_000,
      temperature: 0,
      // Bounded: a downed runner must not hang the create form's "Reading
      // document…" state — we degrade to raw text instead.
      timeoutMs: 60_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[project-seed] distillProjectSeed threw: ${msg}`);
    return { seed: fallback(), degraded: true, reason: msg.slice(0, 200) };
  }

  if (!result.ok) {
    return { seed: fallback(), degraded: true, reason: result.error };
  }

  const seed = normalizeSeed(result.object);
  // An empty description is not a usable seed — fall back to the raw text so the
  // operator has something to edit rather than a blank form.
  if (seed.description.length === 0) {
    return { seed: fallback(), degraded: true, reason: "The model returned an empty summary." };
  }

  return { seed, degraded: false };
}
