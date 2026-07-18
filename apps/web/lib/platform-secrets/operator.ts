// Instance-operator gate (server-only) — design decision D2. Instance-scoped
// writes (platform-secrets rows with tenant_id NULL, .env.local edits from the
// wizard) affect EVERY tenant on the install, so they need a stronger gate
// than tenant membership — but a real instance-admin RBAC model is explicitly
// out of scope for v1. The deterministic zero-schema stand-in: an owner/admin
// of the FIRST tenant ever created on this install. On the dominant
// single-operator deployment that is exactly the person who ran first-run
// setup; on a multi-tenant install it's the hosting operator's org.

import "server-only";

import { supabaseService } from "@/lib/db/server";

const OPERATOR_ROLES = new Set(["owner", "admin"]);

/** Is this user an owner/admin of the oldest tenant on the install? */
export async function isInstanceOperator(userId: string): Promise<boolean> {
  try {
    const supabase = supabaseService();
    const { data: firstTenant, error: tenantErr } = await supabase
      .from("tenants")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (tenantErr || !firstTenant) return false;

    const { data: membership, error: memberErr } = await supabase
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", firstTenant.id as string)
      .eq("user_id", userId)
      .maybeSingle();
    if (memberErr || !membership) return false;
    return OPERATOR_ROLES.has(String(membership.role));
  } catch {
    return false;
  }
}
