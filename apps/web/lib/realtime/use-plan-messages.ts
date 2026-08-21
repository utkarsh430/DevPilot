"use client";

// Phase 2.5+ / M7 — Plan-session message stream.
//
// `useLivePlanMessages` is the chat substrate for the PlanSheet. It mirrors
// `useLiveComments` (Phase 1 / M2 drawer comments) almost exactly:
//
//   • One channel PER MOUNT, scoped to a single `session_id`, with a
//     `React.useId()` suffix so two simultaneous mounts (PlanSheet open from
//     the board header AND a "Resume" click from `<PlanningCard>` mid-debug)
//     don't collide on the same channel name. Supabase's `.channel(name)`
//     returns the existing channel if cached and `.on()` after `.subscribe()`
//     throws — same trap landed in `use-pending-pushes.ts`.
//   • Server-side filter on `session_id=eq.<id>` so other sessions' deltas
//     never reach this client. RLS still gates correctness; the filter trims
//     noise.
//   • Seeds from a server-rendered `initial` list (the actions file fetches
//     the transcript at PlanSheet open and threads it down). The hook only
//     folds in deltas after mount, so first paint matches server.
//   • `isLive` reflects channel state (true on SUBSCRIBED) so the PlanSheet
//     can render a real connectivity dot, not a guess.
//
// We listen to INSERT for the append-only common case, plus UPDATE so the
// edit-and-resend flow (editPlanMessageAction patches a prior user message
// in place + truncates everything after) propagates the new content + the
// truncation to every open tab. DELETE rows arrive too — the truncate is
// implemented as a server-side bulk delete, and we drop matching IDs from
// local state on each one.

import * as React from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/db/browser";
import type { PlanMessage, RealtimePlanMessageRow } from "@/lib/plan/types";

function rowToPlanMessage(row: RealtimePlanMessageRow): PlanMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    role: row.role,
    content: row.content,
    agentRole: row.agent_role,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export function useLivePlanMessages(
  sessionId: string | null,
  initial: PlanMessage[],
): { messages: PlanMessage[]; isLive: boolean } {
  const [messages, setMessages] = React.useState<PlanMessage[]>(initial);
  const [isLive, setIsLive] = React.useState(false);
  // Per-hook-instance unique suffix — same fix as `use-pending-pushes.ts`.
  const instanceId = React.useId();

  // Resync when the seed handed in by the server changes (e.g. PlanSheet
  // switches from session A → session B without unmounting).
  React.useEffect(() => {
    setMessages(initial);
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
      .channel(`plan-messages:${sessionId}:${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "planning_messages",
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          const row = payload.new as RealtimePlanMessageRow;
          setMessages((cur) => {
            // Drop dupes — the seed fetch may race the first Realtime event
            // when the Sheet opens on a session that just received a reply.
            if (cur.some((m) => m.id === row.id)) return cur;
            return [...cur, rowToPlanMessage(row)];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "planning_messages",
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          const row = payload.new as RealtimePlanMessageRow;
          setMessages((cur) => {
            const idx = cur.findIndex((m) => m.id === row.id);
            if (idx === -1) return cur; // not seeded yet — INSERT path will handle
            const next = cur.slice();
            next[idx] = rowToPlanMessage(row);
            return next;
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "planning_messages",
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          // Realtime DELETE payloads include only the row's primary key in
          // `payload.old` unless REPLICA IDENTITY FULL is set on the table.
          // The `id` is enough to drop it locally.
          const oldRow = payload.old as { id?: string };
          if (!oldRow?.id) return;
          setMessages((cur) => cur.filter((m) => m.id !== oldRow.id));
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
        // removeChannel both unsubscribes and frees the slot so reopening the
        // Sheet on the same session doesn't stack channels.
        void supabase.removeChannel(channel);
        channel = null;
      }
    };
  }, [sessionId, instanceId]);

  return { messages, isLive };
}
