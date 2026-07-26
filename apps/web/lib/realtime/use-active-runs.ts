"use client";

// Ambient agent-activity subscription — "is anything working right now?"
//
// Read substrate for `<ActivityIndicator>` in the app chrome. Follows the
// `use-pending-pushes.ts` shape exactly, which is the established precedent for
// a live count in the chrome:
//
//   • One channel PER MOUNT with a `React.useId()` suffix, so a second mount
//     never collides on a cached channel name (`.on()` after `.subscribe()`
//     throws).
//   • Server-side `tenant_id=eq.<id>` filter on INSERT/UPDATE so other tenants'
//     deltas never reach this client. RLS (`runs_member_read`) is the actual
//     boundary; the filter just trims noise.
//   • `createSubscribeHandler` for drop→resubscribe reconciliation. Realtime
//     does not replay missed messages, so without this the indicator would go
//     permanently stale after the first backgrounded tab while still claiming
//     to be live — for THIS surface that means silently showing "2 working"
//     forever after the work finished, which is the worst failure it has.
//   • Unmount tears the socket down via `removeChannel`.
//
// ── READ-ONLY ────────────────────────────────────────────────────────────────
// This hook and its component issue SELECTs and nothing else. They never
// dispatch, cancel, retry or mutate a run — the surface observes, and every
// action deep-links into the existing run view. `__tests__/read-only.test.ts`
// enforces that against the source rather than trusting the comment.
//
// ── WHY A HYBRID, NOT PURE-REALTIME OR PURE-POLL ─────────────────────────────
// A Realtime payload carries the raw `runs` row only — no embeds — so it cannot
// tell us the ticket title, project name or role the popover renders. So:
//
//   • A run LEAVING the working set (status flips off 'running') is applied
//     LOCALLY and instantly from the payload alone. No fetch. This is the
//     responsiveness that matters: the indicator must go quiet the moment work
//     stops, or it lies in the direction that wastes the operator's attention.
//   • A run ENTERING the set needs its embedded detail, so it schedules one
//     coalesced refetch (trailing, `REFETCH_DEBOUNCE_MS`). Runs start every few
//     minutes, not every second, and bursts (a fan-out cohort, a drain window
//     filling) collapse into a single query.
//
// There is no timer and no interval anywhere in this file: an idle tenant makes
// zero requests after the initial bootstrap.

import * as React from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/db/browser";
import { createSubscribeHandler, type RealtimeStatus } from "@/lib/realtime/connection";
import {
  summarizeActivity,
  type ActivityRun,
  type ActivitySummary,
} from "@/lib/activity/active-runs";
import {
  fetchActiveRuns,
  FETCHED_STATUSES,
  type ActivityQueryClient,
  type RawActivityRow,
} from "@/lib/activity/query";

/** Coalesce a burst of run-starts (a fan-out cohort) into one query. */
const REFETCH_DEBOUNCE_MS = 400;

/** Statuses worth carrying in local state at all — mirrors the accessor. */
const TRACKED_STATUSES = new Set<string>(FETCHED_STATUSES);

export type UseActiveRunsResult = ActivitySummary & {
  isLive: boolean;
  loading: boolean;
  status: RealtimeStatus;
};

/**
 * Live agent activity for a tenant, across ALL projects.
 *
 * Tenant-wide is a deliberate scope choice, not an omission — see the header of
 * `lib/activity/active-runs.ts`. The consuming component states it in the UI.
 */
export function useActiveRuns(opts: { tenantId: string }): UseActiveRunsResult {
  const { tenantId } = opts;
  const [rows, setRows] = React.useState<ActivityRun[]>([]);
  const [statusState, setStatusState] = React.useState<RealtimeStatus>("connecting");
  const [loading, setLoading] = React.useState(true);
  const instanceId = React.useId();
  /**
   * id → status mirror of local state, so a realtime handler can ask "do I
   * already have this row at this status?" without reading state inside a
   * setState updater (which must stay pure). Rebuilt from every authoritative
   * fetch, so a drop→resubscribe reconcile also repairs any drift here.
   */
  const trackedRef = React.useRef<Map<string, string>>(new Map());

  React.useEffect(() => {
    // No resolved tenant: open no channel, issue no query, show nothing.
    if (!tenantId) {
      trackedRef.current = new Map();
      setRows([]);
      setLoading(false);
      setStatusState("connecting");
      return;
    }

    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const supabase = supabaseBrowser();

    async function bootstrap() {
      const { rows: next, error } = await fetchActiveRuns(
        supabase as unknown as ActivityQueryClient,
        tenantId,
      );
      if (cancelled) return;
      if (error) {
        // Never swallow a Supabase error silently — an ambiguous embed
        // (PGRST201) otherwise presents as a permanently empty, permanently
        // quiet indicator that looks exactly like a healthy idle tenant.
        console.error("[activity] failed to load active runs", error);
        // Clear the mirror on failure. `applyRow` marks a row as tracked
        // BEFORE the fetch that would supply its detail, so leaving the mirror
        // populated after an error would make a repeat delta for that same run
        // short-circuit as "already have it" and the run would never appear.
        // Emptying it costs one redundant refetch and restores self-healing.
        trackedRef.current = new Map();
        setLoading(false);
        return;
      }
      // The fetch is authoritative — rebuild the mirror from it rather than
      // patching, so any drift accumulated from missed deltas is repaired.
      trackedRef.current = new Map(next.map((r) => [r.id, r.status]));
      setRows(next);
      setLoading(false);
    }

    function scheduleRefetch() {
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        void bootstrap();
      }, REFETCH_DEBOUNCE_MS);
    }

    /**
     * Apply a realtime row. A run leaving the tracked set is dropped locally
     * and instantly; one entering (or changing status within) it needs embeds,
     * so it schedules a coalesced refetch.
     *
     * The "do I already have this?" question is answered from `trackedRef`, a
     * mirror of local state, NOT from inside a `setRows` updater. A state
     * updater must be PURE — React invokes it twice under StrictMode, and
     * scheduling a fetch from inside one is the kind of double-firing that
     * looks fine in production and misbehaves in development.
     */
    function applyRow(row: RawActivityRow) {
      if (!TRACKED_STATUSES.has(row.status)) {
        trackedRef.current.delete(row.id);
        setRows((cur) => cur.filter((r) => r.id !== row.id));
        return;
      }
      // Already tracked at this status — nothing to show differently. This is
      // the common case for `last_event_at` heartbeat updates, and short-
      // circuiting keeps them from each costing a query.
      if (trackedRef.current.get(row.id) === row.status) return;
      trackedRef.current.set(row.id, row.status);
      scheduleRefetch();
    }

    void bootstrap();

    channel = supabase
      .channel(`active-runs:${tenantId}:${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "runs",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => applyRow(payload.new as RawActivityRow),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "runs",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => applyRow(payload.new as RawActivityRow),
      )
      .on(
        "postgres_changes",
        // NO server-side filter on DELETE: under the default replica identity a
        // delete payload carries ONLY the primary key, so filtering it on
        // `tenant_id` matches nothing and silently drops every delete. Take all
        // deletes and match on id — a foreign id is a harmless no-op.
        { event: "DELETE", schema: "public", table: "runs" },
        (payload) => {
          const row = payload.old as Partial<RawActivityRow>;
          if (!row?.id) return;
          trackedRef.current.delete(row.id);
          setRows((cur) => cur.filter((r) => r.id !== row.id));
        },
      )
      .subscribe(
        createSubscribeHandler({
          isCancelled: () => cancelled,
          setStatus: setStatusState,
          // Reconcile after a real drop→resubscribe. Without this the indicator
          // strands on whatever it last saw — showing work that finished during
          // a backgrounded tab, or missing work that started.
          onReconnect: () => void bootstrap(),
        }),
      );

    return () => {
      cancelled = true;
      if (refetchTimer) clearTimeout(refetchTimer);
      // Clear the mirror too — a remount (tenant switch, StrictMode) must not
      // inherit ids from the previous subscription and short-circuit the
      // refetch that would have surfaced them.
      trackedRef.current = new Map();
      setStatusState("connecting");
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    };
  }, [tenantId, instanceId]);

  const summary = React.useMemo(() => summarizeActivity(rows), [rows]);

  return {
    ...summary,
    isLive: statusState === "live",
    loading,
    status: statusState,
  };
}
