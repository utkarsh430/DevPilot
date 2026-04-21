-- Migration: 20260610000000_schedule_activity.sql
--
-- Per-schedule activity log so the operator can see what the cron did, what
-- the drain skipped, and why — independent of digging through Inngest's
-- function-run inspector. Surfaces in the ScheduleDialog's Activity panel.
--
-- Kinds (text, CHECK-constrained):
--   fired             — the cron emitted ticket-drain/requested for this row.
--   skipped           — the cron would have fired but didn't (reason field
--                       carries 'paused-tenant' | 'paused-project' | 'past-window').
--   ticket-advanced   — drain finished/passed one backlog ticket. reason ∈
--                       {'done','failed','stuck','timeout','skipped'}.
--   completed         — drain finished its full batch. metadata.drained / metadata.summary[].
--   error             — anything else worth surfacing (RLS issue, DB error, etc.).
--
-- This is a write-mostly, append-only log. We add a per-schedule index for
-- the ScheduleDialog's "recent activity" query and a tenant-wide index for a
-- future cross-project activity feed.

begin;

create table if not exists public.schedule_activity (
  id           bigserial primary key,
  tenant_id    uuid        not null,
  schedule_id  uuid        not null references public.ticket_schedules(id) on delete cascade,
  project_id   uuid,
  -- Opaque drain identifier minted by drainBacklogFn (NOT an Inngest run id).
  drain_run_id text,
  kind         text        not null check (kind in ('fired','skipped','ticket-advanced','completed','error')),
  reason       text,
  ticket_id    uuid        references public.tickets(id) on delete set null,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists schedule_activity_schedule_idx
  on public.schedule_activity (schedule_id, created_at desc);
create index if not exists schedule_activity_tenant_idx
  on public.schedule_activity (tenant_id, created_at desc);

-- RLS — mirrors ticket_schedules.
alter table public.schedule_activity enable row level security;

drop policy if exists schedule_activity_member_read on public.schedule_activity;
create policy schedule_activity_member_read on public.schedule_activity
  for select using (tenant_id in (select public.current_user_tenants()));

-- Writes happen from server fns (service-role); we still allow tenant
-- members to insert in case a future UI surface (manual annotation) wants
-- to write directly under RLS.
drop policy if exists schedule_activity_member_write on public.schedule_activity;
create policy schedule_activity_member_write on public.schedule_activity
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- Realtime publication so the UI can live-tail activity if/when we wire it.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.schedule_activity;
  end if;
exception when duplicate_object then
  null;
end;
$$;

comment on table public.schedule_activity is
  'Append-only log of scheduler decisions (fired/skipped/ticket-advanced/completed/error). Surfaces in ScheduleDialog Activity panel.';

commit;
