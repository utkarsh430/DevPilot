// Pure derivation of the stored GitHub-token `expires_at`. Extracted into its
// own module (with no `@/lib/db/server` / next-server imports) so Vitest can
// load it directly — the repo's testing convention for pure policy/helper logic.
//
// The bug this exists to prevent (Fix Family A — "non-expiring token wrongly
// marked expired"): `session.expires_at` on a Supabase session is the GoTrue
// JWT session TTL (~3600s), NOT GitHub's access-token lifetime. A DEFAULT GitHub
// OAuth App issues a NON-EXPIRING access token with NO refresh token, so
// deriving `expires_at` from the session TTL stamped every such row with a bogus
// ~1h expiry. About an hour after each sign-in `ensureFreshGithubToken`
// (refresh.ts) then saw the expiry in the past with no refresh token to use and
// returned null, breaking every GitHub operation (land-to-dev, manual push/PR,
// agent git) for every user.
//
// Correct rule: stamp an expiry ONLY when Supabase ALSO forwarded a refresh
// token — i.e. the OAuth App opted into token expiration (Mode 2). In that mode
// the session TTL is a conservative LOWER BOUND that forces an early refresh,
// which then stamps GitHub's REAL lifetime from `expires_in`. In Mode 1 (the
// default: non-expiring, no refresh token) we store null, which
// `ensureFreshGithubToken` reads as "valid forever". This makes the stored
// invariant `expires_at` non-null ⟺ `refresh_token` non-null hold by
// construction.
export function deriveGithubTokenExpiresAt(session: {
  provider_refresh_token?: string | null;
  expires_at?: number | null;
}): string | null {
  // No refresh token → Mode 1 (non-expiring). Never stamp an expiry.
  if (!session.provider_refresh_token) return null;
  // Mode 2: only trust a positive numeric session TTL as the lower-bound expiry.
  if (typeof session.expires_at !== "number" || session.expires_at <= 0) return null;
  return new Date(session.expires_at * 1000).toISOString();
}
