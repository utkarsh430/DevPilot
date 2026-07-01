// Server-side loader for the onboarding readiness snapshot (derivation rules
// live in ./readiness.ts). Used by the app-shell layout (topbar checklist
// seed) and GET /api/onboarding/readiness; the welcome screen shares the pure
// helpers directly since it already loads projects + health for its own UI.

import "server-only";

import { supabaseServer, supabaseService } from "@/lib/db/server";
import { loadProjectsForTenant } from "@/lib/projects/load";
import { loadSystemHealthSnapshot } from "@/lib/health/load";
import { runnerConnectedFromHealth, type ReadinessSnapshot } from "@/lib/onboarding/readiness";

/** Does the user have a GitHub OAuth token row? Presence check only - no
 *  token decrypt (that's `getGithubTokenRow`'s job for callers that need the
 *  plaintext). Fail-soft like the other readiness probes: a transient read
 *  error renders the check unticked rather than breaking the shell. */
export async function githubTokenPresent(userId: string): Promise<boolean> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("github_oauth_tokens")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}

/** Has any run in this tenant finished successfully? RLS-bound (the caller
 *  only sees their tenant); the explicit tenant filter keeps multi-tenant
 *  sessions honest and rides the (tenant_id, status) index. */
export async function hasFinishedRun(tenantId: string): Promise<boolean> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "done")
    .limit(1);
  // Fail-soft: a transient read error renders the check unticked rather than
  // breaking the shell — the next poll corrects it.
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

export async function loadReadinessSnapshot(
  userId: string,
  tenantId: string,
): Promise<ReadinessSnapshot> {
  const [githubConnected, firstRunDone, hasProject, health] = await Promise.all([
    githubTokenPresent(userId),
    hasFinishedRun(tenantId),
    loadProjectsForTenant(tenantId).then((p) => p.length > 0),
    loadSystemHealthSnapshot(tenantId),
  ]);
  return {
    githubConnected,
    hasProject,
    runnerConnected: runnerConnectedFromHealth(health),
    expectsLocalRunner: health.expectsLocalRunner,
    firstRunDone,
  };
}
