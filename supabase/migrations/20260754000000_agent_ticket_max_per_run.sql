-- =============================================================================
-- Migration : 20260754000000_agent_ticket_max_per_run.sql
-- Phase     : follow-up to WI-14 (20260717000000) - make the agent-ticket
--             ceiling resolvable PER PROJECT instead of instance-wide only.
--
-- Why
-- ───
-- `DEVPILOT_MAX_TICKETS_PER_RUN` (default 3) is a process-wide env var, and one
-- number cannot serve the two shapes of work that use this tool. An engineer
-- noticing stray work while doing its ticket should stay near three. A
-- DECOMPOSITION ticket - one whose acceptance criteria are "file the child
-- tickets for this" - legitimately fans out to five or more, and on 2026-08-02
-- one did: the agent wrote all five children out, filed three, and hit the cap.
-- Raising the env var would have raised it for every project on the instance.
--
-- What this adds
-- ──────────────
-- • projects.agent_ticket_max_per_run - NULLABLE int, `check >= 1`.
--
--   NULL is the default and means INHERIT, not "no cap": the app resolves
--   project » env » built-in default (`resolveMaxTicketsPerRun`). Nullable
--   rather than `not null default 3` for exactly that reason - a stamped 3 on
--   every existing row would silently PIN each project to today's value and
--   make the instance-wide env var dead for all of them.
--
--   The `check >= 1` is the storage-layer half of the typo-safety property the
--   resolver already guarantees: no value that can be stored here disables the
--   cap. (0 and negatives are refused outright; the resolver additionally
--   skips any non-numeric value that reaches it via the shell_bootstrap jsonb
--   path, where the column arrives untyped.)
--
--   No upper bound, matching DEVPILOT_MAX_TICKETS_PER_RUN, which has never had
--   one. The cap exists to bound a confused AGENT, not an operator who typed a
--   large number deliberately; and imposing a ceiling-on-the-ceiling here would
--   have to apply to the env rung too, silently shrinking a live configuration.
--
-- Deliberately NOT changed: `projects.agent_ticket_creation` keeps its
-- `default false`. Flipping a column default only affects rows inserted after
-- this migration, so it would leave two projects with identical UI behaving
-- differently for no visible reason ("when were you created"); and backfilling
-- the existing ones is exactly the silent flip of a documented safety default
-- that must not happen to a board already in use. Discoverability is fixed
-- where it belongs - in the create form (an explicit, pre-ticked control) and
-- in the refusal copy, which now names the setting and the page.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. projects.agent_ticket_max_per_run - the per-project rung
-- ---------------------------------------------------------------------------
alter table public.projects
  add column if not exists agent_ticket_max_per_run int
    check (agent_ticket_max_per_run is null or agent_ticket_max_per_run >= 1);

comment on column public.projects.agent_ticket_max_per_run is
  'How many tickets ONE run may file via devpilot_create_ticket in this project. '
  'NULL = inherit (DEVPILOT_MAX_TICKETS_PER_RUN, then the built-in default of 3). '
  'Raised on planning/decomposition-heavy projects, where a single ticket may '
  'legitimately fan out to five or more children. Never < 1: a safety ceiling '
  'must not be switch-off-able.';

-- ---------------------------------------------------------------------------
-- 2. shell_bootstrap() rewrite - keep PROJECT_COLUMNS in sync
--
-- 20260740000000's definition verbatim, plus agent_ticket_max_per_run. Both
-- select lists feed `mapProjectRow`, so a column present in one and not the
-- other comes back SILENTLY DEFAULTED on the shell-bootstrap path rather than
-- erroring - which for this column would mean the topbar/layout read every
-- project as "inherit" no matter what the operator set.
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
