// GitHub OAuth token persistence + retrieval helpers (Phase 2 / M5a).
//
// Supabase Auth's GitHub provider captures `provider_token` /
// `provider_refresh_token` in the session returned by exchangeCodeForSession,
// but Supabase does NOT persist that token past the session — refreshing the
// Supabase JWT does not refresh the upstream GitHub token. Background agents
// need durable access, so we mirror the token into our own table
// (`public.github_oauth_tokens`) at the callback.
//
// The access token is encrypted at the app layer (AES-256-GCM, env master key)
// and stored as opaque bytea (`access_token_encrypted` ‖ `access_token_iv`) —
// see `@/lib/secrets/crypto`. We read/write the columns directly via the
// service-role client; the old pgcrypto security-definer RPCs are gone.
//
// All writes / reads go through the service-role client — RLS only grants
// SELECT-self to the owner, never INSERT/UPDATE/DELETE.

import { supabaseService } from "@/lib/db/server";
import { decryptColumns, encryptSecret, toBytea } from "@/lib/secrets/crypto";
import { deriveGithubTokenExpiresAt } from "@/lib/github/token-expiry";
import { GITHUB_OAUTH_SCOPES } from "@/lib/github/scopes";
import type { GithubAccessTokenRow } from "@/lib/github/types";

/**
 * Truncated representation of a token for log lines. CLAUDE.md "Untrusted
 * content rule" + general hygiene: NEVER log the raw bearer token.
 */
function maskToken(token: string | null | undefined): string {
  if (!token) return "<none>";
  return token.slice(0, 4) + "...";
}

export { GITHUB_OAUTH_SCOPES };

/**
 * Build an opaque "where would the GitHub OAuth flow send the browser if it
 * ran right now" URL descriptor. Kept for API symmetry with the spec; the
 * actual browser-side handshake is done by `signInWithGithub()` in
 * `@/lib/auth`, which calls `supabase.auth.signInWithOAuth` (the only
 * supported way to start the flow with PKCE cookies).
 *
 * Callers SHOULD prefer `signInWithGithub(redirectTo)` from `@/lib/auth`.
 * This function exists so server-side code can log/inspect the intended
 * redirect target without performing it.
 */
export function buildGithubOAuthUrl(redirectTo: string): string {
  const params = new URLSearchParams({
    redirect_to: redirectTo,
    scopes: GITHUB_OAUTH_SCOPES,
  });
  return `supabase://oauth/github?${params.toString()}`;
}

type ProviderSession = {
  user: { id: string };
  provider_token?: string | null;
  provider_refresh_token?: string | null;
  expires_at?: number | null;
};

/**
 * Fetch the authenticated GitHub user's profile + the scopes the token was
 * granted. GitHub returns scopes in the `X-OAuth-Scopes` response header.
 */
async function fetchGithubProfile(
  accessToken: string,
): Promise<{ id: number; login: string; scopes: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "devpilot",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      `GitHub /user returned ${res.status} ${res.statusText} for token ${maskToken(accessToken)}`,
    );
  }
  const scopes = (res.headers.get("x-oauth-scopes") ?? "").replace(/\s+/g, " ").trim();
  const body = (await res.json()) as { id: number; login: string };
  if (typeof body?.id !== "number" || typeof body?.login !== "string") {
    throw new Error("GitHub /user returned a malformed body (missing id/login).");
  }
  return { id: body.id, login: body.login, scopes };
}

/**
 * Persist (or refresh) the user's GitHub OAuth token from a Supabase session.
 *
 * Behaviour:
 *  1. No-op if `session.provider_token` is missing (user signed in via magic
 *     link or skipped the GitHub scope).
 *  2. Hits GitHub's /user endpoint to capture `(github_id, github_login,
 *     scopes)` — Supabase doesn't surface these.
 *  3. Encrypts the access token (AES-256-GCM) and upserts the row directly,
 *     keyed on `user_id`. The refresh token stays plaintext (GitHub treats it
 *     as the long-lived re-auth credential; matched by the table schema).
 *  4. Errors propagate up — the callback handler in
 *     `apps/web/app/auth/callback/route.ts` catches them and redirects to
 *     `/settings/github-integration?error=…` without failing the login.
 */
export async function persistGithubTokenFromSession(session: ProviderSession): Promise<void> {
  const token = session.provider_token;
  if (!token) {
    // User signed in but didn't grant a GitHub session (magic link, or
    // explicit deny). Nothing to persist.
    return;
  }
  const profile = await fetchGithubProfile(token);
  // `expires_at` derivation is deliberately NOT `session.expires_at` (that is
  // the Supabase JWT session TTL, ~1h, not GitHub's token lifetime). Mode 1
  // (default OAuth App: non-expiring token, no refresh token) → null, so the
  // token is treated as valid forever. Mode 2 (OAuth App opted into token
  // expiration → a refresh token is present) → the session TTL as a
  // conservative lower bound that forces an early refresh, which then stamps
  // the real lifetime from `expires_in` (see refresh.ts). Paired with the
  // unchanged `refresh_token` write below this makes the stored invariant
  // `expires_at` non-null ⟺ `refresh_token` non-null hold by construction.
  const expiresAt = deriveGithubTokenExpiresAt(session);

  // Encrypt the access token before it touches the DB. A missing/invalid
  // master key makes encryptSecret throw — we let that surface: a SET must
  // not silently persist a token the app can never decrypt.
  const { ciphertext, iv } = encryptSecret(token);

  const supabase = supabaseService();
  const { error } = await supabase.from("github_oauth_tokens").upsert(
    {
      user_id: session.user.id,
      access_token_encrypted: toBytea(ciphertext),
      access_token_iv: toBytea(iv),
      refresh_token: session.provider_refresh_token ?? null,
      expires_at: expiresAt,
      scopes: profile.scopes,
      github_id: profile.id,
      github_login: profile.login,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) {
    throw new Error(
      `persistGithubTokenFromSession: upsert failed (user=${session.user.id}, ` +
        `github_login=${profile.login}, token=${maskToken(token)}): ${error.message}`,
    );
  }
}

/**
 * Retrieve the decrypted GitHub access token for a user. Returns `null` when
 * no row exists (user never connected GitHub) — callers MUST handle null and
 * either prompt re-auth or fail the job appropriately.
 *
 * Callers are responsible for freshness; `ensureFreshGithubToken` in
 * `refresh.ts` wraps this with the refresh-token flow.
 */
export async function getGithubAccessToken(userId: string): Promise<string | null> {
  // READ posture (mirrors SlideLang's getUserSecret): a missing row, a missing
  // master key, or a decrypt failure all resolve to null — never throw and
  // break the dispatch path. Callers treat null as "no usable connection".
  try {
    const supabase = supabaseService();
    const { data, error } = await supabase
      .from("github_oauth_tokens")
      .select("access_token_encrypted, access_token_iv")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;

    const token = decryptColumns(data.access_token_encrypted, data.access_token_iv);
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the row metadata for the settings UI / engine dispatch. Returns
 * `null` when the user has no token row.
 *
 * The decrypted access token is composed in via `getGithubAccessToken()`
 * (app-layer AES-256-GCM) — the metadata SELECT never reads the encrypted
 * bytea columns. The `accessToken` field on the returned row is plaintext;
 * UI callers that don't need it can drop it at the call site.
 */
export async function getGithubTokenRow(userId: string): Promise<GithubAccessTokenRow | null> {
  const supabase = supabaseService();
  const { data: rowData, error: rowErr } = await supabase
    .from("github_oauth_tokens")
    .select("user_id, refresh_token, expires_at, scopes, github_id, github_login")
    .eq("user_id", userId)
    .maybeSingle();
  if (rowErr) {
    throw new Error(`getGithubTokenRow: select failed (user=${userId}): ${rowErr.message}`);
  }
  if (!rowData) return null;

  const accessToken = await getGithubAccessToken(userId);
  if (accessToken == null) {
    // Row exists but the token couldn't be decrypted (missing/invalid master
    // key or a corrupt value) — treat as no-connection so the UI prompts
    // re-auth rather than rendering a half-connected state.
    return null;
  }
  return {
    userId: rowData.user_id as string,
    accessToken,
    refreshToken: (rowData.refresh_token as string | null) ?? null,
    expiresAt: rowData.expires_at ? new Date(rowData.expires_at as string) : null,
    scopes: (rowData.scopes as string | null) ?? "",
    githubId: Number(rowData.github_id),
    githubLogin: rowData.github_login as string,
  };
}

/**
 * Disconnect: drop the user's token row. Used by /settings/github-integration
 * (A6 owns the UI; this helper is the data-layer plumbing).
 */
export async function deleteGithubToken(userId: string): Promise<void> {
  const supabase = supabaseService();
  const { error } = await supabase.from("github_oauth_tokens").delete().eq("user_id", userId);
  if (error) {
    throw new Error(`deleteGithubToken: delete failed (user=${userId}): ${error.message}`);
  }
}
