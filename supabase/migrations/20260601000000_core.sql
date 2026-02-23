-- ACE Phase 0 core schema.
-- One migration to keep first-touch simple. Future schema changes ship as new migration files.

-- Extensions ------------------------------------------------------------------

create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "vector"   with schema extensions;

-- Tenants & membership --------------------------------------------------------
-- Multi-tenancy primitive. Every domain row carries tenant_id; RLS pivots on
-- the calling user's membership.

create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id)     on delete cascade,
  role        text not null default 'member',  -- 'owner' | 'admin' | 'member'
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_members_user_idx on public.tenant_members(user_id);

-- Helper: SQL function returning the set of tenants the current user belongs to.
-- SECURITY DEFINER lets RLS policies call it without recursing through their own checks.
create or replace function public.current_user_tenants()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.tenant_members where user_id = auth.uid();
$$;

revoke all on function public.current_user_tenants() from public;
grant execute on function public.current_user_tenants() to authenticated, service_role;

-- Agents ----------------------------------------------------------------------

create table public.agents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,
  role         text,                              -- pm | engineer | qa | security | ...
  version      int  not null default 1,
  config       jsonb not null default '{}'::jsonb,-- prompt, model, tools[], skills[], kb_ids[], runner_policy
  created_at   timestamptz not null default now()
);

create index agents_tenant_idx on public.agents(tenant_id);

-- Tickets ---------------------------------------------------------------------
-- Substrate of the orchestration. Status mirrors TDD §5.1 exactly.

create type public.ticket_status as enum (
  'backlog',
  'ready',
  'assigned',
  'in_progress',
  'input_required',
  'blocked',
  'in_review',
  'done',
  'failed'
);

create table public.tickets (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  title               text not null,
  description         text,
  acceptance_criteria text,
  status              public.ticket_status not null default 'backlog',
  priority            int default 3,
  retry_count         int not null default 0,
  column_position     int not null default 0,
  assignee_agent_id   uuid references public.agents(id) on delete set null,
  parent_ticket_id    uuid references public.tickets(id) on delete cascade,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index tickets_tenant_status_idx on public.tickets(tenant_id, status);
create index tickets_tenant_created_idx on public.tickets(tenant_id, created_at desc);

-- Backward-flow + retry guard: state machine enforced in app code,
-- but we trip a hard CHECK on the retry ceiling so the DB also says "no".
alter table public.tickets
  add constraint tickets_retry_count_ceiling check (retry_count <= 10);

-- updated_at trigger
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tickets_updated_at
  before update on public.tickets
  for each row execute function public.touch_updated_at();

-- Ticket dependencies ---------------------------------------------------------

create table public.ticket_dependencies (
  ticket_id         uuid not null references public.tickets(id) on delete cascade,
  blocks_ticket_id  uuid not null references public.tickets(id) on delete cascade,
  primary key (ticket_id, blocks_ticket_id),
  constraint ticket_dependencies_no_self check (ticket_id <> blocks_ticket_id)
);

-- Comments --------------------------------------------------------------------
-- Shared thread between agents and humans. `human-reply` events fire from
-- inserts here when the ticket is in input_required.

create table public.comments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  ticket_id    uuid not null references public.tickets(id) on delete cascade,
  author_type  text not null check (author_type in ('agent','human','system')),
  author_id    text not null,
  body         text not null,
  created_at   timestamptz not null default now()
);

create index comments_ticket_idx on public.comments(ticket_id, created_at);

-- Runners ---------------------------------------------------------------------
-- Registry of Local Claude Code Runner workers (F-RUN-04). API runners are
-- stateless and not represented as rows.

create table public.runners (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  kind                text not null check (kind in ('api','local-cc')),
  name                text not null,
  capabilities        jsonb not null default '[]'::jsonb,
  status              text not null default 'idle',  -- idle | busy | offline
  last_heartbeat_at   timestamptz,
  created_at          timestamptz not null default now()
);

create index runners_tenant_idx on public.runners(tenant_id);

-- Runs ------------------------------------------------------------------------
-- One agent's lifetime on a ticket. Linked to its parent run for future
-- supervisor trees (Phase 1) but the column is harmless at Phase 0.

create table public.runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  agent_id        uuid references public.agents(id)   on delete set null,
  ticket_id       uuid references public.tickets(id)  on delete set null,
  parent_run_id   uuid references public.runs(id)     on delete set null,
  runner_id       uuid references public.runners(id)  on delete set null,
  runner_kind     text check (runner_kind in ('api','local-cc')),
  depth           int  not null default 0,
  status          text not null default 'running',   -- running | awaiting_human | done | failed
  budget_cents    int  not null,
  spent_cents     int  not null default 0,
  last_event_at   timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index runs_tenant_status_idx on public.runs(tenant_id, status);
create index runs_ticket_idx        on public.runs(ticket_id);

-- Run steps -------------------------------------------------------------------
-- Durable checkpoint log + source for the trace tree.

create table public.run_steps (
  id          bigserial primary key,
  run_id      uuid not null references public.runs(id) on delete cascade,
  idx         int  not null,
  kind        text not null check (kind in ('think','tool_call','tool_result','human_wait','system')),
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  unique (run_id, idx)
);

-- Skills ----------------------------------------------------------------------

create table public.skills (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade, -- null = public/marketplace
  name        text not null,
  version     text not null,
  manifest    jsonb not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name, version)
);

-- Data sources + KB chunks ----------------------------------------------------

create table public.data_sources (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind        text not null check (kind in ('kb','vector','sql')),
  name        text not null,
  config      jsonb not null,  -- secret refs, not raw secrets
  read_only   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kb_id       uuid not null references public.data_sources(id) on delete cascade,
  content     text,
  embedding   extensions.vector(1536),
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index kb_chunks_tenant_idx on public.kb_chunks(tenant_id);
create index kb_chunks_embedding_hnsw on public.kb_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- Row Level Security ----------------------------------------------------------
-- Every tenant-scoped table: read/write only when the caller is a member of
-- the row's tenant. service_role bypasses RLS by default in Supabase.

alter table public.tenants            enable row level security;
alter table public.tenant_members     enable row level security;
alter table public.agents             enable row level security;
alter table public.tickets            enable row level security;
alter table public.ticket_dependencies enable row level security;
alter table public.comments           enable row level security;
alter table public.runners            enable row level security;
alter table public.runs               enable row level security;
alter table public.run_steps          enable row level security;
alter table public.skills             enable row level security;
alter table public.data_sources       enable row level security;
alter table public.kb_chunks          enable row level security;

-- Generic helper macro pattern: select/insert/update/delete restricted to members.
-- (Postgres has no macro; we just emit the four policies per table.)

-- tenants
create policy tenants_member_read on public.tenants
  for select using (id in (select public.current_user_tenants()));
-- tenants are created server-side via service_role; no insert/update/delete policies for authenticated.

-- tenant_members
create policy tenant_members_self_read on public.tenant_members
  for select using (user_id = auth.uid() or tenant_id in (select public.current_user_tenants()));

-- agents
create policy agents_member_read on public.agents
  for select using (tenant_id in (select public.current_user_tenants()));
create policy agents_member_write on public.agents
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- tickets
create policy tickets_member_read on public.tickets
  for select using (tenant_id in (select public.current_user_tenants()));
create policy tickets_member_write on public.tickets
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- ticket_dependencies — gate via parent ticket's tenant
create policy ticket_dependencies_member_read on public.ticket_dependencies
  for select using (
    ticket_id in (select id from public.tickets where tenant_id in (select public.current_user_tenants()))
  );
create policy ticket_dependencies_member_write on public.ticket_dependencies
  for all using (
    ticket_id in (select id from public.tickets where tenant_id in (select public.current_user_tenants()))
  ) with check (
    ticket_id in (select id from public.tickets where tenant_id in (select public.current_user_tenants()))
  );

-- comments
create policy comments_member_read on public.comments
  for select using (tenant_id in (select public.current_user_tenants()));
create policy comments_member_write on public.comments
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- runners
create policy runners_member_read on public.runners
  for select using (tenant_id in (select public.current_user_tenants()));
create policy runners_member_write on public.runners
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- runs
create policy runs_member_read on public.runs
  for select using (tenant_id in (select public.current_user_tenants()));
create policy runs_member_write on public.runs
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- run_steps — gate via parent run's tenant
create policy run_steps_member_read on public.run_steps
  for select using (
    run_id in (select id from public.runs where tenant_id in (select public.current_user_tenants()))
  );
create policy run_steps_member_write on public.run_steps
  for all using (
    run_id in (select id from public.runs where tenant_id in (select public.current_user_tenants()))
  ) with check (
    run_id in (select id from public.runs where tenant_id in (select public.current_user_tenants()))
  );

-- skills — public skills (tenant_id null) readable by all authenticated users
create policy skills_read on public.skills
  for select using (
    tenant_id is null or tenant_id in (select public.current_user_tenants())
  );
create policy skills_member_write on public.skills
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- data_sources
create policy data_sources_member_read on public.data_sources
  for select using (tenant_id in (select public.current_user_tenants()));
create policy data_sources_member_write on public.data_sources
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- kb_chunks
create policy kb_chunks_member_read on public.kb_chunks
  for select using (tenant_id in (select public.current_user_tenants()));
create policy kb_chunks_member_write on public.kb_chunks
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- New-user bootstrap ----------------------------------------------------------
-- When a user signs up via Supabase Auth, auto-provision a personal tenant and
-- add them as owner. Phase 0 is single-tenant-per-user; multi-org UI is later.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_tenant_id uuid;
begin
  insert into public.tenants (name)
  values (coalesce(new.raw_user_meta_data->>'name', new.email, 'Personal'))
  returning id into new_tenant_id;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (new_tenant_id, new.id, 'owner');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
