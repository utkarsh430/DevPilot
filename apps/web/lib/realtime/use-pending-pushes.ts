"use client";

// Phase 2 / M5c — Pending-pushes realtime subscription.
//
// `useLivePendingPushes` is the read substrate for the `/changes` list, the
// detail page, and the sidebar `<ChangesBadge>`. It mirrors the shape of
// `useLiveTickets` (Wave 1 of the M2 board substrate):
//
//   • One channel PER MOUNT, scoped to the caller's tenant id, with an
//     optional project filter. Unmount tears the socket down via
//     `removeChannel` so reloading the page doesn't stack channels.
//   • Server-side filter on `tenant_id=eq.<id>` so other tenants' deltas never
//     reach this client. RLS still gates correctness; the filter just trims
//     noise.
//   • An optional `projectId` argument narrows the filter; "All projects" is
//     encoded as `projectId = null/undefined` and is the catch-all.
//   • Only rows with `pushed_at IS NULL` are considered "pending" — the rest
//     are historical/audit rows. The hook drops a row from local state the
//     instant its `pushed_at` flips, regardless of whether the UPDATE event
//     also satisfies the tenant filter (it always will).
//   • `isLive` reflects the channel state (true on SUBSCRIBED) so the badge
//     and list can show real connectivity, not "5s elapsed".
//
// The hook deliberately does its OWN initial fetch (rather than accepting a
// server-rendered seed) because it serves THREE call sites — the list page,
// the diff-review page header, and the sidebar badge — and threading a seed
// through all three is more friction than the extra read. The fetch is
// RLS-gated through the browser client.

import * as React from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/db/browser";
import { createSubscribeHandler, type RealtimeStatus } from "@/lib/realtime/connection";

export type PendingPushFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type PendingPushRow = {
  id: string;
  tenantId: string;
  projectId: string;
  ticketId: string | null;
  runId: string | null;
  branch: string;
  workspacePath: string;
  unpushedCount: number;
  pushedAt: string | null;
  pushedPrUrl: string | null;
  filesChanged: PendingPushFile[];
  headSha: string | null;
  createdAt: string;
  updatedAt: string;
};

// Snake-case row shape Realtime / PostgREST delivers. We do NOT pull
// `unified_diff` into the hook — it's heavy (capped at ~2 MB per row) and only
// the detail page needs it. The detail page fetches it on demand server-side.
type RawRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  ticket_id: string | null;
  run_id: string | null;
  branch: string;
  workspace_path: string;
  unpushed_count: number | null;
  pushed_at: string | null;
  pushed_pr_url: string | null;
  files_changed: PendingPushFile[] | null;
  head_sha: string | null;
  created_at: string;
  updated_at: string;
};

const ROW_COLUMNS =
  "id, tenant_id, project_id, ticket_id, run_id, branch, workspace_path, unpushed_count, pushed_at, pushed_pr_url, files_changed, head_sha, created_at, updated_at";

function rowToPendingPush(row: RawRow): PendingPushRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    runId: row.run_id,
    branch: row.branch,
    workspacePath: row.workspace_path,
    unpushedCount: row.unpushed_count ?? 0,
    pushedAt: row.pushed_at,
    pushedPrUrl: row.pushed_pr_url,
    filesChanged: Array.isArray(row.files_changed) ? row.files_changed : [],
    headSha: row.head_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Sorted newest-first by updated_at so the list/badge surface the most recent
// pending change at the top — matches how the operator scans the queue.
function sortPending(rows: PendingPushRow[]): PendingPushRow[] {
  return [...rows].sort((a, b) => {
    const at = new Date(a.updatedAt).getTime();
    const bt = new Date(b.updatedAt).getTime();
    return bt - at;
  });
}

export function useLivePendingPushes(opts: { tenantId: string; projectId?: string | null }): {
  items: PendingPushRow[];
  isLive: boolean;
  loading: boolean;
  status: RealtimeStatus;
} {
  const { tenantId, projectId } = opts;
  const [items, setItems] = React.useState<PendingPushRow[]>([]);
  const [status, setStatus] = React.useState<RealtimeStatus>("connecting");
  const [loading, setLoading] = React.useState(true);
  // Per-hook-instance unique suffix so two mounts of this hook (e.g. the
  // sidebar ChangesBadge + the /changes page) don't collide on the same
  // channel name. Supabase's `.channel(name)` returns the EXISTING channel
  // if one is already cached under that name, and `.on()` after `.subscribe()`
  // throws. A unique suffix per mount avoids the collision entirely.
  const instanceId = React.useId();

  React.useEffect(() => {
    if (!tenantId) {
      setItems([]);
      setLoading(false);
      setStatus("connecting");
      return;
    }

    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    const supabase = supabaseBrowser();

    async function bootstrap() {
      setLoading(true);
      let query = supabase
        .from("pending_pushes")
        .select(ROW_COLUMNS)
        .eq("tenant_id", tenantId)
        .is("pushed_at", null);
      if (projectId) query = query.eq("project_id", projectId);
      const { data } = await query.order("updated_at", { ascending: false });
      if (cancelled) return;
      const rows = (data as RawRow[] | null)?.map(rowToPendingPush) ?? [];
      setItems(rows);
      setLoading(false);
    }

    function passesProjectFilter(row: RawRow | PendingPushRow): boolean {
      if (!projectId) return true;
      const rowProjectId = "projectId" in row ? row.projectId : row.project_id;
      return rowProjectId === projectId;
    }

    function isPending(row: RawRow): boolean {
      return row.pushed_at === null;
    }

    void bootstrap();

    channel = supabase
      .channel(`pending-pushes:${tenantId}:${projectId ?? "all"}:${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "pending_pushes",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => {
          const row = payload.new as RawRow;
          if (!isPending(row)) return;
          if (!passesProjectFilter(row)) return;
          const next = rowToPendingPush(row);
          setItems((cur) => {
            if (cur.some((r) => r.id === next.id)) return cur;
            return sortPending([next, ...cur]);
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "pending_pushes",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => {
          const row = payload.new as RawRow;
          // A row that just got pushed (pushed_at != null) drops from the
          // pending list immediately — this is what makes the badge tick
          // down when somebody presses Push in another tab.
          if (!isPending(row)) {
            setItems((cur) => cur.filter((r) => r.id !== row.id));
            return;
          }
          if (!passesProjectFilter(row)) {
            setItems((cur) => cur.filter((r) => r.id !== row.id));
            return;
          }
          const next = rowToPendingPush(row);
          setItems((cur) => {
            const idx = cur.findIndex((r) => r.id === next.id);
            if (idx === -1) return sortPending([next, ...cur]);
            const copy = cur.slice();
            copy[idx] = next;
            return sortPending(copy);
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "pending_pushes",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => {
          const row = payload.old as Partial<RawRow>;
          if (!row?.id) return;
          setItems((cur) => cur.filter((r) => r.id !== row.id));
        },
      )
      .subscribe(
        createSubscribeHandler({
          isCancelled: () => cancelled,
          setStatus,
          // Reconcile after a real drop→resubscribe by re-running the same
          // bootstrap fetch — recovers INSERT/UPDATE/DELETE (incl. rows that
          // were pushed and should leave the list) missed during the gap.
          onReconnect: () => void bootstrap(),
        }),
      );

    return () => {
      cancelled = true;
      setStatus("connecting");
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    };
  }, [tenantId, projectId, instanceId]);

  return { items, isLive: status === "live", loading, status };
}
