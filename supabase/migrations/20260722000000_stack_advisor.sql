-- Stack advisor - Stage 4: data model + persistence.
--
-- Builds on WI-15 (`project_stack_tags`, the static service catalog) and the
-- Stage 1-3 pure core (`lib/stack/capabilities.ts`, the extended
-- `service-catalog.ts`, `lib/stack/rank.ts`) already merged. See
-- data/devpilot-stack-advisor-design/report.md §7 for the full design.
--
-- Three changes:
--   1. `projects.stack_ecosystem` - the operator's ecosystem commitment
--      (aws|azure|gcp|oss|mixed|unset). Drives the ranker's native-first
--      ordering and (a later stage) the plan frame's ecosystem line.
--   2. `project_stack_tags` - extended with `capability` and
--      `recommended_service_key` so a row can record which capability slot it
--      fills and whether the operator swapped away from the ranker's pick;
--      `source` widened to distinguish advisor provenance from a manual tick;
--      a partial unique index enforces one chosen service per capability
--      per project (D6).
--   3. `planning_sessions` - `stack_advice_status` + `required_capabilities`,
--      the disposable, re-runnable inference artifact for one session.
--
-- LOAD-BEARING: this migration also rewrites `public.shell_bootstrap()` to
-- include `stack_ecosystem` in its `projects` select list. AGENTS.md /
-- lib/projects/load.ts: `PROJECT_COLUMNS` and the RPC's select list are both
-- mapped by the SAME `mapProjectRow` - a column the mapper reads but the RPC
-- omits comes back as a silently DEFAULTED value on the shell-bootstrap path.
-- `20260719000000` had to do this exact rewrite for the WI-12 LLM-provider
-- columns; this migration does the same for `stack_ecosystem`. The function
-- body below is `20260719000000`'s definition verbatim except for that one
-- added column - every prior column stays.

begin;

-- --- 1. projects.stack_ecosystem -------------------------------------------

alter table public.projects
  add column if not exists stack_ecosystem text not null default 'unset';

alter table public.projects
  drop constraint if exists projects_stack_ecosystem_check;
alter table public.projects
  add constraint projects_stack_ecosystem_check
    check (stack_ecosystem in ('aws', 'azure', 'gcp', 'oss', 'mixed', 'unset'));

comment on column public.projects.stack_ecosystem is
  'Stack advisor - the ecosystem the operator committed to. Drives the ranker''s '
  'native-first ordering and the plan frame''s ecosystem line. ''unset'' asserts '
  'nothing (pre-advisor projects), exactly as project_type=''other'' does for WI-11.';

-- --- 2. project_stack_tags - capability-keyed selection ---------------------

alter table public.project_stack_tags
  -- NULL = a free-floating tag from the manual picker (every pre-advisor row,
  -- and any extra service the operator adds outside the advisor). NOT an
  -- enum: the taxonomy is validated in the app through getCapability(), so it
  -- can grow without a DDL round-trip. A stale key is dropped on read, exactly
  -- as a stale service_key already is (persist.server.ts).
  add column if not exists capability text,
  -- Provenance for swap-tracking: the service the RANKER recommended, when
  -- the operator chose a different one. NULL when they took the
  -- recommendation (or the row didn't come from the advisor).
  add column if not exists recommended_service_key text;

-- Widen `source` so advisor provenance is distinguishable from a manual tick.
alter table public.project_stack_tags
  drop constraint if exists project_stack_tags_source_check;
alter table public.project_stack_tags
  add constraint project_stack_tags_source_check
    check (source in ('detected', 'manual', 'ai_suggested', 'user_override'));
--   detected      - WI-15 repo fingerprinting (unchanged)
--   manual        - operator ticked it in the picker (unchanged)
--   ai_suggested  - advisor proposed the capability, operator accepted the top pick
--   user_override - advisor proposed the capability, operator SWAPPED the service.
--                   recommended_service_key holds what we had suggested.

-- Reconcile the WI-15 base unique with the capability model.
--
-- `20260718000000` created this table with an inline `unique (project_id,
-- service_key)` - "one row per service per project", which was exactly right
-- when a row WAS a service. Under the capability model a row is a
-- (service, capability) PAIR, and one service legitimately fills several
-- slots: supabase -> relational_db + auth + object_storage + realtime, redis
-- -> cache + queue, gcp_cloud_run -> compute_serverless + compute_container.
-- Every one of those rows carries the SAME service_key, so the whole-table
-- unique rejects the entire batched INSERT and NO capability row persists for
-- any multi-capability service. It has to go.
--
-- Dropped by lookup rather than by name: the inline constraint gets Postgres's
-- auto-generated `project_stack_tags_project_id_service_key_key`, but a
-- `drop constraint if exists` on a guessed name that turns out to be wrong
-- would SILENTLY no-op and leave the bug in place. This finds whichever unique
-- constraint covers exactly (project_id, service_key) and drops that.
do $$
declare
  c_name text;
begin
  select con.conname into c_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'project_stack_tags'
    and con.contype = 'u'
    and (
      select array_agg(att.attname::text order by att.attname)
      from unnest(con.conkey) as k(attnum)
      join pg_attribute att
        on att.attrelid = con.conrelid and att.attnum = k.attnum
    ) = array['project_id', 'service_key']
  limit 1;

  if c_name is not null then
    execute format(
      'alter table public.project_stack_tags drop constraint %I', c_name
    );
  end if;
end $$;

-- The dropped unique also kept an EXTRA (manually-picked) service from being
-- pinned to the same project twice. That guarantee is still wanted - it just
-- must not reach across the capability rows. Same columns, scoped to the
-- capability-NULL partition only.
create unique index if not exists project_stack_tags_project_service_extra_uidx
  on public.project_stack_tags(project_id, service_key)
  where capability is null;

-- One chosen service per capability per project. Partial, because pre-advisor
-- rows (and the manual "extra services") carry capability = NULL and there
-- can be many of those.
--
-- Net constraint model: one service per capability, at most one of each extra
-- service, and a service_key MAY repeat across distinct capability rows. Every
-- pre-existing row is capability-NULL and was already unique on (project_id,
-- service_key), so it satisfies the new partial - the transform is safe on
-- existing data.
create unique index if not exists project_stack_tags_project_capability_uidx
  on public.project_stack_tags(project_id, capability)
  where capability is not null;

comment on column public.project_stack_tags.capability is
  'Stack advisor - which capability slot (lib/stack/capabilities.ts) this row fills. '
  'NULL for pre-advisor / manually-picked rows outside the taxonomy.';
comment on column public.project_stack_tags.recommended_service_key is
  'Stack advisor - the ranker''s recommended service_key for this capability, when the '
  'operator swapped to a different one (source=''user_override''). NULL otherwise.';

-- --- 3. planning_sessions - the inference artifact --------------------------

alter table public.planning_sessions
  add column if not exists stack_advice_status text not null default 'unrun';

alter table public.planning_sessions
  drop constraint if exists planning_sessions_stack_advice_status_check;
alter table public.planning_sessions
  add constraint planning_sessions_stack_advice_status_check
    check (stack_advice_status in ('unrun', 'inferring', 'ready', 'accepted', 'skipped'));

alter table public.planning_sessions
  -- The inferred capability keys for THIS session. Disposable, re-runnable.
  -- Validated through getCapability() on read; unknown keys dropped.
  add column if not exists required_capabilities text[] not null default '{}';

comment on column public.planning_sessions.stack_advice_status is
  'Stack advisor panel lifecycle for this session: unrun -> inferring -> ready -> '
  'accepted, or skipped if the operator dismissed the panel. Independent of '
  'planning_sessions.status (discussing|planning|planned|committed|discarded).';
comment on column public.planning_sessions.required_capabilities is
  'Stack advisor - the capability keys inferred for THIS session. Re-runnable and '
  'disposable; the durable, operator-confirmed selection lives on project_stack_tags.';

-- --- shell_bootstrap() rewrite - keep PROJECT_COLUMNS in sync --------------
--
-- Body is otherwise unchanged from `20260719000000` - only the `projects`
-- select list gains `stack_ecosystem`. Forward-only and re-runnable.

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
               auto_land_enabled, agent_ticket_creation, team_tier, project_type,
               llm_provider, llm_base_url, llm_credential_ref, llm_model,
               stack_ecosystem,
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
