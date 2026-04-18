// DB read/write for `agent_prompt_overlays`. PLAIN module — no `server-only`,
// no session: every function takes an injected `SupabaseClient` and an
// already-resolved `tenantId`, so the tenant guard below is reachable from
// Vitest with a filter-applying fake. Same DI split, and the same reason, as
// `lib/learning/write.ts` / `lib/learning/actions.ts`.
//
// This file MUST NOT become a `"use server"` module: these take a raw tenantId,
// so exporting them from an action file would publish a cross-tenant overlay
// writer to the browser — exactly why `createTicketCore` lives in `lib/` and not
// in `board/actions.ts`.
//
// ── Security (load-bearing) ────────────────────────────────────────────────
// `agent_prompt_overlays` denies ALL JWT writes by design (migration
// 20260743000000): an overlay is standing text injected into the system prompt
// of EVERY future run of a role, so a browser-writable row would let a
// compromised client steer an agent permanently. Writes therefore run on the
// SERVICE client with RLS off, and the co-located `.eq("tenant_id", tenantId)`
// on every read and every write IS the entire tenant boundary.
//
// The severity is asymmetric and worth naming: a missing predicate on the READ
// does not merely disclose another workspace's overlay, it SPLICES that
// workspace's instructions into this tenant's agents' system prompts on the next
// dispatch. Tests drive a fake that ACTUALLY applies `.eq`, with a control per
// assertion that neuters the predicate and proves the foreign row would win.

import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "agent_prompt_overlays";

export type RoleOverlay = {
  id: string;
  body: string;
  updatedAt: string | null;
};

export type OverlayWriteResult = { ok: true } | { ok: false; error: string };

/**
 * The tenant-wide overlay for a role, or null.
 *
 * `project_id IS NULL` is the Phase-2 scope and is an explicit predicate, not an
 * incidental one: once Phase 4 writes per-project rows, a query without it would
 * return whichever row the planner felt like and the effective overlay would
 * become nondeterministic.
 */
export async function loadRoleOverlay(
  db: SupabaseClient,
  tenantId: string,
  roleSlug: string,
): Promise<RoleOverlay | null> {
  const { data, error } = await db
    .from(TABLE)
    .select("id, body, updated_at")
    .eq("tenant_id", tenantId)
    .eq("role_slug", roleSlug)
    .is("project_id", null)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: String(data.id),
    body: typeof data.body === "string" ? data.body : "",
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
  };
}

/**
 * The body alone, for the dispatch path. Degrades to `null` on any failure — an
 * overlay is an enrichment and must never fail a dispatch. A missing overlay and
 * an unreadable one both mean "compose without one", which is byte-identical to
 * pre-overlay behaviour.
 */
export async function loadRoleOverlayBody(
  db: SupabaseClient,
  tenantId: string,
  roleSlug: string,
): Promise<string | null> {
  try {
    const row = await loadRoleOverlay(db, tenantId, roleSlug);
    return row && row.body.trim().length > 0 ? row.body : null;
  } catch {
    return null;
  }
}

/**
 * Write the tenant-wide overlay for a role.
 *
 * UPDATE-first, INSERT-only-if-nothing-matched — and specifically NOT the
 * delete-then-insert that `upsertGlobalRoleModel` (20260739000000) uses.
 *
 * That precedent exists because PostgREST's `on_conflict` names COLUMNS and
 * cannot express the partial index's `where project_id is null` predicate, so
 * there is no conflict target to infer — true here too. But delete-then-insert
 * is not the only way around it, and here it would be actively harmful: these
 * two statements are not in one transaction, so an insert that fails after the
 * delete committed (statement timeout, dropped connection) destroys the
 * operator's overlay while returning an error the UI reads as "nothing
 * happened". A lost model override is one re-click; a lost 4,000-character
 * house-rules document the operator no longer has a copy of is not.
 *
 * UPDATE-first never deletes anything, so the worst case of a failure at any
 * point is that the previous overlay survives — the safe direction. The partial
 * unique index stays the backstop: two concurrent first-writes race, one wins,
 * the other fails loudly instead of duplicating.
 */
export async function upsertRoleOverlay(
  db: SupabaseClient,
  args: { tenantId: string; roleSlug: string; body: string; updatedBy: string | null },
): Promise<OverlayWriteResult> {
  const now = new Date().toISOString();

  // `.select("id")` is what makes this a compare-and-set rather than a blind
  // write: it tells us whether a row existed, so the insert below runs only
  // when one genuinely did not.
  const updated = await db
    .from(TABLE)
    .update({ body: args.body, updated_by: args.updatedBy, updated_at: now })
    .eq("tenant_id", args.tenantId)
    .eq("role_slug", args.roleSlug)
    .is("project_id", null)
    .select("id");
  if (updated.error) return { ok: false, error: updated.error.message };
  if ((updated.data?.length ?? 0) > 0) return { ok: true };

  const { error } = await db.from(TABLE).insert({
    tenant_id: args.tenantId,
    project_id: null,
    role_slug: args.roleSlug,
    body: args.body,
    updated_by: args.updatedBy,
    updated_at: now,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Clear the tenant-wide overlay — THE RESET. One delete, and the agent is back
 * to exactly its shipped prompt, because the shipped prompt was never copied
 * anywhere. There is no default to restore and no version to reconcile.
 *
 * Deleting nothing is success: the operator's intent ("this agent has no
 * instructions from me") is satisfied either way, and reporting "not found"
 * would make a double-click look like an error.
 */
export async function clearRoleOverlay(
  db: SupabaseClient,
  tenantId: string,
  roleSlug: string,
): Promise<OverlayWriteResult> {
  const { error } = await db
    .from(TABLE)
    .delete()
    .eq("tenant_id", tenantId)
    .eq("role_slug", roleSlug)
    .is("project_id", null);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
