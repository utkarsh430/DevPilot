// IO half of the two landing outcomes decided in `land-outcome.ts`.
//
// Deliberately NOT `server-only` and deliberately takes an injected
// `SupabaseClient` + a resolved `tenantId`, so the tenant predicates below are
// exercised by a filter-APPLYING fake under Vitest. This follows
// `lib/learning/write.ts`, not the `.server.ts` twin convention: the whole point
// of these functions is the scoping, and scoping that nothing can test is the
// gap every one of this repo's tenant-leak rounds lived in.
//
// TENANT SCOPE. `pending_pushes` reads/writes here are service-role (the land
// worker is an Inngest function with no session, so RLS is off), which makes the
// co-located `.eq("tenant_id", …)` the ENTIRE boundary. It matters unusually
// much on `markConflictResolved`: `pending_pushes.branch` is the ref the land
// worker MERGES into the integration branch, so a foreign row that could be
// stamped "resolved" is a foreign branch declared safe to land.
//
// Note the pre-existing stamps in `lib/engine/conflict-audit.ts`
// (`stampConflict`/`stampRebased`/`stampClean`/`stampResolved`) key on
// `.eq("id", …)` alone. They are unchanged here (out of scope), but nothing new
// should copy that shape.

import type { SupabaseClient } from "@supabase/supabase-js";

/** The one field `decideConflictResolution` needs off the source push. */
export async function loadPendingPushConflictState(
  db: SupabaseClient,
  args: { pendingPushId: string; tenantId: string },
): Promise<{ conflictState: string | null } | null> {
  const { data, error } = await db
    .from("pending_pushes")
    .select("id, conflict_state")
    .eq("id", args.pendingPushId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  if (error) throw new Error(`loadPendingPushConflictState: ${error.message}`);
  if (!data) return null;
  return { conflictState: (data.conflict_state as string | null) ?? null };
}

/**
 * Clear the conflict on a source push whose branch now rebases cleanly, and
 * record the sha it was replayed onto.
 *
 * CAS on `conflict_state = 'conflict'`: only the state we decided against may be
 * moved, so a concurrent `stampConflict` from a second land attempt is never
 * clobbered into a false "resolved". Returns whether a row actually moved.
 */
export async function markConflictResolved(
  db: SupabaseClient,
  args: { pendingPushId: string; tenantId: string; rebasedOntoSha: string },
): Promise<boolean> {
  const { data, error } = await db
    .from("pending_pushes")
    .update({
      conflict_state: "resolved",
      rebased_onto_sha: args.rebasedOntoSha,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.pendingPushId)
    .eq("tenant_id", args.tenantId)
    .eq("conflict_state", "conflict")
    .select("id");
  if (error) throw new Error(`markConflictResolved: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
