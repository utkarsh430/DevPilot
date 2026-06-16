-- WI-12 — per-project LLM provider selection.
--
-- Adds the provider dimension to `projects`: WHICH endpoint a project's agent
-- runs talk to, and (opaquely) where the credential for it lives. Resolution
-- precedence is project » tenant » instance » env, resolved server-side in
-- apps/web/lib/llm/provider-config.server.ts. Every column is nullable and NULL
-- means "inherit", so an existing project changes behaviour in no way at all.
--
-- WHAT IS *NOT* HERE, deliberately: the credential itself. `llm_credential_ref`
-- is an opaque POINTER (`project_secret:<KEY>` → the AES-256-GCM per-project
-- vault, or `platform:<KEY>` → the platform-secrets store). A provider API key
-- never lands in a projects row — that row is read by half the app and returned
-- from loaders that feed the UI, and a secret in it would be a secret in every
-- one of those places. The pointer is a NAME, safe to read, exactly like the
-- `project_secret_names` view.
--
-- `llm_base_url` is user-controllable and drives SERVER-SIDE fetches, which makes
-- it an SSRF primitive. The CHECK below is a shape backstop only — the real
-- control is the validator in lib/llm/base-url{,.server}.ts, which requires https,
-- rejects credentials-in-URL, resolves the host and refuses any private/loopback/
-- link-local/CGNAT/metadata address, and runs at BOTH write time (so nothing bad
-- persists) and call time (so a record that turns malicious later is still
-- refused). Postgres cannot resolve DNS, so it cannot be the enforcement point;
-- what it CAN do is make the obviously-wrong states unrepresentable.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'llm_provider') then
    create type public.llm_provider as enum ('anthropic', 'openai_compatible');
  end if;
end
$$;

alter table public.projects
  add column if not exists llm_provider public.llm_provider,
  add column if not exists llm_base_url text,
  add column if not exists llm_credential_ref text,
  add column if not exists llm_model text;

comment on column public.projects.llm_provider is
  'Per-project LLM provider. NULL = inherit (tenant » instance » env; default anthropic). '
  '"openai_compatible" forces the run onto the API runner — the local-cc runner is the '
  'Claude CLI and cannot speak that protocol.';
comment on column public.projects.llm_base_url is
  'Endpoint for an OpenAI-compatible provider. SSRF-validated at write AND call time '
  '(lib/llm/base-url.server.ts); NULL for anthropic, which has a fixed endpoint we never override.';
comment on column public.projects.llm_credential_ref is
  'OPAQUE pointer to the provider credential — "project_secret:<KEY>" (per-project AES-GCM vault) '
  'or "platform:<KEY>" (platform-secrets). Never the key itself.';
comment on column public.projects.llm_model is
  'Explicit model id/alias. NULL = the tier map (API path) / the account default (subscription path, '
  'where it means no --model flag is passed at all — today''s exact behaviour).';

-- Shape invariants, so a half-configured provider can't sit in the table waiting
-- to fail at dispatch time:
--   • an OpenAI-compatible project must name an endpoint;
--   • an Anthropic project must NOT — a project-settable Anthropic base URL is a
--     way to siphon the tenant's Anthropic credential to a host of the writer's
--     choosing, and there is no legitimate use for it;
--   • an inheriting project (llm_provider NULL) carries no provider config at all.
alter table public.projects
  drop constraint if exists projects_llm_base_url_matches_provider;
alter table public.projects
  add constraint projects_llm_base_url_matches_provider check (
    case
      when llm_provider = 'openai_compatible' then llm_base_url is not null and length(llm_base_url) > 0
      when llm_provider = 'anthropic' then llm_base_url is null
      else llm_base_url is null and llm_credential_ref is null and llm_model is null
    end
  );

-- A base URL we would refuse to dereference anyway has no business persisting.
-- https only, with the one exception the app also makes: an explicit localhost
-- endpoint for local development (Ollama's default is http://localhost:11434),
-- which the app gates behind ACE_LLM_ALLOW_LOCAL_BASE_URL.
alter table public.projects
  drop constraint if exists projects_llm_base_url_scheme;
alter table public.projects
  add constraint projects_llm_base_url_scheme check (
    llm_base_url is null
    or llm_base_url ~ '^https://'
    or llm_base_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)'
  );

-- The ref grammar (see lib/llm/credential-ref.ts). A hand-edited row that doesn't
-- parse would degrade to "no project credential" at read time rather than break —
-- but there's no reason to let it in.
alter table public.projects
  drop constraint if exists projects_llm_credential_ref_shape;
alter table public.projects
  add constraint projects_llm_credential_ref_shape check (
    llm_credential_ref is null
    or llm_credential_ref ~ '^(project_secret|platform):[A-Z][A-Z0-9_]{0,63}$'
  );

-- Keep the shell-bootstrap bundle's project payload in sync with PROJECT_COLUMNS
-- in lib/projects/load.ts — both are mapped by the SAME `mapProjectRow`, so a
-- column the mapper reads but this select list omits comes back silently
-- DEFAULTED rather than real. WI-11 fixed exactly that drift (auto_land_enabled
-- had gone missing the same way) and left the warning; adding four mapper-read
-- columns without refreshing this list would knowingly re-ship it.
--
-- `agent_ticket_creation` (WI-14) had ALREADY drifted out again the same way: the
-- mapper reads it, but its migration didn't refresh this function, so the shell
-- bundle has been handing every project a silently-defaulted `false`. Folded back
-- in here, since we are rewriting the select list anyway and leaving it out would
-- knowingly re-ship the very bug this comment warns about.
--
-- Body is otherwise unchanged from 20260716000000 — only the projects select
-- list gains the llm_* columns. Forward-only and re-runnable.
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
