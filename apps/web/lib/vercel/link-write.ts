// The DB half of the Vercel link: plain functions over an INJECTED Supabase
// client, with the tenant id passed in already resolved.
//
// Split out of the server action for the same reason `lib/learning/write.ts` is:
// a `"use server"` file pulls in `next/headers` and cannot load under Vitest at
// all, so logic left inside one is logic that cannot be tested. Everything that
// can go wrong about a tenant predicate lives here, where a test can drive a
// fake client that actually applies `.eq`.
//
// ── The tenant predicate IS the boundary ───────────────────────────────────
// These writes run with the SERVICE ROLE (the actions derive the tenant from the
// session and then use `supabaseService()`), so RLS is off and the co-located
// `.eq("tenant_id", tenantId)` on every statement is the only thing standing
// between a forged `projectId` in a browser-reachable action argument and
// another tenant's project being repointed at an attacker's Vercel account.
//
// That is not a hypothetical severity: `projects.vercel_project_id` is the
// deploy target. Writing it for a foreign tenant means their next deploy — and,
// from PR 3, every environment variable DevPilot pushes — goes somewhere they do
// not control. The tests drive a filter-APPLYING fake and pair each assertion
// with a control that neuters the predicate and confirms the foreign row would
// be clobbered; a filter-ignoring fake would make the whole suite vacuous.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProdDeployMode } from "@/lib/vercel/deploy-policy";

export type WriteResult = { ok: true } | { ok: false; error: string };

export type VercelLinkWrite = {
  projectId: string;
  vercelProjectId: string;
  vercelProjectName: string | null;
  /** SNAPSHOT of Vercel's production branch at link time. Stored for display
   *  when the API cannot be reached; never treated as authoritative. */
  productionBranch: string | null;
  /** The operator's recorded INTENT, not the observed state. */
  prodDeployMode: ProdDeployMode;
  /** The branch the operator expects Vercel to deploy production from. Stored
   *  so the card can COMPARE it against the live value — DevPilot cannot apply
   *  it (read-only upstream), so the comparison is the whole mechanism. */
  desiredProductionBranch: string | null;
  linkedBy: string | null;
  /** Injected so the value is deterministic in tests. */
  linkedAt: string;
};

/** Record the link. One statement, so a half-linked project is not a state the
 *  card has to render. */
export async function writeVercelLink(
  db: SupabaseClient,
  tenantId: string,
  input: VercelLinkWrite,
): Promise<WriteResult> {
  const { error } = await db
    .from("projects")
    .update({
      vercel_project_id: input.vercelProjectId,
      vercel_project_name: input.vercelProjectName,
      vercel_production_branch: input.productionBranch,
      vercel_production_branch_desired: input.desiredProductionBranch,
      vercel_prod_deploy_mode: input.prodDeployMode,
      vercel_linked_at: input.linkedAt,
      vercel_linked_by: input.linkedBy,
    })
    .eq("id", input.projectId)
    .eq("tenant_id", tenantId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Drop the link.
 *
 * Deliberately clears `vercel_production_url` too: a stale production URL for a
 * project we are no longer linked to is a link the operator would click,
 * believing DevPilot still knows what is deployed there. This does NOT touch the
 * Vercel project itself — DevPilot never deletes a Vercel resource, because an
 * accidental unlink must not be able to destroy a live deployment.
 */
export async function clearVercelLink(
  db: SupabaseClient,
  tenantId: string,
  projectId: string,
): Promise<WriteResult> {
  const { error } = await db
    .from("projects")
    .update({
      vercel_project_id: null,
      vercel_project_name: null,
      vercel_production_url: null,
      vercel_production_branch: null,
      vercel_production_branch_desired: null,
      vercel_prod_deploy_mode: null,
      vercel_linked_at: null,
      vercel_linked_by: null,
    })
    .eq("id", projectId)
    .eq("tenant_id", tenantId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Record a change of intent for git → production auto-deploy. Separate from
 *  the link write because it is the one field an operator changes on its own,
 *  and conflating them would let a mode change silently rewrite the link. */
export async function writeProdDeployMode(
  db: SupabaseClient,
  tenantId: string,
  projectId: string,
  mode: ProdDeployMode,
): Promise<WriteResult> {
  const { error } = await db
    .from("projects")
    .update({ vercel_prod_deploy_mode: mode })
    .eq("id", projectId)
    .eq("tenant_id", tenantId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Record a change to the EXPECTED production branch. Separate from the link
 *  write for the same reason as the mode: it is a field an operator revisits on
 *  its own, and folding it in would let one edit rewrite the whole link. */
export async function writeDesiredProductionBranch(
  db: SupabaseClient,
  tenantId: string,
  projectId: string,
  branch: string | null,
): Promise<WriteResult> {
  const { error } = await db
    .from("projects")
    .update({ vercel_production_branch_desired: branch })
    .eq("id", projectId)
    .eq("tenant_id", tenantId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Refresh the stored production-branch snapshot after a successful live read.
 *  Keeps the offline fallback from drifting further than one render behind. */
export async function writeProductionBranchSnapshot(
  db: SupabaseClient,
  tenantId: string,
  projectId: string,
  branch: string | null,
): Promise<WriteResult> {
  const { error } = await db
    .from("projects")
    .update({ vercel_production_branch: branch })
    .eq("id", projectId)
    .eq("tenant_id", tenantId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
