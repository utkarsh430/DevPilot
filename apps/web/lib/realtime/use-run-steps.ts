"use client";

// Phase 1 / M2 — Wave 2 (run inspector step stream).
//
// `useLiveRunSteps` makes the Run Inspector tail an in-flight run instead of
// freezing on the server-rendered snapshot. Steps appear as the runner emits
// them, so users see thinks/tool_calls/tool_results land within a second of
// the durable engine appending them.
//
// Mirrors `useLiveTickets` (Wave 1):
//   • One channel PER RUN PAGE, scoped to `run_id`. Navigating away tears
//     down the socket via `removeChannel`.
//   • Server-side filter on `run_id=eq.<id>` so other runs' steps don't
//     reach this client. RLS still gates correctness; this trims noise.
//   • `isLive` reflects channel state (true on SUBSCRIBED).
//
// Field mapping: Realtime delivers snake_case columns straight from Postgres;
// we project them into the camelCase `RunStep` shape used everywhere else
// (`run_id` → `runId`, `created_at` → `createdAt`).

import * as React from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/db/browser";
import type { RunStep, RunStepKind } from "@/lib/runs/queries";
import { createSubscribeHandler, type RealtimeStatus } from "@/lib/realtime/connection";

// Snake-case row shape that Realtime delivers for `public.run_steps`.
type RealtimeRunStepRow = {
  id: number;
  run_id: string;
  idx: number;
  kind: RunStepKind;
  payload: Record<string, unknown> | null;
  created_at: string;
};

function rowToRunStep(row: RealtimeRunStepRow): RunStep {
  return {
    id: row.id,
    runId: row.run_id,
    idx: row.idx,
    kind: row.kind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export function useLiveRunSteps(
  runId: string,
  initial: RunStep[],
): { steps: RunStep[]; isLive: boolean; status: RealtimeStatus } {
  const [steps, setSteps] = React.useState<RunStep[]>(initial);
  const [status, setStatus] = React.useState<RealtimeStatus>("connecting");

  // Resync if the server hands a fresh snapshot (e.g. router.refresh()).
  React.useEffect(() => {
    setSteps(initial);
  }, [initial]);

  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    const supabase = supabaseBrowser();

    // Reconcile after a dropped→re-subscribed channel: refetch the run's steps
    // (RLS-gated) so any step the engine appended during the gap — which
    // Realtime will not replay — is recovered. Union with local state by id and
    // keep idx order.
    async function reconcile() {
      const { data } = await supabase
        .from("run_steps")
        .select("id, run_id, idx, kind, payload, created_at")
        .eq("run_id", runId)
        .order("idx", { ascending: true });
      if (cancelled || !data) return;
      const fresh = (data as RealtimeRunStepRow[]).map(rowToRunStep);
      setSteps((cur) => {
        const byId = new Map(fresh.map((s) => [s.id, s]));
        for (const s of cur) if (!byId.has(s.id)) byId.set(s.id, s);
        return Array.from(byId.values()).sort((a, b) => a.idx - b.idx);
      });
    }

    channel = supabase
      .channel(`run-steps:${runId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "run_steps",
          filter: `run_id=eq.${runId}`,
        },
        (payload) => {
          const row = payload.new as RealtimeRunStepRow;
          const next = rowToRunStep(row);
          setSteps((cur) => {
            if (cur.some((s) => s.id === next.id)) return cur;
            // Insert in idx order. Engines append monotonically so the
            // happy path is a tail push; the binary-search-free splice
            // here handles the rare out-of-order delivery cleanly.
            const insertAt = cur.findIndex((s) => s.idx > next.idx);
            if (insertAt === -1) return [...cur, next];
            const copy = cur.slice();
            copy.splice(insertAt, 0, next);
            return copy;
          });
        },
      )
      .subscribe(
        createSubscribeHandler({
          isCancelled: () => cancelled,
          setStatus,
          onReconnect: () => void reconcile(),
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
  }, [runId]);

  return { steps, isLive: status === "live", status };
}
