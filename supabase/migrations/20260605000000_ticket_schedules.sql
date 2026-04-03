-- Phase 2.5++ / Scheduler — per-project ticket-drain schedules.
--
-- A "schedule" tells the cron to drain a project's backlog one ticket at a
-- time, at a chosen UTC time of day, on chosen days of the week. The "Run
-- now" affordance does NOT write a row here — it emits the drain event
-- directly. Only durable / recurring intents land in this table.
--
-- Drain semantics live in the engine (lib/engine/ticket-scheduler.ts):
--   • At fire time, the cron emits `ticket-drain/requested` with project_id.
--   • `drainBacklogFn` loads backlog tickets ordered by column_position,
--     moves the first to ready (kicking the dispatcher), polls until it
--     reaches a terminal state (done/failed), then moves on. Continues on
--     failure so one stuck ticket doesn't halt the drain.
--
-- Day-of-week semantics: 0=Sun, 1=Mon, … 6=Sat (matches JS Date.getUTCDay()).
-- Time of day: HH:MM 24h, UTC. The UI converts to/from the operator's local
-- timezone for display.

create table if not exists public.ticket_schedules (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  project_id            uuid not null references public.projects(id) on delete cascade,
  created_by            uuid not null,
  -- mode discriminator
  mode                  text not null check (mode in ('once', 'recurring')),
  -- recurring: which UTC weekdays (0=Sun..6=Sat) + UTC time-of-day "HH:MM"
  days_of_week          int[] not null default '{}',
  time_of_day           text,
  -- once-mode: when to fire (operator-set; cron picks it up at the next tick
  -- where now() >= run_at AND last_fired_at IS NULL)
  run_at                timestamptz,
  -- lifecycle
  status                text not null default 'active'
                          check (status in ('active', 'paused', 'completed', 'cancelled')),
  last_fired_at         timestamptz,
  -- foreign keys to the latest drain run for live "in progress" chips
  current_drain_run_id  uuid,
  -- bookkeeping
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists ticket_schedules_tenant_status_idx
  on public.ticket_schedules (tenant_id, status);
create index if not exists ticket_schedules_project_idx
  on public.ticket_schedules (project_id);

-- Touch updated_at on every UPDATE — matches the trigger pattern used by
-- planning_sessions.
create or replace function public.touch_ticket_schedules_updated_at()
  returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_ticket_schedules_updated_at on public.ticket_schedules;
create trigger touch_ticket_schedules_updated_at
  before update on public.ticket_schedules
  for each row execute function public.touch_ticket_schedules_updated_at();

-- RLS: tenant members can read + write their own rows.
alter table public.ticket_schedules enable row level security;

drop policy if exists ticket_schedules_member_read on public.ticket_schedules;
create policy ticket_schedules_member_read on public.ticket_schedules
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists ticket_schedules_member_write on public.ticket_schedules;
create policy ticket_schedules_member_write on public.ticket_schedules
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- Realtime publication so the BoardClient can stream UPDATE events
-- (current_drain_run_id transitions etc.) into a live "running" chip.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.ticket_schedules;
  end if;
exception when duplicate_object then
  -- already in the publication; safe to ignore
  null;
end;
$$;

comment on table public.ticket_schedules is
  'Per-project ticket-drain schedules. Cron reads active recurring rows; "Run now" emits drain events directly without writing here.';
comment on column public.ticket_schedules.days_of_week is
  'UTC weekday bitmap: 0=Sun, 1=Mon, … 6=Sat. Empty for mode=once.';
comment on column public.ticket_schedules.time_of_day is
  '"HH:MM" 24h UTC. Cron fires within the same minute the wallclock matches.';
comment on column public.ticket_schedules.current_drain_run_id is
  'Pointer to the in-flight drain run id (Inngest invocation id). Cleared when the drain finishes.';
