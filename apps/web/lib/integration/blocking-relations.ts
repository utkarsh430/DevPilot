// The three reads behind `isDependencyDeferred` - "is the land claim skipping
// this ticket for a legitimate dependency reason?".
//
// LIFTED VERBATIM out of `lib/engine/land-rescue-reaper.ts`, where it was a
// private helper, so the SECOND rescue sweep (`unqueued-land-store.ts`) uses the
// same reads rather than growing a copy. That matters more than ordinary DRY:
// this is a DISARM signal for both sweeps - a relation read as open stands the
// sweep down, and one read as closed lets it act - so two implementations that
// drift do not merely disagree, they disagree about whether it is safe to touch
// a ticket. The RULE they share (`isDependencyDeferred`) was already one
// function; these are the reads that feed it.
//
// It also becomes testable by moving here: `land-rescue-reaper.ts` imports the
// Inngest client and `supabaseService`, both of which reach `server-only`, so
// nothing that lived in that file could load under Vitest.
//
// TENANT SCOPE. Both sweeps run on the SERVICE client (a cron has no session, so
// RLS is off), which makes the co-located `.eq("tenant_id", …)` the entire
// boundary. `ticket_dependencies` carries no `tenant_id` column at all, so its
// safety comes from the ANCHOR (`ticket_id`, taken off a row the caller already
// scoped) plus re-scoping the blocker tickets it points at - exactly what
// `fetchBlockerRows` does. A foreign blocker row reading as "open" would strand
// our land permanently, which is why the scoping is on the reads and not on the
// result.

import type { SupabaseClient } from "@supabase/supabase-js";
import { BLOCKING_RELATION_TYPES } from "@/lib/board/dependencies";
import { LAND_PENDING_QUEUE_STATES } from "@/lib/integration/landed";
import type { BlockingRelation } from "@/lib/integration/land-rescue-policy";

/**
 * Which blocking relations still hold this ticket's land back?
 *
 * Returns `null` when the state could not be established - every caller treats
 * that as DEFERRED, so an unreadable dependency can neither trigger a pointless
 * enqueue/emit nor, far more importantly, a give-up.
 */
export async function loadBlockingRelations(
  db: SupabaseClient,
  args: { ticketId: string; tenantId: string },
): Promise<BlockingRelation[] | null> {
  const { data: deps, error: depsErr } = await db
    .from("ticket_dependencies")
    .select("blocks_ticket_id, relation_type")
    .eq("ticket_id", args.ticketId)
    .in("relation_type", BLOCKING_RELATION_TYPES as unknown as string[]);
  if (depsErr) return null;
  const rows = (deps ?? []) as Array<{ blocks_ticket_id: string; relation_type: string }>;
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => r.blocks_ticket_id).filter(Boolean))];
  if (ids.length === 0) return [];

  const { data: blockers, error: blockersErr } = await db
    .from("tickets")
    .select("id, status, landed_sha")
    .in("id", ids)
    .eq("tenant_id", args.tenantId);
  if (blockersErr) return null;
  const byId = new Map(
    (
      (blockers ?? []) as Array<{ id: string; status: string | null; landed_sha: string | null }>
    ).map((b) => [b.id, b] as const),
  );

  const { data: queued, error: queueErr } = await db
    .from("integration_queue")
    .select("ticket_id")
    .in("ticket_id", ids)
    .eq("tenant_id", args.tenantId)
    .in("status", LAND_PENDING_QUEUE_STATES as unknown as string[]);
  if (queueErr) return null;
  const landPending = new Set(
    ((queued ?? []) as Array<{ ticket_id: string }>).map((q) => q.ticket_id),
  );

  return rows.map((r) => {
    const b = byId.get(r.blocks_ticket_id);
    return {
      relationType: r.relation_type as BlockingRelation["relationType"],
      blockerStatus: b?.status ?? null,
      blockerLandedSha: b?.landed_sha ?? null,
      blockerLandPending: landPending.has(r.blocks_ticket_id),
    };
  });
}
