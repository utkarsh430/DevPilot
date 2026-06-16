-- =============================================================================
-- Migration : 20260717000000_agent_ticket_creation.sql
-- Phase     : 2 / WI-14 - an engineer agent that finds out-of-scope work can
--             file a NEW backlog ticket for it instead of silently widening
--             its own scope (or dropping the finding on the floor).
--
-- What this adds
-- ──────────────
-- • projects.agent_ticket_creation - the per-project opt-in. FALSE by default:
--   letting an agent create work is a real change in what the platform may do
--   on the operator's dime, so it is off until someone turns it on. Same shape
--   and same reasoning as `projects.auto_land_enabled` (20260715000000).
--
-- • tickets.source_run_id - provenance. Which agent RUN filed this ticket
--   (NULL for every human/plan/builder-created ticket, i.e. all of them today).
--   This is what makes an agent-filed ticket auditable after the fact, and it
--   is the join the board/drawer uses to link a ticket back to the run that
--   noticed the work.
--
-- • runs.tickets_created_count + runs_claim_ticket_slot() - the DURABLE
--   per-run fan-out cap. CLAUDE.md §3: "no agent spawn without passing max
--   fan-out". Filing tickets is a spawn in slow motion - each one can become a
--   billable run once a human promotes it - so it gets the same treatment as
--   `runs.children_count` / `runs_increment_children` (20260603050000), for the
--   same reason: an app-side `select count(*)` is a TOCTOU race, and a counter
--   that lives anywhere but the durable run row does not survive a restart.
--
--   Difference from `runs_increment_children`: the cap is enforced INSIDE the
--   statement (`where tickets_created_count < p_max`) rather than by a separate
--   assert-then-increment pair, so two concurrent tool calls from the same run
--   cannot both read "one slot left" and both take it.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. projects.agent_ticket_creation - the per-project opt-in
-- ---------------------------------------------------------------------------
alter table public.projects
  add column if not exists agent_ticket_creation boolean not null default false;

comment on column public.projects.agent_ticket_creation is
  'Opt-in: when true, an agent running a ticket in this project may file NEW '
  'backlog tickets via the ace_create_ticket MCP tool. Agent-filed tickets always '
  'land in `backlog` with requested_role NULL - they reach `ready` (and therefore '
  'a billable run) only via the existing human/unblock path. FALSE = the tool '
  'refuses.';

-- ---------------------------------------------------------------------------
-- 2. tickets.source_run_id - agent-created-ticket provenance
--
-- ON DELETE SET NULL, not CASCADE: a run's retention policy must never be able
-- to delete a ticket. Losing the pointer is acceptable; losing the work is not.
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists source_run_id uuid
    references public.runs(id) on delete set null;

comment on column public.tickets.source_run_id is
  'The agent run that FILED this ticket (ace_create_ticket), or NULL when a human, '
  'the planner, or the workflow builder created it. Provenance only - nothing '
  'gates on it.';

-- Partial: the overwhelming majority of tickets are human-created (NULL), and
-- the only query shape is "which tickets did this run file?".
create index if not exists tickets_source_run_id_idx
  on public.tickets(source_run_id)
  where source_run_id is not null;

-- ---------------------------------------------------------------------------
-- 3. runs.tickets_created_count - the durable per-run fan-out counter
-- ---------------------------------------------------------------------------
alter table public.runs
  add column if not exists tickets_created_count int not null default 0
    check (tickets_created_count >= 0);

comment on column public.runs.tickets_created_count is
  'How many tickets this run has filed via ace_create_ticket. Claimed atomically '
  'by runs_claim_ticket_slot() so the ACE_MAX_TICKETS_PER_RUN cap holds under '
  'concurrent tool calls. Mirrors runs.children_count for spawns.';

-- ---------------------------------------------------------------------------
-- 4. runs_claim_ticket_slot(run, max) - atomic cap-check + increment
--
-- Returns the post-increment count (>= 1) when a slot was claimed.
-- Returns -1 when the run is already AT the cap (nothing incremented).
-- Raises when the run does not exist - an unknown ACE_RUN_ID is a broken
-- relay, not a cap refusal, and the two must not be confused by the caller.
--
-- SECURITY DEFINER + pinned search_path, matching runs_increment_children:
-- the only caller is the service_role engine route, which is outside RLS.
--
-- A claimed slot is NOT released if the subsequent insert fails. That is
-- deliberate and fail-closed: it burns one slot out of ACE_MAX_TICKETS_PER_RUN
-- on a rare DB error, which is strictly safer than a release path an agent
-- could drive in a loop.
-- ---------------------------------------------------------------------------
create or replace function public.runs_claim_ticket_slot(p_run_id uuid, p_max int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- The cap lives in the WHERE clause: the row lock taken by this UPDATE
  -- serialises concurrent claims, and a claim that would cross p_max simply
  -- matches no row.
  update public.runs
     set tickets_created_count = tickets_created_count + 1
   where id = p_run_id
     and tickets_created_count < p_max
  returning tickets_created_count into v_count;

  if v_count is not null then
    return v_count;
  end if;

  -- No row updated: either the run is at the cap, or it does not exist.
  if not exists (select 1 from public.runs where id = p_run_id) then
    raise exception 'runs_claim_ticket_slot: run % not found', p_run_id;
  end if;

  return -1;
end;
$$;

revoke all on function public.runs_claim_ticket_slot(uuid, int) from public;
grant execute on function public.runs_claim_ticket_slot(uuid, int) to service_role;

commit;
