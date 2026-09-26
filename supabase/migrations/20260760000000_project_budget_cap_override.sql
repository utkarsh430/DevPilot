-- =============================================================================
-- Migration : 20260760000000_project_budget_cap_override.sql
-- Phase     : per-project opt-in to bypass the PER-RUN dollar/token ceiling.
--
-- Why
-- ───
-- `assertCanProceed` (apps/web/lib/engine/budget.ts) checked the per-run cap
-- as a TURNSTILE: it refused a NEW action from starting once spend was
-- exhausted, but nothing ever re-checked a JUST-COMPLETED action against the
-- cap. Because every dispatch path sends `iterations: 1`, a run's one step IS
-- its whole lifecycle - the cap was checked once at spent=0 (which trivially
-- passes) and never again. Measured across the last 500 runs (2026-08-06/07):
-- 13 exceeded their cap, $32.92 spent beyond them, worst case 996¢ against a
-- 500¢ cap (~2x) - and every one of those runs then completed NORMALLY, with
-- nothing anywhere recording that the cap had been blown.
--
-- `run-agent.ts` now re-runs the same ceiling check immediately after every
-- step's spend is recorded, so a run that just went over stops cleanly at
-- that boundary (never mid-action) instead of silently continuing. See
-- apps/web/lib/engine/budget-ceiling-policy.ts for the full argument.
--
-- Some tickets are legitimately expensive and an operator may not want that
-- work cut off mid-flight for cost - hence this column. It is an ESCAPE HATCH
-- from the PER-RUN ceiling ONLY: the tenant-wide cost-velocity circuit
-- breaker (VELOCITY_LIMIT_CENTS_PER_MIN, budget.ts) is NEVER bypassed by it,
-- so "ignore my cap" never means "no ceiling at all", and one overridden
-- project cannot starve every other project sharing the tenant's spend
-- window - it is throttled by the exact same shared bucket as everyone else.
--
-- DEFAULT FALSE, following `auto_land_enabled` / `supervisor_enabled` /
-- `agent_ticket_creation` end to end: an existing project's runs are stopped
-- exactly as before until an operator opts in, writable ONLY through the
-- operator-gated `setBudgetCapOverrideAction` - no agent, MCP tool, runner
-- route or engine path touches this column.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. projects.budget_cap_override_enabled - the per-project opt-in.
-- ---------------------------------------------------------------------------
alter table public.projects
  add column if not exists budget_cap_override_enabled boolean not null default false;

comment on column public.projects.budget_cap_override_enabled is
  'Per-project opt-in: bypass the PER-RUN dollar/token ceiling '
  '(runs.budget_cents) for this project''s ticket runs. OFF by default. Does '
  'NOT bypass the tenant-wide cost-velocity circuit breaker (budget.ts), '
  'which remains the backstop - "ignore my cap" never means "no ceiling at '
  'all". Written only by the operator-gated setBudgetCapOverrideAction.';

-- ---------------------------------------------------------------------------
-- 2. shell_bootstrap() rewrite - IN THIS MIGRATION, mandatory.
--
--    20260756000000's definition verbatim, plus budget_cap_override_enabled.
--    apps/web/lib/projects/load.ts's PROJECT_COLUMNS and this select list
--    both feed mapProjectRow - a column present in one and not the other
--    comes back SILENTLY DEFAULTED (to `false`, i.e. cap enforced) on
--    whichever path omitted it, which is the safe direction for a cost
--    setting to drift toward.
-- ---------------------------------------------------------------------------
create or replace function public.shell_bootstrap(p_tenant uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'projects', coalesce((
      select jsonb_agg(to_jsonb(pr) order by pr.created_at asc)
      from (
        select id, tenant_id, name, description, repo_url, github_repo_id,
               github_owner, github_repo, default_branch, integration_branch,
               auto_land_enabled, agent_ticket_creation, agent_ticket_max_per_run,
               supervisor_enabled, budget_cap_override_enabled,
               team_tier, project_type,
               llm_provider, llm_base_url, llm_credential_ref, llm_model,
               stack_ecosystem,
               vercel_project_id, vercel_project_name, vercel_production_url,
               vercel_production_branch, vercel_production_branch_desired,
               vercel_prod_deploy_mode,
               vercel_linked_at, vercel_linked_by,
               created_by, created_at
        from public.projects
        where tenant_id = p_tenant
      ) pr
    ), '[]'::jsonb),

    'notifications', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at desc)
      from (
        select id, tenant_id, user_id, kind, title, body, href, metadata,
               read_at, created_at
        from public.notifications
        order by created_at desc
        limit 20
      ) n
    ), '[]'::jsonb),

    'tenant', (
      select to_jsonb(t)
      from (
        select id, config, automation_state, automation_paused_at,
               automation_resumed_at, automation_paused_by_user_id
        from public.tenants
        where id = p_tenant
      ) t
    ),

    'disconnected', jsonb_build_object(
      'count', (
        select count(*)
        from public.tickets
        where status = 'paused'
          and paused_reason = 'runner-disconnected'
      ),
      'rows', coalesce((
        select jsonb_agg(to_jsonb(d) order by d.paused_at desc)
        from (
          select id, title, paused_at
          from public.tickets
          where status = 'paused'
            and paused_reason = 'runner-disconnected'
          order by paused_at desc
          limit 5
        ) d
      ), '[]'::jsonb)
    ),

    'runners', coalesce((
      select jsonb_agg(to_jsonb(r))
      from (
        select id, name, status, last_heartbeat_at
        from public.runners
        where tenant_id = p_tenant
      ) r
    ), '[]'::jsonb),

    'dev_servers', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.updated_at desc)
      from (
        select project_id, status, updated_at
        from public.dev_server_sessions
        where tenant_id = p_tenant
        order by updated_at desc
        limit 200
      ) s
    ), '[]'::jsonb),

    'github_connected', exists(
      select 1 from public.github_oauth_tokens
    ),

    'first_run_done', exists(
      select 1 from public.runs
      where tenant_id = p_tenant and status = 'done'
    )
  )
$$;

revoke all on function public.shell_bootstrap(uuid) from public;
grant execute on function public.shell_bootstrap(uuid) to authenticated, service_role;

commit;
