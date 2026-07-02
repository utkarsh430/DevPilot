// Server-side helper for forcing a ticket's on-disk workspace to be re-cloned.
//
// The runner's `prepareWorkspace` re-enters an existing workspace and KEEPS its
// current `devpilot/<slug>` branch (cut from the OLD base), ignoring `baseBranch`
// entirely — so a re-dispatched ticket does NOT rebuild on the integration
// branch while its workspace still exists on disk. To make the next run
// fresh-clone the current integration tip, the workspace has to be ABSENT.
//
// We do that by REUSING the existing reaper cleanup pipeline rather than
// inventing a new one: emit the same `workspace/cleanup-requested` event the
// nightly reaper emits. The `workspaceCleanupEnqueuer` translates it into a
// Redis job the runner's cleanup loop drains, and the runner's `cleanupWorkspace`
// enforces the SACRED unpushed-work reap guard (`workspace-reap-guard.ts`) in
// front of the `rm` — so the DEFAULT path can never destroy the only copy of a
// commit. The safe caller (`reopenFromDevAction`) additionally checks for unpushed
// work up front and refuses, so the operator gets a clear message instead of a
// silently-held workspace.
//
// The `force` override
// ────────────────────
// The DELIBERATE "Discard & restart from dev" operator action passes `force:
// true`, which flows through the event → the Redis job → `cleanupWorkspace`,
// where — and ONLY where — it bypasses the reap guard so the confirmed discard
// actually wipes the workspace. This is the sanctioned release of the data-loss
// hold: an operator who has explicitly confirmed they want the work thrown away.
// No reaper path and no agent path ever sets it, so the guard stays fully intact
// for everyone else.
//
// Cross-host note: the event carries the absolute `workspace_path` values the
// runs actually used (gathered from `run_steps.payload`), because the runner
// only acts on paths under its own `WORKSPACE_ROOT` (see the cleanup consumer).

import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseService } from "@/lib/db/server";

/**
 * The distinct absolute `workspace_path` values recorded across all of a
 * ticket's runs. `run_steps` has no direct `ticket_id`, so we join through
 * `runs`. Empty when the ticket never produced a workspace (no code run yet).
 *
 * This is the same gather the workspace reaper does; extracted so both share one
 * implementation.
 */
export async function loadTicketWorkspacePaths(
  ticketId: string,
  tenantId: string,
): Promise<string[]> {
  const supabase = supabaseService();
  // Tenant-scoped: the paths this returns are handed to the runner to `rm -rf`.
  // Unscoped, a planted `{tenant_id: them, ticket_id: <our ticket>}` run row
  // would pull ANOTHER tenant's `run_steps` into the gather and put their
  // workspace path on our cleanup list — a cross-tenant delete of a directory
  // that, per the reap-guard invariant, may hold the only copy of a commit.
  const { data: runs } = await supabase
    .from("runs")
    .select("id")
    .eq("ticket_id", ticketId)
    .eq("tenant_id", tenantId);
  const runIds = (runs ?? []).map((r) => r.id as string);
  if (runIds.length === 0) return [];
  const { data: steps } = await supabase.from("run_steps").select("payload").in("run_id", runIds);
  const set = new Set<string>();
  for (const s of steps ?? []) {
    const p = (s.payload as { workspace_path?: string | null } | null)?.workspace_path;
    if (typeof p === "string" && p.length > 0) set.add(p);
  }
  return Array.from(set);
}

/**
 * Request that the runner remove a ticket's on-disk workspace so the NEXT
 * dispatch fresh-clones the integration branch.
 *
 * Best-effort and asynchronous by nature (the runner drains the cleanup queue on
 * a slow cadence), which is exactly why the reopen leaves the ticket in
 * `backlog` (a resting state that needs an explicit move to `ready` before
 * anything dispatches) — that human step is the gap in which the cleanup runs.
 * Returns whether an emit was made and how many paths it targeted.
 */
export async function requestWorkspaceReset(args: {
  ticketId: string;
  tenantId: string;
  reason: string;
  /**
   * DELIBERATE-DISCARD override — bypass the runner's reap guard so the workspace
   * is wiped even if it holds unpushed commits. Set ONLY by the operator "Discard
   * & restart from dev" action after an explicit, confirmed, human discard. The
   * safe "Restart from dev" leaves this false, so its cleanup still refuses to
   * destroy unpushed work.
   */
  force?: boolean;
}): Promise<{ emitted: boolean; paths: number }> {
  const paths = await loadTicketWorkspacePaths(args.ticketId, args.tenantId);
  if (paths.length === 0) return { emitted: false, paths: 0 };
  // Bounded: an unresponsive Inngest makes a raw `inngest.send` hang rather than
  // throw, and both callers of this function are operator actions that treat the
  // emit as best-effort - an intent a hang silently defeats. The callers bound
  // this whole function as well; that outer bound caps their total wait (it also
  // covers the read above), while this one is what protects a future caller that
  // forgets to.
  await sendEventBounded({
    name: "workspace/cleanup-requested",
    data: {
      tenantId: args.tenantId,
      ticketId: args.ticketId,
      paths,
      reason: args.reason,
      // Only carry the flag when set, so a reaper/safe-restart event stays byte-
      // identical to before this feature.
      ...(args.force ? { force: true } : {}),
    },
  });
  return { emitted: true, paths: paths.length };
}
