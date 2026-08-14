-- =============================================================================
-- Migration : 20260741000000_vercel_oauth_connection.sql
-- Purpose   : PR 3 of the Vercel deployment feature — "Connect Vercel", the
--             one-click OAuth install that replaces pasting an account-scoped
--             token by hand.
--
-- ── Why a dedicated table rather than writing VERCEL_TOKEN ────────────────
-- The obvious shortcut is to drop the OAuth access token into
-- `platform_secrets` under the existing `VERCEL_TOKEN` key, so nothing
-- downstream changes. That was rejected for two concrete reasons:
--
--   1. It CLOBBERS the operator's pasted token. The paste field is the
--      documented fallback for an instance whose integration is not set up (or
--      whose configuration got disabled), and overwriting it means
--      disconnecting leaves the operator with no credential at all rather than
--      the one they had before.
--   2. It cannot hold `configuration_id`. That id is what a disabled-
--      integration diagnosis and any future uninstall/revoke call need, and it
--      arrives exactly once — on the callback. Losing it means the operator's
--      only recourse to a `integration_configuration_disabled` 403 is to hunt
--      through the Vercel dashboard.
--
-- So the connection is its own row, and `resolveVercelConfig` reads it as a
-- rung ABOVE the pasted key. Precedence and its rationale are stated there.
--
-- ── Tenant isolation ──────────────────────────────────────────────────────
-- One connection per tenant (`unique (tenant_id)`), and `tenant_id` is the
-- whole boundary: every read and write of this table runs with the SERVICE ROLE
-- (RLS off), because the callback route has a session but the row holds a
-- credential no JWT role should ever be able to select. The co-located
-- `.eq("tenant_id", …)` in lib/vercel/connection.ts is therefore the only thing
-- between a forged id and another tenant's deploy credential.
--
-- `tenant_id → tenants` is NOT in the `assert_tenant_matches_parent` class
-- (20260732000000): `tenants` carries no `tenant_id` of its own. `connected_by
-- → auth.users` is not a public tenant-scoped table either. So this table needs
-- no parent-match trigger, and the migration-derived pair list in
-- lib/security/__tests__/tenant-scope-scan.test.ts is unaffected.
--
-- ── The token at rest ─────────────────────────────────────────────────────
-- Same shape as `platform_secrets` and `github_oauth_tokens`: app-layer
-- AES-256-GCM (`@/lib/secrets/crypto`) into opaque bytea, so a raw row dump is
-- useless without SECRETS_ENCRYPTION_KEY. The token column is never SELECTed by
-- any status/UI read — `readVercelConnectionStatus` selects the metadata
-- columns only, so the decrypt path has exactly one caller.
--
-- Execution notes: one-shot transactional migration; brand-new table with zero
-- rows, so plain CREATE INDEX (CONCURRENTLY is illegal in a transaction).
-- =============================================================================
begin;

create table if not exists public.vercel_oauth_connections (
  id                uuid        not null default gen_random_uuid()
                      primary key,

  -- The boundary. Cascade: deleting a tenant reaps its credential.
  tenant_id         uuid        not null
                      references public.tenants(id) on delete cascade,

  -- App-layer AES-256-GCM. `[ciphertext ‖ authTag]` and the 12-byte GCM nonce.
  access_token_encrypted bytea  not null,
  access_token_iv        bytea  not null,

  -- Vercel's `team_id` from the token-exchange response. NULL means a personal
  -- (Hobby) account — which is the NORMAL case for the dedicated-account setup
  -- this feature is built around, not an edge case. Threaded into every
  -- subsequent API call exactly as a pasted VERCEL_TEAM_ID would be.
  team_id           text        null,

  -- The installation's configuration id, from the redirect query. Needed to
  -- explain (and, later, to act on) a 403 `integration_configuration_disabled`,
  -- which is only reachable on this credential path. Nullable because the
  -- redirect is a third party's and a missing param must degrade to "we stored
  -- what we got", never to a failed connection.
  configuration_id  text        null,

  -- Identity the credential resolved to at connect time, for display. A
  -- SNAPSHOT: the preflight re-reads the live identity on every render and
  -- reports THAT (same rule as vercel_production_branch — never render a stored
  -- mirror of third-party state as fact).
  account_login     text        null,
  account_kind      text        null
                      constraint chk_vercel_oauth_account_kind
                        check (account_kind is null
                               or account_kind in ('personal', 'team')),

  connected_by      uuid        null
                      references auth.users(id) on delete set null,
  connected_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- One connection per tenant. Reconnecting UPDATES this row rather than
  -- accumulating dead credentials.
  constraint uq_vercel_oauth_connections_tenant unique (tenant_id)
);

comment on table public.vercel_oauth_connections is
  'The Vercel integration OAuth connection for a tenant: an encrypted, '
  'non-expiring access token plus the team_id and configuration_id from the '
  'install. Read as a rung ABOVE the pasted VERCEL_TOKEN platform secret, which '
  'stays as the fallback. All access is service-role + an explicit tenant '
  'predicate; every JWT role is denied, including SELECT.';

comment on column public.vercel_oauth_connections.team_id is
  'Vercel team id from the token exchange. NULL = personal/Hobby account, the '
  'normal case. Threaded into API calls like a pasted VERCEL_TEAM_ID.';

comment on column public.vercel_oauth_connections.configuration_id is
  'Integration configuration id from the install redirect. The only handle on a '
  '403 integration_configuration_disabled, which cannot occur with a pasted token.';

alter table public.vercel_oauth_connections enable row level security;

-- Deny EVERY JWT role, SELECT included. This row holds a deploy credential;
-- there is no member-facing read of it. Status for the settings card is served
-- by a service-role loader that never selects the token columns. service_role
-- bypasses RLS, so the app paths are unaffected.
create policy vercel_oauth_connections_select_deny
  on public.vercel_oauth_connections
  for select
  using (false);

create policy vercel_oauth_connections_insert_deny
  on public.vercel_oauth_connections
  for insert
  with check (false);

create policy vercel_oauth_connections_update_deny
  on public.vercel_oauth_connections
  for update
  using (false);

create policy vercel_oauth_connections_delete_deny
  on public.vercel_oauth_connections
  for delete
  using (false);

commit;
