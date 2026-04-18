-- Phase 2.5+ / Slice IB-B — merge_conflict_events audit table.
--
-- One row per state transition during a conflict's lifecycle. The /changes
-- conflict tab subscribes to this table via realtime to render a live
-- timeline of what happened: detection → merger spawn → merger started →
-- per-file resolutions → merger completed → retry push.
--
-- kind values + payload conventions:
--   'detected'          — initial rebase failure. payload = conflict_detail
--                         (files, stderr, base_sha, branch_sha).
--   'merger_spawned'    — release_engineer ticket auto-created. payload =
--                         { merger_ticket_id }.
--   'merger_started'    — merger's run-agent dispatch began. payload =
--                         { merger_run_id }.
--   'file_resolved'     — merger called ace_log_conflict_event for one file.
--                         payload = { file, strategy: 'pick-ours' | 'pick-
--                         theirs' | 'synthesis' | 'ambiguous', notes? }.
--   'merger_completed'  — merger's run-agent reported success. payload =
--                         { resolved_files: [...], duration_ms, cost_cents }.
--   'operator_overrode' — operator chose Force-push (escape hatch). payload =
--                         { operator_id, reason? }.
--   'retry_pushed'      — pushPendingChangesAction retried after resolution
--                         and the rebase succeeded. payload = { head_sha }.
--   'retry_failed'      — retry still hit a conflict (rare). payload =
--                         { new_conflict_detail }.

create table if not exists public.merge_conflict_events (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,
  pending_push_id   uuid        not null references public.pending_pushes(id) on delete cascade,
  project_id        uuid        not null references public.projects(id) on delete cascade,
  ticket_id         uuid        references public.tickets(id) on delete set null,
  merger_ticket_id  uuid        references public.tickets(id) on delete set null,
  kind              text        not null check (kind in (
                                  'detected','merger_spawned','merger_started',
                                  'file_resolved','merger_completed','operator_overrode',
                                  'retry_pushed','retry_failed')),
  payload           jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists merge_conflict_events_pp_idx
  on public.merge_conflict_events(pending_push_id, created_at);

create index if not exists merge_conflict_events_tenant_idx
  on public.merge_conflict_events(tenant_id, created_at desc);

alter table public.merge_conflict_events enable row level security;

drop policy if exists merge_conflict_events_member_read on public.merge_conflict_events;
create policy merge_conflict_events_member_read on public.merge_conflict_events
  for select using (tenant_id in (select public.current_user_tenants()));

drop policy if exists merge_conflict_events_member_write on public.merge_conflict_events;
create policy merge_conflict_events_member_write on public.merge_conflict_events
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- Wire into Supabase Realtime so the Conflicts tab updates live as the
-- merger emits events.
do $$
declare
  pub_exists boolean;
begin
  select exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) into pub_exists;
  if pub_exists then
    -- DROP first to avoid 42710 (already member) on re-runs.
    begin
      execute 'alter publication supabase_realtime drop table public.merge_conflict_events';
    exception when others then null;
    end;
    execute 'alter publication supabase_realtime add table public.merge_conflict_events';
  end if;
end$$;

-- Replica identity full so realtime payloads carry all columns.
alter table public.merge_conflict_events replica identity full;
