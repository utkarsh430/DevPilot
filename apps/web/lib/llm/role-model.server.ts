import "server-only";

// DB access for the per-agent × per-project model override. The rules live in
// the pure `role-model.ts`; this file only fetches rows.
//
// ── Tenant scope is the boundary ───────────────────────────────────────────
// `agent_project_models` denies every JWT write, so these reads run service-role
// with RLS OFF and the co-located `.eq("tenant_id", …)` is the ONLY thing
// keeping another tenant's override off this run. Both reads are additionally
// keyed on `project_id` — an attacker-controllable pointer — which is precisely
// the shape the tenant-scope scanner hunts, and the shape that has shipped a
// cross-tenant leak four times in this codebase. The DB trigger
// (`assert_tenant_matches_parent`) makes a mismatched row unwritable, but the
// predicate is the app-layer half and neither substitutes for the other.
//
// Every failure degrades to "no override" rather than throwing: a Supabase blip
// must not fail a dispatch, and falling back to the project's model is the
// conservative answer (it is what runs today).
//
// A row with `project_id IS NULL` is the AGENT-WIDE default. The per-run read
// fetches both scopes and lets the pure `pickRoleModelOverride` decide, so the
// precedence rule (agent+project beats agent-global) has exactly one home.

import { supabaseService } from "@/lib/db/server";
import { isLlmProvider } from "@/lib/llm/provider";
import {
  pickRoleModelOverride,
  type RoleModelLookup,
  type RoleModelRow,
} from "@/lib/llm/role-model";

type Row = {
  project_id?: string | null;
  role_slug?: string | null;
  provider?: string | null;
  model?: string | null;
};

/** Narrow a stored row, dropping anything whose provider is not one we know -
 *  an unrecognised provider can never match the winning one, so keeping it would
 *  only produce a confusing `shadowed` label for a value nothing can use.
 *  `project_id` NULL is KEPT: that is the agent-wide default, not a bad row. */
function toOverride(row: Row): RoleModelRow | null {
  const projectId = row.project_id ?? null;
  const roleSlug = (row.role_slug ?? "").trim();
  const model = (row.model ?? "").trim();
  if (!roleSlug || !model) return null;
  if (!isLlmProvider(row.provider)) return null;
  return { projectId, roleSlug, provider: row.provider, model };
}

const SELECT_COLUMNS = "project_id, role_slug, provider, model";

/**
 * The override for ONE (project, role), as the engine needs it at dispatch -
 * resolved across BOTH agent rungs: the project-scoped row if there is one, else
 * the agent-wide default.
 *
 * Two reads rather than one `.or(...)`: each carries its own explicit, literal
 * predicates, so the tenant boundary is visible on both and no project id is
 * ever interpolated into a PostgREST filter string. They run concurrently, so
 * this stays one round trip's latency.
 *
 * `role` is an id the engine already trusts - it comes from the dispatch
 * decision (`decision.role`) / the run's own role column, never from a runner or
 * an MCP tool argument. That is the same rule `resolveLlmProviderConfig`'s header
 * states for every one of its inputs, and it is what stops a runner naming
 * whichever role has the model it would prefer to run on.
 *
 * A ticket-less run (`projectId` null) has no project-scoped row by
 * construction, but the agent-wide default still applies - that is what
 * "agent-wide" means, and it is what makes "set it once for this agent" true
 * rather than true-except-here.
 */
export async function loadRoleModelOverride(args: {
  tenantId: string | null;
  projectId: string | null;
  role: string | null | undefined;
}): Promise<RoleModelLookup> {
  const none: RoleModelLookup = { override: null, scope: "none" };
  const role = (args.role ?? "").trim();
  if (!args.tenantId || !role) return none;
  const tenantId = args.tenantId;
  try {
    const [scoped, global] = await Promise.all([
      args.projectId
        ? supabaseService()
            .from("agent_project_models")
            .select(SELECT_COLUMNS)
            // THE tenant boundary for this service-role read. Never remove.
            .eq("tenant_id", tenantId)
            .eq("project_id", args.projectId)
            .eq("role_slug", role)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabaseService()
        .from("agent_project_models")
        .select(SELECT_COLUMNS)
        // THE tenant boundary for this service-role read. Never remove.
        .eq("tenant_id", tenantId)
        .is("project_id", null)
        .eq("role_slug", role)
        .maybeSingle(),
    ]);

    return pickRoleModelOverride({
      projectOverride: scoped.error || !scoped.data ? null : toOverride(scoped.data as Row),
      globalOverride: global.error || !global.data ? null : toOverride(global.data as Row),
    });
  } catch {
    return none;
  }
}

/** Every override in a tenant - the UI read path (/agents, /scoreboard), so both
 *  screens can render the resolved model per role without an N+1. Includes the
 *  agent-wide rows (`projectId === null`). */
export async function loadRoleModelOverridesForTenant(tenantId: string): Promise<RoleModelRow[]> {
  try {
    const { data, error } = await supabaseService()
      .from("agent_project_models")
      .select(SELECT_COLUMNS)
      // THE tenant boundary for this service-role read. Never remove.
      .eq("tenant_id", tenantId);
    if (error || !data) return [];
    return (data as Row[]).map(toOverride).filter((r): r is RoleModelRow => r != null);
  } catch {
    return [];
  }
}
