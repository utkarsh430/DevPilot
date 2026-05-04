-- =============================================================================
-- Migration : 20260610010000_team_tiers.sql
-- Team-tier presets — Quick / Standard / Thorough.
--
-- Adds a single team_tier knob on every project (default 'standard') and an
-- optional override on each planning_session. The planner pipeline (panels +
-- consolidator) reads the effective tier (session-override falls back to
-- project default) and uses it to:
--   • restrict which role slugs the consolidator may assign to a ticket
--   • cap the number of proposed tickets (quick=6, standard=15, thorough=30)
--   • bias the prompt toward bundling cross-role work in lower tiers
--
-- Existing rows in `projects` get 'standard' via the default, so behaviour
-- is unchanged unless an operator picks a different tier on the new-project
-- form or the project settings page.
--
-- Forward-only and re-runnable.
-- =============================================================================
begin;

do $$ begin
  create type public.team_tier as enum ('quick', 'standard', 'thorough');
exception when duplicate_object then null; end $$;

alter table public.projects
  add column if not exists team_tier public.team_tier not null default 'standard';

alter table public.planning_sessions
  add column if not exists team_tier public.team_tier;

commit;
