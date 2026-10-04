-- =============================================================================
-- Migration : 20260756000000_project_supervisor.sql
-- Phase     : the project supervisor - a supervision loop that lives in the
--             RUNNER process, so it survives the failure it exists to catch.
--
-- Why
-- ───
-- Every recovery mechanism in devpilot is an Inngest cron: stuckTicketSweeper,
-- orphanTicketReaper, staleRunReaper, landRescueReaper, integrationQueueReaper,
-- devServerReaper, runnerWatchdog, ticketScheduleCronFn, workspaceReaper,
-- dispatchRescueReaper. When the durable-execution layer wedges, ALL of them die
-- at once and nothing is left to notice.
--
-- That happened on 2026-08-03: the local Inngest dev server emitted
-- `could not check constraints to lease item` ~5,000,000 times into a 30 GB log
-- while still ACCEPTING EVENTS. Five tickets sat `in_progress` with dead runs
-- holding every WIP slot; tickets queued behind them waited seven hours; the
-- board reported "at WIP limit" throughout. A human found it.
--
-- The design argument (why the runner, why remediation is gated on the engine's
-- own recovery being unavailable, why the reapers are reused rather than
-- duplicated) lives in `apps/web/lib/engine/supervisor-policy.ts`. Read that
-- header first; this file is only the storage.
--
-- What this adds
-- ──────────────
--  1. public.engine_liveness   - the cron canary's stamp. Instance-scoped.
--  2. public.supervisor_actions - the ledger. Every automatic fix, with its
--                                 cause, so repeat remediation can be indicted.
--  3. projects.supervisor_enabled - the per-project opt-in, OFF by default.
--  4. shell_bootstrap() rewrite  - in THIS migration, mandatory. See §3.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. engine_liveness - "is the durable-execution layer actually EXECUTING?"
--
--    A canary cron (lib/engine/liveness.ts, `* * * * *`) stamps this row and
--    does nothing else. A stale stamp means cron execution has stopped, which
--    is PRECISELY the gate the supervisor needs - the reapers it must not
--    duplicate are crons in the same app, so their liveness and this row's
--    freshness are the same fact.
--
--    NO tenant_id, deliberately. A cron has no tenant, and this is a property
--    of the INSTANCE's execution layer, not of anyone's data. It holds no
--    tenant-derived information, so it is outside the `assert_tenant_matches_
--    parent` class and outside the tenant-scoped-read rule: the only read is
--    keyed on a literal constant id, never on an attacker-supplied pointer.
--
--    A TABLE rather than a Redis key, and the distinction matters: Redis is
--    already an availability dependency of the runner's job pull, so a signal
--    stored there could not tell "Inngest stopped" from "Redis stopped", and it
--    is exactly the second case in which we most need to NOT start remediating.
--    Postgres is the one dependency the engine cannot serve a request without.
--
--    One row, keyed on a text literal, so the canary is a single upsert with no
--    lookup and the table can never grow.
-- ---------------------------------------------------------------------------
create table if not exists public.engine_liveness (
  id            text        primary key,

  -- Last time the canary function actually EXECUTED. Not "was scheduled",
  -- not "was accepted" - the incident's whole shape was events being accepted
  -- by something that then ran nothing.
  last_seen_at  timestamptz not null default now(),

  -- Monotonic count of canary executions. Not read by the gate (freshness is
  -- what matters); it makes "has this ever worked on this install?" answerable
  -- from the row alone when diagnosing an `unknown` liveness state.
  ticks         bigint      not null default 0,

  updated_at    timestamptz not null default now()
);

comment on table public.engine_liveness is
  'Heartbeat of the Inngest durable-execution layer, stamped by the '
  'engine-liveness canary cron. A stale last_seen_at means every cron safety '
  'net (the reapers, the sweepers, the watchdogs) has stopped running, which is '
  'the gate the runner-resident project supervisor uses to decide whether it may '
  'remediate. Instance-scoped: a cron has no tenant.';

-- RLS: readable by any signed-in member (it is a single instance-wide liveness
-- fact carrying no tenant data, and the settings/health surface renders it);
-- every JWT write denied - only the service role, i.e. the canary itself, may
-- stamp it. A browser-writable liveness row would let a client forge "the crons
-- are alive" and silently disable the supervisor.
alter table public.engine_liveness enable row level security;

drop policy if exists engine_liveness_read on public.engine_liveness;
create policy engine_liveness_read
  on public.engine_liveness
  for select
  to authenticated
  using (true);

drop policy if exists engine_liveness_insert_deny on public.engine_liveness;
create policy engine_liveness_insert_deny
  on public.engine_liveness for insert with check (false);

drop policy if exists engine_liveness_update_deny on public.engine_liveness;
create policy engine_liveness_update_deny
  on public.engine_liveness for update using (false);

drop policy if exists engine_liveness_delete_deny on public.engine_liveness;
create policy engine_liveness_delete_deny
  on public.engine_liveness for delete using (false);

-- Seed the canary row so the very first stamp is a plain UPDATE and the row's
-- existence is never a race between two concurrent first ticks.
--
-- `last_seen_at` is seeded to the EPOCH, not to now(). Seeding it to now()
-- would assert that cron execution was alive at migration time, which this
-- migration cannot know and which would give a genuinely-wedged instance a free
-- five-minute window of false "alive" immediately after deploying. The epoch
-- reads as `wedged`, which is the honest state until a canary tick proves
-- otherwise - and the supervisor's remediation is additionally gated on
-- per-project opt-in that defaults to OFF, so an install that deploys this
-- while Inngest is genuinely down changes no behaviour at all.
insert into public.engine_liveness (id, last_seen_at, ticks)
values ('recovery-cron', 'epoch'::timestamptz, 0)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. supervisor_actions - THE LEDGER, and the reason this feature is not
--    strictly worse than the bug it fixes.
--
--    An operator hand-swept stalled tickets roughly six times in one day.
--    Every sweep worked. Every sweep also hid the underlying defect (a WIP-slot
--    leak), which stayed invisible for hours precisely because its symptoms kept
--    getting cleared. The board looked like it was recovering; it was failing
--    repeatedly and being rescued.
--
--    An automatic supervisor makes that failure mode WORSE by default: it sweeps
--    faster, more reliably, and without a human ever forming the impression that
--    they keep doing the same thing. So every automatic fix is recorded WITH ITS
--    CAUSE, and `detectRepeatDefect` counts causes inside a window: five
--    remediations of one cause in two hours is escalated as a SUSPECTED DEFECT
--    rather than absorbed as maintenance.
--
--    `cause` names a CAUSE, never an instance - it is the grouping key, and
--    grouping on "ticket 47 stalled" would make every indictment a count of one
--    and the whole escalation dead.
-- ---------------------------------------------------------------------------
create table if not exists public.supervisor_actions (
  id          uuid        primary key default gen_random_uuid(),

  -- ALWAYS derived from the row acted on, never asserted by the runner. The
  -- runner is pooled across tenants and holds no database credentials; the
  -- engine resolves tenant and project from the ticket / queue row.
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  project_id  uuid        references public.projects(id) on delete set null,
  ticket_id   uuid        references public.tickets(id) on delete set null,

  -- The grouping key for the indictment. Values are SUPERVISOR_CAUSES in
  -- lib/engine/supervisor-policy.ts. Text, not an enum, so adding a cause is a
  -- code change rather than a migration - matching `tickets.paused_reason` and
  -- `project_stack_tags.capability`.
  cause       text        not null
                constraint chk_supervisor_actions_cause
                  check (length(btrim(cause)) > 0),

  -- What was actually done. Separate from `cause` because one cause can be
  -- remediated more than one way, and "what happened to my board" and "why"
  -- are different questions an operator asks at different times.
  action      text        not null
                constraint chk_supervisor_actions_action
                  check (length(btrim(action)) > 0),

  -- The operator-facing sentence, already composed. Stored rather than
  -- re-derived so the record says what was true AT THE TIME - re-deriving it
  -- later from current state is how a ledger starts describing the world after
  -- it was repaired instead of the world that needed repairing.
  detail      text        not null default '',

  -- Stamped when THIS row is the one that crossed the repeat threshold. Durable
  -- and queryable, so the accusation survives a runner restart and a page
  -- reload; the health probe re-derives the live count from the window, but the
  -- fact that an escalation fired is recorded here.
  escalated_at timestamptz,

  created_at  timestamptz not null default now()
);

comment on table public.supervisor_actions is
  'Ledger of automatic fixes made by the runner-resident project supervisor, '
  'each with the CAUSE that produced it. Repeated remediation of one cause '
  'inside a window is escalated as a suspected defect rather than absorbed as '
  'maintenance: a fix that keeps firing for the same reason is a bug report. '
  'Rows are written only when the engine''s own cron recovery is unavailable - '
  'while the crons are alive the supervisor observes and writes nothing.';

-- RLS: member SELECT (this is the operator's own audit trail and the escalation
-- surface); every JWT write denied. The sole writer is the service role, via the
-- runner-authenticated supervision route. A browser-writable ledger would let a
-- client both fabricate an accusation and, worse, DELETE the rows that produce
-- one - which is the "silently absorbed" failure the ledger exists to prevent.
alter table public.supervisor_actions enable row level security;

drop policy if exists supervisor_actions_member_read on public.supervisor_actions;
create policy supervisor_actions_member_read
  on public.supervisor_actions
  for select
  using (tenant_id in (select public.current_user_tenants()));

drop policy if exists supervisor_actions_insert_deny on public.supervisor_actions;
create policy supervisor_actions_insert_deny
  on public.supervisor_actions for insert with check (false);

drop policy if exists supervisor_actions_update_deny on public.supervisor_actions;
create policy supervisor_actions_update_deny
  on public.supervisor_actions for update using (false);

drop policy if exists supervisor_actions_delete_deny on public.supervisor_actions;
create policy supervisor_actions_delete_deny
  on public.supervisor_actions for delete using (false);

-- The indictment's read path: "this tenant's remediations, newest first, inside
-- a window, grouped by cause".
create index if not exists idx_supervisor_actions_tenant_recent
  on public.supervisor_actions (tenant_id, created_at desc);

create index if not exists idx_supervisor_actions_cause
  on public.supervisor_actions (tenant_id, cause, created_at desc);

-- Tenant-matches-parent triggers (the 20260732000000 convention). Both FKs point
-- at tenant-scoped parents and the child carries its own tenant_id, so both are
-- in the class. That list is DERIVED from a parse of these migrations and
-- lib/security/__tests__/tenant-scope-scan.test.ts FAILS on a gap - the triggers
-- are not optional book-keeping. Regenerate the audit SQL
-- (scripts/generate-tenant-parent-audit.ts) after applying.
--
-- (`tenant_id → tenants` is not in the class: `tenants` carries no tenant_id of
-- its own, so there is no parent tenant to disagree with.)
drop trigger if exists trg_supervisor_actions_project_id_tenant on public.supervisor_actions;
create trigger trg_supervisor_actions_project_id_tenant
  before insert or update of tenant_id, project_id on public.supervisor_actions
  for each row execute function public.assert_tenant_matches_parent('project_id', 'projects');

drop trigger if exists trg_supervisor_actions_ticket_id_tenant on public.supervisor_actions;
create trigger trg_supervisor_actions_ticket_id_tenant
  before insert or update of tenant_id, ticket_id on public.supervisor_actions
  for each row execute function public.assert_tenant_matches_parent('ticket_id', 'tickets');

-- ---------------------------------------------------------------------------
-- 3. projects.supervisor_enabled - the per-project opt-in.
--
--    DEFAULT FALSE, following `agent_ticket_creation` end to end. The flag
--    decides whether the platform may move tickets on the operator's board
--    without being asked, so it is off until somebody says otherwise, and it is
--    writable ONLY by the operator-gated server action - no agent, MCP tool,
--    runner route or engine path touches this column.
--
--    Note what the flag does NOT gate: DETECTION. The supervisor observes and
--    reports on every project (that costs nothing and hides nothing); the flag
--    gates only whether it may act. An unsupervised project whose board is
--    deadlocked still shows up in the operator's health surface.
-- ---------------------------------------------------------------------------
alter table public.projects
  add column if not exists supervisor_enabled boolean not null default false;

comment on column public.projects.supervisor_enabled is
  'Per-project opt-in for the runner-resident project supervisor to REMEDIATE '
  '(release a deadlocked dispatch queue, hand a stalled ticket back to a human) '
  'when the engine''s own Inngest crons have stopped executing. OFF by default. '
  'Detection and reporting are not gated by this flag - only action is.';

-- ---------------------------------------------------------------------------
-- 4. shell_bootstrap() rewrite - IN THIS MIGRATION, and that is mandatory.
--
--    20260754000000's definition verbatim, plus supervisor_enabled. Both select
--    lists feed `mapProjectRow`, so a column present in PROJECT_COLUMNS and not
--    here comes back SILENTLY DEFAULTED on the shell-bootstrap path rather than
--    erroring. For THIS column that default is `false`, i.e. the topbar/layout
--    path would read every project as un-supervised no matter what the operator
--    set - a safety opt-in reading as off is the one direction that fails
--    quietly instead of loudly.
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
               supervisor_enabled,
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
