// GitHub access-token freshness guard. Called from the engine before a job
// payload that includes `githubToken` lands in Redis (A4 wires the call site).
//
// GitHub OAuth Apps have TWO modes for access-token expiration:
//   1. (default) Tokens do NOT expire — `expires_at` is null + there is no
//      refresh_token. `ensureFreshGithubToken` reduces to the identity
//      function in this case.
//   2. (opt-in) Tokens expire in 8h, refresh tokens in 6 months. Set in the
//      OAuth App settings ("Expire user authorization tokens"). When this is
//      on, Supabase forwards `provider_refresh_token` + `expires_at`.
//
// We handle both shapes: if `expires_at` is null we never refresh; otherwise
// we refresh when we're within 5 minutes of expiry.
//
// Docs: https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/refreshing-user-access-tokens

import { supabaseService } from "@/lib/db/server";
import { getGithubTokenRow } from "@/lib/github/oauth";
import { resolvePlatformSecret } from "@/lib/platform-secrets/resolver";
import { encryptSecret, toBytea } from "@/lib/secrets/crypto";

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const GITHUB_REFRESH_ENDPOINT = "https://github.com/login/oauth/access_token";

type RefreshSuccess = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
};

type RefreshError = {
  error: string;
  error_description?: string;
};

function maskToken(token: string | null | undefined): string {
  if (!token) return "<none>";
  return token.slice(0, 4) + "...";
}

/**
 * Returns a GitHub access token guaranteed to be valid for at least the next
 * 5 minutes, or `null` if the user has no token (or refresh failed and we
 * can't recover without re-auth).
 *
 * Caller decides what null means: the engine should fail the run with a
 * clear "user needs to re-auth" error; the settings UI should re-render the
 * "Connect GitHub" CTA.
 *
 * `tenantId` (default null = instance scope) selects which platform-secrets
 * scope the OAuth App credentials resolve from (tenant override » instance »
 * env). Callers thread the owning project's tenant so a tenant-specific OAuth
 * App can be used; null falls back to the env-backed credentials, i.e. today's
 * behavior.
 */
export async function ensureFreshGithubToken(
  userId: string,
  tenantId: string | null = null,
): Promise<string | null> {
  const row = await getGithubTokenRow(userId);
  if (!row) return null;

  // Mode 1: no expiry — token is valid forever (or until the user revokes).
  if (row.expiresAt == null) return row.accessToken;

  // Mode 2: expiry set — refresh if we're inside the skew window.
  const now = Date.now();
  if (row.expiresAt.getTime() > now + REFRESH_SKEW_MS) return row.accessToken;

  if (!row.refreshToken) {
    // Token expired and we have nothing to refresh with — caller must
    // prompt the user to re-auth.
    console.warn(
      `ensureFreshGithubToken: token expired for user=${userId} and no refresh_token on file ` +
        `(token=${maskToken(row.accessToken)})`,
    );
    return null;
  }

  // Resolve the OAuth App credentials (tenant override » instance » env). An
  // unset value resolves to undefined and hits the same "can't refresh" branch
  // as a missing env var, so the fallback behavior is unchanged.
  const clientId = await resolvePlatformSecret("GITHUB_OAUTH_CLIENT_ID", { tenantId });
  const clientSecret = await resolvePlatformSecret("GITHUB_OAUTH_CLIENT_SECRET", { tenantId });
  if (!clientId || !clientSecret) {
    // Without the OAuth App credentials we cannot call the refresh
    // endpoint. Surface a clear log; treat as no-connection.
    console.warn(
      "ensureFreshGithubToken: GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET unset; " +
        "cannot refresh expiring tokens. See apps/web/.env.example.",
    );
    return null;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: row.refreshToken,
  });

  const res = await fetch(GITHUB_REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "devpilot",
    },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    console.warn(
      `ensureFreshGithubToken: refresh HTTP ${res.status} ${res.statusText} ` +
        `for user=${userId}, refresh_token=${maskToken(row.refreshToken)}`,
    );
    return null;
  }

  const payload = (await res.json()) as RefreshSuccess | RefreshError;
  if ("error" in payload) {
    console.warn(
      `ensureFreshGithubToken: refresh denied for user=${userId}: ` +
        `${payload.error} ${payload.error_description ?? ""}`.trim(),
    );
    return null;
  }
  if (!payload.access_token) {
    console.warn(
      `ensureFreshGithubToken: refresh succeeded but no access_token returned for user=${userId}`,
    );
    return null;
  }

  const newExpiresAt =
    typeof payload.expires_in === "number"
      ? new Date(now + payload.expires_in * 1000).toISOString()
      : null;

  // Persist the new token with the same direct, app-encrypted upsert the
  // callback uses. We re-use the on-file github_id / github_login /
  // (refreshed) scopes — refresh never changes the identity, only the bearer.
  //
  // We already hold a working token in memory, so any persistence failure
  // (missing master key → encryptSecret throws, or a DB error) is logged and
  // swallowed: the in-flight job still gets a valid token from this call.
  try {
    const { ciphertext, iv } = encryptSecret(payload.access_token);
    const supabase = supabaseService();
    const { error } = await supabase.from("github_oauth_tokens").upsert(
      {
        user_id: userId,
        access_token_encrypted: toBytea(ciphertext),
        access_token_iv: toBytea(iv),
        refresh_token: payload.refresh_token ?? row.refreshToken,
        expires_at: newExpiresAt,
        scopes: payload.scope ?? row.scopes,
        github_id: row.githubId,
        github_login: row.githubLogin,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      console.warn(
        `ensureFreshGithubToken: upsert failed after refresh (user=${userId}): ${error.message}`,
      );
    }
  } catch (err) {
    console.warn(
      `ensureFreshGithubToken: could not persist refreshed token (user=${userId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return payload.access_token;
}
