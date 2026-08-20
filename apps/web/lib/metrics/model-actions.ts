"use server";

// The model-pinning actions, at three scopes: PROJECT, AGENT × PROJECT, and
// AGENT-WIDE (all projects).
//
// ── SCOPE: there are now TWO, and each says which it is ────────────────────
// This file originally shipped only `setProjectClaudeModelAction` and recorded a
// genuine per-role override as the REJECTED alternative — it needed a migration,
// a new precedence rung inside the one seam every run resolves through, and a
// story for an `openai_compatible` project that cannot serve Claude at all.
//
// That decision has been SUPERSEDED, and all three costs are paid rather than
// dodged: `agent_project_models` (migration 20260737000000) is the table, the
// rung is applied in `resolveLlmProviderConfig` as a separate MODEL axis that
// never touches the atomic provider decision, and the third is the compatibility
// rule in lib/llm/role-model.ts (a Claude model on an OpenAI-compatible project
// is ignored and logged, never forwarded — forwarding it would 404 the endpoint
// mid-run, strictly worse than the no-op).
//
// The motivating defect is worth restating, because it is what makes the
// per-agent control obligatory rather than nice: `role_config.modelTier` already
// existed, was already written by the JD synthesizer and the visual builder, and
// was already RENDERED as a per-agent model badge — while being a documented
// NO-OP on the local-cc path, i.e. on every normal ticket run. A settable value
// that silently does nothing is the one outcome this must not repeat, which is
// why `describeEffectiveModel` gained a `shadowed` outcome instead of letting a
// UI assert a model that never takes effect.
//
// The PROJECT control stays: the two levels are both wanted, and the project one
// is the right answer for "raise everything on this board".
//
// ── Guards ─────────────────────────────────────────────────────────────────
//  • operator-gated: requireUser() + requireTenantId().
//  • the write is service-role and carries a CO-LOCATED .eq("tenant_id", …) —
//    RLS is off for the service client, so that predicate is the whole boundary.
//    An `.eq("id", projectId)` alone would let any signed-in user of any tenant
//    repoint another tenant's project at a different model.
//  • the model string is NEVER trusted: it must be in CLAUDE_MODEL_LADDER *and*
//    in ALLOWED_CLAUDE_MODELS (the same allowlist `resolveClaudeModelArg` gates
//    the `claude -p --model` argv on). Free text is refused outright.
//  • the columns are produced by `validateProviderConfig`, the ONE write path for
//    a project's provider config, so the SSRF/base-URL rules cannot be bypassed
//    by adding a second writer here.

import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { validateProviderConfig } from "@/lib/llm/project-provider.server";
import { ACCOUNT_DEFAULT_VALUE, isOfferedClaudeModel } from "@/lib/llm/claude-model-ladder";
import {
  clearGlobalRoleModel,
  clearProjectRoleModels,
  clearRoleModel,
  upsertGlobalRoleModel,
  upsertRoleModel,
} from "@/lib/llm/role-model-write";

export type SetProjectModelResult = { ok: true } | { ok: false; error: string };

/**
 * Pin (or clear) the Claude model for one project.
 *
 * `model === ""` clears the override entirely — provider AND model back to NULL,
 * i.e. full inherit from the tenant/instance layer. We do not write
 * `provider: "anthropic", model: null` for that case: it looks like a no-op but
 * would pin the project to Anthropic and quietly override a tenant that had
 * selected an OpenAI-compatible default.
 */
export async function setProjectClaudeModelAction(input: {
  projectId: string;
  model: string;
}): Promise<SetProjectModelResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const model = (input.model ?? "").trim();
  const clearing = model === ACCOUNT_DEFAULT_VALUE;
  if (!clearing && !isOfferedClaudeModel(model)) {
    // Deliberately does not echo the submitted value back into the UI.
    return { ok: false, error: "That is not a model this workspace offers." };
  }

  const supabase = supabaseService();
  // Read the project through the tenant predicate first — both to 404 a foreign
  // id and to refuse a project whose provider is not Claude at all.
  const { data: project, error: readErr } = await supabase
    .from("projects")
    .select("id, name, llm_provider")
    .eq("id", input.projectId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (readErr) {
    console.error("[metrics/model-actions] project read failed:", readErr);
    return { ok: false, error: "Could not read that project." };
  }
  if (!project) return { ok: false, error: "Project not found in this workspace." };

  if (project.llm_provider === "openai_compatible") {
    return {
      ok: false,
      error:
        "This project runs on a custom OpenAI-compatible endpoint, not Claude. Change its provider in project settings first.",
    };
  }

  const validated = await validateProviderConfig(
    clearing
      ? { provider: null, baseUrl: null, model: null }
      : { provider: "anthropic", baseUrl: null, model },
  );
  if (!validated.ok) return { ok: false, error: validated.error };

  const { error: writeErr } = await supabase
    .from("projects")
    .update(validated.columns)
    .eq("id", input.projectId)
    // THE tenant boundary for this service-role write. Never remove.
    .eq("tenant_id", tenantId);
  if (writeErr) {
    console.error("[metrics/model-actions] project model write failed:", writeErr);
    return { ok: false, error: "Could not save that model." };
  }

  revalidatePath("/scoreboard");
  revalidatePath("/agents");
  return { ok: true };
}

export type SetAgentProjectModelResult = { ok: true } | { ok: false; error: string };

/**
 * Pin (or clear) the Claude model for ONE ROLE on ONE PROJECT — the top rung of
 * agent+project » project » tenant » instance » env.
 *
 * `model === null` (or the account-default sentinel) CLEARS the override by
 * DELETING the row. "No row" is the single representation of "inherit": a row
 * with an empty model would be a second one, and the two would drift.
 *
 * ── Keyed on the ROLE SLUG, not agents.id ─────────────────────────────────
 * Dispatch attributes work by `COALESCE(runs.fan_out_role, agents.role)`, and a
 * fan-out sibling carries no `agent_id` at all. An override keyed on an agent
 * row would silently miss every fan-out run — the same class of half-reaching
 * value this whole feature exists to end.
 *
 * ── Guards (identical shape to the project action above) ──────────────────
 *  • operator-gated: requireUser() + requireTenantId(). The tenant comes from
 *    the SESSION, never from the caller.
 *  • the model is validated against the offered ladder AND ALLOWED_CLAUDE_MODELS
 *    — the same allowlist `resolveClaudeModelArg` gates the `claude -p --model`
 *    argv on. Free text is refused outright.
 *  • the columns come from `validateProviderConfig`, the ONE write path for a
 *    provider config, so this does not grow a second validator whose rules can
 *    drift from the SSRF/base-URL ones.
 *  • the project is read through the tenant predicate (404s a foreign id) and
 *    every write carries a CO-LOCATED .eq("tenant_id", …). RLS is off for the
 *    service client, so that predicate is the whole boundary — an .eq on the
 *    project/role alone would let any signed-in user of any tenant repoint
 *    another tenant's agents.
 *  • an `openai_compatible` project is REFUSED rather than silently stored as a
 *    shadowed row: at write time we know it can never take effect, and the
 *    `shadowed` display state exists for rows whose project CHANGED provider
 *    afterwards, not as a place to file writes we could have rejected.
 */
export async function setAgentProjectModelAction(input: {
  projectId: string;
  roleSlug: string;
  /** null / "" clears the override. */
  model: string | null;
}): Promise<SetAgentProjectModelResult> {
  const user = await requireUser();
  const tenantId = await requireTenantId();

  const roleSlug = (input.roleSlug ?? "").trim();
  if (!roleSlug) return { ok: false, error: "No agent named." };

  const model = (input.model ?? "").trim();
  const clearing = model === ACCOUNT_DEFAULT_VALUE;
  if (!clearing && !isOfferedClaudeModel(model)) {
    // Deliberately does not echo the submitted value back into the UI.
    return { ok: false, error: "That is not a model this workspace offers." };
  }

  const supabase = supabaseService();
  const { data: project, error: readErr } = await supabase
    .from("projects")
    .select("id, llm_provider")
    .eq("id", input.projectId)
    // THE tenant boundary for this service-role read. Never remove.
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (readErr) {
    console.error("[metrics/model-actions] project read failed:", readErr);
    return { ok: false, error: "Could not read that project." };
  }
  if (!project) return { ok: false, error: "Project not found in this workspace." };

  // CLEARING is handled BEFORE the openai_compatible refusal, deliberately: a
  // project that switched provider AFTER an override was written is exactly the
  // case that produces a `shadowed` row, and the operator must be able to delete
  // it. Refusing the clear would strand the inert row with no way to remove it.
  if (clearing) {
    const cleared = await clearRoleModel(supabase, {
      tenantId,
      projectId: input.projectId,
      roleSlug,
    });
    if (!cleared.ok) return cleared;
    revalidatePath("/scoreboard");
    revalidatePath("/agents");
    return { ok: true };
  }

  if (project.llm_provider === "openai_compatible") {
    return {
      ok: false,
      error:
        "This project runs on a custom OpenAI-compatible endpoint, not Claude — a Claude model set here would not be used. Change its provider in project settings first.",
    };
  }

  // Through the ONE provider-config validator, so the model rules cannot drift
  // from the project write path's. Only `llm_model` is consumed; the provider is
  // pinned to `anthropic` because that is what the ladder's values ARE, and it is
  // what the compatibility rule will compare against at resolution time.
  const validated = await validateProviderConfig({
    provider: "anthropic",
    baseUrl: null,
    model,
  });
  if (!validated.ok) return { ok: false, error: validated.error };
  const validModel = validated.columns.llm_model;
  if (!validModel) return { ok: false, error: "Could not save that model." };

  const written = await upsertRoleModel(supabase, {
    tenantId,
    projectId: input.projectId,
    roleSlug,
    provider: "anthropic",
    model: validModel,
    createdBy: user.id,
  });
  if (!written.ok) return written;

  revalidatePath("/scoreboard");
  revalidatePath("/agents");
  return { ok: true };
}

export type SetAgentGlobalModelResult = { ok: true } | { ok: false; error: string };

/**
 * Pin (or clear) the AGENT-WIDE default model for one role — the second rung of
 * agent+project » agent-global » project » tenant » instance » env.
 *
 * This is the "set it once for this agent" case. It is stored as an
 * `agent_project_models` row with a NULL `project_id`, so it covers every
 * project in the workspace INCLUDING ones created later — which a fan-out over
 * today's project list could not do.
 *
 * ── It does NOT touch per-project rows ────────────────────────────────────
 * A project-scoped row keeps winning. That is the whole precedence rule, and
 * clearing those rows here to make the global "look like it worked" would delete
 * choices the operator made, silently, from a control that did not say it would.
 * The UI states how many projects override the global and offers
 * `clearAgentProjectModelOverridesAction` as a separate, named action.
 *
 * ── No openai_compatible refusal here, deliberately ───────────────────────
 * The per-project action refuses such a project because at write time it knows
 * the value can never take effect. A global names no project, so there is
 * nothing to check — and refusing it because SOME project in the workspace runs
 * a custom endpoint would block the common case for the uncommon one. The
 * COMPATIBILITY RULE covers it at resolution: on such a project the Claude model
 * is ignored and logged, never forwarded (forwarding would 404 that endpoint
 * mid-run), and the popover renders that project's row as not in effect.
 *
 * Guards are otherwise identical to the per-project action: operator-gated, the
 * tenant from the SESSION, the model validated against the offered ladder AND
 * ALLOWED_CLAUDE_MODELS through the one `validateProviderConfig` seam, and every
 * write carrying a co-located tenant predicate (RLS is off for the service
 * client, so that predicate is the whole boundary).
 */
export async function setAgentGlobalModelAction(input: {
  roleSlug: string;
  /** null / "" clears the agent-wide default. */
  model: string | null;
}): Promise<SetAgentGlobalModelResult> {
  const user = await requireUser();
  const tenantId = await requireTenantId();

  const roleSlug = (input.roleSlug ?? "").trim();
  if (!roleSlug) return { ok: false, error: "No agent named." };

  const model = (input.model ?? "").trim();
  const supabase = supabaseService();

  if (model === ACCOUNT_DEFAULT_VALUE) {
    const cleared = await clearGlobalRoleModel(supabase, { tenantId, roleSlug });
    if (!cleared.ok) return cleared;
    revalidatePath("/scoreboard");
    revalidatePath("/agents");
    return { ok: true };
  }

  if (!isOfferedClaudeModel(model)) {
    // Deliberately does not echo the submitted value back into the UI.
    return { ok: false, error: "That is not a model this workspace offers." };
  }

  const validated = await validateProviderConfig({ provider: "anthropic", baseUrl: null, model });
  if (!validated.ok) return { ok: false, error: validated.error };
  const validModel = validated.columns.llm_model;
  if (!validModel) return { ok: false, error: "Could not save that model." };

  const written = await upsertGlobalRoleModel(supabase, {
    tenantId,
    roleSlug,
    provider: "anthropic",
    model: validModel,
    createdBy: user.id,
  });
  if (!written.ok) return written;

  revalidatePath("/scoreboard");
  revalidatePath("/agents");
  return { ok: true };
}

export type ClearAgentProjectModelOverridesResult =
  | { ok: true; cleared: number }
  | { ok: false; error: string };

/**
 * Drop this role's project-scoped overrides so those projects fall back to the
 * agent-wide default.
 *
 * Explicitly operator-invoked ("Clear N project overrides") and never a side
 * effect of setting a global — see `setAgentGlobalModelAction`.
 *
 * `projectIds` is CLIENT-SUPPLIED, which makes the co-located tenant predicate
 * on the delete strictly more load-bearing than on the single-row path: a forged
 * uuid list is the obvious attack and `.eq("tenant_id", …)` is the only thing
 * that stops it. The action never accepts a tenant id from the caller.
 */
export async function clearAgentProjectModelOverridesAction(input: {
  roleSlug: string;
  projectIds: string[];
}): Promise<ClearAgentProjectModelOverridesResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const roleSlug = (input.roleSlug ?? "").trim();
  if (!roleSlug) return { ok: false, error: "No agent named." };

  const projectIds = [...new Set((input.projectIds ?? []).filter((id) => typeof id === "string"))];
  if (projectIds.length === 0) return { ok: true, cleared: 0 };

  const cleared = await clearProjectRoleModels(supabaseService(), {
    tenantId,
    roleSlug,
    projectIds,
  });
  if (!cleared.ok) return cleared;

  revalidatePath("/scoreboard");
  revalidatePath("/agents");
  return { ok: true, cleared: projectIds.length };
}
