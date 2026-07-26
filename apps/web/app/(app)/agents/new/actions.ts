"use server";

// Server actions for the M5 JD-to-role synthesizer.
//
//  synthesizeRoleAction — runs a Sonnet call against the pasted job description,
//                         returns a structured `RoleConfig` draft for editing.
//  createCustomRoleAction — persists the (operator-edited) draft as an `agents`
//                           row. The role config lives under `agents.config.role_config`
//                           where `lib/roles/load.ts` finds it at dispatch time.
//
// The synthesizer prompt is deliberately strict: every custom role is required
// to call `devpilot_move_ticket` to advance, mirroring the M4 tool-driven roles.
// This is why postprocess.ts routes unknown role slugs through the
// `applyToolDrivenPost` default branch — keeps the contract consistent.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import type { ModelTier } from "@/lib/llm/models";
import { generateObjectForTenant } from "@/lib/llm/generate.server";
import type { RunnerKind } from "@/lib/runners/types";
import type { TicketStatus } from "@/lib/board/state";
import { isBuiltinRole } from "@/lib/roles/load";

const MODEL_TIER_VALUES = ["default", "heavy", "cheap"] as const satisfies readonly ModelTier[];
const RUNNER_KIND_VALUES = ["api", "local-cc"] as const satisfies readonly RunnerKind[];
const ON_SUCCESS_VALUES = ["in_review", "done", "ready"] as const satisfies readonly TicketStatus[];

const SLUG_REGEX = /^[a-z][a-z0-9_]{1,30}$/;

const SynthesizedRoleSchema = z.object({
  slug: z
    .string()
    .regex(SLUG_REGEX)
    .describe(
      "Lowercase identifier, snake_case, 2-31 chars. Stable key used as the role slug everywhere.",
    ),
  displayName: z
    .string()
    .min(2)
    .max(60)
    .describe("Human-readable role name shown in comments and the Run Inspector."),
  systemPrompt: z
    .string()
    .min(120)
    .max(8_000)
    .describe(
      "Full system prompt. MUST instruct the role to call `devpilot_move_ticket` to advance the ticket and `devpilot_comment` to leave a summary. Reference the ticketId provided in the user message.",
    ),
  modelTier: z
    .enum(MODEL_TIER_VALUES)
    .describe(
      "default = Sonnet (most tasks), heavy = Opus (complex reasoning), cheap = Haiku (classification).",
    ),
  runnerPolicy: z
    .enum(RUNNER_KIND_VALUES)
    .describe(
      "api = ApiRunner (per-token Anthropic, no tools); local-cc = Local Claude Code (file/bash/MCP tools available).",
    ),
  onSuccessStatus: z
    .enum(ON_SUCCESS_VALUES)
    .describe(
      "Where the ticket lands on success. For most review-style roles use `in_review`; for terminal roles use `done`.",
    ),
});

export type SynthesizedRole = z.infer<typeof SynthesizedRoleSchema>;

export type SynthesizeResult = { ok: true; draft: SynthesizedRole } | { ok: false; error: string };

const SYNTH_SYSTEM_PROMPT = `You are a role designer for DevPilot, an AI agent orchestration platform.
Given a job description (JD), produce a single specialised agent role that can pick up tickets matching that job and drive them to completion.

Hard constraints on what you produce:
- The system prompt MUST tell the role to call the MCP tool \`devpilot_move_ticket(ticketId, status, reason)\` to advance the ticket. Always.
- The system prompt MUST tell the role to call \`devpilot_comment(ticketId, body)\` with its substantive output (a draft, a verdict, a plan, etc.) BEFORE moving the ticket.
- The system prompt MUST reference \`ticketId\` as a value provided in the user message.
- The system prompt MUST forbid the role from emitting verdict-style text in the assistant message instead of calling the tools.
- The slug must be lowercase snake_case.
- Choose modelTier based on cognitive load: default (Sonnet) for most things, heavy (Opus) only when the JD explicitly needs deep reasoning (security review, architecture, complex synthesis), cheap (Haiku) only for classification/routing.
- runnerPolicy: ALWAYS choose "local-cc" by default. The local Claude Code runner is the default everywhere in this platform — it runs on the operator's own subscription with full file/bash/git tools and is the right answer for ~every role. Only pick "api" when the JD describes a multi-tenant or external-customer-facing endpoint where per-token billing is required.
- onSuccessStatus: "in_review" for roles that produce work for a downstream reviewer (most cases); "done" only for terminal verdict roles.`;

// JSON shape spelled out for the local-cc path — `claude -p` returns free
// text, so `generateObjectForTenant` embeds this hint in its output contract.
// Keep in lockstep with `SynthesizedRoleSchema` above.
const SYNTH_SCHEMA_HINT = [
  "{",
  '  "slug": "<lowercase snake_case identifier, 2-31 chars, must match ^[a-z][a-z0-9_]{1,30}$>",',
  '  "displayName": "<human-readable role name, 2-60 chars>",',
  '  "systemPrompt": "<full system prompt, 120-8000 chars, obeying every hard constraint>",',
  '  "modelTier": "default" | "heavy" | "cheap",',
  '  "runnerPolicy": "api" | "local-cc",',
  '  "onSuccessStatus": "in_review" | "done" | "ready"',
  "}",
].join("\n");

// Local-cc ceiling: role synthesis emits up to ~8 KB of system prompt, which
// on a cold-started `claude -p` can outlive the bridge's 2-min default.
const SYNTH_TIMEOUT_MS = 180_000;

export async function synthesizeRoleAction(jd: string): Promise<SynthesizeResult> {
  await requireUser();
  const tenantId = await requireTenantId();
  const trimmed = jd.trim();
  if (trimmed.length < 50) {
    return { ok: false, error: "Job description is too short (need at least 50 characters)." };
  }
  if (trimmed.length > 6_000) {
    return { ok: false, error: "Job description is too long (limit 6000 characters)." };
  }
  // Auth-mode-aware: claude_code tenants (the default) synthesize on their own
  // Claude Code subscription via the local runner; api_key tenants use the
  // direct API with the tenant-resolved key. Never the raw env getter.
  const res = await generateObjectForTenant({
    tenantId,
    featureName: "Role synthesis",
    tier: "default",
    system: SYNTH_SYSTEM_PROMPT,
    schema: SynthesizedRoleSchema,
    schemaHint: SYNTH_SCHEMA_HINT,
    prompt: `Job description:\n\n${trimmed}\n\nProduce the RoleConfig for an agent that fits this JD.`,
    timeoutMs: SYNTH_TIMEOUT_MS,
  });
  if (!res.ok) {
    return { ok: false, error: res.error };
  }
  return { ok: true, draft: res.object };
}

const CreateRoleInput = SynthesizedRoleSchema;

export type CreateRoleResult =
  | { ok: true; agentId: string; slug: string }
  | { ok: false; error: string };

export async function createCustomRoleAction(
  input: z.infer<typeof CreateRoleInput>,
): Promise<CreateRoleResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = CreateRoleInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { slug } = parsed.data;
  if (isBuiltinRole(slug)) {
    return {
      ok: false,
      error: `slug "${slug}" collides with a built-in role; pick a different identifier`,
    };
  }

  const supabase = supabaseService();

  // Refuse to overwrite an existing custom role of the same slug. Operators
  // can manually edit `agents.config.role_config` if they want to revise; a
  // full versioning UX is out of M5 scope.
  const { count, error: countErr } = await supabase
    .from("agents")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("role", slug);
  if (countErr) return { ok: false, error: countErr.message };
  if ((count ?? 0) > 0) {
    return { ok: false, error: `a role with slug "${slug}" already exists in this tenant` };
  }

  const { data, error } = await supabase
    .from("agents")
    .insert({
      tenant_id: tenantId,
      name: parsed.data.displayName,
      role: slug,
      config: {
        // Mirrors the JSON shape `lib/roles/load.ts::loadCustomRoleConfig`
        // expects. `wip_limit` defaults to dispatcher's DEFAULT_WIP_LIMIT
        // when omitted, so we don't fix it here.
        role_config: {
          displayName: parsed.data.displayName,
          systemPrompt: parsed.data.systemPrompt,
          modelTier: parsed.data.modelTier,
          runnerPolicy: parsed.data.runnerPolicy,
          onSuccessStatus: parsed.data.onSuccessStatus,
        },
        source: "jd-synth",
      },
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };

  revalidatePath("/agents");
  return { ok: true, agentId: data.id as string, slug };
}
