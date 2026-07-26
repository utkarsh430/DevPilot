"use server";

// Stack advisor (Stage 5) — server actions.
//
// Two mount points share these actions (design doc §8.3):
//   - PlanSheet's `discussing` phase, where `sessionId` is set: the panel
//     reads the session's Q&A transcript for context, cost-gates through
//     `assertCanProceedPlan`, and persists the inference artifact
//     (`planning_sessions.required_capabilities` / `.stack_advice_status`).
//   - The project page's `StackCard`, for `generatePlan:false` projects that
//     never get a plan session: `sessionId` is omitted, there is no
//     transcript and no session budget to gate against (the same posture the
//     reference caller `lib/engine/dep-suggest.ts` takes for its single
//     bounded Haiku call — no plan session, no plan-session gate).
//
// Nothing is persisted, and nothing reaches a prompt, until the operator
// clicks "Save stack" (S8): `runStackAdvisorAction` is read-only against the
// durable stack (it only touches the *disposable* inference artifact on the
// session, never `project_stack_tags`); `saveStackAdvisorSelectionAction` is
// the only function in this file that writes the operator's chosen services.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { assertCanProceedPlan } from "@/lib/engine/budget";
import { loadProjectById } from "@/lib/projects/load";
import { inferCapabilities } from "@/lib/stack/infer-capabilities.server";
import type { CapabilitySuggestion } from "@/lib/stack/infer-capabilities";
import { getCapability, type CapabilityKey } from "@/lib/stack/capabilities";
import {
  checkCoherence,
  ECOSYSTEM_CHOICES,
  planStackSelection,
  type CapabilityPlan,
  type CoherenceWarning,
  type EcosystemChoice,
} from "@/lib/stack/rank";
import {
  loadProjectStackTags,
  loadStackSelection,
  persistStackSelection,
  replaceExtraStackTags,
} from "@/lib/stack/persist.server";
import { deriveStackFlavorFromEcosystem } from "@/lib/stack/rank";

// Rough upper-bound cost estimate for the velocity-bucket pre-check, same
// order of magnitude as the plan actions' EST_CENTS.leadReply (both are one
// bounded Haiku/Sonnet-tier call). The real cost isn't recorded against the
// session — `generateObjectForTenant` doesn't surface token usage on the
// local-cc route, the same reason `dep-suggest.ts` never calls
// `recordPlanSessionSpend` either.
const STACK_ADVISOR_EST_CENTS = 4;

// ─── shared: load a project + verify tenancy ────────────────────────────────

async function loadOwnedProject(projectId: string, tenantId: string) {
  const project = await loadProjectById(projectId);
  if (!project || project.tenantId !== tenantId) {
    throw new Error("project not found");
  }
  return project;
}

// ─── shared: pull {q, a} pairs out of a plan session's transcript ──────────
//
// `submitPlanAnswersAction` stores each answered question-panel turn as a
// user message with `metadata.answers` (the structured
// `{questionIdx, q, choice}[]` shape). Free-form user turns (the session's
// opening message, or a plain chat reply) carry no such structure — those
// are folded in as a single {q, a} pair so the model still sees them.
//
// Every string here is UNTRUSTED (operator-typed, but never assumed
// well-formed) — `buildInferencePrompt` fences it before it reaches the
// model; the length caps below are a second, independent bound.

type PendingAnswerChoice =
  | { kind: "option"; label: string }
  | { kind: "options"; labels: string[] }
  | { kind: "other"; text: string };

function choiceToText(choice: unknown): string {
  if (!choice || typeof choice !== "object") return "";
  const c = choice as Partial<PendingAnswerChoice> & Record<string, unknown>;
  if (c.kind === "option" && typeof c.label === "string") return c.label;
  if (c.kind === "options" && Array.isArray(c.labels)) {
    return c.labels.filter((l): l is string => typeof l === "string").join("; ");
  }
  if (c.kind === "other" && typeof c.text === "string") return c.text;
  return "";
}

async function loadAdvisorAnswers(
  sessionId: string,
  tenantId: string,
): Promise<Array<{ q: string; a: string }>> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_messages")
    .select("role, content, metadata")
    .eq("session_id", sessionId)
    .eq("tenant_id", tenantId)
    .eq("role", "user")
    .order("created_at", { ascending: true });
  if (error || !data) return [];

  const answers: Array<{ q: string; a: string }> = [];
  for (const row of data) {
    const metadata = row.metadata as Record<string, unknown> | null;
    const structured = metadata?.answers;
    if (Array.isArray(structured) && structured.length > 0) {
      for (const item of structured) {
        if (!item || typeof item !== "object") continue;
        const q =
          typeof (item as Record<string, unknown>).q === "string"
            ? ((item as Record<string, unknown>).q as string).slice(0, 400)
            : "";
        const a = choiceToText((item as Record<string, unknown>).choice).slice(0, 4_000);
        if (q || a) answers.push({ q, a });
      }
      continue;
    }
    const content = typeof row.content === "string" ? row.content.trim().slice(0, 4_000) : "";
    if (content.length > 0) {
      answers.push({ q: "Operator message", a: content });
    }
  }
  return answers;
}

// ─── 1. runStackAdvisorAction ───────────────────────────────────────────────

const RunStackAdvisorInput = z.object({
  projectId: z.string().uuid(),
  /** Omitted on the project-page path (no plan session exists). */
  sessionId: z.string().uuid().nullish(),
});

export type RunStackAdvisorResult =
  | {
      ok: true;
      ecosystem: EcosystemChoice;
      suggestions: CapabilitySuggestion[];
      plans: CapabilityPlan[];
      coherence: CoherenceWarning[];
      degraded: boolean;
      degradedReason: string | null;
    }
  | { ok: false; error: string };

export async function runStackAdvisorAction(
  input: z.infer<typeof RunStackAdvisorInput>,
): Promise<RunStackAdvisorResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = RunStackAdvisorInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { projectId, sessionId } = parsed.data;

  let project;
  try {
    project = await loadOwnedProject(projectId, tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "project lookup failed" };
  }

  const supabase = supabaseService();
  let answers: Array<{ q: string; a: string }> = [];

  if (sessionId) {
    const { data: session, error: sessErr } = await supabase
      .from("planning_sessions")
      .select("id, tenant_id, project_id, status")
      .eq("id", sessionId)
      .maybeSingle();
    if (sessErr || !session) return { ok: false, error: "planning session not found" };
    if (session.tenant_id !== tenantId || session.project_id !== projectId) {
      return { ok: false, error: "planning session does not belong to this project" };
    }
    if (session.status !== "discussing") {
      return {
        ok: false,
        error: `session is ${session.status}; the stack advisor only runs while discussing`,
      };
    }

    try {
      await assertCanProceedPlan({
        tenantId,
        projectId,
        sessionId,
        estCents: STACK_ADVISOR_EST_CENTS,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    await supabase
      .from("planning_sessions")
      .update({ stack_advice_status: "inferring" })
      .eq("id", sessionId);

    answers = await loadAdvisorAnswers(sessionId, tenantId);
  }

  const result = await inferCapabilities({
    tenantId,
    projectId,
    projectName: project.name,
    projectType: project.projectType,
    description: project.description ?? "",
    answers,
    ecosystem: project.stackEcosystem,
  });

  const capabilities = result.suggestions.map((s) => s.key);

  // Feed the project's ALREADY-saved selection (if any) as the ranker's
  // `currentSelections`, so the D8 cross-capability affinity (e.g. prefer
  // pgvector when the project already has Postgres) sees prior choices, not
  // just choices made earlier in this same ranking pass.
  const existing = await loadStackSelection({ tenantId, projectId });
  const currentSelections = existing.map((e) => ({
    capability: e.capability.key,
    serviceKey: e.service.key,
  }));

  const plans = planStackSelection({
    capabilities,
    ecosystem: project.stackEcosystem,
    currentSelections,
  });
  const coherence = checkCoherence({
    ecosystem: project.stackEcosystem,
    selections: plans
      .filter((p) => p.preselectedKey)
      .map((p) => ({ capability: p.capability.key, serviceKey: p.preselectedKey })),
  });

  if (sessionId) {
    await supabase
      .from("planning_sessions")
      .update({
        stack_advice_status: "ready",
        required_capabilities: capabilities,
      })
      .eq("id", sessionId);
  }

  return {
    ok: true,
    ecosystem: project.stackEcosystem,
    suggestions: result.suggestions,
    plans,
    coherence,
    degraded: result.degraded,
    degradedReason: result.degraded ? result.reason : null,
  };
}

// ─── 2. saveStackAdvisorSelectionAction ─────────────────────────────────────
//
// The ONLY function in this file that writes to `project_stack_tags` /
// `projects.stack_ecosystem`. Called exclusively from the panel's "Save
// stack" button — selection state up to this point is React-local (S8).

const SaveSelectionInput = z.object({
  capability: z.string().min(1).max(60),
  serviceKey: z.string().min(1).max(120),
  recommendedServiceKey: z.string().min(1).max(120),
});

const SaveStackAdvisorInput = z.object({
  projectId: z.string().uuid(),
  sessionId: z.string().uuid().nullish(),
  ecosystem: z.enum(ECOSYSTEM_CHOICES as [EcosystemChoice, ...EcosystemChoice[]]),
  selections: z.array(SaveSelectionInput).max(40),
  /** The "Advanced: extra services" disclosure's ticked set — services
   *  outside the capability taxonomy. Replaces the project's whole
   *  `capability IS NULL` partition; omit/empty clears it. */
  extraServiceKeys: z.array(z.string().min(1).max(120)).max(60).default([]),
});

export type SaveStackAdvisorResult = { ok: true } | { ok: false; error: string };

export async function saveStackAdvisorSelectionAction(
  input: z.infer<typeof SaveStackAdvisorInput>,
): Promise<SaveStackAdvisorResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = SaveStackAdvisorInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { projectId, sessionId, ecosystem, selections, extraServiceKeys } = parsed.data;

  try {
    await loadOwnedProject(projectId, tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "project lookup failed" };
  }

  // Re-validated through the catalog gates inside persistStackSelection
  // regardless — this narrows the type for the call below and drops any
  // capability key that isn't in the closed taxonomy before it even gets
  // there.
  const validSelections = selections.flatMap((sel) => {
    const capability = getCapability(sel.capability);
    if (!capability) return [];
    return [
      {
        capability: capability.key as CapabilityKey,
        serviceKey: sel.serviceKey,
        recommendedServiceKey: sel.recommendedServiceKey,
      },
    ];
  });

  const ok = await persistStackSelection({ tenantId, projectId, selections: validSelections });
  if (!ok) return { ok: false, error: "failed to save the stack selection" };

  const extrasOk = await replaceExtraStackTags({
    tenantId,
    projectId,
    serviceKeys: extraServiceKeys,
  });
  if (!extrasOk) return { ok: false, error: "failed to save the extra services" };

  const supabase = supabaseService();
  const { error: ecoErr } = await supabase
    .from("projects")
    .update({ stack_ecosystem: ecosystem })
    .eq("id", projectId)
    .eq("tenant_id", tenantId);
  if (ecoErr) {
    console.warn(
      `[stack-advisor] failed to persist ecosystem for project ${projectId}: ${ecoErr.message}`,
    );
  }

  if (sessionId) {
    const tags = await loadProjectStackTags({ tenantId, projectId });
    const flavor = deriveStackFlavorFromEcosystem(
      ecosystem,
      tags.map((t) => ({ provider: t.provider })),
    );
    await supabase
      .from("planning_sessions")
      .update({ stack_advice_status: "accepted", stack_flavor: flavor })
      .eq("id", sessionId)
      .eq("tenant_id", tenantId);
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// ─── 3. skipStackAdvisorAction ──────────────────────────────────────────────
//
// The operator dismissed the panel for this session. The frame then behaves
// exactly as it did pre-advisor (whatever manual tags exist, or none) —
// `skipped` is a terminal-for-this-session state, distinct from `unrun`, so
// the panel doesn't keep re-offering itself every time the Sheet re-renders.

const SkipStackAdvisorInput = z.object({ sessionId: z.string().uuid() });

export async function skipStackAdvisorAction(
  input: z.infer<typeof SkipStackAdvisorInput>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireUser();
  const tenantId = await requireTenantId();
  const parsed = SkipStackAdvisorInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const supabase = supabaseService();
  const { error } = await supabase
    .from("planning_sessions")
    .update({ stack_advice_status: "skipped" })
    .eq("id", parsed.data.sessionId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
