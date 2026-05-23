// Server-side helpers for seeding the notifications provider.
//
// The (app) layout calls `loadInitialNotifications` so the topbar bell + the
// toast bridge have rows on first paint and don't depend on a follow-up
// network round-trip from the client.

import "server-only";
import { supabaseServer } from "@/lib/db/server";
import type { NotificationItem } from "@/lib/realtime/use-notifications";
import type { NotificationKind } from "./kinds";

export type NotificationRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
};

const SEED_LIMIT = 20;

/** Map a raw `notifications` row (PostgREST or the `shell_bootstrap` RPC's
 *  jsonb) to a `NotificationItem`. Exported so the shell-bootstrap loader seeds
 *  the bell + toast bridge through the SAME logic as this loader. */
export function mapNotificationRow(r: NotificationRow): NotificationItem {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    kind: r.kind as NotificationKind,
    title: r.title,
    body: r.body,
    href: r.href,
    metadata: r.metadata ?? {},
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

export async function loadInitialNotifications(): Promise<NotificationItem[]> {
  const supabase = await supabaseServer();
  // RLS already filters to the calling user; no explicit user_id eq needed.
  const { data, error } = await supabase
    .from("notifications")
    .select("id, tenant_id, user_id, kind, title, body, href, metadata, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(SEED_LIMIT);
  if (error || !data) return [];
  return (data as NotificationRow[]).map(mapNotificationRow);
}
