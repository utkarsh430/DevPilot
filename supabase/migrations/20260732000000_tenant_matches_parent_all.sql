-- =============================================================================
-- Migration : 20260732000000_tenant_matches_parent_all.sql
-- Purpose   : Make the cross-tenant "attach my row to your parent" class
--             STRUCTURALLY IMPOSSIBLE across the WHOLE schema, not one table at
--             a time.
--
-- Why this exists
-- ───────────────
-- This defect class survived three rounds of app-layer fixes. Each round scoped
-- the named reads; the next reviewer found more. The app-layer `.eq("tenant_id",
-- …)` predicates are worth keeping (they protect against rows already in the
-- table, which no policy can unmake), but they are a per-read discipline and
-- per-read discipline is exactly what kept failing.
--
-- This is the durable guarantee: if no row can EXIST whose tenant disagrees with
-- the parent it points at, then a read keyed on a parent id CANNOT return a
-- foreign row — no matter how many reads forget their predicate.
--
-- The class
-- ─────────
-- Every member write policy in this schema pins the row's OWN `tenant_id` and
-- says nothing about its FK pointers. `runs.ticket_id`, for one, is a nullable
-- FK to ANY ticket. So tenant B could write `{tenant_id: B, ticket_id: <A's
-- ticket>}` — the policy passed — and any RLS-off read keyed on A's ticket id
-- handed B's row back. For `runs` that leaked agent NARRATION; for `comments`, a
-- comment body; for `run_verifications`, forged QA evidence (`exit_code: 0`).
--
-- The covered set is DERIVED, not hand-listed
-- ───────────────────────────────────────────
-- Round 3's trigger list was written from memory and silently omitted
-- `run_verifications` — the exact table that then leaked. So this file's trigger
-- list is GENERATED from a parse of the migrations: every table with a
-- `tenant_id` column × every FK column of that table naming another
-- tenant-scoped table. `lib/security/__tests__/tenant-scope-scan.test.ts`
-- re-derives that enumeration and FAILS if any pair is missing a trigger here,
-- so the set cannot drift as tables are added.
--
-- Two DELIBERATE exclusions (asserted by that same test)
-- ──────────────────────────────────────────────────────
--   • skills.installed_from_skill_id
--   • tool_packages.installed_from_tool_package_id
--
-- These are marketplace PROVENANCE, not ownership: installing a public skill
-- clones it and points at the ORIGINAL, whose tenant is by design someone else's
-- ("trace clones back to their public source" — 20260603090000_m11_marketplace).
-- Enforcing tenant equality on them would break every marketplace install. The
-- distinction is ownership vs provenance, and a blanket "cover every FK" would
-- have shipped an outage.
--
-- Why a trigger and not a policy
-- ──────────────────────────────
-- The service role bypasses RLS entirely, and most writers here ARE the service
-- role (the engine). A WITH CHECK would not see them. A trigger fires for every
-- writer, so this also catches our own engine bugs, not just a hostile member.
--
-- Deploy safety
-- ─────────────
--   • `before insert or update of tenant_id, <ptr>` — an UPDATE that touches
--     neither column does not fire, so ordinary writes are untouched.
--   • NULL pointer ⇒ allowed. Ticket-less runs (supervisor children, ticket-less
--     replays) are a normal supported state.
--   • Missing parent ⇒ allowed; the FK raises its own, clearer error.
--   • Cost is one indexed PK lookup per guarded write.
--   • NOT backfilled. A destructive sweep of runs/comments inside a migration is
--     not something to do silently; the app-layer filters render pre-existing
--     rows inert. The finding query is at the bottom.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- The shared guard. Parameterised by (pointer column, parent table) so the rule
-- is written ONCE and every table gets the identical semantics.
-- ---------------------------------------------------------------------------
create or replace function public.assert_tenant_matches_parent()
returns trigger
language plpgsql
-- SECURITY DEFINER so the parent lookup sees the row regardless of the writer's
-- RLS. Without it a member-role writer's own RLS would hide the foreign parent,
-- the lookup would return NULL, and the guard would fail OPEN — in exactly the
-- case it exists to catch.
security definer
set search_path = public
as $$
declare
  v_ptr_col   text := tg_argv[0];
  v_parent    text := tg_argv[1];
  v_ptr       uuid;
  v_parent_tenant uuid;
begin
  execute format('select ($1).%I', v_ptr_col) into v_ptr using new;

  -- A null pointer names no parent, so there is no tenant to contradict.
  if v_ptr is null then
    return new;
  end if;

  execute format('select tenant_id from public.%I where id = $1', v_parent)
    into v_parent_tenant using v_ptr;

  -- No such parent: let the FK constraint raise its own, clearer error.
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

comment on function public.assert_tenant_matches_parent() is
  'Trigger guard: a row''s tenant_id must equal the tenant of the parent its FK '
  'names. Args: (pointer_column, parent_table). NULL pointer allowed. Applied to '
  'every (tenant_id + FK-to-tenant-scoped-parent) pair except marketplace '
  'provenance (skills/tool_packages installed_from_*), which is cross-tenant by '
  'design. Coverage is asserted by lib/security/__tests__/tenant-scope-scan.test.ts.';

-- ---------------------------------------------------------------------------
-- Generated coverage — one trigger per (table, pointer) pair.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_api_keys_agent_id_tenant on public.api_keys;
create trigger trg_api_keys_agent_id_tenant
  before insert or update of tenant_id, agent_id on public.api_keys
  for each row execute function public.assert_tenant_matches_parent('agent_id', 'agents');

drop trigger if exists trg_branch_promotions_project_id_tenant on public.branch_promotions;
create trigger trg_branch_promotions_project_id_tenant
  before insert or update of tenant_id, project_id on public.branch_promotions
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_comments_ticket_id_tenant on public.comments;
create trigger trg_comments_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.comments
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_dev_server_sessions_pending_push_id_tenant on public.dev_server_sessions;
create trigger trg_dev_server_sessions_pending_push_id_tenant
  before insert or update of tenant_id, pending_push_id on public.dev_server_sessions
  for each row execute function public.assert_tenant_matches_parent('pending_push_id', 'pending_pushes');

drop trigger if exists trg_dev_server_sessions_project_id_tenant on public.dev_server_sessions;
create trigger trg_dev_server_sessions_project_id_tenant
  before insert or update of tenant_id, project_id on public.dev_server_sessions
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_dev_server_sessions_runner_id_tenant on public.dev_server_sessions;
create trigger trg_dev_server_sessions_runner_id_tenant
  before insert or update of tenant_id, runner_id on public.dev_server_sessions
  for each row execute function public.assert_tenant_matches_parent('runner_id', 'runners');

drop trigger if exists trg_dev_server_sessions_ticket_id_tenant on public.dev_server_sessions;
create trigger trg_dev_server_sessions_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.dev_server_sessions
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_dispatch_queue_agent_id_tenant on public.dispatch_queue;
create trigger trg_dispatch_queue_agent_id_tenant
  before insert or update of tenant_id, agent_id on public.dispatch_queue
  for each row execute function public.assert_tenant_matches_parent('agent_id', 'agents');

drop trigger if exists trg_dispatch_queue_ticket_id_tenant on public.dispatch_queue;
create trigger trg_dispatch_queue_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.dispatch_queue
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_exports_project_id_tenant on public.exports;
create trigger trg_exports_project_id_tenant
  before insert or update of tenant_id, project_id on public.exports
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_fan_in_decisions_ticket_id_tenant on public.fan_in_decisions;
create trigger trg_fan_in_decisions_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.fan_in_decisions
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_integration_queue_project_id_tenant on public.integration_queue;
create trigger trg_integration_queue_project_id_tenant
  before insert or update of tenant_id, project_id on public.integration_queue
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_integration_queue_ticket_id_tenant on public.integration_queue;
create trigger trg_integration_queue_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.integration_queue
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_kb_chunks_kb_id_tenant on public.kb_chunks;
create trigger trg_kb_chunks_kb_id_tenant
  before insert or update of tenant_id, kb_id on public.kb_chunks
  for each row execute function public.assert_tenant_matches_parent('kb_id', 'data_sources');

drop trigger if exists trg_merge_conflict_events_merger_ticket_id_tenant on public.merge_conflict_events;
create trigger trg_merge_conflict_events_merger_ticket_id_tenant
  before insert or update of tenant_id, merger_ticket_id on public.merge_conflict_events
  for each row execute function public.assert_tenant_matches_parent('merger_ticket_id', 'tickets');

drop trigger if exists trg_merge_conflict_events_pending_push_id_tenant on public.merge_conflict_events;
create trigger trg_merge_conflict_events_pending_push_id_tenant
  before insert or update of tenant_id, pending_push_id on public.merge_conflict_events
  for each row execute function public.assert_tenant_matches_parent('pending_push_id', 'pending_pushes');

drop trigger if exists trg_merge_conflict_events_project_id_tenant on public.merge_conflict_events;
create trigger trg_merge_conflict_events_project_id_tenant
  before insert or update of tenant_id, project_id on public.merge_conflict_events
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_merge_conflict_events_ticket_id_tenant on public.merge_conflict_events;
create trigger trg_merge_conflict_events_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.merge_conflict_events
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_pending_pushes_merger_ticket_id_tenant on public.pending_pushes;
create trigger trg_pending_pushes_merger_ticket_id_tenant
  before insert or update of tenant_id, merger_ticket_id on public.pending_pushes
  for each row execute function public.assert_tenant_matches_parent('merger_ticket_id', 'tickets');

drop trigger if exists trg_pending_pushes_project_id_tenant on public.pending_pushes;
create trigger trg_pending_pushes_project_id_tenant
  before insert or update of tenant_id, project_id on public.pending_pushes
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_pending_pushes_run_id_tenant on public.pending_pushes;
create trigger trg_pending_pushes_run_id_tenant
  before insert or update of tenant_id, run_id on public.pending_pushes
  for each row execute function public.assert_tenant_matches_parent('run_id', 'runs');

drop trigger if exists trg_pending_pushes_ticket_id_tenant on public.pending_pushes;
create trigger trg_pending_pushes_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.pending_pushes
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_planning_messages_session_id_tenant on public.planning_messages;
create trigger trg_planning_messages_session_id_tenant
  before insert or update of tenant_id, session_id on public.planning_messages
  for each row execute function public.assert_tenant_matches_parent('session_id', 'planning_sessions');

drop trigger if exists trg_planning_proposed_tickets_committed_ticket_id_tenant on public.planning_proposed_tickets;
create trigger trg_planning_proposed_tickets_committed_ticket_id_tenant
  before insert or update of tenant_id, committed_ticket_id on public.planning_proposed_tickets
  for each row execute function public.assert_tenant_matches_parent('committed_ticket_id', 'tickets');

drop trigger if exists trg_planning_proposed_tickets_session_id_tenant on public.planning_proposed_tickets;
create trigger trg_planning_proposed_tickets_session_id_tenant
  before insert or update of tenant_id, session_id on public.planning_proposed_tickets
  for each row execute function public.assert_tenant_matches_parent('session_id', 'planning_sessions');

drop trigger if exists trg_planning_sessions_project_id_tenant on public.planning_sessions;
create trigger trg_planning_sessions_project_id_tenant
  before insert or update of tenant_id, project_id on public.planning_sessions
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_project_handoffs_project_id_tenant on public.project_handoffs;
create trigger trg_project_handoffs_project_id_tenant
  before insert or update of tenant_id, project_id on public.project_handoffs
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_project_handoffs_run_id_tenant on public.project_handoffs;
create trigger trg_project_handoffs_run_id_tenant
  before insert or update of tenant_id, run_id on public.project_handoffs
  for each row execute function public.assert_tenant_matches_parent('run_id', 'runs');

drop trigger if exists trg_project_handoffs_ticket_id_tenant on public.project_handoffs;
create trigger trg_project_handoffs_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.project_handoffs
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_project_secrets_project_id_tenant on public.project_secrets;
create trigger trg_project_secrets_project_id_tenant
  before insert or update of tenant_id, project_id on public.project_secrets
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_project_stack_tags_project_id_tenant on public.project_stack_tags;
create trigger trg_project_stack_tags_project_id_tenant
  before insert or update of tenant_id, project_id on public.project_stack_tags
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_run_verifications_run_id_tenant on public.run_verifications;
create trigger trg_run_verifications_run_id_tenant
  before insert or update of tenant_id, run_id on public.run_verifications
  for each row execute function public.assert_tenant_matches_parent('run_id', 'runs');

drop trigger if exists trg_run_verifications_ticket_id_tenant on public.run_verifications;
create trigger trg_run_verifications_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.run_verifications
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_runs_agent_id_tenant on public.runs;
create trigger trg_runs_agent_id_tenant
  before insert or update of tenant_id, agent_id on public.runs
  for each row execute function public.assert_tenant_matches_parent('agent_id', 'agents');

drop trigger if exists trg_runs_parent_run_id_tenant on public.runs;
create trigger trg_runs_parent_run_id_tenant
  before insert or update of tenant_id, parent_run_id on public.runs
  for each row execute function public.assert_tenant_matches_parent('parent_run_id', 'runs');

drop trigger if exists trg_runs_plan_session_id_tenant on public.runs;
create trigger trg_runs_plan_session_id_tenant
  before insert or update of tenant_id, plan_session_id on public.runs
  for each row execute function public.assert_tenant_matches_parent('plan_session_id', 'planning_sessions');

drop trigger if exists trg_runs_replay_of_run_id_tenant on public.runs;
create trigger trg_runs_replay_of_run_id_tenant
  before insert or update of tenant_id, replay_of_run_id on public.runs
  for each row execute function public.assert_tenant_matches_parent('replay_of_run_id', 'runs');

drop trigger if exists trg_runs_runner_id_tenant on public.runs;
create trigger trg_runs_runner_id_tenant
  before insert or update of tenant_id, runner_id on public.runs
  for each row execute function public.assert_tenant_matches_parent('runner_id', 'runners');

drop trigger if exists trg_runs_ticket_id_tenant on public.runs;
create trigger trg_runs_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.runs
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_schedule_activity_project_id_tenant on public.schedule_activity;
create trigger trg_schedule_activity_project_id_tenant
  before insert or update of tenant_id, project_id on public.schedule_activity
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_schedule_activity_schedule_id_tenant on public.schedule_activity;
create trigger trg_schedule_activity_schedule_id_tenant
  before insert or update of tenant_id, schedule_id on public.schedule_activity
  for each row execute function public.assert_tenant_matches_parent('schedule_id', 'ticket_schedules');

drop trigger if exists trg_schedule_activity_ticket_id_tenant on public.schedule_activity;
create trigger trg_schedule_activity_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.schedule_activity
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_ticket_attachments_ticket_id_tenant on public.ticket_attachments;
create trigger trg_ticket_attachments_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.ticket_attachments
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

drop trigger if exists trg_ticket_schedules_project_id_tenant on public.ticket_schedules;
create trigger trg_ticket_schedules_project_id_tenant
  before insert or update of tenant_id, project_id on public.ticket_schedules
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_tickets_assignee_agent_id_tenant on public.tickets;
create trigger trg_tickets_assignee_agent_id_tenant
  before insert or update of tenant_id, assignee_agent_id on public.tickets
  for each row execute function public.assert_tenant_matches_parent('assignee_agent_id', 'agents');

drop trigger if exists trg_tickets_parent_ticket_id_tenant on public.tickets;
create trigger trg_tickets_parent_ticket_id_tenant
  before insert or update of tenant_id, parent_ticket_id on public.tickets
  for each row execute function public.assert_tenant_matches_parent('parent_ticket_id', 'tickets');

drop trigger if exists trg_tickets_plan_session_id_tenant on public.tickets;
create trigger trg_tickets_plan_session_id_tenant
  before insert or update of tenant_id, plan_session_id on public.tickets
  for each row execute function public.assert_tenant_matches_parent('plan_session_id', 'planning_sessions');

drop trigger if exists trg_tickets_project_id_tenant on public.tickets;
create trigger trg_tickets_project_id_tenant
  before insert or update of tenant_id, project_id on public.tickets
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_tickets_source_run_id_tenant on public.tickets;
create trigger trg_tickets_source_run_id_tenant
  before insert or update of tenant_id, source_run_id on public.tickets
  for each row execute function public.assert_tenant_matches_parent('source_run_id', 'runs');

-- ---------------------------------------------------------------------------
-- Round 3's narrower trigger set is superseded: this file re-guards runs /
-- comments / project_handoffs / pending_pushes via the parameterised function
-- above, alongside every other pair. Drop the old ones so a row is not validated
-- twice with two different error messages.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_runs_tenant_matches_ticket on public.runs;
drop trigger if exists trg_comments_tenant_matches_ticket on public.comments;
drop trigger if exists trg_project_handoffs_tenant_matches_ticket on public.project_handoffs;
drop trigger if exists trg_pending_pushes_tenant_matches_ticket on public.pending_pushes;
drop function if exists public.assert_tenant_matches_ticket();

-- ---------------------------------------------------------------------------
-- Finding pre-existing violations (deliberately NOT auto-fixed — see header).
-- Example for the two that leaked content; the same shape applies to each pair:
--
--   select 'runs' as tbl, r.id, r.tenant_id, t.tenant_id as parent_tenant
--     from public.runs r join public.tickets t on t.id = r.ticket_id
--    where r.tenant_id <> t.tenant_id
--   union all
--   select 'run_verifications', v.id, v.tenant_id, r.tenant_id
--     from public.run_verifications v join public.runs r on r.id = v.run_id
--    where v.tenant_id <> r.tenant_id;
--
-- On a healthy instance this returns zero rows, and the triggers keep it so.
-- ---------------------------------------------------------------------------

commit;
