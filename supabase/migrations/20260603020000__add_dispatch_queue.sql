-- =============================================================================
-- Migration : 20260603020000__add_dispatch_queue.sql
-- Ticket    : d8ecac5b-c8d3-4da0-bfda-6a5a4d92b500
-- Purpose   : Add dispatch_queue — the WIP-gated holding area that releases
--             tickets to agents once their active WIP count drops below
--             (agents.config->>'wip_limit')::int.
--
-- Design notes
-- ────────────
-- • wip_limit is stored in agents.config (jsonb), not a first-class column.
--   The dequeue query casts it at runtime; the enqueue caller snapshots it.
-- • Active-WIP statuses: assigned | in_progress | input_required | blocked |
--   in_review  (everything that is not terminal or pre-start).
-- • RLS follows the existing public.current_user_tenants() pattern.
-- • touch_updated_at() already exists from 20260601000000_core.sql — reused.
--
-- Execution notes
-- ───────────────
-- One-shot transactional migration. All three lookup indexes are plain
-- CREATE INDEX rather than CONCURRENTLY because the table is brand new and
-- has zero rows when this runs — there's nothing to lock-contend against,
-- and CONCURRENTLY is forbidden inside a transaction block which would
-- break `supabase db push`. Future index additions on a populated
-- dispatch_queue should use CONCURRENTLY in a separate non-tx migration.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1.1  dispatch_queue
-- ---------------------------------------------------------------------------
create table if not exists public.dispatch_queue (
  -- Identity
  id                  uuid         not null default gen_random_uuid()
                        primary key,

  -- Tenant isolation
  -- Cascade: when a tenant is deleted all queue rows vanish automatically.
  tenant_id           uuid         not null
                        references public.tenants(id) on delete cascade,

  -- Payload references
  -- Cascade on ticket: if a ticket is hard-deleted the queue entry is gone.
  ticket_id           uuid         not null
                        references public.tickets(id) on delete cascade,

  -- Cascade on agent: if an agent row is deleted the queue entry is gone.
  agent_id            uuid         not null
                        references public.agents(id) on delete cascade,

  -- Ordering
  -- Higher urgency = lower integer (mirrors tickets.priority: 1=critical, 5=low).
  -- Ties broken by enqueued_at ASC so older high-priority items go first.
  priority            integer      not null default 3,

  -- Status lifecycle
  -- pending   -> dispatched  : dequeue succeeded, ticket will be moved to 'assigned'
  -- pending   -> cancelled   : ticket was revoked / agent deactivated
  status              text         not null default 'pending'
                        check (status in ('pending', 'dispatched', 'cancelled')),

  -- Timing (all timestamptz; Supabase DB runs UTC)
  enqueued_at         timestamptz  not null default now(),
  dispatched_at       timestamptz  null,   -- set atomically with status='dispatched'
  cancelled_at        timestamptz  null,   -- set atomically with status='cancelled'

  -- Human-readable note attached on cancellation (nullable).
  cancel_reason       text         null,

  -- WIP snapshot
  -- Snapshot of (agents.config->>'wip_limit')::int at enqueue time.
  -- Used for auditing/SLA only; dequeue always re-reads the live value.
  wip_limit_snapshot  integer      not null
                        constraint chk_dispatch_queue_wip_snapshot_positive
                          check (wip_limit_snapshot > 0),

  -- Metadata
  -- Caller-supplied context: source run_id, routing hints, etc.
  -- Constrained to JSON object (not array or scalar).
  metadata            jsonb        not null default '{}'::jsonb
                        constraint chk_dispatch_queue_metadata_object
                          check (jsonb_typeof(metadata) = 'object'),

  -- Housekeeping
  created_at          timestamptz  not null default now(),
  updated_at          timestamptz  not null default now(),

  -- Cross-column consistency
  -- Dispatched rows MUST record when dispatch happened.
  constraint chk_dispatch_queue_dispatched_ts
    check (status <> 'dispatched' or dispatched_at is not null),

  -- Cancelled rows MUST record when cancellation happened.
  constraint chk_dispatch_queue_cancelled_ts
    check (status <> 'cancelled' or cancelled_at is not null),

  -- Pending rows must NOT yet have a dispatch or cancellation timestamp.
  constraint chk_dispatch_queue_pending_no_ts
    check (
      status <> 'pending'
      or (dispatched_at is null and cancelled_at is null)
    )
);

comment on table public.dispatch_queue is
  'WIP-gated ticket holding area. A pending row means the ticket is waiting '
  'for the named agent to drop below its wip_limit. The Inngest dispatcher '
  'atomically claims rows (SELECT FOR UPDATE SKIP LOCKED) and transitions '
  'them to dispatched once capacity is confirmed.';

-- ---------------------------------------------------------------------------
-- 1.2  updated_at trigger — reuse touch_updated_at() from core migration
-- ---------------------------------------------------------------------------
drop trigger if exists dispatch_queue_updated_at on public.dispatch_queue;
create trigger dispatch_queue_updated_at
  before update on public.dispatch_queue
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 1.3  Unique partial index
-- A ticket may be pending for a given agent at most once.
-- Non-CONCURRENTLY is fine here: table is brand-new, zero rows.
-- ---------------------------------------------------------------------------
create unique index if not exists uq_dispatch_queue_ticket_agent_pending
  on public.dispatch_queue (ticket_id, agent_id)
  where (status = 'pending');

-- ---------------------------------------------------------------------------
-- 1.4  Row-Level Security
--
-- Threat model: a JWT-authenticated tenant member must never read or write
-- another tenant's queue rows even with a direct DB connection.
-- The backend (Inngest, service_role) bypasses RLS and is the sole mutator.
--
-- Pattern matches existing policies in 20260601000000_core.sql which use
-- public.current_user_tenants() (SECURITY DEFINER; no RLS recursion).
-- ---------------------------------------------------------------------------
alter table public.dispatch_queue enable row level security;

-- SELECT: tenant members see only their own rows.
create policy dispatch_queue_member_read
  on public.dispatch_queue
  for select
  using (tenant_id in (select public.current_user_tenants()));

-- INSERT / UPDATE / DELETE: denied for JWT-authenticated roles.
-- service_role (Inngest, migrations) bypasses RLS entirely in Supabase.
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

-- ---------------------------------------------------------------------------
-- 1.5  Atomic dequeue function
--
-- Supabase's JS client cannot express `SELECT FOR UPDATE SKIP LOCKED` directly.
-- We expose it via an RPC. The CTE picks the next pending row for the
-- (tenant, agent) pair, locks it without blocking, and updates it to
-- 'dispatched' in the same statement. Concurrent drain workers either see
-- different rows or no rows — no double-dispatch is possible.
--
-- SECURITY DEFINER so service_role callers don't trip RLS UPDATE deny policy;
-- search_path pinned to public so the function can't be hijacked by a tenant
-- creating a same-named table in a schema they own.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 1.6  Lookup indexes (plain — table is new, no rows to lock against)
--
-- Index A: Primary dequeue hot path (partial — pending rows only).
-- Serves: "next N highest-priority pending items for agent X in tenant T".
create index if not exists idx_dispatch_queue_agent_pending
  on public.dispatch_queue (tenant_id, agent_id, priority asc, enqueued_at asc)
  where (status = 'pending');

-- Index B: Ticket lookup (partial — pending rows only).
-- Serves: enqueue-time idempotency probe + ticket-cancellation fan-out.
create index if not exists idx_dispatch_queue_ticket_pending
  on public.dispatch_queue (tenant_id, ticket_id)
  where (status = 'pending');

-- Index C: Tenant-wide status + time sweep (full — all statuses).
-- Serves: monitoring dashboards, SLA alerting, the stale-queue reaper.
create index if not exists idx_dispatch_queue_tenant_status_time
  on public.dispatch_queue (tenant_id, status, enqueued_at asc);

commit;
