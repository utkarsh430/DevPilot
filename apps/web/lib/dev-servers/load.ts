// Phase 2 / M5e — Dev-server session loaders.
//
// Service-role reads from `dev_server_sessions`. Three call sites:
//   • the project-scoped Run panel needs "is there a session for this project
//     I should attach to?",
//   • the /changes detail page needs the same lookup but scoped to the active
//     pending push so the operator runs THE not-yet-pushed branch, and
//   • the heartbeat HTTP endpoint needs a single-row lookup by id to decide
//     if a status transition fired.
//
// All reads bypass RLS via the service-role client because either:
//   (a) the caller is a server action that has already proved tenant ownership
//       via requireUser + requireTenantId, or
//   (b) the caller is the runner heartbeat endpoint, which is gated by the
//       x-devpilot-runner-key check.
//
// The hook in `apps/web/lib/realtime/use-live-dev-server.ts` does its OWN
// reads via the browser (RLS-gated) client. Don't import this file from any
// client code — it's service-role only.

import { supabaseService } from "@/lib/db/server";

export type DevServerSessionRow = {
  id: string;
  tenantId: string;
  projectId: string;
  ticketId: string | null;
  pendingPushId: string | null;
  workspacePath: string;
  branch: string;
  command: string;
  port: number | null;
  url: string | null;
  pid: number | null;
  runnerId: string | null;
  status: "starting" | "running" | "stopped" | "errored" | "building" | "needs_env";
  statusReason: string | null;
  lastLogTail: string | null;
  startedByUserId: string | null;
  startedAt: string;
  lastHeartbeatAt: string;
  lastInteractionAt: string;
  stoppedAt: string | null;
};

// Raw snake_case shape PostgREST returns. Mirrors the migration's column
// order so future schema extensions are easy to land here.
type RawRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  ticket_id: string | null;
  pending_push_id: string | null;
  workspace_path: string;
  branch: string;
  command: string;
  port: number | null;
  url: string | null;
  pid: number | null;
  runner_id: string | null;
  status: "starting" | "running" | "stopped" | "errored";
  status_reason: string | null;
  last_log_tail: string | null;
  started_by_user_id: string | null;
  started_at: string;
  last_heartbeat_at: string;
  last_interaction_at: string;
  stopped_at: string | null;
};

const ROW_COLUMNS =
  "id, tenant_id, project_id, ticket_id, pending_push_id, workspace_path, branch, command, port, url, pid, runner_id, status, status_reason, last_log_tail, started_by_user_id, started_at, last_heartbeat_at, last_interaction_at, stopped_at";

function mapRow(row: RawRow): DevServerSessionRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    pendingPushId: row.pending_push_id,
    workspacePath: row.workspace_path,
    branch: row.branch,
    command: row.command,
    port: row.port,
    url: row.url,
    pid: row.pid,
    runnerId: row.runner_id,
    status: row.status,
    statusReason: row.status_reason,
    lastLogTail: row.last_log_tail,
    startedByUserId: row.started_by_user_id,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastInteractionAt: row.last_interaction_at,
    stoppedAt: row.stopped_at,
  };
}

/**
 * Most recent active session (status in 'starting' or 'running') for a
 * project. Returns null if no session is currently live — the UI uses that
 * null result to render the Idle state with a Run button.
 */
export async function getActiveSessionForProject(
  projectId: string,
  tenantId: string,
): Promise<DevServerSessionRow | null> {
  const supabase = supabaseService();
  // Tenant-scoped: `dev_server_sessions` carries its own `tenant_id` and its
  // member write policy pins only that, never the `project_id` it names — so a
  // clean project id does not imply a clean session row. `tenantId` is a
  // REQUIRED parameter rather than an optional one so a future caller cannot
  // reintroduce the unscoped read by omission.
  const { data, error } = await supabase
    .from("dev_server_sessions")
    .select(ROW_COLUMNS)
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId)
    .in("status", ["starting", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`getActiveSessionForProject failed: ${error.message}`);
  }
  return data ? mapRow(data as RawRow) : null;
}

/**
 * Same as above but scoped to a specific pending push id. Used by the /changes
 * detail page so the Run button attaches to THAT branch's session, not just
 * any session on the project.
 */
export async function getActiveSessionForPendingPush(
  pendingPushId: string,
  tenantId: string,
): Promise<DevServerSessionRow | null> {
  const supabase = supabaseService();
  // Same scope, same reason as `getActiveSessionForProject` above.
  const { data, error } = await supabase
    .from("dev_server_sessions")
    .select(ROW_COLUMNS)
    .eq("pending_push_id", pendingPushId)
    .eq("tenant_id", tenantId)
    .in("status", ["starting", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`getActiveSessionForPendingPush failed: ${error.message}`);
  }
  return data ? mapRow(data as RawRow) : null;
}

/**
 * Single session by id. Used by the heartbeat HTTP endpoint to detect status
 * transitions (which then emit `dev_server.status_changed`) and by the stop
 * action to verify tenant ownership before sending the stop event.
 */
export async function getSessionById(sessionId: string): Promise<DevServerSessionRow | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("dev_server_sessions")
    .select(ROW_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  if (error) {
    throw new Error(`getSessionById failed: ${error.message}`);
  }
  return data ? mapRow(data as RawRow) : null;
}
