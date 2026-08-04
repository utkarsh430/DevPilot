"use client";

// Phase 2 / M5e — Dev-server session realtime hook.
//
// `useLiveDevServer` mirrors `useLivePendingPushes` (M5c canonical pattern).
// It subscribes to `dev_server_sessions` filtered by tenant_id and returns
// the SINGLE most-recent active session matching the caller's scope:
//
//   • scope = { kind: "project",      projectId }      — Run panel on
//                                                        /projects/[id]
//   • scope = { kind: "pending_push", pendingPushId }  — Run panel on
//                                                        /changes/[id]
//
// One channel PER MOUNT, scoped with a `React.useId()` suffix so two mounts
// (e.g. the project panel + a sidebar pill) don't collide on the same
// channel name. Supabase's `.channel(name)` returns the EXISTING channel
// when a name is already cached and `.on()` after `.subscribe()` throws —
// the unique suffix avoids that bug class entirely. The M5c instanceId fix
// for `useLivePendingPushes` is the canonical reference; this hook follows
// the same shape.
//
// The hook also tracks `loading` (false once the initial fetch completes)
// and `isLive` (true while the channel is SUBSCRIBED) so the panel can
// distinguish "no session" from "still booting" and show the connection
// dot accordingly.

import * as React from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/db/browser";

export type DevServerStatus =
  | "starting"
  | "running"
  | "stopped"
  | "errored"
  | "building"
  | "needs_env";

export type DevServerSnapshot = {
  id: string;
  tenantId: string;
  projectId: string;
  status: DevServerStatus;
  statusReason: string | null;
  port: number | null;
  url: string | null;
  command: string;
  lastLogTail: string | null;
  startedAt: string;
  updatedAt: string;
  /** Slice C — runner's file-watcher heartbeat. The runner reads HEAD's SHA
   *  on every workspace-tree change (debounced 500ms) and emits the result
   *  alongside the normal heartbeat. UI compares against the last-known
   *  pending_pushes.head_sha to surface a "Workspace updated" pill when
   *  the operator made a commit locally. Null when the watcher isn't
   *  running (older runner builds, sessions in 'starting', etc.). */
  workspaceHeadSha: string | null;
  /** Slice C — `git status --porcelain` line count. Drives the
   *  "N uncommitted edits" badge in the Live tab + RunPanel headers so the
   *  operator can tell at a glance whether their local edits are still
   *  pending. */
  workspaceDirtyFileCount: number | null;
  /** Slice IB / branch picker — the branch the workspace is checked out on.
   *  Surfaced so the panel can render a "switch branch" affordance. */
  branch: string;
  /** Required env var keys the runner detected as missing (status=needs_env).
   *  The panel renders a masked-input form for these. Null otherwise. */
  missingEnvKeys: string[] | null;
};

// Snake-case shape PostgREST / Realtime delivers. We only pick the columns
// the panel actually needs — the raw migration has more (workspace_path,
// branch, pid, runner_id, …) but those aren't surfaced in this UI today.
type RawRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  pending_push_id: string | null;
  status: DevServerStatus;
  status_reason: string | null;
  port: number | null;
  url: string | null;
  command: string;
  last_log_tail: string | null;
  started_at: string;
  updated_at: string;
  workspace_head_sha: string | null;
  workspace_dirty_file_count: number | null;
  branch: string;
  missing_env_keys: string[] | null;
};

const ROW_COLUMNS =
  "id, tenant_id, project_id, pending_push_id, status, status_reason, port, url, command, last_log_tail, started_at, updated_at, workspace_head_sha, workspace_dirty_file_count, branch, missing_env_keys";

function mapRow(row: RawRow): DevServerSnapshot {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    status: row.status,
    statusReason: row.status_reason,
    port: row.port,
    url: row.url,
    command: row.command,
    lastLogTail: row.last_log_tail,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    workspaceHeadSha: row.workspace_head_sha,
    workspaceDirtyFileCount: row.workspace_dirty_file_count,
    branch: row.branch,
    missingEnvKeys: row.missing_env_keys,
  };
}

// A session is "visible in the panel" if it matches the scope AND is in
// starting/running OR is the most recent errored row. Errored rows MUST stay
// visible so the operator sees `statusReason` + the log tail explaining why
// `pnpm dev` crashed (e.g. "Missing required Supabase environment variable"
// from the project's own startup-validation). The old behavior dropped them
// silently and the panel collapsed back to Idle, hiding the failure.
//
// `stopped` rows DO get dropped — those represent a user-initiated Stop, no
// reason for the operator to keep staring at the corpse.
function isVisibleStatus(row: RawRow): boolean {
  return (
    row.status === "starting" ||
    row.status === "running" ||
    row.status === "errored" ||
    // `building` (live substage) and `needs_env` (parked, awaiting the
    // operator's env input) must stay visible so the panel can show progress /
    // the masked-input prompt.
    row.status === "building" ||
    row.status === "needs_env"
  );
}

export type DevServerScope =
  | { kind: "project"; projectId: string }
  | { kind: "pending_push"; pendingPushId: string };

function passesScope(row: RawRow, scope: DevServerScope): boolean {
  if (scope.kind === "project") {
    return row.project_id === scope.projectId;
  }
  return row.pending_push_id === scope.pendingPushId;
}

export function useLiveDevServer(opts: { tenantId: string; scope: DevServerScope }): {
  session: DevServerSnapshot | null;
  isLive: boolean;
  loading: boolean;
} {
  const { tenantId, scope } = opts;
  const [session, setSession] = React.useState<DevServerSnapshot | null>(null);
  const [isLive, setIsLive] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  // Per-mount unique suffix. See `useLivePendingPushes` for the full
  // rationale — short version: Supabase caches channels by name and `.on()`
  // after `.subscribe()` throws, so a duplicate name across mounts trips a
  // hard error. `React.useId()` is stable per mount and unique across them.
  const instanceId = React.useId();

  // Scope identity for the effect dep array. We can't put the `scope` object
  // itself in there (new object reference every render) so we project it to
  // a primitive key.
  const scopeKey =
    scope.kind === "project" ? `project:${scope.projectId}` : `pending_push:${scope.pendingPushId}`;

  React.useEffect(() => {
    if (!tenantId) {
      setSession(null);
      setLoading(false);
      setIsLive(false);
      return;
    }

    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    const supabase = supabaseBrowser();

    async function fetchLatest(): Promise<RawRow | null> {
      let query = supabase
        .from("dev_server_sessions")
        .select(ROW_COLUMNS)
        .eq("tenant_id", tenantId)
        .in("status", ["starting", "running", "errored", "building", "needs_env"]);
      if (scope.kind === "project") {
        query = query.eq("project_id", scope.projectId);
      } else {
        query = query.eq("pending_push_id", scope.pendingPushId);
      }
      const { data } = await query.order("started_at", { ascending: false }).limit(1);
      return ((data as RawRow[] | null) ?? [])[0] ?? null;
    }

    async function bootstrap() {
      setLoading(true);
      const first = await fetchLatest();
      if (cancelled) return;
      setSession(first ? mapRow(first) : null);
      setLoading(false);
    }

    function applyIncoming(row: RawRow) {
      if (!passesScope(row, scope)) {
        // If the row used to be ours but the scope link got cleared (e.g.
        // pending_push_id set to null because the push landed), drop it.
        setSession((cur) => (cur && cur.id === row.id ? null : cur));
        return;
      }
      if (!isVisibleStatus(row)) {
        // Stopped row → drop if it's the current one. Errored rows are
        // visible (see isVisibleStatus comment), so they don't hit this.
        setSession((cur) => (cur && cur.id === row.id ? null : cur));
        return;
      }
      const next = mapRow(row);
      setSession((cur) => {
        if (!cur) return next;
        if (cur.id === next.id) return next;
        // Two active sessions for the same scope shouldn't happen in
        // practice — the start action races on insert and the engine reaps
        // duplicates — but if it does, prefer the most recent `started_at`.
        return new Date(next.startedAt).getTime() >= new Date(cur.startedAt).getTime() ? next : cur;
      });
    }

    // Polling backstop. Supabase Realtime postgres_changes can fail to deliver
    // (RLS/auth on the WS, replica-identity propagation, idle-socket drops) even
    // while the channel reports SUBSCRIBED — which left the panel stale until a
    // manual page reload. Re-querying every 2.5s guarantees the panel reflects
    // DB state (status flips, last_log_tail) within a few seconds regardless.
    async function poll() {
      if (cancelled) return;
      const row = await fetchLatest();
      if (cancelled) return;
      if (row) applyIncoming(row);
      else setSession((cur) => (cur ? null : cur));
    }

    void bootstrap();

    channel = supabase
      .channel(`dev-server-sessions:${tenantId}:${scopeKey}:${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "dev_server_sessions",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => {
          applyIncoming(payload.new as RawRow);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "dev_server_sessions",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => {
          applyIncoming(payload.new as RawRow);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "dev_server_sessions",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => {
          const row = payload.old as Partial<RawRow>;
          if (!row?.id) return;
          setSession((cur) => (cur && cur.id === row.id ? null : cur));
        },
      )
      .subscribe((status) => {
        if (cancelled) return;
        setIsLive(status === "SUBSCRIBED");
      });

    const pollTimer = setInterval(() => void poll(), 2500);

    return () => {
      cancelled = true;
      setIsLive(false);
      clearInterval(pollTimer);
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    };
    // `scope` is captured via scopeKey; including the raw object would
    // re-fire the effect every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, scopeKey, instanceId]);

  return { session, isLive, loading };
}
