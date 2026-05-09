-- =============================================================================
-- Migration : 20260615010000_secrets_app_layer_aes.sql
-- Secrets at rest = app-layer AES-256-GCM (the SlideLang model). CONSOLIDATED.
--
-- This single migration is the squash of the four-step evolution that shipped
-- the platform-secrets feature and moved ALL secret encryption out of the DB:
--   1. platform_secrets vault table (originally pgcrypto + a value_plain
--      transition column + scope RPCs)
--   2. a Supabase-Vault key source (ace_vault_key) — NEVER created here
--   3. the drop of the plaintext transition columns
--   4. app-layer AES-256-GCM: `*_iv` columns; encryption now lives in Node
--      (@/lib/secrets/crypto), keyed by the env var SECRETS_ENCRYPTION_KEY
--
-- Net effect (on top of the committed github_oauth_tokens / project_secrets
-- migrations): the three secret tables store ONLY opaque AES bytea —
--   `*_encrypted` = [aes-256-gcm ciphertext ‖ authTag(16)],  `*_iv` = 12-byte
--   GCM nonce — and every pgcrypto/Vault RPC plus the ace_vault_key() helper is
-- gone. The database never sees plaintext and holds no key; losing the env
-- SECRETS_ENCRYPTION_KEY makes the stored secrets unrecoverable (== at rest).
--
-- The one-time re-encryption of pre-existing rows (pgcrypto → AES) was performed
-- out-of-band against the live DB. Fresh deploys have no rows, so this migration
-- is pure, idempotent DDL (create/add/drop … if [not] exists throughout).
-- =============================================================================
begin;

-- ── platform_secrets — per-tenant + instance config vault, final (AES) shape ──
-- NULLABLE tenant_id: NULL = instance-level value, non-null = per-tenant
-- override. Resolver precedence (applied in Node): tenant row » instance » env.
create table if not exists public.platform_secrets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references public.tenants(id) on delete cascade,
  secret_key      text not null,
  value_encrypted bytea, -- [aes-256-gcm ciphertext ‖ authTag(16)]
  value_iv        bytea, -- 12-byte GCM nonce
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  constraint platform_secrets_key_format check (secret_key ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  -- PG15+ NULLS NOT DISTINCT: a NULL tenant_id (instance scope) collides with
  -- NULL, so supabase-js can upsert on (tenant_id, secret_key) directly — no
  -- coalesce-to-zero-uuid sentinel index needed.
  constraint platform_secrets_scope_key unique nulls not distinct (tenant_id, secret_key)
);
create index if not exists platform_secrets_tenant_idx on public.platform_secrets (tenant_id);

-- Service-role-only reads (NO member RLS policy) — same posture as
-- project_secrets / github_oauth_tokens. The UI reads names + masked tails via
-- service-role server actions; full values are decrypted only in the app layer.
alter table public.platform_secrets enable row level security;

-- Realtime so the Platform secrets tab reflects cross-tab edits.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.platform_secrets;
  end if;
exception when duplicate_object then
  null;
end$$;

create or replace function public.tg_platform_secrets_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists platform_secrets_touch_updated_at on public.platform_secrets;
create trigger platform_secrets_touch_updated_at
before update on public.platform_secrets
for each row execute function public.tg_platform_secrets_touch_updated_at();

-- ── github_oauth_tokens / project_secrets — converge to AES columns ───────────
-- The committed migrations created these with a pgcrypto `*_encrypted` column +
-- a plaintext transition column. Ensure the AES columns exist and the plaintext
-- columns are gone. add/drop … if [not] exists → safe on both fresh + live DBs.
alter table public.github_oauth_tokens add column if not exists access_token_encrypted bytea;
alter table public.github_oauth_tokens add column if not exists access_token_iv bytea;
alter table public.github_oauth_tokens drop column if exists access_token;

alter table public.project_secrets add column if not exists value_encrypted bytea;
alter table public.project_secrets add column if not exists value_iv bytea;
alter table public.project_secrets drop column if exists value_plain;

-- ── retire every DB-side crypto RPC + the Vault key helper ────────────────────
-- All encryption/decryption now happens in Node (@/lib/secrets/crypto); the app
-- reads/writes these tables directly via supabase-js. Nothing calls these.
drop function if exists public.set_github_token(uuid, text, text, timestamptz, text, bigint, text);
drop function if exists public.get_github_token(uuid);
drop function if exists public.set_project_secret(uuid, text, text, uuid);
drop function if exists public.get_project_secrets_json(uuid);
drop function if exists public.get_project_secret_tails(uuid);
drop function if exists public.delete_project_secret(uuid, text);
drop function if exists public.set_platform_secret(uuid, text, text, uuid);
drop function if exists public.get_platform_secret_tails(uuid);
drop function if exists public.get_resolved_platform_secrets(uuid);
drop function if exists public.delete_platform_secret(uuid, text);
drop function if exists public.ace_vault_key();

commit;
