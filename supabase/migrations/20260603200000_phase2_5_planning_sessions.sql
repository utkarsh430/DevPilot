-- Migration: 20260603200000_phase2_5_planning_sessions.sql
--
-- Phase 2.5+ / M7 — Plan-tickets surface ("ultra plan" mode). The board's
-- pre-ticket planning surface: operators discuss a project goal in prose,
-- a multi-agent panel (PM + Tech Lead + DevOps + Consolidator) deliberates,
-- and the result is a curated list of proposed tickets the operator can
-- review, edit, and bulk-commit to the board.
--
-- Three tables:
--   1. planning_sessions       — one row per plan-mode discussion.
--   2. planning_messages       — chat transcript (realtime-published).
--   3. planning_proposed_tickets — the panel's output, reviewed pre-commit.
--
-- All tenant-scoped; RLS keyed off `current_user_tenants()`. Cascade
-- delete from tenants + projects. `planning_messages` is added to
-- supabase_realtime so the PlanSheet can subscribe with the same hook
-- shape as useLiveComments.

begin;

-- ---------------------------------------------------------------------------
-- 1. planning_sessions
-- ---------------------------------------------------------------------------

create table if not exists public.planning_sessions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  project_id         uuid not null references public.projects(id) on delete cascade,
  created_by         uuid references auth.users(id) on delete set null,
  -- One-line headline of what's being planned. Updated by the lead agent
  -- as the discussion advances (M5h-style cheap Haiku call once per N turns).
  goal_summary       text,
  status             text not null default 'discussing'
    check (status in ('discussing','planning','planned','committed','discarded')),
  stack_flavor       text not null default 'mixed'
    check (stack_flavor in ('industry','mixed','oss')),
  -- Free-form refinement on top of stack_flavor ("Postgres OK, no AWS").
  stack_preferences  text default '',
  -- Cumulative LLM spend on this session in cents. Stripe meter aggregator
  -- (M15) reads this column and bills via the same nightly path as runs.
  spent_cents        int not null default 0,
  billed_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists planning_sessions_tenant_idx
  on public.planning_sessions(tenant_id);
create index if not exists planning_sessions_project_idx
  on public.planning_sessions(project_id);
create index if not exists planning_sessions_status_idx
  on public.planning_sessions(tenant_id, status)
  where status not in ('discarded','committed');

alter table public.planning_sessions enable row level security;

drop policy if exists planning_sessions_member_read on public.planning_sessions;
create policy planning_sessions_member_read on public.planning_sessions
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists planning_sessions_member_write on public.planning_sessions;
create policy planning_sessions_member_write on public.planning_sessions
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

drop trigger if exists planning_sessions_updated_at on public.planning_sessions;
create trigger planning_sessions_updated_at
  before update on public.planning_sessions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. planning_messages
-- ---------------------------------------------------------------------------

create table if not exists public.planning_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.planning_sessions(id) on delete cascade,
  tenant_id   uuid not null,
  role        text not null check (role in ('user','assistant','system')),
  content     text not null,
  -- Which panel agent emitted this assistant/system message:
  --   lead | pm | tech_lead | devops | consolidator
  -- null on user messages.
  agent_role  text,
  -- Token usage, latency, model id — same shape as run_steps.payload.
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists planning_messages_session_idx
  on public.planning_messages(session_id, created_at);

alter table public.planning_messages enable row level security;

drop policy if exists planning_messages_member_read on public.planning_messages;
create policy planning_messages_member_read on public.planning_messages
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists planning_messages_member_write on public.planning_messages;
create policy planning_messages_member_write on public.planning_messages
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- Realtime publication so the PlanSheet's chat panel updates live as the
-- lead replies and the panel agents tick through their stages.
do $$
begin
  begin
    alter publication supabase_realtime add table public.planning_messages;
  exception
    when duplicate_object then null;
  end;
end$$;

-- ---------------------------------------------------------------------------
-- 3. planning_proposed_tickets
-- ---------------------------------------------------------------------------

create table if not exists public.planning_proposed_tickets (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid not null references public.planning_sessions(id) on delete cascade,
  tenant_id            uuid not null,
  -- Display + dependency-resolution order. Consolidator decides.
  ordinal              int not null,
  title                text not null,
  description          text,
  acceptance_criteria  text,
  -- Suggested role slug from the role catalog (validated at commit time
  -- against lib/roles/catalog.ts — bad slugs fall through to null = auto-pick).
  requested_role       text,
  -- References other rows in the same session by ordinal. commitPlanAction
  -- resolves these into ticket_dependencies rows using committed_ticket_id.
  depends_on_ordinals  int[] not null default '{}',
  -- User toggle in the review UI. Defaults selected; commit honors this.
  selected             boolean not null default true,
  -- Populated by commitPlanAction; null until commit.
  committed_ticket_id  uuid references public.tickets(id) on delete set null,
  created_at           timestamptz not null default now()
);

create index if not exists planning_proposed_tickets_session_idx
  on public.planning_proposed_tickets(session_id, ordinal);

alter table public.planning_proposed_tickets enable row level security;

drop policy if exists planning_proposed_tickets_member_read on public.planning_proposed_tickets;
create policy planning_proposed_tickets_member_read on public.planning_proposed_tickets
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists planning_proposed_tickets_member_write on public.planning_proposed_tickets;
create policy planning_proposed_tickets_member_write on public.planning_proposed_tickets
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

commit;
