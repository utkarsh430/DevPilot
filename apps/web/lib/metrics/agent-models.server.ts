import "server-only";

// Loads the facts the per-agent model pickers on `/agents` and `/scoreboard`
// render, and folds them through THE shared resolver.
//
// It computes no precedence of its own. Provider selection is `selectProvider`,
// the per-project answer is `resolveProjectModels` (lib/metrics/agent-model.ts —
// the same function `loadAgentScoreboard` calls), and the per-role answer is
// `describeRoleEffectiveModel`, which applies the compatibility rule and yields
// the `shadowed` outcome. That is the whole point: `/agents` and `/scoreboard`
// used to disagree about the same agent's model, and there is now no second
// place where a label could be derived differently.
//
// ── tenantId is REQUIRED and IS the boundary ───────────────────────────────
// The override read (`loadRoleModelOverridesForTenant`) is service-role with RLS
// off, so its co-located `.eq("tenant_id", …)` is the only thing keeping another
// tenant's overrides out of this workspace's pickers. Required rather than
// optional, because an optional parameter is the one callers forget.
//
// This module only READS. `setAgentProjectModelAction`
// (lib/metrics/model-actions.ts) is the single write path.

import { supabaseService } from "@/lib/db/server";
import { loadProjectsForTenant } from "@/lib/projects/load";
import {
  isLlmProvider,
  selectProvider,
  LLM_PROVIDER_CONFIG_KEY,
  type LlmProvider,
} from "@/lib/llm/provider";
import { describeRoleEffectiveModel, ladderRung } from "@/lib/llm/claude-model-ladder";
import { indexRoleModels, lookupRoleModel, type RoleModelIndex } from "@/lib/llm/role-model";
import { loadRoleModelOverridesForTenant } from "@/lib/llm/role-model.server";
import {
  resolveProjectModels,
  type ProjectModelRow,
  type ProjectProviderInput,
} from "@/lib/metrics/agent-model";
import {
  buildAgentGlobalTarget,
  buildAgentModelTargets,
  type AgentGlobalTarget,
  type AgentModelTarget,
  type ProjectModelFacts,
} from "@/lib/metrics/agent-model-view";

/** Everything both screens need to build a per-agent picker, loaded once. */
export type AgentModelContext = {
  projects: ProjectModelRow[];
  /** The raw provider rows, so a per-ROLE answer can be re-resolved per project. */
  providerRows: ProjectProviderInput[];
  tenantProvider: LlmProvider | null;
  /** The tenant's override rows split by scope: project-scoped and agent-wide. */
  overrides: RoleModelIndex;
};

/**
 * The tenant-level provider default (`tenants.config.llm_provider`).
 *
 * Read here rather than through the `server-only` `getTenantLlmProvider` for the
 * same reason `lib/metrics/agents.ts` does its own: keeping the precedence rule
 * itself in the pure `selectProvider` and only the IO here. A DB error swallows
 * to null so a Supabase blip cannot silently relabel every project's model.
 */
async function readTenantProvider(tenantId: string): Promise<LlmProvider | null> {
  try {
    const { data, error } = await supabaseService()
      .from("tenants")
      .select("config")
      // `tenants.id` IS the tenant — the scoped form for this table.
      .eq("id", tenantId)
      .maybeSingle();
    if (error || !data) return null;
    const raw = ((data.config ?? {}) as Record<string, unknown>)[LLM_PROVIDER_CONFIG_KEY];
    return isLlmProvider(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function loadAgentModelContext(tenantId: string): Promise<AgentModelContext> {
  const [projects, tenantProvider, overrideRows] = await Promise.all([
    loadProjectsForTenant(tenantId),
    readTenantProvider(tenantId),
    loadRoleModelOverridesForTenant(tenantId),
  ]);

  const providerRows: ProjectProviderInput[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    provider: p.llmProvider,
    baseUrl: p.llmBaseUrl,
    model: p.llmModel,
    credentialRef: p.llmCredentialRef,
  }));

  return {
    projects: resolveProjectModels({ projects: providerRows, tenantProvider }),
    providerRows,
    tenantProvider,
    overrides: indexRoleModels(overrideRows),
  };
}

/**
 * The picker rows for one role, over a given set of projects.
 *
 * `projectIds` is the caller's decision and the two screens differ deliberately:
 * `/scoreboard` passes the role's OWN `projectIds` (the projects its runs
 * actually touched — a row is a measurement, so its control targets what was
 * measured), while `/agents` passes every project in the workspace (a card is a
 * configuration surface, and an agent can be configured before it ever runs).
 * Neither ever collapses to a single project silently.
 */
export function agentModelTargets(
  roleSlug: string,
  projectIds: readonly string[],
  ctx: AgentModelContext,
): AgentModelTarget[] {
  const facts: ProjectModelFacts[] = ctx.providerRows.map((project) => {
    const selection = selectProvider({ project, tenantProvider: ctx.tenantProvider });
    // agent+project » agent-global, through the ONE pure precedence function the
    // engine's resolver uses.
    const winner = lookupRoleModel(ctx.overrides, project.id, roleSlug);
    const own = winner.scope === "project" ? winner.override : null;
    return {
      projectId: project.id,
      projectName: project.name,
      // The SAME function the engine's resolution and the scoreboard rollup use,
      // so a shadowed override renders as shadowed here too — including an
      // agent-wide model that this project's provider cannot serve.
      effective: describeRoleEffectiveModel({
        provider: selection.provider,
        projectModel: selection.model,
        override: winner.override,
      }),
      // The picker's selection is this project's OWN row only. Neither the
      // project-level model nor the agent-wide default is pre-selected here:
      // both are inherited, and pre-filling either would let a plain "Apply"
      // silently mint a per-project override nobody asked for — which would then
      // keep winning after the agent-wide default changed.
      currentValue: own ? (ladderRung(own.model)?.value ?? "") : "",
      hasOwnRow: own != null,
    };
  });
  return buildAgentModelTargets(projectIds, facts);
}

/**
 * The "All projects" row for one role: the agent-wide default, plus which of the
 * targeted projects override it.
 *
 * Takes the already-built `targets` rather than recomputing, so the count next
 * to "Clear N project overrides" can never disagree with the rows listed
 * underneath it.
 */
export function agentGlobalTarget(
  roleSlug: string,
  targets: readonly AgentModelTarget[],
  ctx: AgentModelContext,
): AgentGlobalTarget {
  const global = ctx.overrides.byRole.get(roleSlug) ?? null;
  return buildAgentGlobalTarget(global ? (ladderRung(global.model)?.value ?? "") : "", targets);
}

/** Both halves of one agent's control, so a caller cannot build the targets and
 *  the global from different inputs. */
export type AgentModelScope = { targets: AgentModelTarget[]; global: AgentGlobalTarget };

export function agentModelScope(
  roleSlug: string,
  projectIds: readonly string[],
  ctx: AgentModelContext,
): AgentModelScope {
  const targets = agentModelTargets(roleSlug, projectIds, ctx);
  return { targets, global: agentGlobalTarget(roleSlug, targets, ctx) };
}
