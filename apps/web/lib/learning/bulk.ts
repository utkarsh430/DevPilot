// Bulk status-flip DB logic for the lessons table view.
//
// ── Why a plain module (no `server-only`, no session) ──
// Same DI split as `lib/learning/write.ts`: an injected `SupabaseClient` + an
// already-resolved `tenantId`, so the tenant boundary is unit-testable with a
// fake client that actually applies filters. The `"use server"` wrapper
// (`lib/learning/actions.ts`) derives `tenantId` from the SESSION and passes
// `supabaseService()`; it never re-implements this SQL. This file MUST NOT be a
// `"use server"` file — these functions take a raw tenantId and so must not be
// browser-callable endpoints.
//
// ── Security (load-bearing, identical to write.ts) ──
// `agent_learnings` denies ALL JWT-role writes by design (migration
// 20260735000000) — the human-review gate IS the safety story, since an active
// lesson is fed into every future agent run (PR 4). So this runs on the SERVICE
// client with RLS off, and the co-located `.eq("tenant_id", tenantId)` is the
// ENTIRE write-side tenant boundary. It is applied ALONGSIDE the `.in("id", …)`,
// never instead of it: a caller-supplied id list is attacker-controllable, so
// without the tenant predicate a forged uuid would flip a foreign tenant's row.
// A bulk flip whose ids belong to another tenant matches zero rows and reports
// `updated: 0` — never a partial cross-tenant write.
// `__tests__/bulk-tenant-scope.test.ts` asserts exactly that with a
// filter-applying fake (a filter-ignoring fake would make it vacuous).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LearningTargetStatus } from "@/lib/learning/write";

const TABLE = "agent_learnings";

/** Hard ceiling on one bulk call. Mirrored by the action's Zod schema; kept
 *  here too so a non-action caller can't post an unbounded id list. */
export const BULK_MAX_IDS = 500;

export type BulkResult = { ok: true; updated: number } | { ok: false; error: string };

/**
 * Flip many learnings to `status` in one statement, scoped to (ids ∩ tenant).
 * Returns how many rows ACTUALLY changed — the UI reports that number rather
 * than the requested count, so a partial match (a row already settled by another
 * tab, or an id that isn't ours) is visible instead of silently assumed.
 *
 * `approvedBy` is stamped only on the approve path, matching
 * `transitionLearningStatus`'s single-row contract.
 */
export async function bulkTransitionLearnings(
  db: SupabaseClient,
  args: {
    ids: readonly string[];
    tenantId: string;
    status: LearningTargetStatus;
    approvedBy?: string | null;
  },
): Promise<BulkResult> {
  const ids = Array.from(new Set(args.ids)).slice(0, BULK_MAX_IDS);
  if (ids.length === 0) return { ok: true, updated: 0 };

  const patch: Record<string, unknown> = { status: args.status };
  if (args.status === "active") patch.approved_by = args.approvedBy ?? null;

  const { data, error } = await db
    .from(TABLE)
    .update(patch)
    .in("id", ids)
    // THE tenant boundary — see the header. Never remove, never make optional.
    .eq("tenant_id", args.tenantId)
    .select("id");

  if (error) return { ok: false, error: error.message };
  return { ok: true, updated: (data ?? []).length };
}
