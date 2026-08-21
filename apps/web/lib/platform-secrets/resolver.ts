// Platform-secrets resolver (server-only). The runtime read path for
// DB-backed config with env fallback.
//
//   resolveSync(key, { tenantId })  =  tenant override » instance » process.env
//
// Design (see the plan): consumers' getters are SYNCHRONOUS, so we keep an
// in-process cache (per-tenant + instance maps) warmed asynchronously at request
// boundaries (`ensurePlatformSecretsLoaded`). `resolveSync` never blocks on I/O —
// on a cold/stale cache it returns the env value immediately and kicks a
// background refresh. So a cold cache behaves exactly like reading env today.
//
// Gated by DEVPILOT_PLATFORM_SECRETS_ENABLED — DEFAULT ON. An empty store resolves
// byte-for-byte to process.env (the fallback of last resort), so env-only
// installs behave identically; only an explicit `0`/`false`/`no` disables the
// DB path entirely (then resolveSync returns process.env[key] directly and the
// DB is never consulted). The per-tenant merge (tenant-over-instance) is done
// here in Node now (the RPC that used to do it is gone), so a tenant's cached
// map is already the resolved view. Values are AES-256-GCM at rest and
// decrypted via `@/lib/secrets/crypto` when the map is built.

import "server-only";

import { supabaseService } from "@/lib/db/server";
import { decryptColumns } from "@/lib/secrets/crypto";

const FLAG = (process.env.DEVPILOT_PLATFORM_SECRETS_ENABLED ?? "").trim().toLowerCase();
const ENABLED = !(FLAG === "0" || FLAG === "false" || FLAG === "no");
const TTL_MS =
  Math.max(5, Number(process.env.DEVPILOT_PLATFORM_SECRETS_TTL_SECONDS ?? "60") || 60) * 1000;

// Cache key for the instance scope (tenant_id = null).
const INSTANCE = "__instance__";

type Entry = { map: Map<string, string>; loadedAt: number };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();

function scopeKeyOf(tenantId: string | null): string {
  return tenantId ?? INSTANCE;
}

function envVal(key: string): string | undefined {
  const v = process.env[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

type SecretRow = {
  tenant_id: string | null;
  secret_key: string;
  value_encrypted: unknown;
  value_iv: unknown;
};

async function load(scopeKey: string, tenantId: string | null): Promise<void> {
  try {
    // Read instance rows (tenant_id NULL) plus this tenant's overrides in one
    // shot. When tenantId is null we only get the instance rows back.
    let query = supabaseService()
      .from("platform_secrets")
      .select("tenant_id, secret_key, value_encrypted, value_iv");
    query =
      tenantId === null
        ? query.is("tenant_id", null)
        : query.or(`tenant_id.is.null,tenant_id.eq.${tenantId}`);
    const { data, error } = await query;
    if (error) {
      // Best-effort: keep whatever's cached; resolveSync falls back to env.
      console.warn(`[platform-secrets] resolver load failed:`, error.message);
      return;
    }

    // Node-side merge: the per-tenant row (tenant_id === tenantId, non-null)
    // wins over the instance row (tenant_id null) for the same key. Decrypt the
    // winner; skip any row whose value won't decrypt (missing/bad key, corrupt).
    const winners = new Map<string, SecretRow>();
    for (const r of (data ?? []) as SecretRow[]) {
      const prev = winners.get(r.secret_key);
      // A non-null tenant_id always beats a null one; otherwise first/only wins.
      if (!prev || (r.tenant_id !== null && prev.tenant_id === null)) {
        winners.set(r.secret_key, r);
      }
    }

    const map = new Map<string, string>();
    for (const [key, row] of winners) {
      let plaintext: string | null = null;
      try {
        plaintext = decryptColumns(row.value_encrypted, row.value_iv);
      } catch {
        plaintext = null;
      }
      if (plaintext && plaintext.length > 0) map.set(key, plaintext);
    }
    cache.set(scopeKey, { map, loadedAt: Date.now() });
  } catch (e) {
    console.warn(`[platform-secrets] resolver load threw:`, e instanceof Error ? e.message : e);
  }
}

export function platformSecretsEnabled(): boolean {
  return ENABLED;
}

/** Warm the cache for a scope. No-op when the feature is off or the cache is
 *  fresh. Concurrent calls for the same scope coalesce into one query. */
export async function ensurePlatformSecretsLoaded(tenantId: string | null): Promise<void> {
  if (!ENABLED) return;
  const sk = scopeKeyOf(tenantId);
  const entry = cache.get(sk);
  if (entry && Date.now() - entry.loadedAt < TTL_MS) return;

  let p = inflight.get(sk);
  if (!p) {
    p = load(sk, tenantId).finally(() => inflight.delete(sk));
    inflight.set(sk, p);
  }
  await p;
}

/** Synchronous resolve: tenant override » instance » process.env. Never blocks
 *  on I/O; on a cold/stale cache it returns env and triggers a background load. */
export function resolveSync(key: string, opts: { tenantId: string | null }): string | undefined {
  if (!ENABLED) return envVal(key);
  const sk = scopeKeyOf(opts.tenantId);
  const entry = cache.get(sk);
  if (!entry) {
    void ensurePlatformSecretsLoaded(opts.tenantId);
    return envVal(key);
  }
  if (Date.now() - entry.loadedAt >= TTL_MS) {
    void ensurePlatformSecretsLoaded(opts.tenantId);
  }
  // The tenant map is already the merged (tenant-over-instance) view from the
  // RPC, so a hit here is the winning DB value; env is the final fallback.
  const hit = entry.map.get(key);
  return hit !== undefined ? hit : envVal(key);
}

/** Async convenience: warm then resolve. Use where an await is already cheap. */
export async function resolvePlatformSecret(
  key: string,
  opts: { tenantId: string | null },
): Promise<string | undefined> {
  await ensurePlatformSecretsLoaded(opts.tenantId);
  return resolveSync(key, opts);
}

/** Drop a scope's cache so the next resolve re-reads the DB. Called by the
 *  management actions right after a write (single-process immediate
 *  consistency; TTL covers other instances). */
export function invalidatePlatformSecrets(tenantId: string | null): void {
  cache.delete(scopeKeyOf(tenantId));
}
