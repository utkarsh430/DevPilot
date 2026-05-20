-- Single-round-trip loader for the authenticated (app) shell layout.
--
-- Why: `app/(app)/layout.tsx` renders on every hard navigation and seeds the
-- topbar (project switcher, notifications bell, health dot, automation switch)
-- plus the runner-disconnected banner and the readiness checklist. After the
-- Wave-1 parallelization those loads ran as one `Promise.all`, but that is
-- still ~9 separate Supabase round trips (projects, notifications, tenant
-- automation+config, runner-disconnected tickets, runners, dev-server
-- sessions, github token presence, finished-run probe). On cloud latency
-- (~80ms/hop) that dominates the shell's TTFB. This function returns ALL of it
-- in ONE round trip as a single jsonb bundle; the TS loader in
-- `lib/shell/bootstrap.ts` maps it into the exact shapes the layout consumes.
--
-- SECURITY INVOKER on purpose (mirrors `replay_chain`): the web app calls this
-- through the RLS-bound client, so every sub-select runs under the caller's
-- row-level policies. Each table below already has a member/owner read policy
-- (projects/runners/dev_server_sessions/tickets/runs/tenants scope by
-- `current_user_tenants()`, notifications/github_oauth_tokens scope by
-- `auth.uid()`), so the result set is byte-for-byte identical to the per-loader
-- queries it replaces — no data-exposure change. `p_tenant` narrows the
-- tenant-scoped reads to the caller's active tenant exactly as the loaders did;
-- RLS still guarantees `p_tenant` must be one the caller belongs to.
--
-- Semantics mirror the TS loaders it replaces:
--   • projects            — every project for the tenant, created_at asc.
--   • notifications        — caller's 20 most-recent, created_at desc (RLS
--                            scopes to auth.uid(); no tenant filter, as before).
--   • tenant               — the tenant's automation columns + config jsonb
--                            (config drives the LLM auth-mode → expectsLocalRunner).
--   • disconnected         — exact count + first 5 runner-disconnected paused
--                            tickets, paused_at desc (RLS scopes to the caller's
--                            tenants; no explicit tenant filter, as before).
--   • runners / dev_servers — the health-dot seed rows (derivation stays in TS
--                            so the snapshot semantics are unchanged).
--   • github_connected      — does the caller have a GitHub OAuth token row.
--   • first_run_done        — has any run in this tenant finished `done`.

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
               team_tier, created_by, created_at
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
