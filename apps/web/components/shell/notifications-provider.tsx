"use client";

// Notifications context + toast bridge.
//
// Owns ONE realtime subscription per app load (via useNotifications) and
// exposes the stream to whichever shell components need it — today the
// topbar bell and the internal `NotificationsToastBridge` that fires Sonner
// toasts when fresh, prefs-allowed items arrive.
//
// Why a context (not just two independent hook calls):
//   - Each subscription opens a Supabase Realtime channel; one is enough.
//   - The bell unread count and the toaster's "is this fresh?" check must
//     agree, so they should look at the same `items` array.
//   - The prefs lookup (does this kind allow a toast?) is shared too.

import * as React from "react";
import { toast as sonnerToast } from "sonner";
import { supabaseBrowser } from "@/lib/db/browser";
import {
  defaultsForKind,
  type NotificationChannelPrefs,
  type NotificationKind,
} from "@/lib/notifications/kinds";
import {
  useNotifications,
  type NotificationItem,
  type UseNotificationsResult,
} from "@/lib/realtime/use-notifications";

type NotificationsContextValue = UseNotificationsResult & {
  prefsForKind: (kind: NotificationKind) => NotificationChannelPrefs;
};

const NotificationsContext = React.createContext<NotificationsContextValue | null>(null);

export function useNotificationsContext(): NotificationsContextValue {
  const ctx = React.useContext(NotificationsContext);
  if (!ctx) {
    throw new Error("useNotificationsContext must be used inside <NotificationsProvider>");
  }
  return ctx;
}

type PrefRow = {
  kind: string;
  in_app: boolean;
  toast: boolean;
};

export function NotificationsProvider({
  userId,
  initial,
  children,
}: {
  /** Auth user id; null when the layout couldn't resolve a session (rare). */
  userId: string | null;
  initial: NotificationItem[];
  children: React.ReactNode;
}) {
  const stream = useNotifications(userId, initial);

  // Per-kind preference map. RLS-gated read; refreshed on a same-user UPDATE
  // so the settings page changes take effect without a page reload.
  const [prefs, setPrefs] = React.useState<Map<string, NotificationChannelPrefs>>(new Map());

  React.useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const supabase = supabaseBrowser();
    void (async () => {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select("kind, in_app, toast");
      if (cancelled || error || !data) return;
      const next = new Map<string, NotificationChannelPrefs>();
      for (const r of data as PrefRow[]) {
        next.set(r.kind, { inApp: r.in_app, toast: r.toast });
      }
      setPrefs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const prefsForKind = React.useCallback(
    (kind: NotificationKind): NotificationChannelPrefs => {
      return prefs.get(kind) ?? defaultsForKind(kind);
    },
    [prefs],
  );

  const value = React.useMemo<NotificationsContextValue>(
    () => ({ ...stream, prefsForKind }),
    [stream, prefsForKind],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      <NotificationsToastBridge />
    </NotificationsContext.Provider>
  );
}

// ─── Toast bridge ───────────────────────────────────────────────────────────
// Fires a Sonner toast for items that:
//   1. Arrived after the bridge mounted (so we don't re-toast the seed),
//   2. Are still unread, and
//   3. Are within FRESH_MS of created_at (avoids stale-stream replays after
//      a re-subscribe).
//   4. Have toast=true in the user's prefs (per-kind opt-out honored).
//
// Items are tracked in a Set keyed by id to suppress double-toasts on
// route changes that remount the bridge under React strict-mode dev.

const FRESH_MS = 10_000;

function NotificationsToastBridge() {
  const { items, prefsForKind } = useNotificationsContext();
  // Anything created on/before this is treated as "already seen" — i.e.
  // the server-rendered seed plus everything pre-mount.
  const mountedAtRef = React.useRef<number>(Date.now());
  const toastedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    for (const item of items) {
      if (toastedRef.current.has(item.id)) continue;
      if (item.readAt !== null) continue;
      const createdMs = new Date(item.createdAt).getTime();
      if (createdMs <= mountedAtRef.current) {
        // Seed row — mark as already-toasted so a future re-render doesn't
        // surface it as "new".
        toastedRef.current.add(item.id);
        continue;
      }
      if (Date.now() - createdMs > FRESH_MS) {
        toastedRef.current.add(item.id);
        continue;
      }
      const { toast } = prefsForKind(item.kind);
      if (!toast) {
        toastedRef.current.add(item.id);
        continue;
      }
      toastedRef.current.add(item.id);
      sonnerToast(item.title, {
        description: item.body ?? undefined,
        action: item.href
          ? {
              label: "Open",
              onClick: () => {
                window.location.href = item.href!;
              },
            }
          : undefined,
      });
    }
  }, [items, prefsForKind]);

  return null;
}
