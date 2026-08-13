// Platform secrets vault helpers (server-only). Mirrors `lib/projects/secrets.ts`
// but scoped on a NULLABLE tenant_id (null = instance-level) instead of a
// project. Plaintext never crosses the wire — names + masked tails are derived
// app-side from app-layer AES-256-GCM (`@/lib/secrets/crypto`); full values are
// read only by the resolver (Phase 2+).
//
// Encryption lives in the Node app layer now (not pgcrypto). Each row stores
// opaque `value_encrypted` / `value_iv` bytea columns. WRITES require the master
// key (encryptSecret throws if it's missing — the operator must configure
// SECRETS_ENCRYPTION_KEY); the tail derivation on READ tolerates a
// missing/invalid key (decryptColumns returns null and we skip the row).

import "server-only";

import { supabaseService } from "@/lib/db/server";
import { decryptColumns, encryptSecret, toBytea } from "@/lib/secrets/crypto";
import { PLATFORM_SECRET_CATALOG, type PlatformSecretCatalogEntry } from "./catalog";

export async function setPlatformSecret(input: {
  /** null = instance-level row; non-null = per-tenant override. */
  tenantId: string | null;
  secretKey: string;
  value: string;
  userId: string | null;
}): Promise<void> {
  // Encrypt app-side. Throws when SECRETS_ENCRYPTION_KEY is unset — a SET must
  // not silently store an unrecoverable/plaintext value, so let it surface.
  const { ciphertext, iv } = encryptSecret(input.value);
  const supabase = supabaseService();
  // UNIQUE (tenant_id, secret_key) NULLS NOT DISTINCT — null tenant_id (instance
  // scope) matches null, so onConflict on the pair works directly.
  const { error } = await supabase.from("platform_secrets").upsert(
    {
      tenant_id: input.tenantId,
      secret_key: input.secretKey,
      value_encrypted: toBytea(ciphertext),
      value_iv: toBytea(iv),
      created_by: input.userId,
    },
    { onConflict: "tenant_id,secret_key" },
  );
  if (error) throw new Error(`setPlatformSecret failed: ${error.message}`);
}

export async function deletePlatformSecret(input: {
  tenantId: string | null;
  secretKey: string;
}): Promise<void> {
  const supabase = supabaseService();
  const base = supabase.from("platform_secrets").delete().eq("secret_key", input.secretKey);
  // null tenant_id is the instance scope — match it with IS NULL, not = null.
  const scoped =
    input.tenantId === null ? base.is("tenant_id", null) : base.eq("tenant_id", input.tenantId);
  const { error } = await scoped;
  if (error) throw new Error(`deletePlatformSecret failed: ${error.message}`);
}

type NameRow = { secret_key: string; updated_at: string };

/** Configured KEY names for one scope. Service-role read of the underlying
 *  table (no value columns selected); the action layer gates by tenant. */
async function listPlatformSecretNames(tenantId: string | null): Promise<NameRow[]> {
  const supabase = supabaseService();
  const base = supabase.from("platform_secrets").select("secret_key, updated_at");
  const scoped = tenantId === null ? base.is("tenant_id", null) : base.eq("tenant_id", tenantId);
  const { data, error } = await scoped.order("secret_key", { ascending: true });
  if (error) {
    console.warn(`[platform-secrets] listPlatformSecretNames failed:`, error.message);
    return [];
  }
  return (data ?? []).map((r) => {
    const row = r as NameRow;
    return { secret_key: String(row.secret_key), updated_at: String(row.updated_at) };
  });
}

/** Masked last ≤4 chars per configured key for one scope. Reads the encrypted
 *  columns directly and derives the tail app-side. A missing/invalid master key
 *  (or a single bad row) yields no tail for that key — never throws. */
async function getPlatformSecretTailsMap(tenantId: string | null): Promise<Record<string, string>> {
  const supabase = supabaseService();
  const base = supabase.from("platform_secrets").select("secret_key, value_encrypted, value_iv");
  const scoped = tenantId === null ? base.is("tenant_id", null) : base.eq("tenant_id", tenantId);
  const { data, error } = await scoped;
  if (error) {
    console.warn(`[platform-secrets] getPlatformSecretTailsMap failed:`, error.message);
    return {};
  }
  const out: Record<string, string> = {};
  for (const r of data ?? []) {
    const row = r as { secret_key: string; value_encrypted: unknown; value_iv: unknown };
    let plaintext: string | null = null;
    try {
      plaintext = decryptColumns(row.value_encrypted, row.value_iv);
    } catch {
      // Bad key / corrupt row — skip this entry, keep the rest.
      plaintext = null;
    }
    if (plaintext) out[String(row.secret_key)] = plaintext.slice(-4);
  }
  return out;
}

export type ConfiguredPlatformSecret = {
  key: string;
  /** Masked tail (last ≤4 chars). Null when the value is empty. */
  tail: string | null;
  updatedAt: string;
};

export type PlatformSecretsOverview = {
  /** Which keys this tenant has overridden, with masked tails. */
  configured: ConfiguredPlatformSecret[];
  /** Which keys have an INSTANCE default row (tenant_id NULL) — set from the
   *  setup wizard by an instance operator; shown as a chip on the tenant page. */
  instanceConfigured: ConfiguredPlatformSecret[];
  /** Static metadata for every surfaced key (label, description, required, …). */
  catalog: readonly PlatformSecretCatalogEntry[];
};

async function listConfiguredForScope(
  tenantId: string | null,
): Promise<ConfiguredPlatformSecret[]> {
  const [names, tails] = await Promise.all([
    listPlatformSecretNames(tenantId),
    getPlatformSecretTailsMap(tenantId),
  ]);
  return names.map((n) => ({
    key: n.secret_key,
    tail: tails[n.secret_key] ?? null,
    updatedAt: n.updated_at,
  }));
}

/** Configured keys (with masked tails) for the instance scope only. */
export async function loadInstanceSecretsConfigured(): Promise<ConfiguredPlatformSecret[]> {
  return listConfiguredForScope(null);
}

/** One-shot fetch for the Platform secrets card: which keys this tenant has set
 *  (with masked tails), which have instance defaults, + the static catalog. */
export async function loadPlatformSecretsOverview(
  tenantId: string,
): Promise<PlatformSecretsOverview> {
  const [configured, instanceConfigured] = await Promise.all([
    listConfiguredForScope(tenantId),
    listConfiguredForScope(null),
  ]);
  return { configured, instanceConfigured, catalog: PLATFORM_SECRET_CATALOG };
}
