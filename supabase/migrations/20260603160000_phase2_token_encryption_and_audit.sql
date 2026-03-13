-- =============================================================================
-- Migration : 20260603160000_phase2_token_encryption_and_audit.sql
-- Phase 2 / M5d — Token encryption (pgcrypto) + tenant-scoped audit log.
--
-- Purpose
-- ────────
-- Two things ship together in this milestone because they are the security
-- polish for the rest of M5:
--
--   1. **Token encryption** — M5a's `github_oauth_tokens.access_token` is
--      plaintext, RLS-protected, service_role-only-writable. That's fine
--      for a single-operator dev box but inappropriate for a production
--      multi-tenant deployment, where a DB snapshot read leaks every
--      user's GitHub PAT-equivalent. We add a `bytea` column written via
--      pgcrypto's `pgp_sym_encrypt(token, current_setting('app.token_vault_key'))`
--      and two security-definer helpers (`set_github_token`,
--      `get_github_token`) so the application layer never touches the
--      plaintext column path. The old `access_token text` column STAYS in
--      place during this transition window — `set_github_token` writes
--      to BOTH columns (encrypted if the vault key is set, plaintext
--      always) so existing readers don't break. A later migration, after
--      the operator confirms all rows are encrypted, drops the plaintext
--      column.
--
--      Vault key: `app.token_vault_key` is a Postgres custom setting that
--      the operator sets via `alter system set` (or per-session for local
--      dev). If the setting is unset, encryption is skipped and the
--      plaintext column is the system of record — the operator is
--      expected to set the key and re-run a backfill before flipping
--      the application to the encrypted-read path.
--
--   2. **Audit log** — `ace_audit_log` records security-relevant actions
--      (`project.created`, `pending_push.pushed`, `github_token.set`, …)
--      so we can investigate "who pushed what when" after the fact.
--      Tenant-scoped; standard member-read RLS.
--
-- Idempotent: re-runnable.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 0. pgcrypto extension (idempotent; already created in core.sql but we
--    re-assert in case this migration runs first against a downstream env).
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. github_oauth_tokens.access_token_encrypted (bytea)
-- ---------------------------------------------------------------------------
-- New column for the pgp_sym_encrypt-wrapped token. The original
-- `access_token text` column stays as a transition fallback; a later
-- migration drops it once the operator confirms all rows are encrypted.

alter table public.github_oauth_tokens
  add column if not exists access_token_encrypted bytea;

-- ---------------------------------------------------------------------------
-- 2. set_github_token (security definer; service_role only)
-- ---------------------------------------------------------------------------
-- Single chokepoint for writing tokens. Writes to BOTH columns during the
-- transition window:
--   • Plaintext `access_token` is always written (existing readers).
--   • `access_token_encrypted` is written iff `app.token_vault_key` is
--     set; otherwise we leave it null and the operator handles backfill
--     after setting the key.
--
-- The `pgp_sym_encrypt` overload uses the text-form vault key directly so
-- the operator can set it via `alter system set app.token_vault_key = '…'`.

create or replace function public.set_github_token(
  p_user_id      uuid,
  p_token        text,
  p_refresh      text,
  p_expires      timestamptz,
  p_scopes       text,
  p_github_id    bigint,
  p_github_login text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_vault_key text := current_setting('app.token_vault_key', true);
  v_encrypted bytea;
begin
  if v_vault_key is not null and length(v_vault_key) > 0 then
    v_encrypted := extensions.pgp_sym_encrypt(p_token, v_vault_key);
  else
    v_encrypted := null;
  end if;

  insert into public.github_oauth_tokens (
    user_id, access_token, access_token_encrypted,
    refresh_token, expires_at, scopes, github_id, github_login
  )
  values (
    p_user_id, p_token, v_encrypted,
    p_refresh, p_expires, p_scopes, p_github_id, p_github_login
  )
  on conflict (user_id) do update set
    access_token           = excluded.access_token,
    access_token_encrypted = excluded.access_token_encrypted,
    refresh_token          = excluded.refresh_token,
    expires_at             = excluded.expires_at,
    scopes                 = excluded.scopes,
    github_id              = excluded.github_id,
    github_login           = excluded.github_login,
    updated_at             = now();
end;
$$;

revoke all on function public.set_github_token(uuid, text, text, timestamptz, text, bigint, text) from public;
grant execute on function public.set_github_token(uuid, text, text, timestamptz, text, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. get_github_token (security definer; service_role only)
-- ---------------------------------------------------------------------------
-- Single chokepoint for reading tokens. Prefers the encrypted column when
-- the vault key is set and the encrypted bytes are present; otherwise
-- falls back to the plaintext column so transition-window reads don't
-- break. Returns null when there's no row at all.

create or replace function public.get_github_token(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_vault_key text := current_setting('app.token_vault_key', true);
  v_encrypted bytea;
  v_plaintext text;
begin
  select access_token_encrypted, access_token
    into v_encrypted, v_plaintext
    from public.github_oauth_tokens
   where user_id = p_user_id;

  if v_encrypted is not null and v_vault_key is not null and length(v_vault_key) > 0 then
    return extensions.pgp_sym_decrypt(v_encrypted, v_vault_key)::text;
  end if;

  return v_plaintext;
end;
$$;

revoke all on function public.get_github_token(uuid) from public;
grant execute on function public.get_github_token(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Backfill encryption for existing plaintext rows
-- ---------------------------------------------------------------------------
-- If `app.token_vault_key` is set at migration time, populate
-- `access_token_encrypted` for every row that still has a null one. If
-- not, this is a no-op and the operator is expected to set the key and
-- re-run a one-shot backfill before the application flips to the
-- encrypted-read code path.

do $$
declare
  v_vault_key text := current_setting('app.token_vault_key', true);
begin
  if v_vault_key is not null and length(v_vault_key) > 0 then
    update public.github_oauth_tokens
       set access_token_encrypted = extensions.pgp_sym_encrypt(access_token, v_vault_key)
     where access_token_encrypted is null
       and access_token is not null;
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 5. ace_audit_log
-- ---------------------------------------------------------------------------
-- Tenant-scoped audit trail for security-relevant actions. Application
-- code inserts rows via the server actions; downstream we can wire
-- triggers on specific tables (e.g., pending_pushes UPDATE → audit row).

create table if not exists public.ace_audit_log (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  -- Null when the action was system-driven (e.g., a scheduled refresh job).
  actor_user_id   uuid references auth.users(id) on delete set null,
  -- Dotted action name, e.g.: 'project.created', 'project.deleted',
  -- 'pending_push.pushed', 'pending_push.discarded', 'github_token.set',
  -- 'github_token.revoked'.
  action          text not null,
  -- The DB table the action affected (for the inline trace UI).
  target_table    text,
  target_id       uuid,
  -- Free-form payload: { from, to, branch, pr_url, … } — narrow and
  -- non-PII; never the token itself.
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists ace_audit_log_tenant_created_idx
  on public.ace_audit_log(tenant_id, created_at desc);

alter table public.ace_audit_log enable row level security;

drop policy if exists ace_audit_log_member_read on public.ace_audit_log;
create policy ace_audit_log_member_read on public.ace_audit_log
  for select using (tenant_id in (select public.current_user_tenants()));

-- Writes happen via service_role from the server actions; no member-write
-- policy on purpose (members can't forge audit rows from the client).

commit;
