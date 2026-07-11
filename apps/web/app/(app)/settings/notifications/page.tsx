// Notification preferences page.
//
// Reads existing rows under RLS, fills in the kind catalog's per-kind
// defaults for anything the user hasn't overridden yet, and hands the
// merged list to the client form. No client-side fetch on mount.

import { requireUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import {
  NOTIFICATION_KIND_CATALOG,
  NOTIFICATION_KINDS,
  type NotificationKind,
} from "@/lib/notifications/kinds";
import { NotificationPrefsForm, type PrefRow } from "./prefs-form";

export const dynamic = "force-dynamic";

type StoredRow = { kind: string; in_app: boolean; toast: boolean };

export default async function NotificationsSettingsPage() {
  await requireUser();
  const supabase = await supabaseServer();
  const { data } = await supabase.from("notification_preferences").select("kind, in_app, toast");
  const stored = new Map<string, { inApp: boolean; toast: boolean }>();
  for (const r of (data as StoredRow[] | null) ?? []) {
    stored.set(r.kind, { inApp: r.in_app, toast: r.toast });
  }

  const rows: PrefRow[] = NOTIFICATION_KINDS.map((kind: NotificationKind) => {
    const entry = NOTIFICATION_KIND_CATALOG[kind];
    const merged = stored.get(kind) ?? entry.defaults;
    return {
      kind,
      label: entry.label,
      description: entry.description,
      group: entry.group,
      inApp: merged.inApp,
      toast: merged.toast,
    };
  });

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="font-display text-xl font-bold tracking-tight">Notifications</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Pick which events show up in your bell and which pop a toast on top of whatever screen
          you&apos;re on. Changes apply immediately to future events; the bell shows the history
          either way.
        </p>
      </header>
      <NotificationPrefsForm rows={rows} />
    </div>
  );
}
