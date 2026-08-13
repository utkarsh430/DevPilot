"use client";

// Phase 2.5+ / M7 (UX wave) — Live plan-session row hook.
//
// `useLivePlanSession` mirrors `useLivePlanMessages` exactly — same channel
// shape, same `React.useId()` per-mount suffix, same `setSession(initial)`
// resync semantics — but tracks the single `planning_sessions` row by `id`
// instead of a stream of `planning_messages` rows.
//
// Why this hook (and not just a re-fetch after the snapshot loads):
//   • PlanSheet flips its visible mode off `session.status`
//     (`discussing → planning → planned → committed/discarded`). If the
//     Inngest pipeline finishes (or Agent S's rollback path fires) while the
//     Sheet is open, the operator should see the transition without a manual
//     refresh.
//   • A second tab discarding/committing the same session must close this
//     Sheet gracefully — when the row deletes or its status moves to a
//     terminal state, we want to surface that immediately.
//
// We listen to UPDATE and DELETE on the row. INSERTs can't apply to a row we
// already loaded (the PK is fixed at session-create time), and the seed comes
// from a server-rendered snapshot.

import * as React from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/db/browser";
import type { PlanSession, PlanStatus, StackAdviceStatus, StackFlavor } from "@/lib/plan/types";

// Snake-case row shape as it arrives off Postgres logical replication.
// Kept private to this file — components see `PlanSession`.
type RealtimePlanSessionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  created_by: string | null;
  goal_summary: string | null;
  status: PlanStatus;
  stack_flavor: StackFlavor;
  stack_preferences: string | null;
  spent_cents: number | null;
  billed_at: string | null;
  created_at: string;
  updated_at: string;
  stack_advice_status: StackAdviceStatus | null;
};

function rowToPlanSession(row: RealtimePlanSessionRow): PlanSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    createdBy: row.created_by,
    goalSummary: row.goal_summary,
    status: row.status,
    stackFlavor: row.stack_flavor,
    stackPreferences: row.stack_preferences ?? "",
    spentCents: row.spent_cents ?? 0,
    billedAt: row.billed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stackAdviceStatus: row.stack_advice_status ?? "unrun",
  };
}

export function useLivePlanSession(
  sessionId: string | null,
  initial: PlanSession | null,
): { session: PlanSession | null; isLive: boolean } {
  const [session, setSession] = React.useState<PlanSession | null>(initial);
  const [isLive, setIsLive] = React.useState(false);
  // Per-hook-instance unique suffix — same fix as `use-pending-pushes.ts`.
  const instanceId = React.useId();

  // Resync when the seed handed in by the parent changes (e.g. PlanSheet
  // loads a fresh snapshot after a session swap or `startPlanSessionAction`).
  React.useEffect(() => {
    setSession(initial);
  }, [initial]);

  React.useEffect(() => {
    if (!sessionId) {
      setIsLive(false);
      return;
    }

    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    const supabase = supabaseBrowser();

    channel = supabase
      .channel(`plan-session:${sessionId}:${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "planning_sessions",
          filter: `id=eq.${sessionId}`,
        },
        (payload) => {
          const row = payload.new as RealtimePlanSessionRow;
          setSession(rowToPlanSession(row));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "planning_sessions",
          filter: `id=eq.${sessionId}`,
        },
        () => {
          // Another tab (or a cascade) deleted the row — surface null so the
          // PlanSheet can close itself.
          setSession(null);
        },
      )
      .subscribe((status) => {
        if (cancelled) return;
        setIsLive(status === "SUBSCRIBED");
      });

    return () => {
      cancelled = true;
      setIsLive(false);
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    };
  }, [sessionId, instanceId]);

  return { session, isLive };
}
