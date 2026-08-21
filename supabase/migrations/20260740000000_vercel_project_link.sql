-- =============================================================================
-- Migration : 20260740000000_vercel_project_link.sql
-- Purpose   : PR 2 of the Vercel deployment feature — the durable state behind
--             "this DevPilot project is linked to this Vercel project", plus the
--             `project_deployments` ledger PR 4 will write into.
--             Plan: data/devpilot-vercel-deploy-plan-v1/report.md §4/§6/§8.
--
-- ── The safety problem these columns exist to make VISIBLE ─────────────────
-- The moment a GitHub repo is linked to a Vercel project, Vercel deploys every
-- push to the project's production branch — automatically, with no approval
-- step. DevPilot's agents push constantly and the auto-land pipeline merges into
-- the integration branch on its own, so a naive link hands every agent a live
-- production deploy button that bypasses every gate DevPilot could ever build.
--
-- Two of the columns below exist solely so that state can be STATED to the
-- operator rather than left implicit:
--
--   vercel_production_branch — the branch Vercel reported as its production
--     branch at link time. A SNAPSHOT FOR DISPLAY AND AUDIT, never an authority:
--     `link.productionBranch` is READ-ONLY in Vercel's public REST API (verified
--     against the official OpenAPI spec — neither POST /v11/projects nor
--     PATCH /v9/projects accepts it), so DevPilot cannot set it and must not
--     pretend the stored value is current. Every render re-reads the live value
--     from Vercel and reports THAT; this column is the fallback when the API
--     cannot be reached, and it is labelled as unconfirmed when used.
--
--   vercel_prod_deploy_mode — the operator's RECORDED INTENT for whether git
--     pushes may deploy to production ('devpilot_gated' = DevPilot asked Vercel to
--     disable git-triggered production deploys; 'git_auto' = the operator
--     knowingly left them on). Also not an authority: Vercel is. It records what
--     was asked for, so a later divergence between intent and live state is
--     detectable and showable instead of silent.
--
-- The general rule this encodes: NEVER render a stored mirror of third-party
-- state as though it were fact. Both columns are nullable and both are
-- documented as snapshots.
--
-- ── project_deployments ────────────────────────────────────────────────────
-- The deploy audit trail: who deployed what, from which commit, and whether a
-- human or an agent triggered it. `triggered_by` + `trigger_source` are what
-- make "was this production deploy human-approved?" answerable from one query —
-- Vercel's own activity log attributes everything to the single token identity
-- and so cannot distinguish DevPilot users. Created here, in PR 2, because the
-- link and the ledger are one schema change; PR 4 writes the first row.
--
-- ── PROJECT_COLUMNS / shell_bootstrap() sync (the documented trap) ─────────
-- LOAD-BEARING: this migration also rewrites `public.shell_bootstrap()` to add
-- the new columns to its `projects` select list. AGENTS.md / lib/projects/load.ts:
-- `PROJECT_COLUMNS` and the RPC's select list are both mapped by the SAME
-- `mapProjectRow`, so a column the mapper reads but the RPC omits comes back
-- SILENTLY DEFAULTED on the shell-bootstrap path — i.e. an ARMED project would
-- render as unlinked in the shell. `20260719000000` and `20260722000000` each
-- had to do this same rewrite; the body below is `20260722000000`'s definition
-- verbatim except for the added columns. Every prior column stays.
--
-- ── Tenant isolation ───────────────────────────────────────────────────────
-- `project_deployments` carries `tenant_id` plus two FKs to tenant-scoped
-- parents (`project_id`, `ticket_id`), so both get an
-- `assert_tenant_matches_parent` trigger per the 20260732000000 convention.
-- That pair list is DERIVED from a parse of these migrations and
-- lib/security/__tests__/tenant-scope-scan.test.ts re-derives it and FAILS on a
-- gap — the triggers are not optional book-keeping. Each FK is declared on its
-- own column line with the literal `uuid` token and a `references public.<t>(`
-- clause, because that parser is column-by-column. The audit SQL
-- (scripts/generate-tenant-parent-audit.ts) is regenerated to cover both.
-- `assert_tenant_matches_parent` short-circuits on a NULL pointer, so the
-- nullable `ticket_id` is fine. (`tenant_id → tenants` is not in the class:
-- `tenants` carries no tenant_id of its own.)
--
-- RLS mirrors agent_project_models: members SELECT their own rows;
-- INSERT/UPDATE/DELETE denied to JWT roles, because every write goes through a
-- validated service-role server action.
--
-- Execution notes: one-shot transactional migration; the table is brand new with
-- zero rows, so indexes are plain CREATE INDEX (CONCURRENTLY is illegal inside a
-- transaction).
-- =============================================================================
begin;

-- --- 1. projects: the Vercel link ------------------------------------------

alter table public.projects
  -- Vercel's own project id (`prj_…`). NULL = not linked. This is the single
  -- flag every "is this project linked?" check reads.
  add column if not exists vercel_project_id text,
  -- Vercel's project NAME, for display and for building a dashboard deep link
  -- without a second API round trip on every render.
  add column if not exists vercel_project_name text,
  -- The stable production URL, written by PR 4 on a successful deploy. Present
  -- here so the link and the artifact it produces are one schema change.
  add column if not exists vercel_production_url text,
  -- SNAPSHOT of `link.productionBranch` at link time. See the header: read-only
  -- upstream, so this is display/audit fallback, never an authority.
  add column if not exists vercel_production_branch text,
  -- The branch the operator WANTS Vercel to deploy production from. Defaults to
  -- the project's integration branch ('dev'), because that is where auto-land
  -- puts completed work and `main` is human-promoted from it. DevPilot cannot
  -- APPLY this (see the header: read-only upstream), so it exists to be
  -- COMPARED against the live value on every render — a mismatch is the loud
  -- warning + manual-steps banner on the DeploymentCard. Without a stored
  -- intent there is nothing to compare against and "Vercel is still on main"
  -- is indistinguishable from "main is what we wanted".
  add column if not exists vercel_production_branch_desired text,
  -- The operator's recorded intent for git → production auto-deploy.
  add column if not exists vercel_prod_deploy_mode text,
  add column if not exists vercel_linked_at timestamptz,
  -- Who linked it. Deploy configuration is an operator action and the audit
  -- trail starts at the link, not at the first deploy.
  add column if not exists vercel_linked_by uuid references auth.users(id) on delete set null;

alter table public.projects
  drop constraint if exists projects_vercel_prod_deploy_mode_check;
alter table public.projects
  add constraint projects_vercel_prod_deploy_mode_check
    check (vercel_prod_deploy_mode is null
           or vercel_prod_deploy_mode in ('devpilot_gated', 'git_auto'));

comment on column public.projects.vercel_project_id is
  'Vercel project id (prj_…). NULL = not linked to Vercel.';
comment on column public.projects.vercel_production_branch_desired is
  'The branch the operator wants Vercel deploying production from (normally the '
  'integration branch). DevPilot CANNOT set this on Vercel — productionBranch is '
  'read-only in the REST API — so this is the intent the UI compares the live '
  'value against in order to warn when they diverge.';
comment on column public.projects.vercel_production_branch is
  'SNAPSHOT of Vercel''s link.productionBranch at link time — display/audit '
  'only. Vercel''s REST API exposes productionBranch as READ-ONLY, so DevPilot '
  'cannot set it and must re-read the live value rather than trust this.';
comment on column public.projects.vercel_prod_deploy_mode is
  'Operator INTENT for git-push → production deploys: devpilot_gated (DevPilot '
  'asked Vercel to disable them) or git_auto (knowingly left on). Vercel is the '
  'authority on the live state; this records what was asked for so a divergence '
  'is detectable rather than silent.';

-- --- 2. project_deployments -------------------------------------------------

create table if not exists public.project_deployments (
  id            uuid        not null default gen_random_uuid()
                  primary key,

  -- Tenant isolation (cascade: deleting a tenant reaps its deploy history).
  tenant_id     uuid        not null
                  references public.tenants(id) on delete cascade,

  -- The DevPilot project this deployment belongs to.
  project_id    uuid        not null
                  references public.projects(id) on delete cascade,

  -- The ticket whose work this deployment carries, when there is one. Nullable:
  -- an operator can deploy the current integration tip with no ticket in play.
  -- `set null` rather than cascade — deleting a ticket must not erase the record
  -- that something was deployed to production.
  ticket_id     uuid        null
                  references public.tickets(id) on delete set null,

  -- Vercel's deployment id (`dpl_…`).
  vercel_deployment_id text not null
                  constraint chk_project_deployments_vercel_id_nonempty
                    check (length(btrim(vercel_deployment_id)) > 0),

  target        text        not null
                  constraint chk_project_deployments_target
                    check (target in ('production', 'preview')),

  -- Mirrors Vercel's `readyState`. Stored as text rather than an enum: it is a
  -- third party's vocabulary and can gain a value without our deploy, and an
  -- unknown state must degrade to "shown verbatim", never to a failed insert.
  ready_state   text        not null
                  constraint chk_project_deployments_ready_state_nonempty
                    check (length(btrim(ready_state)) > 0),

  url           text        null,
  commit_sha    text        null,

  -- The audit pair. `trigger_source` is the question that matters: production
  -- deploys are human-only by design (plan §9), so a 'agent' row on a
  -- production target is a finding, not a normal state.
  triggered_by  uuid        null
                  references auth.users(id) on delete set null,
  trigger_source text       not null
                  constraint chk_project_deployments_trigger_source
                    check (trigger_source in ('human', 'agent', 'git_push')),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One row per Vercel deployment per tenant. Makes the PR-4 poll loop's
  -- "record or update" an upsert rather than a read-then-insert race.
  constraint uq_project_deployments_vercel_id
    unique (tenant_id, vercel_deployment_id)
);

comment on table public.project_deployments is
  'Deploy audit trail: one row per Vercel deployment DevPilot knows about. '
  'triggered_by + trigger_source answer "who deployed this, and was it a '
  'human" — Vercel''s own activity log attributes everything to the single '
  'token identity and cannot distinguish DevPilot users. Written by validated '
  'service-role paths only (PR 4); JWT writes are denied.';

alter table public.project_deployments enable row level security;

-- SELECT: tenant members see only their own rows.
create policy project_deployments_member_read
  on public.project_deployments
  for select
  using (tenant_id in (select public.current_user_tenants()));

-- INSERT / UPDATE / DELETE: denied for JWT roles. service_role bypasses RLS.
create policy project_deployments_insert_deny
  on public.project_deployments
  for insert
  with check (false);

create policy project_deployments_update_deny
  on public.project_deployments
  for update
  using (false);

create policy project_deployments_delete_deny
  on public.project_deployments
  for delete
  using (false);

-- The card's read path: "the last N deployments for this project", newest first.
create index if not exists idx_project_deployments_project
  on public.project_deployments (tenant_id, project_id, created_at desc);

-- The ticket drawer's read path.
create index if not exists idx_project_deployments_ticket
  on public.project_deployments (tenant_id, ticket_id)
  where ticket_id is not null;

-- Tenant-matches-parent triggers (the 20260732000000 convention). See header.
drop trigger if exists trg_project_deployments_project_id_tenant on public.project_deployments;
create trigger trg_project_deployments_project_id_tenant
  before insert or update of tenant_id, project_id on public.project_deployments
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_project_deployments_ticket_id_tenant on public.project_deployments;
create trigger trg_project_deployments_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.project_deployments
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

-- --- 3. shell_bootstrap() rewrite — keep PROJECT_COLUMNS in sync ------------
-- 20260722000000's definition verbatim, plus the seven vercel_* columns.

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
