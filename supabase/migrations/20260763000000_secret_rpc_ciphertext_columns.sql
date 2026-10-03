-- =============================================================================
-- Migration : 20260763000000_secret_rpc_ciphertext_columns.sql
-- Purpose   : Fix `devpilot_set_project_secret` (20260762000000), which
--             DELEGATES to `public.set_project_secret(uuid, text, text, uuid)`
--             — a function DROPPED by 20260615010000 when secret encryption
--             moved from pgcrypto-in-DB to app-layer AES-256-GCM in Node
--             (apps/web/lib/secrets/crypto.ts). `project_secrets` has carried
--             no `value_plain` column and no `set_project_secret` function
--             since that migration, so the delegate is dead code against the
--             CURRENT schema: calling `devpilot_set_project_secret` fails at
--             runtime. Caught live by the devpilot-desktop phase gate (WP 1.4)
--             — NOT by the WP 1.3 local harness
--             (supabase/tests/rls-agent-writes/), whose own
--             sql/01_schema_subset.sql had independently drifted from the real
--             post-AES schema: it hand-transcribed the PRE-AES
--             (20260606000000) shape verbatim, including a local
--             `value_plain` column and a local `set_project_secret` copy, so
--             the harness's own delegate call succeeded against a schema that
--             no longer exists in reality. That drift is fixed alongside this
--             migration (see the harness's own updated files).
--
-- Fix
-- ───
-- `devpilot_set_project_secret` now takes the CIPHERTEXT + IV directly — both
-- already app-layer-encrypted in Node before the RPC call — and writes them
-- straight into `project_secrets.value_encrypted` / `value_iv`. It becomes a
-- dumb, authorized writer, never a crypto boundary: the database never sees
-- plaintext, exactly as it does not today for the app's own direct-table-write
-- path (apps/web/lib/projects/secrets.ts's `setProjectSecret`), and exactly
-- the convention every other secrets table in this schema already uses (see
-- `github_oauth_tokens.access_token_encrypted`/`_iv`,
-- `vercel_oauth_connections.access_token_encrypted`/`_iv`).
--
-- The wire format is the SAME `\x<hex>` bytea-literal text that
-- `lib/secrets/crypto.ts`'s `toBytea()` already produces and that
-- `setProjectSecret()` already sends over supabase-js today for a plain
-- table upsert. The two new parameters are typed `text` (not `bytea`) and
-- cast explicitly with `::bytea` inside the function body, rather than
-- relying on PostgREST's own JSON→bytea parameter coercion — which has no
-- precedent anywhere else in this schema and would make the RPC's behaviour
-- depend on an untested conversion path. A desktop-side caller therefore
-- encrypts with the identical Node convention (`encryptSecret` + `toBytea`)
-- and passes the identical hex string it would otherwise send to a direct
-- table upsert.
--
-- `project_secrets` carries no separate auth-tag or key-version column: the
-- Node `encryptSecret()` helper already appends the 16-byte GCM auth tag onto
-- the ciphertext before it is ever written (`EncryptResult` /
-- `Buffer.concat([enc, tag])` in crypto.ts), so `value_encrypted` alone is the
-- full opaque payload and no third cryptographic parameter is needed.
--
-- The old 3-arg overload (p_project_id uuid, p_secret_key text, p_value text)
-- — the plaintext-accepting signature 20260762000000 shipped — is DROPPED in
-- this same migration so a plaintext-accepting signature does not linger
-- callable alongside the fix. Postgres overloads on argument list, so
-- `create or replace function ...(uuid, text, text, text)` would otherwise
-- coexist with the old `(uuid, text, text)` signature rather than replacing
-- it. This drop is of OUR OWN function shipped hours ago, not an existing
-- consumer surface: nothing in this repository calls the 3-arg form (the
-- desktop app's own DAL is the only caller of this RPC and has no shipped
-- release yet).
--
-- Every safety property from 20260762000000 is preserved verbatim: SECURITY
-- DEFINER, pinned search_path, tenant re-derived from `projects` (never a
-- client-supplied tenant_id), `require_tenant_member()` re-checked, REVOKE
-- (public, anon) before GRANT (authenticated). `project_secrets` itself still
-- carries no table-level grant to `authenticated` (20260761000000) — this RPC
-- remains the only sanctioned write path to secret values, and
-- `devpilot_get_project_secret_names` (unchanged — it never touched
-- `value_plain`/`value_encrypted` in the first place) remains the only
-- sanctioned read path, names only.
--
-- Do NOT touch `public.set_project_secret` beyond ceasing to call it — it
-- is already dropped (20260615010000); re-dropping it here would be a no-op
-- and re-creating it is out of scope.
--
-- Idempotent: DROP FUNCTION IF EXISTS + CREATE OR REPLACE FUNCTION throughout.
-- =============================================================================
begin;

-- Drop the dead delegate's plaintext-accepting 3-arg signature. The 4-arg
-- replacement below is a DIFFERENT signature (Postgres overloads on argument
-- list), so this drop is required — CREATE OR REPLACE alone would leave the
-- old, broken 3-arg function coexisting and callable.
drop function if exists public.devpilot_set_project_secret(uuid, text, text);

create or replace function public.devpilot_set_project_secret(
  p_project_id uuid,
  p_secret_key text,
  -- Hex bytea literal ('\x...'), [aes-256-gcm ciphertext ‖ authTag(16)] — see
  -- apps/web/lib/secrets/crypto.ts's encryptSecret()/toBytea(). Already
  -- encrypted by the caller; this function never sees plaintext.
  p_ciphertext text,
  -- Hex bytea literal ('\x...'), 12-byte GCM nonce — see crypto.ts's
  -- encryptSecret()/toBytea().
  p_iv text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  if p_ciphertext is null or p_iv is null then
    raise exception 'devpilot_set_project_secret: ciphertext and iv are both required'
      using errcode = '22023';
  end if;

  select tenant_id into v_tenant_id from public.projects where id = p_project_id;
  if v_tenant_id is null then
    raise exception 'project % not found', p_project_id;
  end if;
  perform public.require_tenant_member(v_tenant_id);

  insert into public.project_secrets (
    project_id, tenant_id, secret_key, value_encrypted, value_iv, created_by
  )
  values (
    p_project_id, v_tenant_id, p_secret_key, p_ciphertext::bytea, p_iv::bytea, auth.uid()
  )
  on conflict (project_id, secret_key) do update set
    value_encrypted = excluded.value_encrypted,
    value_iv        = excluded.value_iv,
    updated_at      = now();
end;
$$;

revoke all on function public.devpilot_set_project_secret(uuid, text, text, text) from public, anon;
grant execute on function public.devpilot_set_project_secret(uuid, text, text, text) to authenticated;

commit;
