"use client";

// Phase 1 / M2 — Wave 1 (board substrate).
//
// `useLiveTickets` swaps the Phase 0 5s `router.refresh()` poll on /board for a
// Supabase Realtime subscription. The initial list is still rendered from the
// server-side `loadBoardTickets()` result; this hook only folds in deltas after
// mount so two tabs see each other's edits in under a second.
//
// Design notes (per docs/DEVPILOT_PHASE1_PLAN.md §M2 and the locked decision):
//   • One channel PER PAGE, not globally — keeps us under the free-tier egress
//     ceiling and means leaving /board tears the socket down.
//   • Filtered server-side by `tenant_id` so other tenants' deltas never hit
//     this client. RLS already covers correctness; the filter just trims noise.
//   • The tenant_id is resolved from the user's `tenant_members` row through
//     the browser client (RLS-gated) so the server `page.tsx` doesn't have to
//     be refactored to drop a prop down — Wave 2 may swap this for a context.
//   • `isLive` tracks the channel state (true on SUBSCRIBED) so the indicator
//     can show real connectivity, not just "5s elapsed".

import * as React from "react";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/db/browser";
import type { BoardTicket, RealtimeCommentRow, RealtimeTicketRow } from "@/components/board/types";
import type { TicketStatus } from "@/lib/board/state";
import { createSubscribeHandler, type RealtimeStatus } from "@/lib/realtime/connection";

function rowToBoardTicket(row: RealtimeTicketRow, previous?: BoardTicket): BoardTicket {
  const rawPriority = row.priority ?? previous?.priority ?? 0;
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status as TicketStatus,
    retryCount: row.retry_count ?? 0,
    updatedAt: row.updated_at,
    columnPosition: row.column_position ?? null,
    // Assigned at insert and immutable thereafter, so it arrives on the INSERT
    // payload and every later UPDATE carries the same value. Fall back to the
    // previous snapshot (then null) so a legacy payload that omits the column
    // can't blank the key on a live card.
    ticketNumber: row.ticket_number ?? previous?.ticketNumber ?? null,
    autoPromoteWhenUnblocked: row.auto_promote_when_unblocked === true,
    // Comment-derived fields aren't part of the tickets row — carry over
    // whatever the previous snapshot had so an UPDATE on the ticket doesn't
    // wipe its last-comment preview.
    lastCommentAuthor: previous?.lastCommentAuthor ?? null,
    lastCommentBody: previous?.lastCommentBody ?? null,
    lastCommentAt: previous?.lastCommentAt ?? null,
    commentCount: previous?.commentCount ?? 0,
    // Same logic for the pending_push pointer — it lives in a sibling table
    // and is overlaid in BoardClient from useLivePendingPushes. Preserve it
    // across ticket-row UPDATEs; BoardClient will fold in fresher push data.
    pendingPush: previous?.pendingPush ?? null,
    // M1 — Linear-style properties. Priority/estimate/due_at live on the
    // tickets row so they arrive in the payload; labels + sub-issue counts
    // come from sibling tables (ticket_labels, child tickets) and are not
    // re-fetched here — carry them over from the previous snapshot so a
    // ticket UPDATE doesn't visually wipe its chips. Realtime channels on
    // labels/ticket_labels (and a router.refresh on label mutations) keep
    // them fresh.
    priority: (rawPriority >= 0 && rawPriority <= 4 ? rawPriority : 0) as BoardTicket["priority"],
    estimateCents: row.estimate_cents ?? previous?.estimateCents ?? null,
    dueAt: row.due_at ?? previous?.dueAt ?? null,
    labels: previous?.labels ?? [],
    parentTicketId: row.parent_ticket_id ?? previous?.parentTicketId ?? null,
    subIssueTotal: previous?.subIssueTotal ?? 0,
    subIssueDone: previous?.subIssueDone ?? 0,
    // SME safety flag lives on the tickets row, so it arrives in the payload;
    // fall back to the previous snapshot then false when a legacy payload omits
    // it, so a ticket UPDATE never silently disarms the flag on the card.
    safetyCritical: row.safety_critical ?? previous?.safetyCritical ?? false,
    // Async dep-suggestions parked by suggestTicketDepsFn. Deliberately does NOT
    // fall back to the previous snapshot: the column is intentionally cleared to
    // NULL on accept/skip, and that NULL must become [] so the card chip
    // disappears — carrying over `previous` would resurrect a dismissed batch.
    // A realtime UPDATE always carries every column, so `undefined` won't occur
    // post-migration; if it ever did (a legacy payload), [] is the safe read.
    suggestedDependencies: row.suggested_dependencies ?? [],
    // Landing visibility. The full derivation needs `pending_pushes`,
    // `integration_queue` and the nothing-to-land notice, none of which is in
    // this subscription, so we can only upgrade — never downgrade — from a
    // ticket UPDATE: a stamped `landed_sha` clears a stale "not landed" chip
    // live, and anything else carries the server-derived state over untouched.
    //
    // The `nothing_to_land` guard is load-bearing since PR #137: that path
    // deliberately STAMPS `landed_sha` (with the base tip, so `builds_on`
    // dependents don't wedge), so a ticket that had nothing to land now carries
    // a sha too. Without the guard, a later ticket UPDATE would silently
    // "upgrade" a correct "Nothing to land" chip into `landed` and drop it —
    // losing exactly the third outcome this feature exists to distinguish. The
    // notice outranks the sha server-side; it must outrank it here too.
    landedSha: row.landed_sha ?? previous?.landedSha ?? null,
    landingState:
      previous?.landingState?.kind === "nothing_to_land"
        ? previous.landingState
        : typeof row.landed_sha === "string" && row.landed_sha.trim() !== ""
          ? { kind: "landed", sha: row.landed_sha }
          : previous?.landingState,
  };
}

export function useLiveTickets(initial: BoardTicket[]): {
  tickets: BoardTicket[];
  isLive: boolean;
  status: RealtimeStatus;
  reconnect: () => void;
} {
  const [tickets, setTickets] = React.useState<BoardTicket[]>(initial);
  const [status, setStatus] = React.useState<RealtimeStatus>("connecting");
  const router = useRouter();
  // Bumping this tears the channel down and re-subscribes (manual retry from
  // the connection indicator when the socket is wedged offline).
  const [retryNonce, setRetryNonce] = React.useState(0);
  const reconnect = React.useCallback(() => setRetryNonce((n) => n + 1), []);
  // Comment ids already folded into a ticket's commentCount, so a redelivered
  // INSERT event never double-counts (mirrors use-comments' id-dedup guard).
  const countedCommentIds = React.useRef<Set<string>>(new Set());

  // Resync when the server passes a fresh snapshot (e.g. router.refresh()).
  React.useEffect(() => {
    setTickets(initial);
  }, [initial]);

  React.useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    const supabase = supabaseBrowser();

    async function subscribe() {
      // Resolve tenant from `tenant_members` — RLS guarantees the caller only
      // sees their own row. Phase 0 ships one tenant per user; multi-org will
      // swap this for an active-tenant cookie.
      const { data: member } = await supabase
        .from("tenant_members")
        .select("tenant_id")
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const tenantId = (member?.tenant_id as string | undefined) ?? null;
      if (!tenantId) return;

      channel = supabase
        .channel(`board:${tenantId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "tickets",
            filter: `tenant_id=eq.${tenantId}`,
          },
          (payload) => {
            const row = payload.new as RealtimeTicketRow;
            setTickets((cur) => {
              if (cur.some((t) => t.id === row.id)) return cur;
              return [rowToBoardTicket(row), ...cur];
            });
          },
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "tickets",
            filter: `tenant_id=eq.${tenantId}`,
          },
          (payload) => {
            const row = payload.new as RealtimeTicketRow;
            setTickets((cur) => {
              const idx = cur.findIndex((t) => t.id === row.id);
              if (idx === -1) return [rowToBoardTicket(row), ...cur];
              const prev = cur[idx];
              const next = cur.slice();
              next[idx] = rowToBoardTicket(row, prev);
              return next;
            });
          },
        )
        .on(
          "postgres_changes",
          {
            event: "DELETE",
            schema: "public",
            table: "tickets",
            // NO tenant_id filter here. Postgres logs only the PK for a DELETE
            // under the default REPLICA IDENTITY, so `payload.old` carries just
            // the id — a server-side `tenant_id=eq.…` filter can never match and
            // silently drops every DELETE, leaving phantom cards after an agent,
            // the sweeper, or another tab removes a ticket. We instead take all
            // ticket DELETEs and match on id below: a delete for an id we don't
            // hold is a harmless no-op, so cross-tenant leakage can't corrupt
            // this board.
          },
          (payload) => {
            const row = payload.old as Partial<RealtimeTicketRow>;
            if (!row?.id) return;
            setTickets((cur) => cur.filter((t) => t.id !== row.id));
          },
        )
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "comments",
            filter: `tenant_id=eq.${tenantId}`,
          },
          (payload) => {
            const row = payload.new as RealtimeCommentRow;
            // Dedup by comment id: Realtime can redeliver an event (e.g. across
            // a reconnect), which would otherwise inflate the count on every
            // replay. `use-comments` guards the thread the same way by id.
            if (countedCommentIds.current.has(row.id)) return;
            countedCommentIds.current.add(row.id);
            setTickets((cur) => {
              const idx = cur.findIndex((t) => t.id === row.ticket_id);
              if (idx === -1) return cur;
              const prev = cur[idx];
              if (!prev) return cur;
              // Only overwrite the preview if this comment is newer than the
              // one already shown — out-of-order delivery is rare but possible.
              const previousAt = prev.lastCommentAt ? new Date(prev.lastCommentAt).getTime() : 0;
              const incomingAt = new Date(row.created_at).getTime();
              const next = cur.slice();
              next[idx] = {
                ...prev,
                commentCount: (prev.commentCount ?? 0) + 1,
                lastCommentAuthor:
                  incomingAt >= previousAt
                    ? `${row.author_type}:${row.author_id}`
                    : prev.lastCommentAuthor,
                lastCommentBody: incomingAt >= previousAt ? row.body : prev.lastCommentBody,
                lastCommentAt: incomingAt >= previousAt ? row.created_at : prev.lastCommentAt,
              };
              return next;
            });
          },
        )
        .subscribe(
          createSubscribeHandler({
            isCancelled: () => cancelled,
            setStatus,
            // On a real drop→resubscribe, refetch the authoritative board via
            // the server component. This recovers every INSERT/UPDATE/DELETE and
            // comment-count change missed during the gap (Realtime does not
            // replay them), and re-seeds `initial` through the resync effect.
            onReconnect: () => router.refresh(),
            // A manual retry (nonce bump) only happens after we were offline,
            // so reconcile as soon as this fresh channel reaches SUBSCRIBED.
            startDropped: retryNonce > 0,
          }),
        );
    }

    void subscribe();

    return () => {
      cancelled = true;
      setStatus("connecting");
      if (channel) {
        // removeChannel both unsubscribes and frees the slot. Without this the
        // socket keeps the channel and the next mount stacks another one.
        void supabase.removeChannel(channel);
        channel = null;
      }
    };
  }, [router, retryNonce]);

  return { tickets, isLive: status === "live", status, reconnect };
}
