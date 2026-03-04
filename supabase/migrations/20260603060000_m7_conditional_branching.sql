-- =============================================================================
-- Migration : 20260603060000_m7_conditional_branching.sql
-- Phase     : Phase 1 / M7 — Conditional branching (F-ORC-05).
-- Purpose   : Wire the data model for role-driven conditional routing.
--             Adds:
--               1. runs.branch_key      — text; the branch key the role's
--                                          postprocess parsed from its final
--                                          assistant text (e.g. "small_change",
--                                          "large_change"). Null on roles
--                                          that don't declare a `branches` map
--                                          or didn't emit a key.
--               2. tickets.branch_hops  — int; counts how many times the
--                                          dispatcher has routed via a
--                                          `branches` map for this ticket.
--                                          Hard cap (MAX_BRANCH_HOPS=4)
--                                          enforced app-side; the column is
--                                          the durable cycle guard.
--               3. tech_lead built-in agent — materialized per tenant as the
--                                          canonical "deeper review" target
--                                          for the large_change branch.
--
-- Design notes
-- ────────────
-- • branch_key lives on the run row (not run_steps) so the dispatcher's
--   "what did the last role decide?" query is a single indexed lookup keyed
--   by (tenant_id, ticket_id) — no jsonb digging through run_steps.
-- • branch_hops on the ticket (not on the run) survives across role
--   transitions and is the natural cycle-guard surface — the dispatcher
--   bumps it each time it picks the next role via `branches[branchKey]`.
-- • A missing/invalid branch key MUST NOT crash the dispatcher (M7 spec) —
--   the dispatcher falls back to the state-machine decision. The DB
--   tolerates branch_key being any text; validation is app-side.
-- • The tech_lead row is added by extending `materialize_builtin_agents`,
--   following the M4/M6 pattern. Backfills for existing tenants.
--
-- Execution notes
-- ───────────────
-- Single transaction. Apply via `supabase db push`. Existing tickets get
-- branch_hops=0; existing runs get branch_key=NULL — both no-ops for any
-- pre-M7 flow.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1.1  runs.branch_key — durable branch decision from the just-completed role.
-- ---------------------------------------------------------------------------
alter table public.runs
  add column if not exists branch_key text;

-- Tiny defensive cap — the dispatcher only reads short identifiers like
-- "small_change", "large_change". Anything longer is almost certainly bad
-- input from a buggy postprocess parser and we don't want it leaking into
-- log lines unbounded.
alter table public.runs
  drop constraint if exists runs_branch_key_short_chk;
alter table public.runs
  add constraint runs_branch_key_short_chk
    check (branch_key is null or char_length(branch_key) <= 64);

-- Lookup index for "latest completed run on this ticket carrying a branch
-- key" — the dispatcher's hot path inside decideNextRole.
create index if not exists runs_ticket_branch_key_idx
  on public.runs(ticket_id, last_event_at desc)
  where branch_key is not null;

-- ---------------------------------------------------------------------------
-- 1.2  tickets.branch_hops — durable cycle-guard counter.
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists branch_hops int not null default 0;

-- Defensive ceiling at the DB layer too. The app's MAX_BRANCH_HOPS default
-- is 4; we leave generous headroom (16) so an operator-tuned higher cap
-- doesn't trip the CHECK before app-side guard kicks in.
alter table public.tickets
  drop constraint if exists tickets_branch_hops_ceiling_chk;
alter table public.tickets
  add constraint tickets_branch_hops_ceiling_chk
    check (branch_hops >= 0 and branch_hops <= 16);

-- ---------------------------------------------------------------------------
-- 1.3  Materialize the Tech Lead agent row per tenant.
-- Extends `materialize_builtin_agents` so future tenants get the row at
-- creation time; backfills existing tenants. This is the M7 canonical
-- "deeper review" target for the large_change branch.
-- ---------------------------------------------------------------------------
create or replace function public.materialize_builtin_agents(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_roles jsonb := jsonb_build_array(
    jsonb_build_object('role', 'pm',         'name', 'PM',            'model_tier', 'default'),
    jsonb_build_object('role', 'engineer',   'name', 'Engineer',      'model_tier', 'default'),
    jsonb_build_object('role', 'qa',         'name', 'QA',            'model_tier', 'default'),
    jsonb_build_object('role', 'devops',     'name', 'DevOps',        'model_tier', 'default'),
    jsonb_build_object('role', 'techwriter', 'name', 'Tech Writer',   'model_tier', 'default'),
    jsonb_build_object('role', 'designer',   'name', 'Designer',      'model_tier', 'default'),
    jsonb_build_object('role', 'dataeng',    'name', 'Data Engineer', 'model_tier', 'heavy'),
    jsonb_build_object('role', 'security',   'name', 'Security',      'model_tier', 'default'),
    jsonb_build_object('role', 'triage',     'name', 'Triage',        'model_tier', 'default'),
    jsonb_build_object('role', 'tech_lead',  'name', 'Tech Lead',     'model_tier', 'heavy')
  );
  v_row jsonb;
begin
  for v_row in select * from jsonb_array_elements(v_roles)
  loop
    insert into public.agents (tenant_id, name, role, config)
    select p_tenant_id,
           v_row->>'name',
           v_row->>'role',
           jsonb_build_object(
             'wip_limit', 3,
             'assignment_mode', 'push',
             'runner_policy', 'local-cc',
             'model_tier', v_row->>'model_tier'
           )
    where not exists (
      select 1 from public.agents
      where tenant_id = p_tenant_id and role = v_row->>'role'
    );
  end loop;
end;
$$;

revoke all on function public.materialize_builtin_agents(uuid) from public;
grant execute on function public.materialize_builtin_agents(uuid) to service_role;

-- Backfill the triage + tech_lead agents for existing tenants. Idempotent.
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.materialize_builtin_agents(t.id);
  end loop;
end;
$$;

commit;
