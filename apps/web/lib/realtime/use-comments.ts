"use client";

// Phase 1 / M2 — Wave 2 (drawer comments stream).
//
// `useLiveComments` swaps the TicketDrawer's 5s `setInterval` comments fetch
// for a Supabase Realtime subscription. The initial list still comes from the
// drawer's open-time fetch of `/api/board/tickets/<id>/comments`; this hook
// only folds in new INSERTs so the thread updates within a second of an
// agent or human posting.
//
// Mirrors `useLiveTickets` (Wave 1):
//   • One channel PER DRAWER OPEN, scoped to the ticket id — closing the
//     drawer or switching tickets tears down the socket via `removeChannel`.
//   • Filtered server-side by `ticket_id` so other tickets' comments don't
//     reach this client. RLS still gates correctness; the filter trims noise.
//   • `isLive` reflects the channel state (true on SUBSCRIBED) so the drawer
//     can render a real connectivity dot, not a guess.

import * as React from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/db/browser";
import type { BoardComment, RealtimeCommentRow } from "@/components/board/types";
import { createSubscribeHandler, type RealtimeStatus } from "@/lib/realtime/connection";

function rowToBoardComment(row: RealtimeCommentRow): BoardComment {
  return {
    id: row.id,
    authorType: row.author_type,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
    metadata: (row as { metadata?: unknown }).metadata as
      | Record<string, unknown>
      | null
      | undefined,
  };
}

export function useLiveComments(
  ticketId: string | null,
  initial: BoardComment[],
): { comments: BoardComment[]; isLive: boolean; status: RealtimeStatus } {
  const [comments, setComments] = React.useState<BoardComment[]>(initial);
  const [status, setStatus] = React.useState<RealtimeStatus>("connecting");

  // Resync when the server / drawer-open fetch hands us a fresh seed.
  React.useEffect(() => {
    setComments(initial);
  }, [initial]);

  React.useEffect(() => {
    if (!ticketId) {
      setStatus("connecting");
      return;
    }

    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    const supabase = supabaseBrowser();

    // Reconcile after a dropped→re-subscribed channel: Realtime never replays
    // the INSERTs missed during the gap, so refetch the whole thread from the
    // DB (RLS-gated) and union it with local state by id.
    async function reconcile() {
      const { data } = await supabase
        .from("comments")
        .select("id, author_type, author_id, body, created_at, metadata")
        .eq("ticket_id", ticketId as string)
        .order("created_at", { ascending: true });
      if (cancelled || !data) return;
      const fresh = (data as RealtimeCommentRow[]).map(rowToBoardComment);
      setComments((cur) => {
        const byId = new Map(fresh.map((c) => [c.id, c]));
        // Keep any local-only comment that hasn't landed in the DB read yet
        // (e.g. an optimistic post that raced the refetch).
        for (const c of cur) if (!byId.has(c.id)) byId.set(c.id, c);
        return Array.from(byId.values()).sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
      });
    }

    channel = supabase
      .channel(`ticket-comments:${ticketId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "comments",
          filter: `ticket_id=eq.${ticketId}`,
        },
        (payload) => {
          const row = payload.new as RealtimeCommentRow;
          setComments((cur) => {
            // Drop dupes — the initial fetch may race the first Realtime event
            // when the drawer opens on a ticket that just received a comment.
            if (cur.some((c) => c.id === row.id)) return cur;
            return [...cur, rowToBoardComment(row)];
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
        // removeChannel both unsubscribes and frees the slot, mirroring the
        // Wave 1 hook so reopening the drawer doesn't stack channels.
        void supabase.removeChannel(channel);
        channel = null;
      }
    };
  }, [ticketId]);

  return { comments, isLive: status === "live", status };
}
