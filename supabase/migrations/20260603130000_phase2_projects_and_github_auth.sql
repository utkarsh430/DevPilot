-- =============================================================================
-- Migration : 20260603130000_phase2_projects_and_github_auth.sql
-- Phase 2 / M5a — Per-project repos + GitHub OAuth auth.
--
-- Purpose
-- ────────
-- Today the engineer runner commits to `~/.ace/workspaces/<ticketId>/` and the
-- remote is hardcoded to a single global `ENGINEER_REPO_URL` env var, so every
-- tenant's tickets land in the same scratch repo (or, more often, nowhere at
-- all because nothing ever `git push`-es). This migration moves the orchestrator
-- from "global env-var repo" to a proper per-project model:
--
--   1. `public.projects` — tenant-scoped projects, each with its own GitHub
--      repo URL + owner/repo/branch metadata. M5a stores `repo_url` for
--      connect-existing flows; M5b's create-new-repo flow populates the
--      GitHub-side fields.
--   2. `public.github_oauth_tokens` — per-user durable storage of the GitHub
--      access token captured at the Supabase Auth OAuth callback. Supabase
--      Auth itself does not persist `provider_token` past the session, so we
--      mirror it here for background-agent use. M5a stores plaintext (RLS-
--      protected, service_role-only write); M5d wraps it in pgcrypto.
--   3. `tickets.project_id` — nullable FK so existing 100+ tickets keep
--      working. Null falls through to the per-tenant "Default" project, which
--      itself inherits `ENGINEER_REPO_URL` until the operator wires a real
--      repo.
--   4. Backfill a "Default" project for every existing tenant so the
--      project-switcher UI has something to show on first load and so
--      `loadProjectForTicket(...)` always resolves to a row.
--
-- RLS
-- ───
-- `projects` follows the standard tenant-member pattern.
-- `github_oauth_tokens` is per-user: SELECT only by the owning user; writes
-- only via service_role (no policy → denied for normal users).
--
-- Idempotency
-- ───────────
-- Forward-only and re-runnable: `create table if not exists`,
-- `add column if not exists`, `create index if not exists`, and
-- `drop policy if exists` then `create policy` for policy churn.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. projects
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  description     text,
  -- "https://github.com/<owner>/<repo>.git"; null until M5b's create-repo
  -- flow seeds it (or until the operator connects an existing repo).
  repo_url        text,
  -- GitHub's numeric repo id; null on connect-by-URL.
  github_repo_id  bigint,
  github_owner    text,
  github_repo     text,
  default_branch  text default 'main',
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists projects_tenant_idx on public.projects(tenant_id);

alter table public.projects enable row level security;

drop policy if exists projects_member_read on public.projects;
create policy projects_member_read on public.projects
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists projects_member_write on public.projects;
create policy projects_member_write on public.projects
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- Wire into Supabase Realtime so the topbar project-switcher and the
-- /projects list update live when a project is created elsewhere.
do $$
begin
  begin
    alter publication supabase_realtime add table public.projects;
  exception
    when duplicate_object then null;
  end;
end$$;

-- ---------------------------------------------------------------------------
-- 2. github_oauth_tokens
-- ---------------------------------------------------------------------------
-- Per-user GitHub OAuth tokens. M5a stores plaintext (RLS-protected,
-- service_role-only writes); M5d's migration adds a pgcrypto bytea column
-- and security-definer set_/get_ functions. Once all rows are migrated to
-- the encrypted column, a later migration drops the plaintext column.

create table if not exists public.github_oauth_tokens (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  access_token   text not null,
  refresh_token  text,
  expires_at     timestamptz,
  scopes         text,
  github_id      bigint not null,
  github_login   text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.github_oauth_tokens enable row level security;

-- Only the owning user can read their own row (e.g., the "Connected as
-- @login" status pill in /settings/github-integration). All INSERT/UPDATE
-- happens via the server action with a service-role client.
drop policy if exists github_token_self_read on public.github_oauth_tokens;
create policy github_token_self_read on public.github_oauth_tokens
  for select using (user_id = auth.uid());

-- updated_at trigger using the existing helper from core.sql.
drop trigger if exists github_oauth_tokens_updated_at on public.github_oauth_tokens;
create trigger github_oauth_tokens_updated_at
  before update on public.github_oauth_tokens
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. tickets.project_id
-- ---------------------------------------------------------------------------
-- Nullable FK so the 100+ existing tickets keep working without backfill.
-- The orchestrator treats `project_id IS NULL` as "use the tenant's Default
-- project" which itself falls back to ENGINEER_REPO_URL.

alter table public.tickets
  add column if not exists project_id uuid references public.projects(id) on delete set null;

create index if not exists tickets_project_idx on public.tickets(project_id);

-- ---------------------------------------------------------------------------
-- 4. Default project per tenant (backwards-compat backfill)
-- ---------------------------------------------------------------------------
-- Auto-create a "Default" project for every existing tenant so the
-- project-switcher always has something to show and `loadProjectForTicket(...)`
-- always resolves to a row. Idempotent via the `where not exists` guard.

do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    insert into public.projects (tenant_id, name, description, repo_url, default_branch)
    select t.id,
           'Default',
           'Backwards-compat fallback project using ENGINEER_REPO_URL',
           null,
           'main'
    where not exists (
      select 1 from public.projects p
      where p.tenant_id = t.id and p.name = 'Default'
    );
  end loop;
end$$;

commit;
