-- Migration: 20260718000000_project_stack_tags.sql
--
-- Phase 2.5++ / WI-15 — durable project stack tags.
--
-- The operator's committed stack ("this project runs on Postgres, Redis and
-- S3") was, until now, only expressible as the soft `planning_sessions.
-- stack_flavor` prose knob — a 3-position hint the panel agents were free to
-- reinterpret every run. This table is the HARD, durable model: one row per
-- (project, service), each row pinned to an entry in the static service
-- catalog (`apps/web/lib/stack/service-catalog.ts`).
--
-- Two ways a row gets here, recorded in `source`:
--   • 'detected' — import-time fingerprinting of the connected repo's
--     manifests (package.json / lockfiles / Dockerfile / terraform). The
--     detector may only emit keys that exist in the static catalog, and the
--     operator confirms every detected tag in the create form before it is
--     saved. Repo content NEVER reaches this table verbatim.
--   • 'manual'   — the operator ticked the box themselves.
--
-- `label` is denormalized from the catalog at write time so the row is
-- self-describing for SQL consumers; the application always renders from the
-- catalog, never from this column (defence-in-depth against a bad write ever
-- reaching a prompt).
--
-- Tenant-scoping is load-bearing, not decorative: the create/import server
-- actions write through the SERVICE ROLE, which bypasses RLS entirely. The
-- `tenant_id` column (denormalized from the project, as `planning_messages`
-- does) is what every member-facing read is keyed off, and the actions set it
-- from the verified caller's tenant — never from the submitted form.

begin;

create table if not exists public.project_stack_tags (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  -- Mirrors `StackProvider` in apps/web/lib/plan/types.ts. A closed set: the
  -- catalog cannot grow a provider without a migration, which is the point —
  -- an unknown provider is how an injected fingerprint would slip through.
  provider    text not null check (provider in ('aws', 'azure', 'gcp', 'oss')),
  -- Stable key into the static catalog (e.g. 'aws_s3', 'postgres').
  service_key text not null,
  -- Human label, denormalized from the catalog at write time.
  label       text not null,
  source      text not null default 'manual' check (source in ('detected', 'manual')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One row per service per project. The create action re-writes the whole
  -- set on save, so this also makes a replayed submit idempotent.
  unique (project_id, service_key)
);

create index if not exists project_stack_tags_tenant_idx
  on public.project_stack_tags(tenant_id);
create index if not exists project_stack_tags_project_idx
  on public.project_stack_tags(project_id);

alter table public.project_stack_tags enable row level security;

-- Policies are the `planning_sessions` pair verbatim (20260603200000), keyed
-- off `current_user_tenants()`.
drop policy if exists project_stack_tags_member_read on public.project_stack_tags;
create policy project_stack_tags_member_read on public.project_stack_tags
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists project_stack_tags_member_write on public.project_stack_tags;
create policy project_stack_tags_member_write on public.project_stack_tags
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

drop trigger if exists project_stack_tags_updated_at on public.project_stack_tags;
create trigger project_stack_tags_updated_at
  before update on public.project_stack_tags
  for each row execute function public.touch_updated_at();

commit;
