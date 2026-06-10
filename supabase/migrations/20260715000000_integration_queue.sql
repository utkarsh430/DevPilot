-- =============================================================================
-- Migration : 20260715000000_integration_queue.sql
-- Purpose   : WI-4 / WI-5 — the auto-land queue and the "landed on dev" truth.
--
-- WHAT LANDS HERE
-- ───────────────
-- 1. `integration_queue`  — one row per ticket that needs its `ace/<slug>`
--    branch landed on the project's integration branch (dev). Mirrors
--    `dispatch_queue` (20260603020000__add_dispatch_queue.sql): same RLS shape,
--    same SECURITY DEFINER claim function, same FOR UPDATE SKIP LOCKED claim.
-- 2. `tickets.landed_sha` + `tickets.integrated_at` — the single truth that a
--    ticket's work is ON the integration branch. WI-5 re-gates readiness on
--    this instead of `status = 'done'`.
-- 3. `projects.auto_land_enabled` — the per-project opt-in. Default FALSE, so
--    every existing project keeps today's manual push→PR→merge flow until an
--    operator turns it on. (The runtime kill switch `ACE_AUTO_LAND_ENABLED=0`
--    disables the worker instance-wide regardless of this flag.)
-- 4. `ticket_land_open(ticket)` — the shared SQL predicate behind both the
--    claim function's dependency gate and (via its TS twin in
--    `lib/integration/landed.ts`) the WI-5 readiness gate.
-- 5. Backfill — every already-`done` ticket is stamped as landed, so turning
--    the flag on cannot retroactively wedge dependents of historical work.
--
-- SERIALIZATION (load-bearing — read before changing the claim function)
-- ─────────────────────────────────────────────────────────────────────
-- `integration_queue_claim_next` uses FOR UPDATE SKIP LOCKED. That is a
-- single-ROW claim, NOT a per-project mutex: two concurrent callers get two
-- DIFFERENT rows, and both would rebase-and-merge into the same `dev` tip at
-- once. Per-project mutual exclusion comes from ONE place and one place only —
-- the `land-ticket` Inngest function's `concurrency { limit: 1, key: projectId }`
-- (`apps/web/lib/engine/land-worker.ts`), which claims and FULLY lands exactly
-- one row per invocation. SKIP LOCKED here is defence in depth (it keeps the
-- reaper and a late worker off the same row), not the serialization itself.
-- Do NOT raise that concurrency limit, and do NOT fold landing into
-- `drainBacklogFn` — its own `limit: 1` is the DRAIN coordinator lock, and
-- sharing it would stall the drain's fan-out behind every merge.
--
-- Execution notes
-- ───────────────
-- One-shot transactional migration. Plain CREATE INDEX (not CONCURRENTLY):
-- the table is brand new with zero rows, and CONCURRENTLY is forbidden inside
-- a transaction block, which would break `supabase db push`.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. tickets.landed_sha / tickets.integrated_at — the "landed on dev" truth
--
-- One ticket, one landing. `landed_sha` is the integration-branch commit that
-- CONTAINS this ticket's work (resolved by reading the dev ref after the merge
-- — never from the merge API's return value, which is empty on an
-- already-up-to-date replay). Once set it is never rewritten: it is the sha the
-- child of a `builds_on` chain roots on, so rewriting it would silently move
-- every stacked child's base.
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists landed_sha    text,
  add column if not exists integrated_at timestamptz;

comment on column public.tickets.landed_sha is
  'Integration-branch (dev) commit SHA that contains this ticket''s work. NULL = '
  'not landed. Written once by the land worker (lib/engine/land-worker.ts) or by '
  'the integration-queue reaper reconciling against the dev ref. WI-5 gates '
  'readiness on this, not on status=done: a done-but-unlanded parent means the '
  'dependent would branch off a tree that lacks the parent''s commits.';

comment on column public.tickets.integrated_at is
  'When landed_sha was stamped. Set atomically with it; NULL iff landed_sha is NULL.';

-- Cross-column consistency: the two columns are one fact, so they are set
-- together or not at all. Guards against a half-stamp (the exact silent
-- half-land the crash-safe stamp exists to prevent).
alter table public.tickets
  drop constraint if exists chk_tickets_landed_pair;
alter table public.tickets
  add constraint chk_tickets_landed_pair
  check ((landed_sha is null) = (integrated_at is null));

-- Readiness/blocker queries filter on "which of these blockers are unlanded",
-- so the partial index covers exactly the rows they care about.
create index if not exists idx_tickets_unlanded
  on public.tickets (project_id, status)
  where (landed_sha is null);

-- ---------------------------------------------------------------------------
-- 2. projects.auto_land_enabled — the per-project opt-in
--
-- FALSE by default: a project keeps the manual /changes push→PR→merge flow
-- until an operator opts in. Nothing else changes behaviour on this flag —
-- notably the WI-5 readiness predicate does NOT read it (see ticket_land_open
-- below), because it derives the legacy semantics on its own when no queue row
-- exists.
-- ---------------------------------------------------------------------------
alter table public.projects
  add column if not exists auto_land_enabled boolean not null default false;

comment on column public.projects.auto_land_enabled is
  'Opt-in: when true, a done ticket with a branch is enqueued on integration_queue '
  'and auto-landed onto integration_branch (squash) by the land worker. False = '
  'the legacy manual push/PR/merge flow. The instance-wide kill switch is the '
  'ACE_AUTO_LAND_ENABLED env var.';

-- ---------------------------------------------------------------------------
-- 3. integration_queue
-- ---------------------------------------------------------------------------
create table if not exists public.integration_queue (
  id             uuid        not null default gen_random_uuid() primary key,

  tenant_id      uuid        not null references public.tenants(id)  on delete cascade,
  -- project_id is NOT NULL on purpose: it is the Inngest concurrency key that
  -- serializes landing. A null key would collapse every project onto one
  -- global lane (or, worse, resolve to `undefined` and serialize nothing).
  project_id     uuid        not null references public.projects(id) on delete cascade,
  ticket_id      uuid        not null references public.tickets(id)  on delete cascade,

  -- pending                    → waiting for the worker to claim it
  -- landing                    → claimed; a worker is rebasing/merging it NOW
  -- awaiting_merge_resolution  → parked: the rebase conflicted and a merger
  --                              (release_engineer) ticket owns the fix. Re-pended
  --                              when that merger reaches done.
  -- landed | failed | cancelled → terminal
  status         text        not null default 'pending'
                   check (status in ('pending','landing','awaiting_merge_resolution',
                                     'landed','failed','cancelled')),

  -- Mirrors tickets.priority (1 = critical … 5 = low); ties broken by enqueued_at.
  priority       integer     not null default 3,

  enqueued_at    timestamptz not null default now(),
  claimed_at     timestamptz null,
  landed_at      timestamptz null,

  -- Attempt accounting. `attempts` is bumped on every claim; the worker fails
  -- the row for good once it exceeds the ceiling, so a permanently-broken land
  -- can't spin the pump forever.
  attempts       integer     not null default 0,
  -- Liveness. The worker stamps this while it holds the row; the reaper uses
  -- its age to tell "a worker is mid-merge" from "a worker died mid-merge".
  heartbeat_at   timestamptz null,
  last_error     text        null,

  -- Per-attempt land ledger. `branch_promotions` is deliberately NOT reused for
  -- this: its `strategy` CHECK is ('pr','direct') and its only consumer is the
  -- project page's integration→production promotion panel, which would drown in
  -- one row per ticket per attempt. The queue row already IS the per-attempt
  -- record, so the ledger columns live here.
  pr_number      integer     null,
  pr_url         text        null,
  merge_sha      text        null,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Landed rows MUST carry the timestamp + the sha they landed as. This is the
  -- DB-level half of the crash-safe stamp: a worker that resolved a NULL sha
  -- cannot record a landing at all, so the "silent half-land" (row says landed,
  -- ticket says unlanded, every dependent wedged forever) is unrepresentable.
  constraint chk_integration_queue_landed_ts
    check (status <> 'landed' or (landed_at is not null and merge_sha is not null)),

  constraint chk_integration_queue_attempts_nonneg
    check (attempts >= 0)
);

comment on table public.integration_queue is
  'Auto-land queue: one row per ticket whose ace/<slug> branch needs landing on '
  'the project''s integration branch. Drained ONE AT A TIME PER PROJECT by the '
  'land-ticket Inngest function (concurrency {limit:1, key:projectId}) — the '
  'FOR UPDATE SKIP LOCKED claim below is a single-row claim, NOT a per-project '
  'mutex, so that concurrency key is what actually serializes landing.';

drop trigger if exists integration_queue_updated_at on public.integration_queue;
create trigger integration_queue_updated_at
  before update on public.integration_queue
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3.1  Duplicate-enqueue guard
--
-- Deliberately BROADER than dispatch_queue's `where status = 'pending'`: a
-- re-fired enqueue (the same ticket reaching done twice, a cron pump racing an
-- event) must not be able to create a second row while the first is already
-- claimed ('landing') or parked on a merger ('awaiting_merge_resolution').
-- Narrowing this to 'pending' would let a ticket land twice.
-- ---------------------------------------------------------------------------
create unique index if not exists uq_integration_queue_ticket_active
  on public.integration_queue (ticket_id)
  where (status in ('pending','landing','awaiting_merge_resolution'));

-- Claim hot path (partial — claimable rows only).
create index if not exists idx_integration_queue_project_pending
  on public.integration_queue (project_id, priority asc, enqueued_at asc)
  where (status = 'pending');

-- Reaper sweep: rows a worker may have died holding.
create index if not exists idx_integration_queue_inflight
  on public.integration_queue (status, heartbeat_at)
  where (status in ('landing','awaiting_merge_resolution'));

-- ---------------------------------------------------------------------------
-- 3.2  Row-Level Security — same threat model as dispatch_queue.
-- Tenant members read their own rows; only service_role (the engine) mutates.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. ticket_land_open(ticket) — "is this ticket's work still NOT on dev, with
--    something still expected to put it there?"
--
-- The one predicate behind BOTH the claim function's dependency gate and (as
-- its TS twin, `classifyBlocker` in lib/integration/landed.ts) the WI-5
-- readiness gate. Three cases, and the third is the one that matters:
--
--   • landed_sha set                     → CLOSED. The work is on dev.
--   • not done                           → OPEN ("working"). Same as legacy.
--   • done, unlanded, has an active or
--     failed integration_queue row       → OPEN ("awaiting_land").
--   • done, unlanded, NO such row        → CLOSED.
--
-- That last case is why this is not simply `landed_sha is null`. Most tickets
-- never produce a branch at all (PM, design, research, the ~48 non-code roles),
-- and an auto-spawned merger ticket carries no branch of its own — it fixes the
-- SOURCE ticket's branch in the source workspace. Gating readiness on
-- `landed_sha is not null` alone would wedge every dependent of every one of
-- them, forever. "Nothing was ever queued to land" is a legitimate CLOSED.
--
-- It also means a project with auto_land_enabled = false derives the exact
-- legacy semantics for free: no queue rows are ever written, so open ⟺ not done.
-- ---------------------------------------------------------------------------
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

comment on function public.ticket_land_open(uuid) is
  'True when the ticket''s work is not yet on the integration branch AND something '
  'is still expected to put it there. TS twin: classifyBlocker() in '
  'lib/integration/landed.ts — keep the two in sync.';

revoke all on function public.ticket_land_open(uuid) from public;
grant execute on function public.ticket_land_open(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. integration_queue_claim_next(project) — atomic claim, in dependency order
--
-- Picks the highest-priority pending row for the project whose blocking
-- relations permit it to land NOW, flips it to 'landing', bumps `attempts` and
-- stamps the heartbeat — all in one statement.
--
-- Dependency gate. `blocked_by` and `builds_on` are the blocking relations
-- (BLOCKING_RELATION_TYPES, lib/board/dependencies.ts) but they gate LANDING
-- differently, and conflating them deadlocks the queue:
--
--   • builds_on  — the child's branch was cut from the parent's, so the
--                  parent's commits must already be on dev or the squash would
--                  replay them. Gate on ticket_land_open(parent).
--   • blocked_by — a gate ticket. The auto-spawned merger is the load-bearing
--                  case: the source ticket is blocked_by its merger, and the
--                  merger has no branch and so can NEVER land. Gating the source
--                  on the merger's landed_sha would park it forever. Gate on
--                  the blocker being DONE, not on it having landed.
--
-- An ineligible row is SKIPPED, not halted on: the ORDER BY simply moves past
-- it and an independent ticket lands instead, so one stalled chain never blocks
-- the whole project's lane (this is what preserves WI-13's parallelism).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6. Backfill — stamp every already-done ticket as landed.
--
-- Without this, flipping auto_land_enabled on would make the whole history read
-- as unlanded: every dependent of every ticket ever completed would be held out
-- of `ready` waiting for a landing that is never going to be enqueued.
--
-- The sha is unknowable retroactively (the work was landed by hand, through PRs
-- we have no record of), so we stamp the sentinel `backfill` rather than invent
-- one. Everything downstream treats landed_sha as an opaque "is it set" flag
-- EXCEPT the builds_on re-root, which roots a child at the parent's sha — and a
-- child of a backfilled parent falls back to the integration tip, which for
-- historical work is exactly right (it contains that work already).
--
-- ticket_land_open() would already report these CLOSED (they have no queue row),
-- so this backfill is belt-and-braces: it makes the truth explicit on the row
-- rather than inferred from an absence.
-- ---------------------------------------------------------------------------
update public.tickets
   set landed_sha    = 'backfill',
       integrated_at = coalesce(updated_at, now())
 where status = 'done'
   and landed_sha is null;

commit;
