-- WP 1.3 RLS harness: a schema subset transcribed VERBATIM (column-for-column)
-- from devpilot's real `supabase/migrations/*.sql`, trimmed to the tables,
-- columns, functions, triggers and policies that are RLS/trigger/RPC-relevant
-- to the migrations under test (20260761000000, 20260762000000,
-- 20260763000000, 20260764000000, 20260765000000) — the same "minimal but
-- faithful subset" methodology the devpilot-desktop probe used
-- (projects/devpilot-desktop/probes/rls/sql/01_schema.sql), but sourced from
-- the REAL current migrations rather than a hand-authored stub. Every section
-- below cites its source file(s) so drift is easy to re-verify.
--
-- `dispatch_queue` and `integration_queue` (20260603020000, 20260715000000)
-- were added for 20260765000000 - previously listed among the omissions
-- below, now loaded in full (table, RLS, RPCs, tenant triggers) because that
-- migration's INSERT policy and claim-function guards need them.
--
-- Deliberately OMITTED (not RLS/trigger/RPC-relevant to the migrations under
-- test, and not needed by anything they call): runners, skills,
-- data_sources, kb_chunks, run_verifications, dev_server_sessions,
-- ticket_number/assign_ticket_number, billing, GitHub OAuth, Vercel,
-- `fan_in_decisions`, `supervisor_actions`, `ticket_schedules`,
-- `schedule_activity`, the rest of the land pipeline beyond claim
-- (`enqueueForLanding`'s insert, `stampLanded`, `moveQueueRow`,
-- `recordLandPullRequest`, `heartbeatQueueRow` - see 20260765000000's own
-- file header for why those stay out of scope), and every FK/trigger pair
-- that touches ONLY those tables. This means: (a) `runs.runner_id` and
-- `merge_conflict_events`'s realtime-publication wiring are not reproduced
-- (harmless - no test exercises them), and (b) this harness cannot detect a
-- regression in a table it never loads. What it CAN and DOES prove: every
-- policy/grant/RPC in 20260761000000 + 20260762000000 + 20260763000000 +
-- 20260764000000 + 20260765000000 behaves correctly against the real column
-- set of the tables those files actually touch, with the real tenant-
-- integrity triggers from 20260732000000 in place exactly as they exist in
-- production.
--
-- NOTE ON A PRIOR DRIFT (fixed alongside 20260763000000): an earlier version
-- of this file transcribed `project_secrets` from its ORIGINAL migration
-- (20260606000000) — a `value_plain` column plus a local `set_project_secret`
-- pgcrypto function — without also applying the later amendment
-- (20260615010000_secrets_app_layer_aes.sql) that drops `value_plain`, adds
-- `value_iv`, and DROPS `set_project_secret`/`get_project_secrets_json`
-- entirely (encryption moved to Node's app-layer AES-256-GCM,
-- apps/web/lib/secrets/crypto.ts). That gave `devpilot_set_project_secret`'s
-- broken delegate-to-`set_project_secret` call a schema to succeed against
-- that does not exist in reality — a false green. The `project_secrets`
-- section below now transcribes the schema's REAL current shape (post-AES,
-- no `value_plain`, no local `set_project_secret`), and no longer needs
-- `pgcrypto` at all (it was pulled in only for that dropped function's
-- `pgp_sym_encrypt`/`pgp_sym_decrypt` calls — `gen_random_uuid()` used
-- throughout this file is core Postgres since PG13, not pgcrypto).

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260601000000_core.sql
-- ═══════════════════════════════════════════════════════════════════════════

create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id)     on delete cascade,
  role        text not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

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

create table public.agents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,
  role         text,
  version      int  not null default 1,
  config       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

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

-- Source: 20260603130000_phase2_projects_and_github_auth.sql (RLS policy
-- transcribed verbatim; repo_url/github_*/description/default_branch columns
-- omitted — not RLS/trigger/RPC-relevant to the two migrations under test).
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

alter table public.projects enable row level security;

create policy projects_member_read on public.projects
  for select using (tenant_id in (select public.current_user_tenants()));

create policy projects_member_write on public.projects
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- This throwaway harness has no Supabase platform bootstrap (the auto-expose
-- default-privilege grant every real project gets on `public` tables) — so,
-- exactly like every other table below, `authenticated` needs an EXPLICIT
-- table-level grant here to reach what the policy above already allows.
grant select, insert, update, delete on public.projects to authenticated;

create table public.tickets (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  project_id          uuid references public.projects(id) on delete set null,
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

alter table public.tickets
  add constraint tickets_retry_count_ceiling check (retry_count <= 10);

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

create table public.ticket_dependencies (
  ticket_id         uuid not null references public.tickets(id) on delete cascade,
  blocks_ticket_id  uuid not null references public.tickets(id) on delete cascade,
  primary key (ticket_id, blocks_ticket_id),
  constraint ticket_dependencies_no_self check (ticket_id <> blocks_ticket_id)
);

create table public.comments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  ticket_id    uuid not null references public.tickets(id) on delete cascade,
  author_type  text not null check (author_type in ('agent','human','system')),
  author_id    text not null,
  body         text not null,
  created_at   timestamptz not null default now()
);

create table public.runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  agent_id        uuid references public.agents(id)   on delete set null,
  ticket_id       uuid references public.tickets(id)  on delete set null,
  parent_run_id   uuid references public.runs(id)     on delete set null,
  runner_kind     text check (runner_kind in ('api','local-cc')),
  depth           int  not null default 0,
  status          text not null default 'running',
  budget_cents    int  not null,
  spent_cents     int  not null default 0,
  last_event_at   timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create table public.run_steps (
  id          bigserial primary key,
  run_id      uuid not null references public.runs(id) on delete cascade,
  idx         int  not null,
  kind        text not null check (kind in ('think','tool_call','tool_result','human_wait','system')),
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  unique (run_id, idx)
);

alter table public.tenants            enable row level security;
alter table public.tenant_members     enable row level security;
alter table public.agents             enable row level security;
alter table public.tickets            enable row level security;
alter table public.ticket_dependencies enable row level security;
alter table public.comments           enable row level security;
alter table public.runs               enable row level security;
alter table public.run_steps          enable row level security;

create policy tenants_member_read on public.tenants
  for select using (id in (select public.current_user_tenants()));

create policy tenant_members_self_read on public.tenant_members
  for select using (user_id = auth.uid() or tenant_id in (select public.current_user_tenants()));

create policy agents_member_read on public.agents
  for select using (tenant_id in (select public.current_user_tenants()));
create policy agents_member_write on public.agents
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

create policy tickets_member_read on public.tickets
  for select using (tenant_id in (select public.current_user_tenants()));
-- Pre-20260759000000 shape (the write policy this migration replaces below);
-- installed here so applying 20260762000000's real predecessor migrations
-- against realistic PRIOR state is exercised, not skipped.
create policy tickets_member_write on public.tickets
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

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

create policy comments_member_read on public.comments
  for select using (tenant_id in (select public.current_user_tenants()));
-- Pre-20260761000000 shape (core.sql's original "for all", no author_type
-- restriction) — the migration under test replaces this.
create policy comments_member_write on public.comments
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

create policy runs_member_read on public.runs
  for select using (tenant_id in (select public.current_user_tenants()));
-- Pre-20260761000000 shape (core.sql's original "for all") — the migration
-- under test drops this policy entirely.
create policy runs_member_write on public.runs
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

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

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260603010000_m4_additional_roles.sql — tickets.requested_role
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.tickets add column requested_role text;
create index tickets_requested_role_idx
  on public.tickets(tenant_id, requested_role)
  where requested_role is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260603150000_phase2_pending_pushes.sql
-- Source: 20260607040000_pending_pushes_conflict.sql — merger_ticket_id
-- ═══════════════════════════════════════════════════════════════════════════
create table public.pending_pushes (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  ticket_id       uuid references public.tickets(id) on delete set null,
  run_id          uuid references public.runs(id) on delete set null,
  merger_ticket_id uuid references public.tickets(id) on delete set null,
  workspace_path  text not null,
  branch          text not null,
  unpushed_count  int  not null default 0,
  pushed_at       timestamptz,
  created_at      timestamptz not null default now()
);
alter table public.pending_pushes enable row level security;
create policy pending_pushes_member_read on public.pending_pushes
  for select using (tenant_id in (select public.current_user_tenants()));
create policy pending_pushes_member_write on public.pending_pushes
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260607010000_linear_props_and_relations.sql — relation_type
-- Source: 20260607060000_relation_type_builds_on.sql — 'builds_on' added
-- Source: 20260729000000_ticket_dependencies_cross_tenant_write.sql — both
--         endpoints tenant-scoped (superseding the write policy installed
--         above from core.sql)
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.ticket_dependencies
  add column relation_type text not null default 'blocked_by';
alter table public.ticket_dependencies
  add constraint ticket_dependencies_relation_type_check
  check (relation_type in ('blocked_by', 'related', 'duplicate', 'builds_on'));
alter table public.ticket_dependencies drop constraint ticket_dependencies_pkey;
alter table public.ticket_dependencies
  add constraint ticket_dependencies_pkey primary key (ticket_id, blocks_ticket_id, relation_type);

drop policy if exists ticket_dependencies_member_write on public.ticket_dependencies;
create policy ticket_dependencies_member_write on public.ticket_dependencies
  for all
  using (
    ticket_id in (
      select id from public.tickets where tenant_id in (select public.current_user_tenants())
    )
  )
  with check (
    ticket_id in (
      select id from public.tickets where tenant_id in (select public.current_user_tenants())
    )
    and blocks_ticket_id in (
      select id from public.tickets where tenant_id in (select public.current_user_tenants())
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260607050000_merge_conflict_events.sql
-- ═══════════════════════════════════════════════════════════════════════════
create table public.merge_conflict_events (
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
alter table public.merge_conflict_events enable row level security;
create policy merge_conflict_events_member_read on public.merge_conflict_events
  for select using (tenant_id in (select public.current_user_tenants()));
-- Pre-20260761000000 shape (no kind restriction) — the migration under test
-- replaces this.
create policy merge_conflict_events_member_write on public.merge_conflict_events
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260606000000_phase2_5_project_secrets.sql (table + comments.metadata)
--         AS AMENDED BY 20260615010000_secrets_app_layer_aes.sql, which is
--         the REAL current shape: no `value_plain` column (dropped), a
--         `value_iv` column (added), and NO `set_project_secret` /
--         `get_project_secrets_json` functions (both dropped — encryption
--         moved to Node's app-layer AES-256-GCM). `devpilot_set_project_secret`
--         (20260762000000, fixed by 20260763000000) writes
--         `value_encrypted`/`value_iv` directly; it delegates to nothing.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.comments add column metadata jsonb;

create table public.project_secrets (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  secret_key      text not null,
  value_encrypted bytea,
  value_iv        bytea,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  unique (project_id, secret_key),
  constraint project_secrets_key_format check (secret_key ~ '^[A-Z][A-Z0-9_]{0,127}$')
);
alter table public.project_secrets enable row level security;
-- DELIBERATELY NO member-read policy — values are RPC-only
-- (devpilot_set_project_secret / devpilot_get_project_secret_names).

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260609000000_pause_resume_schema.sql — 'paused' status value
-- ═══════════════════════════════════════════════════════════════════════════
alter type public.ticket_status add value if not exists 'paused';

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260603050000_m8_supervisor_caps.sql — runs.children_count
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.runs
  add column children_count int not null default 0
    check (children_count >= 0);

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260711000000_ticket_safety_critical.sql
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.tickets add column safety_critical boolean not null default false;

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260727000000_ticket_plan_hold.sql
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.tickets add column plan_hold boolean not null default false;

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260717000000_agent_ticket_creation.sql
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.projects
  add column agent_ticket_creation boolean not null default false;
alter table public.tickets
  add column source_run_id uuid references public.runs(id) on delete set null;
alter table public.runs
  add column tickets_created_count int not null default 0 check (tickets_created_count >= 0);

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260754000000_agent_ticket_max_per_run.sql
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.projects
  add column agent_ticket_max_per_run int
    check (agent_ticket_max_per_run is null or agent_ticket_max_per_run >= 1);

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260755000000_agent_ticket_alias.sql
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.tickets add column agent_alias text;

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260738000000_qa_gate_delivery.sql — tickets.gate_retry_count
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.tickets add column gate_retry_count int not null default 0;

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260606020000_tickets_auto_promote_when_unblocked.sql — added for
-- 20260764000000's devpilot_engine_transition_ticket, which (like the real
-- transitionTicket) clears this flag whenever a ticket leaves backlog.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.tickets
  add column if not exists auto_promote_when_unblocked boolean not null default false;

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260714000000_project_handoffs.sql
-- ═══════════════════════════════════════════════════════════════════════════
create table public.project_handoffs (
  id          uuid        not null default gen_random_uuid() primary key,
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  project_id  uuid        not null references public.projects(id) on delete cascade,
  ticket_id   uuid        not null references public.tickets(id) on delete cascade,
  run_id      uuid        null references public.runs(id) on delete set null,
  role        text        not null,
  kind        text        not null
                constraint chk_project_handoffs_kind
                  check (kind in ('built', 'decision', 'assumption', 'interface')),
  body        text        not null
                constraint chk_project_handoffs_body_nonempty
                  check (length(btrim(body)) > 0),
  created_at  timestamptz not null default now()
);
alter table public.project_handoffs enable row level security;
create policy project_handoffs_member_read
  on public.project_handoffs
  for select
  using (tenant_id in (select public.current_user_tenants()));
-- Pre-20260761000000 shape: deny-all for every non-service writer. The
-- migration under test replaces THIS ONE (project_handoffs_insert_deny) with
-- a real member-write policy; the update/delete denies stay untouched.
create policy project_handoffs_insert_deny
  on public.project_handoffs
  for insert
  with check (false);
create policy project_handoffs_update_deny
  on public.project_handoffs
  for update
  using (false);
create policy project_handoffs_delete_deny
  on public.project_handoffs
  for delete
  using (false);

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260603020000__add_dispatch_queue.sql - the WIP-gated holding
-- area 20260765000000 adds an INSERT policy for. Trimmed to the columns/
-- constraints/RLS/RPC that migration touches (metadata's jsonb-object CHECK
-- and the three timestamp cross-column CHECKs are kept verbatim, since a
-- test inserting a malformed row should hit the SAME constraint it would in
-- production, not a laxer stand-in).
-- ═══════════════════════════════════════════════════════════════════════════
create table public.dispatch_queue (
  id                  uuid         not null default gen_random_uuid()
                        primary key,
  tenant_id           uuid         not null
                        references public.tenants(id) on delete cascade,
  ticket_id           uuid         not null
                        references public.tickets(id) on delete cascade,
  agent_id            uuid         not null
                        references public.agents(id) on delete cascade,
  priority            integer      not null default 3,
  status              text         not null default 'pending'
                        check (status in ('pending', 'dispatched', 'cancelled')),
  enqueued_at         timestamptz  not null default now(),
  dispatched_at       timestamptz  null,
  cancelled_at        timestamptz  null,
  cancel_reason       text         null,
  wip_limit_snapshot  integer      not null
                        constraint chk_dispatch_queue_wip_snapshot_positive
                          check (wip_limit_snapshot > 0),
  metadata            jsonb        not null default '{}'::jsonb
                        constraint chk_dispatch_queue_metadata_object
                          check (jsonb_typeof(metadata) = 'object'),
  created_at          timestamptz  not null default now(),
  updated_at          timestamptz  not null default now(),
  constraint chk_dispatch_queue_dispatched_ts
    check (status <> 'dispatched' or dispatched_at is not null),
  constraint chk_dispatch_queue_cancelled_ts
    check (status <> 'cancelled' or cancelled_at is not null),
  constraint chk_dispatch_queue_pending_no_ts
    check (
      status <> 'pending'
      or (dispatched_at is null and cancelled_at is null)
    )
);

create trigger dispatch_queue_updated_at
  before update on public.dispatch_queue
  for each row execute function public.touch_updated_at();

create unique index uq_dispatch_queue_ticket_agent_pending
  on public.dispatch_queue (ticket_id, agent_id)
  where (status = 'pending');

alter table public.dispatch_queue enable row level security;

create policy dispatch_queue_member_read
  on public.dispatch_queue
  for select
  using (tenant_id in (select public.current_user_tenants()));

-- Pre-20260765000000 shape: deny-all INSERT for every non-service writer.
-- The migration under test replaces THIS ONE with a real member-scoped
-- policy; the update/delete denies stay untouched.
create policy dispatch_queue_insert_deny
  on public.dispatch_queue
  for insert
  with check (false);

create policy dispatch_queue_update_deny
  on public.dispatch_queue
  for update
  using (false);

create policy dispatch_queue_delete_deny
  on public.dispatch_queue
  for delete
  using (false);

-- Pre-20260765000000 shape: service_role only, no tenant-membership guard
-- (the finding 20260765000000's own header explains at length - the
-- function has always trusted p_tenant_id/p_agent_id at face value, which
-- was safe only while service_role was its sole caller). The migration under
-- test CREATE OR REPLACEs this exact function, adding the guard.
create or replace function public.dispatch_queue_claim_next(
  p_tenant_id uuid,
  p_agent_id  uuid
)
returns table (id uuid, ticket_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select dq.id
      from public.dispatch_queue dq
     where dq.tenant_id = p_tenant_id
       and dq.agent_id  = p_agent_id
       and dq.status    = 'pending'
     order by dq.priority asc, dq.enqueued_at asc
     limit 1
     for update skip locked
  )
  update public.dispatch_queue dq
     set status        = 'dispatched',
         dispatched_at = now()
    from claimed
   where dq.id = claimed.id
  returning dq.id, dq.ticket_id;
end;
$$;

revoke all on function public.dispatch_queue_claim_next(uuid, uuid) from public;
grant execute on function public.dispatch_queue_claim_next(uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260715000000_integration_queue.sql - the auto-land queue
-- 20260765000000 adds a tenant-membership guard + authenticated EXECUTE to.
-- Trimmed to the columns/constraints/RLS/RPC that migration touches.
-- `tickets.landed_sha` is added here too - `ticket_land_open` reads it, and
-- the CREATE FUNCTION below would fail to compile without the column, exactly
-- as it would against a real schema that had never run 20260715000000.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.tickets add column landed_sha text;

create table public.integration_queue (
  id             uuid        not null default gen_random_uuid() primary key,
  tenant_id      uuid        not null references public.tenants(id)  on delete cascade,
  project_id     uuid        not null references public.projects(id) on delete cascade,
  ticket_id      uuid        not null references public.tickets(id)  on delete cascade,
  status         text        not null default 'pending'
                   check (status in ('pending','landing','awaiting_merge_resolution',
                                     'landed','failed','cancelled')),
  priority       integer     not null default 3,
  enqueued_at    timestamptz not null default now(),
  claimed_at     timestamptz null,
  landed_at      timestamptz null,
  attempts       integer     not null default 0,
  heartbeat_at   timestamptz null,
  last_error     text        null,
  pr_number      integer     null,
  pr_url         text        null,
  merge_sha      text        null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint chk_integration_queue_landed_ts
    check (status <> 'landed' or (landed_at is not null and merge_sha is not null)),
  constraint chk_integration_queue_attempts_nonneg
    check (attempts >= 0)
);

create trigger integration_queue_updated_at
  before update on public.integration_queue
  for each row execute function public.touch_updated_at();

create unique index uq_integration_queue_ticket_active
  on public.integration_queue (ticket_id)
  where (status in ('pending','landing','awaiting_merge_resolution'));

alter table public.integration_queue enable row level security;

create policy integration_queue_member_read
  on public.integration_queue
  for select
  using (tenant_id in (select public.current_user_tenants()));

create policy integration_queue_insert_deny
  on public.integration_queue for insert with check (false);

create policy integration_queue_update_deny
  on public.integration_queue for update using (false);

create policy integration_queue_delete_deny
  on public.integration_queue for delete using (false);

create or replace function public.ticket_land_open(p_ticket_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.tickets t
     where t.id = p_ticket_id
       and t.landed_sha is null
       and (
         t.status <> 'done'
         or exists (
           select 1
             from public.integration_queue q
            where q.ticket_id = t.id
              and q.status in ('pending','landing','awaiting_merge_resolution','failed')
         )
       )
  );
$$;

revoke all on function public.ticket_land_open(uuid) from public;
grant execute on function public.ticket_land_open(uuid) to service_role;

-- Pre-20260765000000 shape: service_role only, no tenant-membership guard
-- (the function has always trusted p_project_id at face value). The
-- migration under test CREATE OR REPLACEs this exact function, adding a
-- guard derived from the project's own tenant_id.
create or replace function public.integration_queue_claim_next(
  p_project_id uuid
)
returns table (id uuid, ticket_id uuid, tenant_id uuid, attempts integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select q.id
      from public.integration_queue q
     where q.project_id = p_project_id
       and q.status = 'pending'
       and not exists (
         select 1
           from public.ticket_dependencies d
           join public.tickets b on b.id = d.blocks_ticket_id
          where d.ticket_id = q.ticket_id
            and d.relation_type in ('blocked_by','builds_on')
            and case
                  when d.relation_type = 'builds_on'
                    then public.ticket_land_open(b.id)
                  else b.status <> 'done'
                end
       )
     order by q.priority asc, q.enqueued_at asc
     limit 1
     for update skip locked
  )
  update public.integration_queue q
     set status       = 'landing',
         claimed_at   = now(),
         heartbeat_at = now(),
         attempts     = q.attempts + 1
    from claimed
   where q.id = claimed.id
  returning q.id, q.ticket_id, q.tenant_id, q.attempts;
end;
$$;

revoke all on function public.integration_queue_claim_next(uuid) from public;
grant execute on function public.integration_queue_claim_next(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260759000000_tickets_write_policy_no_self_reference.sql —
--         CURRENT (pre-20260761000000) tickets_member_write shape: tenant +
--         project scoped, NO parent_ticket_id clause (the fix for the
--         2026-08-06 42P17 recursion incident). Reinstalled here to replace
--         core.sql's tenant-only version above, matching the schema's real
--         current state exactly before 20260761000000/20260762000000 apply.
-- ═══════════════════════════════════════════════════════════════════════════
drop policy if exists tickets_member_write on public.tickets;
create policy tickets_member_write on public.tickets
  for all
  using (tenant_id in (select public.current_user_tenants()))
  with check (
    tenant_id in (select public.current_user_tenants())
    and (
      project_id is null
      or project_id in (
        select id from public.projects where tenant_id in (select public.current_user_tenants())
      )
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- Source: 20260732000000_tenant_matches_parent_all.sql — the fix for the
-- 42P17 recursion incident. assert_tenant_matches_parent() transcribed
-- VERBATIM, plus every trigger instance relevant to the 12 tables above
-- (omitting only pairs whose OTHER table this subset doesn't load, e.g.
-- api_keys, branch_promotions, dev_server_sessions, planning_*, schedule_*,
-- ticket_attachments, ticket_schedules, run_verifications — none of which
-- 20260761000000/20260762000000 touch).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.assert_tenant_matches_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ptr_col       text := tg_argv[0];
  v_parent_table  text := tg_argv[1];
  v_ptr           uuid;
  v_parent_tenant uuid;
begin
  execute format('select ($1).%I', v_ptr_col) into v_ptr using new;

  if v_ptr is null then
    return new;
  end if;

  execute format('select tenant_id from public.%I where id = $1', v_parent_table)
    into v_parent_tenant using v_ptr;

  if v_parent_tenant is null then
    return new;
  end if;

  if v_parent_tenant <> new.tenant_id then
    raise exception
      'cross-tenant write refused: %.% = % belongs to tenant %, but the row''s tenant is %',
      tg_table_name, v_ptr_col, v_ptr, v_parent_tenant, new.tenant_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_comments_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.comments
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

create trigger trg_merge_conflict_events_merger_ticket_id_tenant
  before insert or update of tenant_id, merger_ticket_id on public.merge_conflict_events
  for each row execute function public.assert_tenant_matches_parent('merger_ticket_id', 'tickets');

create trigger trg_merge_conflict_events_pending_push_id_tenant
  before insert or update of tenant_id, pending_push_id on public.merge_conflict_events
  for each row execute function public.assert_tenant_matches_parent('pending_push_id', 'pending_pushes');

create trigger trg_merge_conflict_events_project_id_tenant
  before insert or update of tenant_id, project_id on public.merge_conflict_events
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

create trigger trg_merge_conflict_events_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.merge_conflict_events
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

create trigger trg_pending_pushes_merger_ticket_id_tenant
  before insert or update of tenant_id, merger_ticket_id on public.pending_pushes
  for each row execute function public.assert_tenant_matches_parent('merger_ticket_id', 'tickets');

create trigger trg_pending_pushes_project_id_tenant
  before insert or update of tenant_id, project_id on public.pending_pushes
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

create trigger trg_pending_pushes_run_id_tenant
  before insert or update of tenant_id, run_id on public.pending_pushes
  for each row execute function public.assert_tenant_matches_parent('run_id', 'runs');

create trigger trg_pending_pushes_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.pending_pushes
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

create trigger trg_project_handoffs_project_id_tenant
  before insert or update of tenant_id, project_id on public.project_handoffs
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

create trigger trg_project_handoffs_run_id_tenant
  before insert or update of tenant_id, run_id on public.project_handoffs
  for each row execute function public.assert_tenant_matches_parent('run_id', 'runs');

create trigger trg_project_handoffs_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.project_handoffs
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

create trigger trg_project_secrets_project_id_tenant
  before insert or update of tenant_id, project_id on public.project_secrets
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

create trigger trg_runs_agent_id_tenant
  before insert or update of tenant_id, agent_id on public.runs
  for each row execute function public.assert_tenant_matches_parent('agent_id', 'agents');

create trigger trg_runs_parent_run_id_tenant
  before insert or update of tenant_id, parent_run_id on public.runs
  for each row execute function public.assert_tenant_matches_parent('parent_run_id', 'runs');

create trigger trg_runs_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.runs
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

create trigger trg_tickets_assignee_agent_id_tenant
  before insert or update of tenant_id, assignee_agent_id on public.tickets
  for each row execute function public.assert_tenant_matches_parent('assignee_agent_id', 'agents');

create trigger trg_tickets_parent_ticket_id_tenant
  before insert or update of tenant_id, parent_ticket_id on public.tickets
  for each row execute function public.assert_tenant_matches_parent('parent_ticket_id', 'tickets');

create trigger trg_tickets_project_id_tenant
  before insert or update of tenant_id, project_id on public.tickets
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

create trigger trg_tickets_source_run_id_tenant
  before insert or update of tenant_id, source_run_id on public.tickets
  for each row execute function public.assert_tenant_matches_parent('source_run_id', 'runs');

-- dispatch_queue / integration_queue anchors - 20260765000000's new INSERT
-- policy on dispatch_queue relies on THESE (pre-existing, unchanged)
-- triggers to re-derive the row's tenant from its ticket_id/agent_id anchor
-- rather than trusting a caller-supplied tenant_id; see that migration's own
-- file header.
create trigger trg_dispatch_queue_agent_id_tenant
  before insert or update of tenant_id, agent_id on public.dispatch_queue
  for each row execute function public.assert_tenant_matches_parent('agent_id', 'agents');

create trigger trg_dispatch_queue_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.dispatch_queue
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

create trigger trg_integration_queue_project_id_tenant
  before insert or update of tenant_id, project_id on public.integration_queue
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

create trigger trg_integration_queue_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.integration_queue
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

-- ═══════════════════════════════════════════════════════════════════════════
-- SIMULATED Supabase platform default-privilege bootstrap — NOT part of any
-- devpilot migration. A real Supabase project configured to auto-expose new
-- `public` entities grants `authenticated` broad table-level privileges the
-- moment a table is created, entirely OUTSIDE any migration file (confirmed
-- by grepping every real devpilot migration for a table-level GRANT: there is
-- none, anywhere, for any of these tables — see 20260761000000's own file
-- header). This throwaway harness has no such bootstrap, so it is simulated
-- HERE, deliberately BEFORE the two migrations under test apply.
--
-- This is load-bearing for what this harness actually proves. Without it,
-- `authenticated` would start with ZERO privilege on every table, and
-- 20260761000000's `revoke ... ; grant <narrower> ...` sequences would be
-- revoking a privilege that was never granted in THIS harness — a no-op that
-- would make the REVOKE-before-GRANT fix (devpilot-desktop companion harness,
-- PR #8) untestable here, i.e. this file would silently stop proving the
-- thing it exists to prove. Granting broadly here first is what makes the
-- narrowing in 20260761000000 real and observable.
--
-- Granted to `anon` too, for the same reason 20260761000000 REVOKEs `anon`
-- alongside `authenticated` on every one of these tables: a real Supabase
-- bootstrap hands `anon` its own standing grant, independent of
-- `authenticated`'s, and simulating only one role here would leave the
-- migration's anon-revoke untested against a grant that was never simulated
-- in the first place.
--
-- `project_secrets` is DELIBERATELY EXCLUDED — the real table has never had
-- a grant (20260606000000's own comment: "DELIBERATELY NO member-read policy
-- ... values are service-role-only readable"), and 20260761000000's new
-- `revoke all on public.project_secrets from authenticated, anon;` is
-- re-asserting that fact explicitly, not narrowing something this bootstrap
-- granted. Simulating a grant here that the real platform never gave it
-- would test a scenario that cannot occur.
-- ═══════════════════════════════════════════════════════════════════════════
grant select, insert, update, delete on
  public.tenants, public.tenant_members, public.agents, public.tickets,
  public.ticket_dependencies, public.comments, public.runs, public.run_steps,
  public.pending_pushes, public.merge_conflict_events, public.project_handoffs,
  public.dispatch_queue, public.integration_queue
  to authenticated, anon;
