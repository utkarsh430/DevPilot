-- =============================================================================
-- audit-tenant-parent-mismatches.sql
--
-- GENERATED FILE -- do not edit by hand.
-- Source: apps/web/scripts/generate-tenant-parent-audit.ts
-- Regenerate: pnpm --filter @devpilot/web tsx scripts/generate-tenant-parent-audit.ts
--
-- Reports every EXISTING row whose `tenant_id` disagrees with the tenant of the
-- parent its pointer names -- i.e. rows the cross-tenant class could have written
-- BEFORE the guards existed.
--
-- Why this script exists
-- ----------------------
-- `20260732000000_tenant_matches_parent_all.sql` makes such a row unwritable
-- from now on, and the app-layer `.eq("tenant_id", ...)` predicates stop reads
-- returning one. Neither can do anything about a row ALREADY written by one of
-- the round-1..4 holes: a trigger validates writes, not history, and the
-- migration deliberately does not backfill (a silent destructive sweep of
-- runs/comments is not something to do inside a migration).
--
-- So "the class is closed" is only fully true once this returns ZERO ROWS on
-- prod. Run it before trusting the close.
--
-- How to run
--   psql "$SUPABASE_DB_URL" -f apps/web/scripts/audit-tenant-parent-mismatches.sql
--
-- Read-only: pure SELECTs, no writes, safe against a live database.
--
-- Expected output
--   Zero rows, twice (detail, then summary). Anything returned is a real
--   cross-tenant row. Cleanup is deliberately NOT automated here: the right call
--   depends on what wrote the row, and deleting a customer's runs or comments on
--   the strength of a script is not a decision to take blind.
--
-- Coverage
-- --------
-- The 60 pairs below are `guardedTenantPointers` -- every relationship in the
-- schema (FK-derived UNION the curated non-FK ones, so the FK-less
-- `schedule_activity.project_id` is covered too) MINUS the cross-tenant-by-design
-- set. The triggers and the static detector read that same set, so this audit
-- cannot check a pair the DB does not guard, or skip one it does.
--
-- Deliberately EXCLUDED (`CROSS_TENANT_BY_DESIGN`, lib/security/tenant-scope-scan.ts).
-- A mismatch on these is CORRECT, so auditing them would report healthy rows as
-- findings and bury the real ones:
--   * skills.installed_from_skill_id -> skills
--     marketplace PROVENANCE, not ownership: installing a public skill
--     clones it and points at the ORIGINAL, whose tenant is by design
--     someone else's.
--
--   * tool_packages.installed_from_tool_package_id -> tool_packages
--     marketplace PROVENANCE — same as skills.installed_from_skill_id.
--
--   * runs.runner_id -> runners
--     runners are SHARED ACROSS TENANTS. A runner registers under one
--     tenant (api/runners/register) but the claim route stamps
--     runs.runner_id keyed only on (run id, runner_id IS NULL) with NO
--     tenant filter — so a runner legitimately executes another tenant's
--     run. Prod confirms it: one runner served all 3 tenants, 8 runs carry
--     tenant_id != runners.tenant_id, all old and terminal. A trigger here
--     REJECTS a legitimate claim and wedges the run.
--
--   * dev_server_sessions.runner_id -> runners
--     same shared-runner relationship as runs.runner_id — a dev-server
--     session runs on whichever runner owns the workspace host, not on one
--     of its own tenant's.
--
-- =============================================================================

\timing on

-- -- 1. Detail: every mismatched row ----------------------------------------
with mismatches as (
  select
    'agent_learnings'::text as child_table,
    'source_mistake_id'::text as pointer_column,
    'agent_mistakes'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_learnings c
  join public.agent_mistakes p on p.id = c.source_mistake_id
  where c.source_mistake_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_mistakes'::text as child_table,
    'agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_mistakes c
  join public.agents p on p.id = c.agent_id
  where c.agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_mistakes'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_mistakes c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_mistakes'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_mistakes c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_project_models'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_project_models c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_prompt_overlays'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_prompt_overlays c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'api_keys'::text as child_table,
    'agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.api_keys c
  join public.agents p on p.id = c.agent_id
  where c.agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'branch_promotions'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.branch_promotions c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'comments'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.comments c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dev_server_sessions'::text as child_table,
    'pending_push_id'::text as pointer_column,
    'pending_pushes'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dev_server_sessions c
  join public.pending_pushes p on p.id = c.pending_push_id
  where c.pending_push_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dev_server_sessions'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dev_server_sessions c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dev_server_sessions'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dev_server_sessions c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dispatch_queue'::text as child_table,
    'agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dispatch_queue c
  join public.agents p on p.id = c.agent_id
  where c.agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dispatch_queue'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dispatch_queue c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'exports'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.exports c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'fan_in_decisions'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.fan_in_decisions c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'integration_queue'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.integration_queue c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'integration_queue'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.integration_queue c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'kb_chunks'::text as child_table,
    'kb_id'::text as pointer_column,
    'data_sources'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.kb_chunks c
  join public.data_sources p on p.id = c.kb_id
  where c.kb_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'merge_conflict_events'::text as child_table,
    'merger_ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.merge_conflict_events c
  join public.tickets p on p.id = c.merger_ticket_id
  where c.merger_ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'merge_conflict_events'::text as child_table,
    'pending_push_id'::text as pointer_column,
    'pending_pushes'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.merge_conflict_events c
  join public.pending_pushes p on p.id = c.pending_push_id
  where c.pending_push_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'merge_conflict_events'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.merge_conflict_events c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'merge_conflict_events'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.merge_conflict_events c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'pending_pushes'::text as child_table,
    'merger_ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.pending_pushes c
  join public.tickets p on p.id = c.merger_ticket_id
  where c.merger_ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'pending_pushes'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.pending_pushes c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'pending_pushes'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.pending_pushes c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'pending_pushes'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.pending_pushes c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'planning_messages'::text as child_table,
    'session_id'::text as pointer_column,
    'planning_sessions'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.planning_messages c
  join public.planning_sessions p on p.id = c.session_id
  where c.session_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'planning_proposed_tickets'::text as child_table,
    'committed_ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.planning_proposed_tickets c
  join public.tickets p on p.id = c.committed_ticket_id
  where c.committed_ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'planning_proposed_tickets'::text as child_table,
    'session_id'::text as pointer_column,
    'planning_sessions'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.planning_proposed_tickets c
  join public.planning_sessions p on p.id = c.session_id
  where c.session_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'planning_sessions'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.planning_sessions c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_deployments'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_deployments c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_deployments'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_deployments c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_handoffs'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_handoffs c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_handoffs'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_handoffs c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_handoffs'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_handoffs c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_secrets'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_secrets c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_stack_tags'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_stack_tags c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'run_artifacts'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.run_artifacts c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'run_verifications'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.run_verifications c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'run_verifications'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.run_verifications c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.agents p on p.id = c.agent_id
  where c.agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'parent_run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.runs p on p.id = c.parent_run_id
  where c.parent_run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'plan_session_id'::text as pointer_column,
    'planning_sessions'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.planning_sessions p on p.id = c.plan_session_id
  where c.plan_session_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'replay_of_run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.runs p on p.id = c.replay_of_run_id
  where c.replay_of_run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'schedule_activity'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.schedule_activity c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'schedule_activity'::text as child_table,
    'schedule_id'::text as pointer_column,
    'ticket_schedules'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.schedule_activity c
  join public.ticket_schedules p on p.id = c.schedule_id
  where c.schedule_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'schedule_activity'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.schedule_activity c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'supervisor_actions'::text as child_table,
    'console_message_id'::text as pointer_column,
    'supervisor_console_messages'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.supervisor_actions c
  join public.supervisor_console_messages p on p.id = c.console_message_id
  where c.console_message_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'supervisor_actions'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.supervisor_actions c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'supervisor_actions'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.supervisor_actions c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'supervisor_console_messages'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.supervisor_console_messages c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'ticket_attachments'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.ticket_attachments c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'ticket_schedules'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.ticket_schedules c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'assignee_agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.agents p on p.id = c.assignee_agent_id
  where c.assignee_agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'parent_ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.tickets p on p.id = c.parent_ticket_id
  where c.parent_ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'plan_session_id'::text as pointer_column,
    'planning_sessions'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.planning_sessions p on p.id = c.plan_session_id
  where c.plan_session_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'source_run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.runs p on p.id = c.source_run_id
  where c.source_run_id is not null
    and c.tenant_id is distinct from p.tenant_id
)
select child_table, pointer_column, parent_table, child_id, child_tenant, parent_tenant
from mismatches
order by child_table, pointer_column, child_id;

-- -- 2. Summary: counts per (table, pointer). Zero rows = the close holds for
--    every guarded pair. ------------------------------------------------------
with mismatches as (
  select
    'agent_learnings'::text as child_table,
    'source_mistake_id'::text as pointer_column,
    'agent_mistakes'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_learnings c
  join public.agent_mistakes p on p.id = c.source_mistake_id
  where c.source_mistake_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_mistakes'::text as child_table,
    'agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_mistakes c
  join public.agents p on p.id = c.agent_id
  where c.agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_mistakes'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_mistakes c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_mistakes'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_mistakes c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_project_models'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_project_models c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'agent_prompt_overlays'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.agent_prompt_overlays c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'api_keys'::text as child_table,
    'agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.api_keys c
  join public.agents p on p.id = c.agent_id
  where c.agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'branch_promotions'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.branch_promotions c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'comments'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.comments c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dev_server_sessions'::text as child_table,
    'pending_push_id'::text as pointer_column,
    'pending_pushes'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dev_server_sessions c
  join public.pending_pushes p on p.id = c.pending_push_id
  where c.pending_push_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dev_server_sessions'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dev_server_sessions c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dev_server_sessions'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dev_server_sessions c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dispatch_queue'::text as child_table,
    'agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dispatch_queue c
  join public.agents p on p.id = c.agent_id
  where c.agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'dispatch_queue'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.dispatch_queue c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'exports'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.exports c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'fan_in_decisions'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.fan_in_decisions c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'integration_queue'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.integration_queue c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'integration_queue'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.integration_queue c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'kb_chunks'::text as child_table,
    'kb_id'::text as pointer_column,
    'data_sources'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.kb_chunks c
  join public.data_sources p on p.id = c.kb_id
  where c.kb_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'merge_conflict_events'::text as child_table,
    'merger_ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.merge_conflict_events c
  join public.tickets p on p.id = c.merger_ticket_id
  where c.merger_ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'merge_conflict_events'::text as child_table,
    'pending_push_id'::text as pointer_column,
    'pending_pushes'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.merge_conflict_events c
  join public.pending_pushes p on p.id = c.pending_push_id
  where c.pending_push_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'merge_conflict_events'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.merge_conflict_events c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'merge_conflict_events'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.merge_conflict_events c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'pending_pushes'::text as child_table,
    'merger_ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.pending_pushes c
  join public.tickets p on p.id = c.merger_ticket_id
  where c.merger_ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'pending_pushes'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.pending_pushes c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'pending_pushes'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.pending_pushes c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'pending_pushes'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.pending_pushes c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'planning_messages'::text as child_table,
    'session_id'::text as pointer_column,
    'planning_sessions'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.planning_messages c
  join public.planning_sessions p on p.id = c.session_id
  where c.session_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'planning_proposed_tickets'::text as child_table,
    'committed_ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.planning_proposed_tickets c
  join public.tickets p on p.id = c.committed_ticket_id
  where c.committed_ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'planning_proposed_tickets'::text as child_table,
    'session_id'::text as pointer_column,
    'planning_sessions'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.planning_proposed_tickets c
  join public.planning_sessions p on p.id = c.session_id
  where c.session_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'planning_sessions'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.planning_sessions c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_deployments'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_deployments c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_deployments'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_deployments c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_handoffs'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_handoffs c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_handoffs'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_handoffs c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_handoffs'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_handoffs c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_secrets'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_secrets c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'project_stack_tags'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.project_stack_tags c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'run_artifacts'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.run_artifacts c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'run_verifications'::text as child_table,
    'run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.run_verifications c
  join public.runs p on p.id = c.run_id
  where c.run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'run_verifications'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.run_verifications c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.agents p on p.id = c.agent_id
  where c.agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'parent_run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.runs p on p.id = c.parent_run_id
  where c.parent_run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'plan_session_id'::text as pointer_column,
    'planning_sessions'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.planning_sessions p on p.id = c.plan_session_id
  where c.plan_session_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'replay_of_run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.runs p on p.id = c.replay_of_run_id
  where c.replay_of_run_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'runs'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.runs c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'schedule_activity'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.schedule_activity c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'schedule_activity'::text as child_table,
    'schedule_id'::text as pointer_column,
    'ticket_schedules'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.schedule_activity c
  join public.ticket_schedules p on p.id = c.schedule_id
  where c.schedule_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'schedule_activity'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.schedule_activity c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'supervisor_actions'::text as child_table,
    'console_message_id'::text as pointer_column,
    'supervisor_console_messages'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.supervisor_actions c
  join public.supervisor_console_messages p on p.id = c.console_message_id
  where c.console_message_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'supervisor_actions'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.supervisor_actions c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'supervisor_actions'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.supervisor_actions c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'supervisor_console_messages'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.supervisor_console_messages c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'ticket_attachments'::text as child_table,
    'ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.ticket_attachments c
  join public.tickets p on p.id = c.ticket_id
  where c.ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'ticket_schedules'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.ticket_schedules c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'assignee_agent_id'::text as pointer_column,
    'agents'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.agents p on p.id = c.assignee_agent_id
  where c.assignee_agent_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'parent_ticket_id'::text as pointer_column,
    'tickets'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.tickets p on p.id = c.parent_ticket_id
  where c.parent_ticket_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'plan_session_id'::text as pointer_column,
    'planning_sessions'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.planning_sessions p on p.id = c.plan_session_id
  where c.plan_session_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'project_id'::text as pointer_column,
    'projects'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.projects p on p.id = c.project_id
  where c.project_id is not null
    and c.tenant_id is distinct from p.tenant_id
  union all
  select
    'tickets'::text as child_table,
    'source_run_id'::text as pointer_column,
    'runs'::text as parent_table,
    c.id::text as child_id,
    c.tenant_id::text as child_tenant,
    p.tenant_id::text as parent_tenant
  from public.tickets c
  join public.runs p on p.id = c.source_run_id
  where c.source_run_id is not null
    and c.tenant_id is distinct from p.tenant_id
)
select child_table, pointer_column, parent_table, count(*) as mismatched_rows
from mismatches
group by child_table, pointer_column, parent_table
order by mismatched_rows desc;
