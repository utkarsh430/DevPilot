-- =============================================================================
-- Migration : 20260603190000_phase2_5_cohort_plan.sql
-- Phase     : Phase 2.5 / M6 — Workflow Builder that actually runs.
--
-- Purpose
-- ───────
-- M6 single-cohort fan-out (engineer + security joined to qa) shipped behind
-- `tickets.acceptance_strategy`. Phase 2.5 widens the runtime to true
-- multi-stage DAGs whose visual contract in the builder matches what the
-- engine executes: leaf siblings of one cohort may themselves trigger nested
-- child cohorts, each with their own acceptance strategy and fan-in role.
--
-- The contract is the new `tickets.cohort_plan jsonb`. Its shape is locked
-- by the M6 plan file (when-i-i-got-crystalline-tulip.md):
--
--   {
--     "version": 1,
--     "cohorts": [
--       {
--         "cohort_key": "review",
--         "members": ["engineer", "security"],
--         "acceptance_strategy": "all",     // "single" | "all" | "quorum(n)"
--         "fan_in_role": "qa",              // null → state machine
--         "parent_cohort_key": null,        // null → top-level
--         "trigger_role": "pm"              // top-level: dispatcher pick
--                                           // nested: sibling leaf role
--       },
--       ...
--     ]
--   }
--
-- The cohort_plan is COPIED FROM the agent's `config.cohort_plan` onto the
-- ticket row at creation time (by the builder's createTicket action) so a
-- ticket's plan is immutable post-creation even if the operator edits the
-- agent definition mid-flight.
--
-- This migration adds:
--   1. tickets.cohort_plan jsonb — nullable. CHECK that, when set, the inner
--      cohorts field is an array (cheap shape validation at the DB).
--   2. runs.cohort_key text — non-null on runs seeded by a cohort fan-out,
--      keyed to the cohort entry whose member this run is filling.
--   3. runs.cohort_depth int default 0 — 0 for top-level cohorts and Phase 0
--      single-emit runs, +1 for each nested level. Cap-checked by spawning.ts
--      against MAX_COHORT_DEPTH (default 2) at fan-out time.
--   4. Partial index runs_ticket_cohort_idx — the aggregator's "all runs in
--      this ticket × this cohort" hot path.
--   5. Partial index tickets_cohort_plan_idx — narrows the "tickets with a
--      cohort plan" scans the dispatcher does, cheap to maintain because
--      most tickets are single-emit.
--
-- Idempotent: re-runnable. All adds use `if not exists`; constraints are
-- drop-and-recreate.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1.1  tickets.cohort_plan — the per-ticket DAG description.
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists cohort_plan jsonb;

-- Defensive shape check: when non-null, `cohort_plan.cohorts` must be a JSON
-- array. The engine's parseCohortPlan does the full structural validation
-- (cohort_key, members[], acceptance_strategy parsing) at fan-out time and
-- throws NonRetriableError on bad shape. This constraint is the belt-and-
-- braces "the DB column at least looks like our contract" guard.
alter table public.tickets
  drop constraint if exists tickets_cohort_plan_shape_chk;
alter table public.tickets
  add constraint tickets_cohort_plan_shape_chk
    check (
      cohort_plan is null
      or jsonb_typeof(cohort_plan->'cohorts') = 'array'
    );

-- Partial index: most tickets won't carry a cohort_plan (single-emit + legacy
-- M6 single-cohort path don't need one), so a partial index keeps the bytes
-- cheap. Engine reads via (tenant_id, ticket_id) with cohort_plan IS NOT NULL.
create index if not exists tickets_cohort_plan_idx
  on public.tickets(tenant_id)
  where cohort_plan is not null;

-- ---------------------------------------------------------------------------
-- 1.2  runs.cohort_key, runs.cohort_depth — per-run cohort attribution.
-- ---------------------------------------------------------------------------
alter table public.runs
  add column if not exists cohort_key   text,
  add column if not exists cohort_depth int not null default 0;

-- Depth is non-negative. CHECK protects the cap-check in spawning.ts from a
-- corrupted value (e.g. a future migration miscount); drop-and-recreate so
-- this migration stays re-runnable.
alter table public.runs
  drop constraint if exists runs_cohort_depth_chk;
alter table public.runs
  add constraint runs_cohort_depth_chk
    check (cohort_depth >= 0);

-- Hot-path index: the aggregator's "all runs for (tenant, ticket, cohort)"
-- lookup. Partial so only cohort-seeded runs cost bytes; single-emit runs
-- carry cohort_key=NULL and don't show up here.
create index if not exists runs_ticket_cohort_idx
  on public.runs(tenant_id, ticket_id, cohort_key)
  where cohort_key is not null;

commit;
