// The DB half of writing a per-agent model override, at both scopes: a
// project-scoped row, and the AGENT-WIDE default (the row with a NULL
// `project_id`, which applies to every project including ones created later).
//
// ── Why a plain module (no `server-only`, no session) ──────────────────────
// Same split as `lib/learning/write.ts` / `lib/learning/actions.ts`: this file
// takes an already-resolved `tenantId` and a `SupabaseClient` as ARGUMENTS, so
// it loads under Vitest and its tenant-scope test can drive a fake client that
// ACTUALLY applies `.eq`. The `"use server"` wrapper
// (`setAgentProjectModelAction`) derives the tenant from the session and passes
// `supabaseService()`.
//
// ── The tenant predicate IS the boundary ───────────────────────────────────
// `agent_project_models` denies every JWT write, so these run service-role with
// RLS OFF. Nothing else keeps a caller from repointing another tenant's agents
// at a different model. The upsert carries `tenant_id` in BOTH the payload and
// the conflict target — so a conflicting row in a foreign tenant is not matched
// and cannot be updated — and the delete carries an explicit `.eq("tenant_id",
// …)` alongside its `.eq("project_id", …)`, which without it would delete any
// tenant's override for that project/role.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmProvider } from "@/lib/llm/provider";

export const AGENT_PROJECT_MODELS_TABLE = "agent_project_models";
/** The unique constraint, as PostgREST wants it named. */
export const AGENT_PROJECT_MODEL_CONFLICT = "tenant_id,project_id,role_slug";

export type WriteResult = { ok: true } | { ok: false; error: string };

/** Upsert the override for one (tenant, project, role). */
export async function upsertRoleModel(
  db: SupabaseClient,
  args: {
    tenantId: string;
    projectId: string;
    roleSlug: string;
    provider: LlmProvider;
    model: string;
    createdBy: string | null;
    now?: string;
  },
): Promise<WriteResult> {
  const { error } = await db.from(AGENT_PROJECT_MODELS_TABLE).upsert(
    {
      // In the payload AND in the conflict target — see the header.
      tenant_id: args.tenantId,
      project_id: args.projectId,
      role_slug: args.roleSlug,
      provider: args.provider,
      model: args.model,
      created_by: args.createdBy,
      updated_at: args.now ?? new Date().toISOString(),
    },
    { onConflict: AGENT_PROJECT_MODEL_CONFLICT },
  );
  if (error) {
    console.error("[role-model-write] upsert failed:", error);
    return { ok: false, error: "Could not save that model." };
  }
  return { ok: true };
}

/**
 * Clear the override by DELETING the row.
 *
 * "No row" is the single representation of "inherit" — a row with an empty model
 * would be a second one, and the two would drift (the DB CHECK forbids it
 * anyway).
 */
export async function clearRoleModel(
  db: SupabaseClient,
  args: { tenantId: string; projectId: string; roleSlug: string },
): Promise<WriteResult> {
  const { error } = await db
    .from(AGENT_PROJECT_MODELS_TABLE)
    .delete()
    .eq("project_id", args.projectId)
    .eq("role_slug", args.roleSlug)
    // THE tenant boundary for this service-role write. Never remove.
    .eq("tenant_id", args.tenantId);
  if (error) {
    console.error("[role-model-write] clear failed:", error);
    return { ok: false, error: "Could not clear that model." };
  }
  return { ok: true };
}

/**
 * Upsert the AGENT-WIDE default for one (tenant, role) — the row with a NULL
 * `project_id`.
 *
 * ── Why delete-then-insert rather than an upsert ───────────────────────────
 * Uniqueness of the global is enforced by a PARTIAL index
 * (`uq_agent_project_models_global … where project_id is null`), because the
 * plain `unique (tenant_id, project_id, role_slug)` does NOT constrain these
 * rows at all: Postgres treats NULLs as distinct, so it would happily hold a
 * dozen globals for one role. PostgREST's `on_conflict` names COLUMNS and cannot
 * express a partial index's predicate, so there is no conflict target to infer
 * and an upsert would insert a duplicate (or error) rather than update.
 *
 * The two statements are not atomic, but the partial index is the backstop: a
 * concurrent second insert fails loudly instead of duplicating, and the failure
 * surfaces as "could not save" rather than as an ambiguous stored state.
 *
 * BOTH statements carry the tenant predicate — the delete because without it it
 * would clear every tenant's global for that role, the insert because
 * `tenant_id` is what the row IS scoped by (RLS is off for the service client).
 */
export async function upsertGlobalRoleModel(
  db: SupabaseClient,
  args: {
    tenantId: string;
    roleSlug: string;
    provider: LlmProvider;
    model: string;
    createdBy: string | null;
    now?: string;
  },
): Promise<WriteResult> {
  const cleared = await clearGlobalRoleModel(db, {
    tenantId: args.tenantId,
    roleSlug: args.roleSlug,
  });
  if (!cleared.ok) return cleared;

  const { error } = await db.from(AGENT_PROJECT_MODELS_TABLE).insert({
    tenant_id: args.tenantId,
    // NULL project_id IS the agent-wide scope. Never write a sentinel string.
    project_id: null,
    role_slug: args.roleSlug,
    provider: args.provider,
    model: args.model,
    created_by: args.createdBy,
    updated_at: args.now ?? new Date().toISOString(),
  });
  if (error) {
    console.error("[role-model-write] global upsert failed:", error);
    return { ok: false, error: "Could not save that model." };
  }
  return { ok: true };
}

/** Clear the agent-wide default by DELETING the row — "no row" is the single
 *  representation of "inherit", at this scope as at the project one. */
export async function clearGlobalRoleModel(
  db: SupabaseClient,
  args: { tenantId: string; roleSlug: string },
): Promise<WriteResult> {
  const { error } = await db
    .from(AGENT_PROJECT_MODELS_TABLE)
    .delete()
    .is("project_id", null)
    .eq("role_slug", args.roleSlug)
    // THE tenant boundary for this service-role write. Never remove.
    .eq("tenant_id", args.tenantId);
  if (error) {
    console.error("[role-model-write] global clear failed:", error);
    return { ok: false, error: "Could not clear that model." };
  }
  return { ok: true };
}

/**
 * Drop this role's PROJECT-scoped rows, so those projects fall back to the
 * agent-wide default.
 *
 * Only ever reached from an explicit operator action ("Clear N project
 * overrides"). Setting a global NEVER calls this: a per-project row is a choice
 * the operator made, and deleting it silently to make the global look like it
 * "worked" is exactly the kind of surprise this family of work exists to end.
 *
 * An empty id list is a no-op rather than an unfiltered delete — `.in("…", [])`
 * matches nothing in PostgREST, but relying on that for a DESTRUCTIVE statement
 * is not a boundary worth resting on.
 */
export async function clearProjectRoleModels(
  db: SupabaseClient,
  args: { tenantId: string; roleSlug: string; projectIds: readonly string[] },
): Promise<WriteResult> {
  if (args.projectIds.length === 0) return { ok: true };
  const { error } = await db
    .from(AGENT_PROJECT_MODELS_TABLE)
    .delete()
    .in("project_id", [...args.projectIds])
    .eq("role_slug", args.roleSlug)
    // THE tenant boundary for this service-role write. The project ids are
    // CLIENT-SUPPLIED, so this predicate is the only thing keeping a forged list
    // from clearing another tenant's overrides. Never remove.
    .eq("tenant_id", args.tenantId);
  if (error) {
    console.error("[role-model-write] project overrides clear failed:", error);
    return { ok: false, error: "Could not clear those overrides." };
  }
  return { ok: true };
}
