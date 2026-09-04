// The DB half of the Vercel OAuth connection: plain functions over an INJECTED
// Supabase client, with the tenant id passed in already resolved.
//
// Split out of the route/action for the same reason `lib/vercel/link-write.ts`
// and `lib/learning/write.ts` are: a `"use server"` file (or a route that pulls
// in `next/headers`) cannot load under Vitest at all, so logic left inside one
// is logic that cannot be tested. Everything that can go wrong about a tenant
// predicate lives here, where a test drives a fake client that actually applies
// `.eq`.
//
// ── The tenant predicate IS the boundary ──────────────────────────────────
// `vercel_oauth_connections` denies EVERY JWT role, SELECT included, so every
// access here runs with the SERVICE ROLE and RLS is off. The co-located
// `.eq("tenant_id", tenantId)` is therefore the only thing between a mistaken
// or forged tenant id and another tenant's DEPLOY CREDENTIAL — not a
// preference row, the credential itself. Read it and you can deploy as them;
// overwrite it and every project DevPilot creates for them, and (PR 4) every
// environment variable it pushes, goes to an account you control.
//
// The tests pair each assertion with a CONTROL case that neuters the predicate
// and confirms the foreign row would be reachable; a fake client that ignored
// `.eq` would make the whole suite vacuous.
//
// ── Encryption is injected, not imported ──────────────────────────────────
// `@/lib/secrets/crypto` is `server-only` and would make this module unloadable
// under Vitest — the exact trap that made the mistakes-backfill script throw at
// import time (AGENTS.md, "server-only-in-CLI class"). So the encrypt/decrypt
// pair arrives as an argument and `connection.server.ts` supplies the real one.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ConnectionWriteResult = { ok: true } | { ok: false; error: string };

/** How the two credential paths are distinguished everywhere downstream. */
export type VercelCredentialSource = "oauth" | "pasted" | "none";

/** Injected crypto, so this module never imports `server-only`. */
export type ConnectionCrypto = {
  encrypt: (plaintext: string) => { ciphertext: unknown; iv: unknown };
  /** Returns null on a missing/invalid master key or a corrupt row — never
   *  throws, matching the read posture of every other secret reader here. */
  decrypt: (ciphertext: unknown, iv: unknown) => string | null;
};

export type VercelConnectionWrite = {
  accessToken: string;
  teamId: string | null;
  configurationId: string | null;
  accountLogin: string | null;
  accountKind: "personal" | "team" | null;
  connectedBy: string | null;
  /** Injected so the value is deterministic in tests. */
  connectedAt: string;
};

/** Metadata only — no token, ever. This is what the settings card renders. */
export type VercelConnectionStatus = {
  connected: boolean;
  teamId: string | null;
  configurationId: string | null;
  accountLogin: string | null;
  accountKind: "personal" | "team" | null;
  connectedAt: string | null;
};

export const DISCONNECTED: VercelConnectionStatus = {
  connected: false,
  teamId: null,
  configurationId: null,
  accountLogin: null,
  accountKind: null,
  connectedAt: null,
};

/**
 * Store (or replace) the tenant's connection.
 *
 * Upsert on `tenant_id`: reconnecting REPLACES the credential rather than
 * accumulating rows, so there is never a question of which of two stored tokens
 * is live. The unique constraint makes that structural rather than conventional.
 */
export async function writeVercelConnection(
  db: SupabaseClient,
  tenantId: string,
  input: VercelConnectionWrite,
  crypto: ConnectionCrypto,
): Promise<ConnectionWriteResult> {
  let ciphertext: unknown;
  let iv: unknown;
  try {
    const enc = crypto.encrypt(input.accessToken);
    ciphertext = enc.ciphertext;
    iv = enc.iv;
  } catch (err) {
    // A missing SECRETS_ENCRYPTION_KEY must FAIL the connect, not store a
    // plaintext or unreadable credential. Surfaced verbatim: the underlying
    // error names the env var and how to generate one.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const { error } = await db.from("vercel_oauth_connections").upsert(
    {
      tenant_id: tenantId,
      access_token_encrypted: ciphertext,
      access_token_iv: iv,
      team_id: input.teamId,
      configuration_id: input.configurationId,
      account_login: input.accountLogin,
      account_kind: input.accountKind,
      connected_by: input.connectedBy,
      connected_at: input.connectedAt,
      updated_at: input.connectedAt,
    },
    { onConflict: "tenant_id" },
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Read the tenant's connection INCLUDING the decrypted token.
 *
 * The only caller is credential resolution. Returns null for "no connection",
 * "no master key" and "corrupt row" alike — all three mean the same thing to a
 * caller (no usable OAuth credential) and the pasted-token fallback below it
 * handles them identically.
 */
export async function readVercelConnectionToken(
  db: SupabaseClient,
  tenantId: string,
  crypto: ConnectionCrypto,
): Promise<{ token: string; teamId: string | null } | null> {
  const { data, error } = await db
    .from("vercel_oauth_connections")
    .select("access_token_encrypted, access_token_iv, team_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return null;
  let token: string | null = null;
  try {
    token = crypto.decrypt(data.access_token_encrypted, data.access_token_iv);
  } catch {
    token = null;
  }
  if (!token || token.length === 0) return null;
  return { token, teamId: (data.team_id as string | null) ?? null };
}

/**
 * Read the connection METADATA. Never selects the token columns, so the
 * settings page's read path cannot leak a credential even if a future component
 * serialised the whole object to the browser.
 */
export async function readVercelConnectionStatus(
  db: SupabaseClient,
  tenantId: string,
): Promise<VercelConnectionStatus> {
  const { data, error } = await db
    .from("vercel_oauth_connections")
    .select("team_id, configuration_id, account_login, account_kind, connected_at")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return DISCONNECTED;
  const kind = data.account_kind as string | null;
  return {
    connected: true,
    teamId: (data.team_id as string | null) ?? null,
    configurationId: (data.configuration_id as string | null) ?? null,
    accountLogin: (data.account_login as string | null) ?? null,
    accountKind: kind === "personal" || kind === "team" ? kind : null,
    connectedAt: (data.connected_at as string | null) ?? null,
  };
}

/**
 * Disconnect: drop the row.
 *
 * LOCAL ONLY, and the UI says so. Vercel's REST API exposes no endpoint to
 * revoke an integration access token or uninstall a configuration on the
 * account's behalf — that is a dashboard action. So this removes DevPilot's
 * ability to use the credential and nothing more; the operator must also
 * uninstall the integration on Vercel if they want the grant itself withdrawn.
 * Claiming otherwise would leave a live grant behind a UI that said it was gone.
 */
export async function deleteVercelConnection(
  db: SupabaseClient,
  tenantId: string,
): Promise<ConnectionWriteResult> {
  const { error } = await db.from("vercel_oauth_connections").delete().eq("tenant_id", tenantId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
