"use server";

// Persist the tenant's LLM auth-mode into `tenants.config.llm_auth_mode`.
//
// We read-merge-write the jsonb so we never clobber sibling keys
// (`config.default_agent_id` etc.). Service-role write, scoped by tenant id —
// the same pattern the billing action uses for tenant-row writes. No cache to
// invalidate: `getLlmAuthMode` reads `tenants.config` fresh each call.

import { revalidatePath } from "next/cache";
import { requireUser, requireTenantId } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { isLlmAuthMode, LLM_AUTH_MODE_CONFIG_KEY, type LlmAuthMode } from "@/lib/llm/auth-mode";

export async function setLlmAuthModeAction(
  mode: LlmAuthMode,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isLlmAuthMode(mode)) {
    return { ok: false, error: "unknown auth mode" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const supabase = supabaseService();

  const { data: tenant, error: readErr } = await supabase
    .from("tenants")
    .select("config")
    .eq("id", tenantId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!tenant) return { ok: false, error: "tenant not found" };

  const config = { ...((tenant.config ?? {}) as Record<string, unknown>) };
  config[LLM_AUTH_MODE_CONFIG_KEY] = mode;

  const { error: writeErr } = await supabase.from("tenants").update({ config }).eq("id", tenantId);
  if (writeErr) return { ok: false, error: writeErr.message };

  // The mode drives the runner-mode / system-health surfaces too — refresh
  // those so the change is reflected without a hard reload.
  revalidatePath("/settings/llm-auth");
  revalidatePath("/settings/system-health");
  return { ok: true };
}
