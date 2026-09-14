// The DB half of the deploy ledger: plain functions over an INJECTED Supabase
// client, with the tenant id passed in already resolved.
//
// Split out of the action and the Inngest worker for the same reason
// `link-write.ts` is: a `"use server"` file pulls in `next/headers` and cannot
// load under Vitest at all, and an Inngest worker drags in the whole engine. So
// logic left in either is logic that cannot be tested — and everything that can
// go wrong about a tenant predicate lives here, where a test can drive a fake
// client that actually applies `.eq`.
//
// ── The tenant predicate IS the boundary ───────────────────────────────────
// These statements run with the SERVICE ROLE — the action derives the tenant
// from the session and then uses `supabaseService()`, and the poller has no
// session at all and trusts only the tenant id stamped on the event it was
// given. RLS is therefore off, and the co-located `.eq("tenant_id", …)` on every
// read and every write is the only thing between a forged `projectId` and
// another tenant's deploy history.
//
// The severity is concrete in both directions. A missing predicate on the WRITE
// lets one tenant stamp `vercel_production_url` on another's project — the URL
// their operators click to check what is live. On the READ it discloses another
// tenant's deployment ids, commit SHAs and build-log links, which are the exact
// inventory PR 5 will promote from.
//
// The tests drive a filter-APPLYING fake and pair each assertion with a control
// that neuters the predicate and confirms the foreign row would be reached; a
// filter-ignoring fake would make the whole suite vacuous.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeployTarget } from "@/lib/vercel/deploy-state";

export type WriteResult = { ok: true } | { ok: false; error: string };

/** One row of `project_deployments`, as the card and the poller read it. */
export type DeploymentRecord = {
  id: string;
  vercelDeploymentId: string;
  target: DeployTarget;
  /** Vercel's raw `readyState`, stored verbatim — see `classifyDeployState`. */
  readyState: string;
  url: string | null;
  inspectorUrl: string | null;
  errorMessage: string | null;
  branch: string | null;
  commitSha: string | null;
  ticketId: string | null;
  triggerSource: string;
  createdAt: string;
  readyAt: string | null;
  becameProductionAt: string | null;
  promotedAt: string | null;
};

/** The fields an upsert may set. Every one is nullable-or-known; nothing here is
 *  derived from caller-supplied text without the callers' own validation. */
export type DeploymentUpsert = {
  projectId: string;
  vercelDeploymentId: string;
  target: DeployTarget;
  readyState: string;
  url: string | null;
  inspectorUrl: string | null;
  errorMessage: string | null;
  branch: string | null;
  commitSha: string | null;
  ticketId: string | null;
  triggeredBy: string | null;
  triggerSource: "human" | "agent" | "git_push";
  readyAt: string | null;
  /** When this deployment began serving production. Written only for a
   *  production build that reached READY — see the migration header on why this
   *  is distinct from `promoted_at`. */
  becameProductionAt: string | null;
  /** Injected so tests are deterministic. */
  polledAt: string;
};

/**
 * Create or update the record for one Vercel deployment.
 *
 * An UPSERT rather than insert-then-update because the poller writes the same
 * row repeatedly as the build progresses, and a read-then-write there is a race
 * two concurrent polls both win. The conflict target is
 * `(tenant_id, vercel_deployment_id)` — the unique constraint 20260740000000
 * declared for exactly this. **`tenant_id` must stay in the conflict target**:
 * dropping it would make two tenants share one key and let a foreign deployment
 * id collide with ours.
 *
 * `tenant_id` is also in the PAYLOAD, which is what the
 * `assert_tenant_matches_parent` triggers check against `projects`/`tickets` —
 * so a row whose project belongs to another tenant cannot be written at all,
 * independent of anything this function does.
 */
export async function upsertDeploymentRecord(
  db: SupabaseClient,
  tenantId: string,
  input: DeploymentUpsert,
): Promise<WriteResult> {
  const { error } = await db.from("project_deployments").upsert(
    {
      tenant_id: tenantId,
      project_id: input.projectId,
      ticket_id: input.ticketId,
      vercel_deployment_id: input.vercelDeploymentId,
      target: input.target,
      ready_state: input.readyState,
      url: input.url,
      inspector_url: input.inspectorUrl,
      error_message: input.errorMessage,
      branch: input.branch,
      commit_sha: input.commitSha,
      triggered_by: input.triggeredBy,
      trigger_source: input.triggerSource,
      ready_at: input.readyAt,
      became_production_at: input.becameProductionAt,
      polled_at: input.polledAt,
      updated_at: input.polledAt,
    },
    { onConflict: "tenant_id,vercel_deployment_id" },
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Stamp the project's stable production URL after a successful PRODUCTION
 * deploy.
 *
 * Never called for a preview: a preview URL is per-deployment and writing it
 * here would make the card advertise a throwaway build as the live site. The
 * caller enforces that; this function takes the URL it is given.
 */
export async function writeProductionUrl(
  db: SupabaseClient,
  tenantId: string,
  projectId: string,
  url: string,
): Promise<WriteResult> {
  const { error } = await db
    .from("projects")
    .update({ vercel_production_url: url })
    .eq("id", projectId)
    .eq("tenant_id", tenantId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

const RECORD_COLUMNS =
  "id, vercel_deployment_id, target, ready_state, url, inspector_url, error_message, " +
  "branch, commit_sha, ticket_id, trigger_source, created_at, ready_at, " +
  "became_production_at, promoted_at";

/** The card's read: the most recent deployments for a project, newest first. */
export async function listProjectDeployments(
  db: SupabaseClient,
  tenantId: string,
  projectId: string,
  limit = 10,
): Promise<DeploymentRecord[]> {
  const { data, error } = await db
    .from("project_deployments")
    .select(RECORD_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  // Cast: `RECORD_COLUMNS` is a concatenated string, so PostgREST's typed-select
  // inference cannot parse it into a row shape and degrades to an error type.
  // `mapDeploymentRow` is total over `unknown` fields, so the shape is enforced
  // there rather than by the generic.
  return (data as unknown as DeploymentRow[]).map(mapDeploymentRow);
}

/** One record by Vercel's deployment id. Used by the poller to recover the row
 *  it is updating without threading the uuid through the event payload. */
export async function getDeploymentRecord(
  db: SupabaseClient,
  tenantId: string,
  vercelDeploymentId: string,
): Promise<DeploymentRecord | null> {
  const { data, error } = await db
    .from("project_deployments")
    .select(RECORD_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("vercel_deployment_id", vercelDeploymentId)
    .maybeSingle();
  if (error || !data) return null;
  return mapDeploymentRow(data as unknown as DeploymentRow);
}

type DeploymentRow = Record<string, unknown>;

function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function mapDeploymentRow(row: DeploymentRow): DeploymentRecord {
  const target = row.target === "production" ? "production" : "preview";
  return {
    id: String(row.id ?? ""),
    vercelDeploymentId: String(row.vercel_deployment_id ?? ""),
    target,
    readyState: String(row.ready_state ?? ""),
    url: s(row.url),
    inspectorUrl: s(row.inspector_url),
    errorMessage: s(row.error_message),
    branch: s(row.branch),
    commitSha: s(row.commit_sha),
    ticketId: s(row.ticket_id),
    triggerSource: String(row.trigger_source ?? ""),
    createdAt: String(row.created_at ?? ""),
    readyAt: s(row.ready_at),
    becameProductionAt: s(row.became_production_at),
    promotedAt: s(row.promoted_at),
  };
}
