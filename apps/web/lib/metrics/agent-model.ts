// THE shared "what model does this agent actually run on" resolver.
//
// PURE: no `server-only`, no DB. Both screens that show an agent's model read it
// from here.
//
// ── Why this is shared rather than computed per screen ─────────────────────
// /agents and /scoreboard disagreed about the same agent. /agents rendered the
// static catalog `role_config.modelTier` — a value that has been a documented
// NO-OP on the local-cc path since it shipped — while /scoreboard rendered the
// model the provider chain actually resolves. Two screens, one agent, two
// answers, one of them false. Lifting the resolution into one exported function
// is what makes a repeat structurally impossible: there is no second place to
// compute it.
//
// The precedence itself is not re-implemented here either. Provider selection is
// `selectProvider` (the same pure function the engine calls) and the role rung is
// `applyRoleModelOverride` (likewise), so a label cannot drift from what a run
// will do.

import { selectProvider, type LlmProvider, type ProjectProviderRow } from "@/lib/llm/provider";
import {
  describeEffectiveModel,
  describeRoleEffectiveModel,
  formatEffectiveModel,
  type EffectiveModel,
} from "@/lib/llm/claude-model-ladder";
import { indexRoleModels, lookupRoleModel, type RoleModelRow } from "@/lib/llm/role-model";

/** A project's LLM model, as the provider chain actually resolves it — before
 *  any per-role override (that is a per-ROLE question, not a project one). */
export type ProjectModelRow = {
  projectId: string;
  projectName: string;
  effective: EffectiveModel;
  /** Which precedence layer won — project » tenant » default. */
  source: "project" | "tenant" | "default";
};

/**
 * The model shown on an AGENT row.
 *
 * A scoreboard row is a ROLE and is tenant-wide, while the model is configured
 * per PROJECT (and now per role WITHIN a project). So a role that ran in two
 * projects with different models genuinely has no single answer, and inventing
 * one would drive exactly the bad upgrade decision the operator is trying to
 * avoid. Hence the explicit `mixed` case.
 *
 * Both variants carry `projectIds`: with a per-role-per-project override the
 * resolution is inherently per-project, so a control has to be able to expand
 * into the projects behind the label rather than silently picking one.
 */
export type AgentModel =
  | {
      kind: "resolved";
      effective: EffectiveModel;
      label: string;
      /** Nameable only when exactly ONE project is behind the label. */
      projectId: string | null;
      projectIds: string[];
    }
  | { kind: "mixed"; labels: string[]; projectCount: number; projectIds: string[] };

export type ProjectProviderInput = ProjectProviderRow & { id: string; name: string };

/**
 * Resolve every project's model through the SAME precedence function the engine
 * uses. Note a project with `llm_model` set but `llm_provider` NULL resolves to
 * model = null — reading `projects.llm_model` directly would report a pinned
 * model that is never in effect.
 */
export function resolveProjectModels(args: {
  projects: readonly ProjectProviderInput[];
  tenantProvider: LlmProvider | null;
}): ProjectModelRow[] {
  return args.projects.map((p) => {
    const selection = selectProvider({ project: p, tenantProvider: args.tenantProvider });
    return {
      projectId: p.id,
      projectName: p.name,
      effective: describeEffectiveModel(selection.provider, selection.model),
      source: selection.source,
    };
  });
}

/**
 * role slug → the model that role's runs actually run on.
 *
 * `roleOverrides` are the `agent_project_models` rows for the tenant, at both
 * scopes. A role's answer for a given project is the project's resolution WITH
 * that role's winning override applied (project-scoped if there is one, else the
 * agent-wide default) — including the `shadowed` outcome, which is why this cannot
 * reuse the plain `projectModels` label for a role that has an override.
 */
export function resolveModelByRole(args: {
  /** (role slug, the projects that role's runs touched). */
  roles: readonly { role: string; projectIds: readonly string[] }[];
  projects: readonly ProjectProviderInput[];
  tenantProvider: LlmProvider | null;
  /** Every `agent_project_models` row for the tenant, BOTH scopes — a row with
   *  `projectId === null` is that role's agent-wide default. */
  roleOverrides: readonly RoleModelRow[];
}): Record<string, AgentModel> {
  const projectById = new Map(args.projects.map((p) => [p.id, p]));
  const overrideByKey = indexRoleModels(args.roleOverrides);

  // The answer for a role whose runs touched no project at all (ticket-less
  // supervisor children): the tenant/default layer, with the role's AGENT-WIDE
  // default still applied — such a run has no project-scoped row by
  // construction, but the global is agent-wide and the engine applies it there
  // too (lib/llm/role-model.server.ts), so the label must agree.
  const tenantSelection = selectProvider({ project: null, tenantProvider: args.tenantProvider });

  const out: Record<string, AgentModel> = {};
  for (const { role, projectIds } of args.roles) {
    const resolved = projectIds
      .map((id) => {
        const project = projectById.get(id);
        if (!project) return null;
        const selection = selectProvider({ project, tenantProvider: args.tenantProvider });
        const effective = describeRoleEffectiveModel({
          provider: selection.provider,
          projectModel: selection.model,
          // agent+project » agent-global, in ONE pure place.
          override: lookupRoleModel(overrideByKey, id, role).override,
        });
        return { projectId: id, effective };
      })
      .filter((r): r is { projectId: string; effective: EffectiveModel } => r != null);

    if (resolved.length === 0) {
      const tenantEffective = describeRoleEffectiveModel({
        provider: tenantSelection.provider,
        projectModel: tenantSelection.model,
        override: lookupRoleModel(overrideByKey, null, role).override,
      });
      out[role] = {
        kind: "resolved",
        effective: tenantEffective,
        label: formatEffectiveModel(tenantEffective),
        projectId: null,
        projectIds: [],
      };
      continue;
    }

    const ids = resolved.map((r) => r.projectId);
    const first = resolved[0]!;
    const labels = [...new Set(resolved.map((r) => formatEffectiveModel(r.effective)))].sort();
    out[role] =
      labels.length === 1
        ? {
            kind: "resolved",
            effective: first.effective,
            label: formatEffectiveModel(first.effective),
            projectId: resolved.length === 1 ? first.projectId : null,
            projectIds: ids,
          }
        : { kind: "mixed", labels, projectCount: resolved.length, projectIds: ids };
  }
  return out;
}
