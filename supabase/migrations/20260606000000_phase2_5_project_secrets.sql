-- =============================================================================
-- Migration : 20260606000000_phase2_5_project_secrets.sql
-- Phase 2.5++ / Slice A — Per-project encrypted secrets vault.
--
-- Purpose
-- ────────
-- Modern projects need env values (DATABASE_URL, STRIPE_API_KEY, …) to
-- build / boot / test. These cannot live in the repo (gitignored) and the
-- per-ticket workspace is wiped between runs by `git clean -fdx`. The
-- operator currently has no place to provide them.
--
-- This migration ships a per-project key/value vault that mirrors the
-- proven `github_oauth_tokens` pattern from 20260603160000:
--
--   • `project_secrets` table with `value_plain` (transition fallback) +
--     `value_encrypted bytea` (pgp_sym_encrypted via app.token_vault_key).
--   • `set_project_secret`, `delete_project_secret`,
--     `get_project_secrets_json` security-definer functions — service_role
--     only — so the plaintext path never crosses the RLS layer.
--   • `project_secret_names` view — tenant members can list the KEY names
--     of secrets they own without ever seeing values.
--
-- Engine integration: `run-agent.ts` calls `get_project_secrets_json` at
-- dispatch time and threads the result into the runner job payload. The
-- runner writes `<workspace>/.env.local` AND injects the same JSON as
-- envOverrides for both `claude -p` and `pnpm dev`.
--
-- Idempotent: re-runnable.
-- =============================================================================
begin;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. project_secrets table
-- ---------------------------------------------------------------------------

create table if not exists public.project_secrets (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  secret_key      text not null,
  -- Transition-fallback plaintext column. Always written by
  -- set_project_secret(); a later migration drops it once the operator
  -- confirms app.token_vault_key is set everywhere and all rows have an
  -- encrypted bytea companion.
  value_plain     text,
  -- pgp_sym_encrypted with app.token_vault_key. Null when the vault key
  -- is unset (dev box without encryption-at-rest configured).
  value_encrypted bytea,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  unique (project_id, secret_key),
  -- Conventional .env naming: uppercase + underscores + digits.
  constraint project_secrets_key_format check (secret_key ~ '^[A-Z][A-Z0-9_]{0,127}$')
);

create index if not exists project_secrets_tenant_idx
  on public.project_secrets(tenant_id);
create index if not exists project_secrets_project_idx
  on public.project_secrets(project_id);

alter table public.project_secrets enable row level security;

-- DELIBERATELY NO member-read policy on the table itself — values are
-- service-role-only readable, and members read names via the view below.
-- This is the same posture the codebase uses for github_oauth_tokens.

-- ---------------------------------------------------------------------------
-- 2. project_secret_names view — member-readable, values masked out
-- ---------------------------------------------------------------------------
-- The view filters to only the non-secret columns (id, project_id,
-- secret_key, timestamps). Member read of this view inherits the
-- projects.tenant_id RLS check via the join.

create or replace view public.project_secret_names
with (security_invoker = true)
as
select
  ps.id,
  ps.project_id,
  ps.tenant_id,
  ps.secret_key,
  ps.created_at,
  ps.updated_at,
  ps.created_by
from public.project_secrets ps
where ps.tenant_id in (select public.current_user_tenants());

-- Realtime: members watching the Secrets tab should see cross-tab
-- adds / edits / deletes without polling.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    -- Realtime watches the underlying table, not the view; subscribers
    -- can filter client-side by project_id.
    alter publication supabase_realtime add table public.project_secrets;
  end if;
exception when duplicate_object then
  -- Already in the publication; harmless.
  null;
end$$;

-- ---------------------------------------------------------------------------
-- 3. set_project_secret (security definer; service_role only)
-- ---------------------------------------------------------------------------
-- Single chokepoint for writes. Resolves tenant_id from projects so the
-- caller doesn't need to know it. Always writes plaintext (transition
-- fallback); writes encrypted bytea iff app.token_vault_key is set.

create or replace function public.set_project_secret(
  p_project_id uuid,
  p_secret_key text,
  p_value      text,
  p_user_id    uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_vault_key text := current_setting('app.token_vault_key', true);
  v_tenant_id uuid;
  v_encrypted bytea;
begin
  select tenant_id into v_tenant_id from public.projects where id = p_project_id;
  if v_tenant_id is null then
    raise exception 'set_project_secret: project % not found', p_project_id;
  end if;

  if v_vault_key is not null and length(v_vault_key) > 0 then
    v_encrypted := extensions.pgp_sym_encrypt(p_value, v_vault_key);
  else
    v_encrypted := null;
  end if;

  insert into public.project_secrets (
    project_id, tenant_id, secret_key, value_plain, value_encrypted, created_by
  )
  values (
    p_project_id, v_tenant_id, p_secret_key, p_value, v_encrypted, p_user_id
  )
  on conflict (project_id, secret_key) do update set
    value_plain     = excluded.value_plain,
    value_encrypted = excluded.value_encrypted,
    updated_at      = now();
end;
$$;

revoke all on function public.set_project_secret(uuid, text, text, uuid) from public;
grant execute on function public.set_project_secret(uuid, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. delete_project_secret (security definer; service_role only)
-- ---------------------------------------------------------------------------

create or replace function public.delete_project_secret(
  p_project_id uuid,
  p_secret_key text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.project_secrets
   where project_id = p_project_id
     and secret_key = p_secret_key;
end;
$$;

revoke all on function public.delete_project_secret(uuid, text) from public;
grant execute on function public.delete_project_secret(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. get_project_secrets_json (security definer; service_role only)
-- ---------------------------------------------------------------------------
-- Returns all secrets for a project as a single jsonb object
-- ({"KEY": "value", …}). Prefers the encrypted bytea column when the
-- vault key is set; falls back to plaintext during the transition window.
-- Returns '{}' when the project has no secrets.

create or replace function public.get_project_secrets_json(
  p_project_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_vault_key text := current_setting('app.token_vault_key', true);
  v_result jsonb := '{}'::jsonb;
  r record;
  v_value text;
begin
  for r in
    select secret_key, value_plain, value_encrypted
      from public.project_secrets
     where project_id = p_project_id
  loop
    if r.value_encrypted is not null
       and v_vault_key is not null
       and length(v_vault_key) > 0
    then
      v_value := extensions.pgp_sym_decrypt(r.value_encrypted, v_vault_key)::text;
    else
      v_value := r.value_plain;
    end if;
    if v_value is not null then
      v_result := v_result || jsonb_build_object(r.secret_key, v_value);
    end if;
  end loop;
  return v_result;
end;
$$;

revoke all on function public.get_project_secrets_json(uuid) from public;
grant execute on function public.get_project_secrets_json(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. updated_at trigger so timestamps stay honest
-- ---------------------------------------------------------------------------

create or replace function public.tg_project_secrets_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_secrets_touch_updated_at on public.project_secrets;
create trigger project_secrets_touch_updated_at
before update on public.project_secrets
for each row execute function public.tg_project_secrets_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 7. comments.metadata (jsonb)
-- ---------------------------------------------------------------------------
-- The new `ace_request_secret` MCP tool writes a structured payload onto
-- the agent's comment so the UI can render a masked-input form
-- (<SecretRequestCard>) instead of plain markdown. We use the same
-- jsonb shape pattern as planning_messages.metadata — small, additive,
-- and reusable by any future tool that needs structured payloads
-- (e.g. ace_request_secret today, ace_attach_file tomorrow).
--
-- Existing rows get a NULL metadata (RLS / readers must tolerate it).
alter table public.comments
  add column if not exists metadata jsonb;

commit;
