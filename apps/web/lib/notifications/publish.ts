// Server-side publisher for in-app notifications.
//
// Called from Inngest functions after a durable state transition (plan
// finished, run failed, ticket transitioned, …). The publisher:
//   1. Resolves the recipient's per-kind preferences (falling back to the
//      kind's catalog defaults when no row exists).
//   2. If `inApp` is disabled for that (user, kind), returns null without
//      inserting — the bell stays clean and the toast bridge has nothing
//      to react to.
//   3. Otherwise inserts a row via the service-role client. The unique
//      partial index on `(user_id, dedupe_key)` keeps Inngest step retries
//      idempotent: the second insert raises 23505 and we treat that as
//      "already published, success."
//
// All inserts go through the service-role client because notifications are
// written for a specific user (potentially across tenants) and we don't want
// the publisher to require an authenticated request context.

import { supabaseService } from "@/lib/db/server";
import { defaultsForKind, type NotificationKind } from "./kinds";

export type PublishNotificationArgs = {
  tenantId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Deterministic key for retry idempotency. Example: `plan.finished:${sessionId}`.
   * Null disables dedupe (single-shot emissions only).
   */
  dedupeKey?: string | null;
};

export type PublishResult =
  | { ok: true; id: string }
  | { ok: true; skipped: "disabled" | "duplicate"; id: null }
  | { ok: false; error: string };

export async function publishNotification(args: PublishNotificationArgs): Promise<PublishResult> {
  const supabase = supabaseService();

  // 1. Resolve preference — defaults to catalog when no row exists.
  const { data: prefRow, error: prefErr } = await supabase
    .from("notification_preferences")
    .select("in_app, toast")
    .eq("user_id", args.userId)
    .eq("kind", args.kind)
    .maybeSingle();

  if (prefErr) {
    // Preference lookup failed — log and fall back to defaults so a
    // misconfigured prefs table doesn't suppress critical notifications.
    console.error("[notifications] prefs lookup failed", {
      kind: args.kind,
      userId: args.userId,
      error: prefErr.message,
    });
  }

  const fallback = defaultsForKind(args.kind);
  const inApp = prefRow?.in_app ?? fallback.inApp;

  if (!inApp) {
    return { ok: true, skipped: "disabled", id: null };
  }

  // 2. Insert. Unique partial index on (user_id, dedupe_key) makes retries
  //    idempotent for dedupe-keyed emissions; nulls bypass the constraint.
  const { data, error } = await supabase
    .from("notifications")
    .insert({
      tenant_id: args.tenantId,
      user_id: args.userId,
      kind: args.kind,
      title: args.title,
      body: args.body ?? null,
      href: args.href ?? null,
      metadata: args.metadata ?? {},
      dedupe_key: args.dedupeKey ?? null,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation. With our partial index this can only
    // mean a duplicate dedupe_key — i.e. an Inngest step retried after
    // its first successful publish. Treat as success.
    if (error.code === "23505") {
      return { ok: true, skipped: "duplicate", id: null };
    }
    console.error("[notifications] insert failed", {
      kind: args.kind,
      userId: args.userId,
      error: error.message,
    });
    return { ok: false, error: error.message };
  }

  return { ok: true, id: data.id };
}
