-- =============================================================================
-- Migration : 20260716000000_project_type.sql
-- WI-11 — Project platform ("project type").
--
-- Adds a single `project_type` knob on every project, chosen by the operator at
-- creation/import. It drives two things in the app:
--   • the dev/preview command (lib/dev-servers/stack-detect.ts) — the platform
--     coarsely steers which family of commands we look for on disk, instead of
--     guessing purely from whichever files happen to exist.
--   • plan mode (lib/plan/prompts.ts) — rendered as a HARD frame so the panel
--     agents don't propose Next.js routes for a native iOS app.
--
-- Default is 'other', and that choice is load-bearing rather than filler:
-- 'other' means "the operator asserted no platform". It adds NO plan frame and
-- NO command steering, so every row that predates this migration keeps its
-- exact pre-WI-11 behaviour — in particular the Run button's inferred command
-- is unchanged. NOT NULL + DEFAULT (rather than a nullable column) so no reader
-- ever has to handle a null, and a mis-steer can never break an existing
-- project's Run.
--
-- Also refreshes `shell_bootstrap` so its `projects` select list carries the
-- new column. That function's payload is mapped by the SAME `mapProjectRow` as
-- the direct PostgREST reads (see lib/projects/load.ts), so a column the mapper
-- reads but the RPC omits comes back as a silently-defaulted value rather than
-- the real one. `auto_land_enabled` (added by WI-4) had already drifted out of
-- this list the same way; it is folded back in here, since we are rewriting the
-- select list anyway and leaving it out would knowingly re-ship the same bug.
-- The rest of the function body is unchanged from 20260707010000.
--
-- Forward-only and re-runnable.
-- =============================================================================
begin;

do $$ begin
  create type public.project_type as enum ('web', 'mobile', 'ios', 'desktop', 'other');
exception when duplicate_object then null; end $$;

alter table public.projects
  add column if not exists project_type public.project_type not null default 'other';

comment on column public.projects.project_type is
  'Operator-chosen target platform. Steers the dev/preview command and plan-mode prompts. ''other'' = no platform asserted (no steering).';

-- Keep the shell-bootstrap bundle's project payload in sync with PROJECT_COLUMNS
-- in lib/projects/load.ts — both are mapped by mapProjectRow.
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
               auto_land_enabled, team_tier, project_type, created_by, created_at
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
