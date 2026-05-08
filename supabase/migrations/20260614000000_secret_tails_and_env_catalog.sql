-- =============================================================================
-- Migration : 20260614000000_secret_tails_and_env_catalog.sql
-- Phase 2.5++ — Secrets manager: masked tails + per-project env catalog.
--
-- Two additive pieces backing the redesigned project Secrets card (the
-- "bring-your-own-keys" surface):
--
--   1. get_project_secret_tails(project_id) — security-definer, service_role
--      only. Returns {"KEY": "tail"} where `tail` is the LAST ≤4 chars of each
--      secret's value, so the UI can render "Configured ••••nwAA" WITHOUT ever
--      shipping the full value across the RLS boundary. Mirrors the decrypt
--      logic in get_project_secrets_json (prefer encrypted bytea, fall back to
--      plaintext during the transition window).
--
--   2. projects.env_catalog (jsonb) + env_catalog_at (timestamptz) — the set of
--      env keys a project DECLARES via its .env.example, each classified
--      required/optional with a short description pulled from the comment above
--      the key. The runner parses this during a localhost start and reports it
--      (POST /api/runners/dev-servers/:id/env-catalog); the Secrets card then
--      renders every declared key — configured or not — with the right label.
--
-- Idempotent: re-runnable.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. get_project_secret_tails — masked last-4 per key (service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.get_project_secret_tails(
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
    if v_value is not null and length(v_value) > 0 then
      -- right() clamps to the string length, so short values just yield
      -- themselves — the UI masks the rest with dots regardless.
      v_result := v_result || jsonb_build_object(r.secret_key, right(v_value, 4));
    end if;
  end loop;
  return v_result;
end;
$$;

revoke all on function public.get_project_secret_tails(uuid) from public;
grant execute on function public.get_project_secret_tails(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. projects.env_catalog — declared env keys (required/optional + descr)
-- ---------------------------------------------------------------------------
-- Shape: [{"key":"DATABASE_URL","required":true,"description":"Postgres URL"}]
-- Nullable until the runner parses .env.example for the first time.
alter table public.projects
  add column if not exists env_catalog jsonb;
alter table public.projects
  add column if not exists env_catalog_at timestamptz;

commit;
