-- Phase 2 — Linear-inspired board features (M1 + M2 schema).
--
-- Adds first-class issue properties (priority encoding, estimate, due date,
-- labels) and generalizes the dependency table to a multi-flavour relations
-- table (blocked_by / related / duplicate).
--
-- Notes on priority:
--   • The column already exists (`int default 3`) and the engine's dispatch
--     queue snapshots it. Historically used a 1..5 scale (1=critical, 5=low).
--   • We migrate to Linear's encoding: 0=none, 1=urgent, 2=high, 3=medium,
--     4=low. Rows at priority=3 (the legacy default) become "medium" — no
--     visible change for existing tickets. Any 5 (legacy "low") is clamped
--     to 4. The new default for fresh rows is 0 (none) so operators opt in
--     explicitly. Engine dispatch keeps treating "lower number = sort first"
--     for non-zero priorities; the zero "no-priority" case is handled at the
--     UI/sort layer where it sorts last.
--
-- Notes on relations:
--   • `ticket_dependencies` already exists with PK (ticket_id, blocks_ticket_id)
--     and ON DELETE CASCADE on both columns — we add a `relation_type` discriminator
--     and widen the PK so the same pair can carry multiple relation flavours.
--   • Semantics: a row (ticket_id=A, blocks_ticket_id=B, relation_type='blocked_by')
--     means "A is blocked by B". `blocks` is the inverse query, not a stored row.
--     `related` and `duplicate` are symmetric in meaning; we store one canonical
--     row per pair per type and surface both directions in the UI.
--
-- Notes on realtime:
--   • Adds the two new tables to the supabase_realtime publication.
--   • Sets REPLICA IDENTITY FULL so DELETE events deliver under tenant-scoped
--     channel filters — mirrors the fix we landed for tickets/pending_pushes
--     in 20260607000000_tickets_replica_identity_full.sql.

-- ---------------------------------------------------------------------------
-- 1. Ticket properties

update public.tickets set priority = 4 where priority > 4;
update public.tickets set priority = 0 where priority < 0;

alter table public.tickets alter column priority set default 0;
alter table public.tickets
  drop constraint if exists tickets_priority_linear_range;
alter table public.tickets
  add constraint tickets_priority_linear_range
  check (priority between 0 and 4);

alter table public.tickets add column if not exists estimate_cents int null;
alter table public.tickets add column if not exists due_at         timestamptz null;

create index if not exists tickets_tenant_priority_idx
  on public.tickets(tenant_id, priority)
  where priority > 0;

create index if not exists tickets_tenant_due_at_idx
  on public.tickets(tenant_id, due_at)
  where due_at is not null;

-- ---------------------------------------------------------------------------
-- 2. Labels — tenant-scoped, multi-attach to tickets via join table.

create table if not exists public.labels (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  color      text not null default 'muted',
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists labels_tenant_idx on public.labels(tenant_id);

create table if not exists public.ticket_labels (
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  label_id  uuid not null references public.labels(id)  on delete cascade,
  primary key (ticket_id, label_id)
);

create index if not exists ticket_labels_label_idx on public.ticket_labels(label_id);

-- ---------------------------------------------------------------------------
-- 3. Generalize ticket_dependencies to multi-flavour relations.

alter table public.ticket_dependencies
  add column if not exists relation_type text not null default 'blocked_by';

alter table public.ticket_dependencies
  drop constraint if exists ticket_dependencies_relation_type_check;
alter table public.ticket_dependencies
  add constraint ticket_dependencies_relation_type_check
  check (relation_type in ('blocked_by','related','duplicate'));

-- Widen PK so multiple relation types between the same pair coexist.
-- Idempotent: skip if the PK already includes relation_type (e.g. re-runs
-- after this migration has already landed, or after the builds_on widening
-- in 20260607060000).
do $$
declare
  pk_cols text;
begin
  select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
    into pk_cols
    from pg_constraint c
    join pg_attribute  a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
   where c.conrelid = 'public.ticket_dependencies'::regclass
     and c.contype  = 'p';
  if pk_cols is null or pk_cols not like '%relation_type%' then
    if pk_cols is not null then
      execute 'alter table public.ticket_dependencies drop constraint ticket_dependencies_pkey';
    end if;
    execute 'alter table public.ticket_dependencies '
         || 'add constraint ticket_dependencies_pkey '
         || 'primary key (ticket_id, blocks_ticket_id, relation_type)';
  end if;
end$$;

create index if not exists ticket_dependencies_blocks_idx
  on public.ticket_dependencies(blocks_ticket_id, relation_type);

-- ---------------------------------------------------------------------------
-- 4. RLS — mirror the patterns in 20260601000000_core.sql.

alter table public.labels        enable row level security;
alter table public.ticket_labels enable row level security;

drop policy if exists labels_member_read  on public.labels;
create policy labels_member_read on public.labels
  for select using (tenant_id in (select public.current_user_tenants()));
drop policy if exists labels_member_write on public.labels;
create policy labels_member_write on public.labels
  for all using (tenant_id in (select public.current_user_tenants()))
         with check (tenant_id in (select public.current_user_tenants()));

drop policy if exists ticket_labels_member_read  on public.ticket_labels;
create policy ticket_labels_member_read on public.ticket_labels
  for select using (
    ticket_id in (select id from public.tickets where tenant_id in (select public.current_user_tenants()))
  );
drop policy if exists ticket_labels_member_write on public.ticket_labels;
create policy ticket_labels_member_write on public.ticket_labels
  for all using (
    ticket_id in (select id from public.tickets where tenant_id in (select public.current_user_tenants()))
  ) with check (
    ticket_id in (select id from public.tickets where tenant_id in (select public.current_user_tenants()))
  );

-- ---------------------------------------------------------------------------
-- 5. Realtime publication + REPLICA IDENTITY FULL so DELETE events deliver
--    under filtered subscriptions.

do $$
begin
  begin alter publication supabase_realtime add table public.labels;        exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.ticket_labels; exception when duplicate_object then null; end;
end$$;

alter table public.labels        replica identity full;
alter table public.ticket_labels replica identity full;
