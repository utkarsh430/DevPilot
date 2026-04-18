"use server";

// Phase 1 / M14 — server actions for the API key settings page.
//
// CLAUDE.md non-negotiable: cleartext key is shown ONCE. We return it from
// `createApiKeyAction`; the database NEVER stores it (only sha256). The UI
// is responsible for making the operator copy it before navigating away.

import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { mintApiKey } from "@/lib/api/key-auth";

export type CreateKeyResult =
  | { ok: true; id: string; name: string; cleartext: string; prefix: string }
  | { ok: false; error: string };

export type RevokeKeyResult = { ok: true } | { ok: false; error: string };

const MAX_NAME_LEN = 80;

/**
 * Create a new full-scope API key for the calling user's tenant.
 * The returned `cleartext` is the operator's ONLY chance to capture the secret.
 */
export async function createApiKeyAction(input: { name: string }): Promise<CreateKeyResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const name = (input.name ?? "").trim();
  if (name.length === 0) return { ok: false, error: "name required" };
  if (name.length > MAX_NAME_LEN)
    return { ok: false, error: `name too long (max ${MAX_NAME_LEN})` };

  const { cleartext, hash, prefix } = mintApiKey();
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      tenant_id: tenantId,
      name,
      hash,
      prefix,
      scope: "api",
    })
    .select("id, name, prefix")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "insert failed" };
  }
  revalidatePath("/settings/api-keys");
  return {
    ok: true,
    id: data.id as string,
    name: data.name as string,
    cleartext,
    prefix: data.prefix as string,
  };
}

/**
 * Soft-revoke an API key. Subsequent auth lookups refuse it with a 401
 * "key revoked" reason. We keep the row for audit; full deletion is
 * available via the same shape with `purge=true` but not exposed in UI.
 */
export async function revokeApiKeyAction(input: { id: string }): Promise<RevokeKeyResult> {
  await requireUser();
  const tenantId = await requireTenantId();
  if (!input.id || typeof input.id !== "string") {
    return { ok: false, error: "id required" };
  }
  const supabase = supabaseService();
  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", input.id)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings/api-keys");
  return { ok: true };
}

/**
 * Issue a widget token for a single agent. Distinct from `createApiKeyAction`
 * so the form on `/settings/api-keys` can offer a clearly-different affordance.
 */
export type CreateWidgetTokenResult =
  | { ok: true; id: string; cleartext: string; agentId: string; prefix: string }
  | { ok: false; error: string };

export async function createWidgetTokenAction(input: {
  agentId: string;
  name?: string;
}): Promise<CreateWidgetTokenResult> {
  await requireUser();
  const tenantId = await requireTenantId();
  if (!input.agentId || typeof input.agentId !== "string") {
    return { ok: false, error: "agentId required" };
  }
  const supabase = supabaseService();
  const { data: agent } = await supabase
    .from("agents")
    .select("id, tenant_id, name")
    .eq("id", input.agentId)
    .maybeSingle();
  if (!agent || agent.tenant_id !== tenantId) {
    return { ok: false, error: "agent not found" };
  }
  const { cleartext, hash, prefix } = mintApiKey();
  const name = (input.name ?? `widget:${agent.name}`).slice(0, MAX_NAME_LEN);
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      tenant_id: tenantId,
      name,
      hash,
      prefix,
      scope: "widget",
      agent_id: agent.id,
    })
    .select("id, prefix")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "insert failed" };
  }
  revalidatePath("/settings/api-keys");
  return {
    ok: true,
    id: data.id as string,
    cleartext,
    agentId: agent.id as string,
    prefix: data.prefix as string,
  };
}
