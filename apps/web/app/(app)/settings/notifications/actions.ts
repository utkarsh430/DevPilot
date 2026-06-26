"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { NOTIFICATION_KINDS, type NotificationKind } from "@/lib/notifications/kinds";

export type UpdatePreferenceArgs = {
  kind: NotificationKind;
  inApp: boolean;
  toast: boolean;
};

export async function updateNotificationPreference(
  args: UpdatePreferenceArgs,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!NOTIFICATION_KINDS.includes(args.kind)) {
    return { ok: false, error: "unknown notification kind" };
  }
  const user = await requireUser();
  const supabase = await supabaseServer();
  const { error } = await supabase.from("notification_preferences").upsert(
    {
      user_id: user.id,
      kind: args.kind,
      in_app: args.inApp,
      toast: args.toast,
    },
    { onConflict: "user_id,kind" },
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings/notifications");
  return { ok: true };
}
