"use client";

// Live notifications hook — mirrors the per-(user) notification stream and
// exposes mark-as-read helpers. Same channel shape as use-plan-session.ts:
//   • per-instance React.useId() suffix avoids cross-mount channel collision,
//   • INSERT + UPDATE postgres_changes filtered on user_id,
//   • seeded from a server-rendered initial list so the bell renders without
//     a flash on first paint.
//
// `userId` is the auth user id. The publisher writes one row per (user, event)
// so the filter `user_id=eq.${userId}` is both correct and RLS-aligned.

import * as React from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/db/browser";
import type { NotificationKind } from "@/lib/notifications/kinds";
import { createSubscribeHandler, type RealtimeStatus } from "@/lib/realtime/connection";

export type NotificationItem = {
  id: string;
  tenantId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

type RealtimeRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  metadata: Record<string, unknown> | null;
  dedupe_key: string | null;
  read_at: string | null;
  created_at: string;
};

function rowToItem(row: RealtimeRow): NotificationItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    href: row.href,
    metadata: row.metadata ?? {},
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

const MAX_BUFFERED = 50;

export type UseNotificationsResult = {
  items: NotificationItem[];
  unreadCount: number;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  isLive: boolean;
  status: RealtimeStatus;
};

const NOTIFICATION_COLUMNS =
  "id, tenant_id, user_id, kind, title, body, href, metadata, dedupe_key, read_at, created_at";

export function useNotifications(
  userId: string | null,
  initial: NotificationItem[] = [],
): UseNotificationsResult {
  const [items, setItems] = React.useState<NotificationItem[]>(initial);
  const [status, setStatus] = React.useState<RealtimeStatus>("connecting");
  const instanceId = React.useId();

  // Resync when the parent hands in a fresh seed (e.g. layout re-fetched).
  React.useEffect(() => {
    setItems(initial);
  }, [initial]);

  React.useEffect(() => {
    if (!userId) {
      setStatus("connecting");
      return;
    }

    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    const supabase = supabaseBrowser();

    // Reconcile after a dropped→re-subscribed channel: refetch the recent
    // notifications (RLS-gated to this user) so INSERT/UPDATE events missed
    // during the gap — new alerts, or read-state flips from another tab — are
    // recovered. The DB read is authoritative, so we replace local state with
    // it; an in-flight optimistic read flip that hasn't persisted yet re-lands
    // on its own via the subsequent UPDATE event.
    async function reconcile() {
      const { data } = await supabase
        .from("notifications")
        .select(NOTIFICATION_COLUMNS)
        .eq("user_id", userId as string)
        .order("created_at", { ascending: false })
        .limit(MAX_BUFFERED);
      if (cancelled || !data) return;
      const fresh = (data as RealtimeRow[]).map(rowToItem);
      setItems(fresh);
    }

    channel = supabase
      .channel(`notifications:${userId}:${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as RealtimeRow;
          setItems((prev) => {
            if (prev.some((i) => i.id === row.id)) return prev;
            return [rowToItem(row), ...prev].slice(0, MAX_BUFFERED);
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as RealtimeRow;
          setItems((prev) => prev.map((i) => (i.id === row.id ? rowToItem(row) : i)));
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
  }, [userId, instanceId]);

  const markRead = React.useCallback(async (id: string) => {
    const supabase = supabaseBrowser();
    const now = new Date().toISOString();
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, readAt: now } : i)));
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .eq("id", id)
      .is("read_at", null);
    if (error) {
      // Roll back the optimistic flip; Realtime will reconcile if needed.
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, readAt: null } : i)));
    }
  }, []);

  const markAllRead = React.useCallback(async () => {
    const supabase = supabaseBrowser();
    const now = new Date().toISOString();
    let unreadIds: string[] = [];
    setItems((prev) => {
      unreadIds = prev.filter((i) => i.readAt === null).map((i) => i.id);
      if (unreadIds.length === 0) return prev;
      return prev.map((i) => (i.readAt === null ? { ...i, readAt: now } : i));
    });
    if (unreadIds.length === 0) return;
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .in("id", unreadIds);
    if (error) {
      setItems((prev) => prev.map((i) => (unreadIds.includes(i.id) ? { ...i, readAt: null } : i)));
    }
  }, []);

  const unreadCount = React.useMemo(
    () => items.reduce((acc, i) => acc + (i.readAt === null ? 1 : 0), 0),
    [items],
  );

  return { items, unreadCount, markRead, markAllRead, isLive: status === "live", status };
}
