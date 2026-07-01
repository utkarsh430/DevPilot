-- Backfill: null out bogus GitHub-token expiries wrongly derived from the
-- Supabase session TTL (Fix Family A — "non-expiring token wrongly marked
-- expired").
--
-- Bug: `persistGithubTokenFromSession` derived the stored `expires_at` from
-- `session.expires_at` — the Supabase GoTrue JWT session TTL (~3600s), NOT
-- GitHub's access-token lifetime. A DEFAULT GitHub OAuth App issues a
-- NON-EXPIRING access token with NO refresh token, so every such row got a live
-- token paired with a bogus ~1h expiry. About an hour after each sign-in
-- `ensureFreshGithubToken` saw the expiry in the past with no refresh token to
-- use and returned null, breaking every GitHub operation (land-to-dev, manual
-- push/PR, agent git) for every user.
--
-- The write-path fix stores `expires_at = NULL` for these Mode-1 rows going
-- forward (invariant: `expires_at` non-null ⟺ `refresh_token` non-null). This
-- backfill heals already-connected users with NO forced re-auth: their
-- underlying GitHub token is still live — only the stored expiry was wrong.
--
-- The WHERE clause is the EXACT Mode-1 fingerprint (no refresh token + a stamped
-- expiry). Mode-2 rows (`refresh_token` present) carry a real expiry and are
-- left untouched.

update public.github_oauth_tokens
set expires_at = null,
    updated_at = now()
where refresh_token is null
  and expires_at is not null;
