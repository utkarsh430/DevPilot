// The DB half of rollback: plain functions over an INJECTED Supabase client,
// with the tenant id passed in already resolved.
//
// Split out of the `"use server"` action for the same reason `deploy-write.ts`
// and `link-write.ts` are: an action file pulls in `next/headers` and cannot load
// under Vitest at all, so logic left in one is logic that cannot be tested — and
// everything that can go wrong about a tenant predicate lives here, where a test
// can drive a fake client that actually applies `.eq`.
//
// ── The tenant predicate IS the boundary ───────────────────────────────────
// These statements run SERVICE-ROLE (RLS off): the action derives the tenant
// from the session and then uses `supabaseService()`. So the co-located
// `.eq("tenant_id", …)` on every read and every write is the only thing between
// a forged `projectId`/`deploymentId` and another tenant's deployments.
//
// The severity here is higher than PR 4's, and specifically so:
//
//   READ  — this list is the PROMOTION INVENTORY. A missing predicate does not
//           merely disclose another tenant's deployment ids; it OFFERS them as
//           rollback targets, and the next click sends one of their deployments
//           to production. Disclosure and a live production change are not the
//           same severity.
//   WRITE — stamping `promoted_at` on a foreign row corrupts the record that
//           decides whether a deployment can be promoted again, and
//           `vercel_production_url` is the URL their operators click to check
//           what is live.
//
// Every property below is paired with a CONTROL test that neuters the predicate
// and asserts the foreign row WOULD be reached. A filter-ignoring fake would
// make the whole suite vacuous; this repo has shipped that mistake before.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mapDeploymentRow,
  type DeploymentRecord,
  type WriteResult,
} from "@/lib/vercel/deploy-write";

const RECORD_COLUMNS =
  "id, vercel_deployment_id, target, ready_state, url, inspector_url, error_message, " +
  "branch, commit_sha, ticket_id, trigger_source, created_at, ready_at, " +
  "became_production_at, promoted_at";

/**
 * The production deployments for a project — the rollback inventory.
 *
 * Filtered to `target = 'production'` because a preview has never been aliased to
 * a production domain and can never be a rollback candidate. That is also the
 * shape of the partial index 20260742000000 created for exactly this query.
 *
 * Ordered by `became_production_at` DESC in SQL, and re-sorted by
 * `planRollbackTargets` afterwards. The duplication is deliberate: the SQL order
 * is what makes `limit` select the RIGHT rows (an arbitrary order plus a limit
 * would silently drop the most recent production deployments, which are the only
 * ones a rollback can reach), while the pure re-sort is what a test can assert.
 */
export async function listProductionDeployments(
  db: SupabaseClient,
  tenantId: string,
  projectId: string,
  limit = 20,
): Promise<DeploymentRecord[]> {
  const { data, error } = await db
    .from("project_deployments")
    .select(RECORD_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .eq("target", "production")
    .order("became_production_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error || !data) return [];
  // Cast: `RECORD_COLUMNS` is a concatenated string, so PostgREST's typed-select
  // inference cannot parse it into a row shape. `mapDeploymentRow` is total over
  // `unknown` fields, so the shape is enforced there.
  return (data as unknown as Record<string, unknown>[]).map(mapDeploymentRow);
}

/**
 * Record that a deployment has begun serving production again.
 *
 * Written for BOTH paths, because both make the target live and the column means
 * exactly that ("when this deployment began serving production"). Keeping it
 * accurate is what makes the ordering in `planRollbackTargets` correct after a
 * rollback: production moves without a new deployment being built, so a ledger
 * that never re-stamps would go on claiming the old row is live.
 *
 * `promotedAt`/`promotedBy` are written ONLY on the promote path, and that
 * distinction is load-bearing rather than bookkeeping. Vercel refuses to promote
 * a deployment that has already been promoted; `promoted_at` is DevPilot's record
 * of that, and stamping it after a ROLLBACK would mark a perfectly valid future
 * rollback target as one to warn about. The two facts are "this served
 * production" and "this was promoted", and they are not the same fact.
 */
export async function recordProductionPointer(
  db: SupabaseClient,
  tenantId: string,
  args: {
    vercelDeploymentId: string;
    becameProductionAt: string;
    /** Set on the promote (undo) path only. */
    promotedAt?: string | null;
    promotedBy?: string | null;
  },
): Promise<WriteResult> {
  const patch: Record<string, unknown> = {
    became_production_at: args.becameProductionAt,
    updated_at: args.becameProductionAt,
  };
  if (args.promotedAt) {
    patch.promoted_at = args.promotedAt;
    patch.promoted_by = args.promotedBy ?? null;
  }

  const { error } = await db
    .from("project_deployments")
    .update(patch)
    .eq("tenant_id", tenantId)
    .eq("vercel_deployment_id", args.vercelDeploymentId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
