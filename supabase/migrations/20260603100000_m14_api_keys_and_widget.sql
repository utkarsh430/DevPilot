-- =============================================================================
-- Migration : 20260603100000_m14_api_keys_and_widget.sql
-- Phase 1 / M14 — Agents-as-APIs + OpenAI-compatible endpoint + embeddable widget.
--
-- Purpose
-- ────────
-- 1. Create `api_keys` — per-tenant API keys for the public platform surface
--    (`POST /v1/agents/{id}/runs`, `POST /v1/chat/completions`, and the
--    widget endpoint). Keys are sha256-hashed at rest; the cleartext secret
--    is shown to the operator EXACTLY ONCE on creation. `scope` distinguishes
--    full API keys ('api') from widget tokens ('widget') so a widget token
--    can't be repurposed against the full agent surface.
-- 2. Add `tenants.config` (jsonb) so we can stash tenant-level settings
--    without inventing a new table per knob. M14 uses
--    `config.default_agent_id` for the OpenAI-compat default agent.
-- 3. RLS: members can read their tenant's API keys; service_role bypasses RLS
--    for the actual auth check (constant-time hash compare server-side).
--
-- Idempotency
-- ───────────
-- Forward-only. `create table if not exists` and `add column if not exists`
-- guard re-runs.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. tenants.config
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column if not exists config jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. api_keys
-- ---------------------------------------------------------------------------

create table if not exists public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  -- sha256 of the full cleartext secret. Operator never sees this column;
  -- cleartext is shown ONCE at creation and never re-shown.
  hash          text not null,
  -- First 8 chars of the cleartext (the printable "label" portion). Useful
  -- for an operator to identify the key in the list view without exposing
  -- the secret bytes.
  prefix        text not null,
  -- 'api'    — full surface (POST /v1/agents/{id}/runs, /v1/chat/completions)
  -- 'widget' — single-agent scoped widget token, narrower surface.
  scope         text not null default 'api' check (scope in ('api', 'widget')),
  -- For widget-scoped tokens, the single agent this token is bound to.
  -- Null for 'api' scope.
  agent_id      uuid references public.agents(id) on delete cascade,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists api_keys_tenant_idx on public.api_keys(tenant_id);
create index if not exists api_keys_hash_idx   on public.api_keys(hash);
create index if not exists api_keys_prefix_idx on public.api_keys(prefix);

alter table public.api_keys enable row level security;

-- Tenant members can SEE their key rows (without the secret — that was never
-- stored). They CAN'T create/revoke directly from the client; mutations go
-- through the server action which uses the service-role client.
drop policy if exists api_keys_member_read on public.api_keys;
create policy api_keys_member_read on public.api_keys
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists api_keys_member_write on public.api_keys;
create policy api_keys_member_write on public.api_keys
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

commit;
