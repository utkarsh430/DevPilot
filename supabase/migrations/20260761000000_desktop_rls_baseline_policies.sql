-- =============================================================================
-- Migration : 20260761000000_desktop_rls_baseline_policies.sql
-- Purpose   : WP 1.3 (devpilot-desktop) — the RLS foundation that lets the
--             desktop app write to the board AS A SIGNED-IN USER, with no
--             service-role key. This is the "plain policy" half; the six
--             SECURITY DEFINER RPCs that the other 7 MCP tool-relay routes
--             need are in the companion migration, 20260762000000.
--
-- Provenance
-- ──────────
-- Productionised from the executed local-harness probe at
--   projects/devpilot-desktop/probes/rls/{sql,tests}/
--   projects/devpilot-desktop/docs/probes/04-rls-agent-writes.md
-- The probe classified 3 of the 10 agent write shapes (comment, handoff,
-- log-conflict-event) as feasible under a bare owner/tenant-scoped policy —
-- this migration closes the drift between that candidate design and devpilot's
-- REAL schema/grants. The RLS *approach* is unchanged from the probe; the
-- adaptations below are schema-fidelity fixes, not a redesign:
--
--   • Every tenant-integrity trigger the probe's design needs ALREADY EXISTS
--     on this schema (assert_tenant_matches_parent, 20260732000000) — this
--     migration adds ZERO new triggers, only policy + grant changes.
--   • `run_steps` / `ticket_dependencies` were already shaped exactly like the
--     probe's "safe pattern" (WITH CHECK reads a DIFFERENT table) since
--     20260601000000 / 20260729000000 — untouched here.
--   • `query-db` (probe route #8) needs no schema change at all: its reads
--     (runs/agents/data_sources) and its run_steps audit insert are already
--     plain-policy-feasible on the live schema.
--
-- The one adaptation that is NOT in the probe's candidate SQL: real devpilot's
-- Supabase project grants `authenticated` full table-level privileges on every
-- public table by PLATFORM DEFAULT (Supabase's per-project bootstrap runs
-- `alter default privileges ... grant all ... to authenticated`, outside any
-- migration file — confirmed by grepping every migration for a table-level
-- GRANT: there is none, anywhere, ever, for `tickets`/`comments`/`runs`/etc).
-- The probe's *local* harness never had that bootstrap, so its `grant select,
-- insert on ... to authenticated` lines were ADDITIVE from nothing. Here they
-- would be no-ops — the REAL narrowing has to be an explicit REVOKE first.
-- Column-level GRANT cannot narrow an already-standing TABLE-level GRANT; it
-- can only add a MORE PERMISSIVE column carve-out on top of a revoked table
-- grant. So every "column-restricted" section below does
--     revoke <cmd> on <table> from authenticated;
--     grant <cmd> (<safe columns>) on <table> to authenticated;
-- — the revoke is not defensive boilerplate, it is the ONLY thing that makes
-- the grant below it narrower than what the platform already handed out.
--
-- Web-safety audit (why this is additive/non-breaking for the CURRENT web app)
-- ─────────────────────────────────────────────────────────────────────────
-- Read every write site in apps/web that touches tickets/comments/runs/
-- project_handoffs/merge_conflict_events before writing this file. Result:
--   • `runs` — ZERO RLS-bound (supabaseServer()) writes anywhere. The one
--     comment that touches it says so directly ("service-role write (RLS
--     forbids user writes to runs)", app/api/runs/[id]/release-takeover).
--     Dropping runs_member_write and revoking write grants matches an
--     invariant the app ALREADY assumed was true.
--   • `tickets` — the ONE RLS-bound write is the human "New Ticket" INSERT
--     (createTicketCore via supabaseServer(), called from createTicketAction).
--     Every UPDATE/DELETE in apps/web/app/(app)/board/actions.ts —
--     updateTicketAction, deleteTicketAction, bulkDeleteTicketsAction,
--     bulkMoveToReadyAction, setTicketSafetyCriticalAction,
--     setTicketPriorityAction, setTicketEstimateAction, setTicketDueAtAction,
--     reorderTicketsAction, acceptTicketDependenciesAction, transitionTicket()
--     itself — uses `supabaseService()`. INSERT stays UNRESTRICTED at the
--     column level (matching the probe exactly: only UPDATE is narrowed), so
--     the human create form keeps setting requested_role/column_position/etc.
--     precisely as it does today.
--   • `comments` — `addComment()` (the ONE write path; postCommentAction, the
--     agent comment/system-comment/request-human/request-secret routes all
--     funnel through it) always uses `supabaseService()`. No RLS-bound writer
--     exists to restrict.
--   • `project_handoffs` — currently `with check (false)` for every non-
--     service writer (20260714000000): this migration can only WIDEN it, by
--     construction. Nothing to break.
--   • `merge_conflict_events` — the one non-runner-key writer, the operator's
--     Force-push override (`operator_overrode`, app/(app)/changes/actions.ts),
--     goes through `logConflictEvent()` → `supabaseService()`. No RLS-bound
--     writer exists to restrict.
--
-- Because none of these narrowings touch `service_role` (every REVOKE/GRANT
-- below targets `authenticated`/`anon` only), the current web app — which
-- performs essentially every mutation through service-role server actions —
-- is unaffected byte-for-byte. What changes is what a *desktop client*,
-- running as the signed-in user with no service key, may do (and, as
-- defence in depth, what an unauthenticated `anon` caller could ever
-- attempt — RLS already refuses it, this closes the standing grant too).
--
-- Idempotent: DROP POLICY IF EXISTS / CREATE OR REPLACE throughout; REVOKE on
-- a privilege never granted is a harmless no-op (this is also what makes the
-- same file apply cleanly against the probe's from-scratch local harness,
-- which has no platform bootstrap grants to begin with).
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. tickets — two adaptations beyond the probe's candidate design, both
--    found by the devpilot-desktop companion harness (WP 1.4, PR #8) driving
--    this exact policy set against a REAL local Supabase (Postgres +
--    PostgREST + GoTrue), not just this repo's throwaway-Postgres harness:
--
--    (a) UPDATE is narrowed to (title, description, acceptance_criteria,
--        assignee_agent_id) via a column-level GRANT — status/requested_role/
--        retry_count/gate_retry_count/safety_critical/plan_hold/source_run_id/
--        agent_alias/parent_ticket_id/column_position are reachable only
--        through devpilot_move_ticket / devpilot_create_ticket (20260762000000),
--        which re-derive tenant and enforce the FSM/actor gates a row-level
--        policy cannot express.
--
--    (b) INSERT is now SPLIT from UPDATE/DELETE into its own policy that
--        additionally requires `status = 'backlog'`. The probe's own design
--        left INSERT column-unrestricted (matching `createTicketCore`, which
--        ALWAYS inserts `status: 'backlog'` today) — but "unrestricted" meant
--        a tenant member could insert a ticket ALREADY at `status = 'done'`
--        (or any other status), bypassing every FSM transition gate this
--        migration's devpilot_move_ticket exists to enforce. Verified directly
--        against a real harness by PR #8, which flagged it as inherited from
--        the probe's own policy set rather than something it introduced.
--        Constraining the INITIAL value at INSERT time closes it without
--        touching UPDATE/DELETE at all — `createTicketCore`'s current
--        behaviour (always 'backlog') is unaffected byte-for-byte.
--
--    The single "for all" tickets_member_write (20260759000000) is therefore
--    replaced by three narrower policies: tickets_member_insert (status
--    forced to 'backlog'), tickets_member_update (unrestricted at the policy
--    level — the column grant below is what narrows it), and
--    tickets_member_delete (unchanged tenant-only USING, matching the
--    original policy's DELETE behaviour exactly). tickets_member_read is
--    untouched.
-- ---------------------------------------------------------------------------
drop policy if exists tickets_member_write on public.tickets;

-- IF EXISTS on all three: idempotence on RE-application (not just on the
-- superseded tickets_member_write) — a bare `create policy` here would fail
-- "policy already exists" the second time this migration runs, since the
-- first application already created these three names.
drop policy if exists tickets_member_insert on public.tickets;
create policy tickets_member_insert on public.tickets
  for insert
  with check (
    tenant_id in (select public.current_user_tenants())
    and (
      project_id is null
      or project_id in (
        select id from public.projects where tenant_id in (select public.current_user_tenants())
      )
    )
    and status = 'backlog'
  );

drop policy if exists tickets_member_update on public.tickets;
create policy tickets_member_update on public.tickets
  for update
  using (tenant_id in (select public.current_user_tenants()))
  with check (
    tenant_id in (select public.current_user_tenants())
    and (
      project_id is null
      or project_id in (
        select id from public.projects where tenant_id in (select public.current_user_tenants())
      )
    )
  );

drop policy if exists tickets_member_delete on public.tickets;
create policy tickets_member_delete on public.tickets
  for delete
  using (tenant_id in (select public.current_user_tenants()));

-- REVOKE BEFORE GRANT — load-bearing, not defensive boilerplate. A Supabase
-- project configured to auto-expose new `public` entities hands
-- `authenticated` FULL privileges on every new table via its own default-
-- privilege bootstrap (outside any migration file — see the file header).
-- That standing grant silently VOIDS a bare column-level GRANT: Postgres
-- privileges are additive, so "authenticated already has table-level UPDATE"
-- means a narrower column-level grant on top of it does nothing at all. The
-- REVOKE is what makes the GRANT below actually narrower than what the
-- platform handed out — found the hard way by PR #8's harness, which
-- verified this against a real Supabase stack (this repo's own throwaway-
-- Postgres harness has no such bootstrap to begin with, so it could not have
-- caught the omission on its own).
-- `anon` (unauthenticated) is included in every REVOKE below alongside
-- `authenticated`, for the same reason 20260762000000 revokes RPC EXECUTE
-- from both: RLS would refuse an anon caller anyway (current_user_tenants()
-- resolves nothing for a NULL auth.uid()), so this is defence in depth, not
-- the primary boundary — but the platform bootstrap grants `anon` its own
-- table-level privilege alongside `authenticated`, and leaving it unrevoked
-- would be exactly the kind of standing grant this file exists to close.
revoke insert, update, delete on public.tickets from authenticated, anon;
grant select, insert, delete on public.tickets to authenticated;
grant update (title, description, acceptance_criteria, assignee_agent_id)
  on public.tickets to authenticated;

comment on table public.tickets is
  'INSERT (tickets_member_insert) is tenant+project scoped AND requires '
  'status=''backlog'' — see 20260761000000. UPDATE (tickets_member_update) is '
  'tenant+project scoped at the policy level and column-restricted to '
  '(title, description, acceptance_criteria, assignee_agent_id) at the grant '
  'level. DELETE (tickets_member_delete) is tenant scoped, unchanged from the '
  'original tickets_member_write (20260759000000). Every column not in the '
  'UPDATE grant list (status, requested_role, retry_count, gate_retry_count, '
  'safety_critical, plan_hold, source_run_id, agent_alias, parent_ticket_id, '
  'column_position) is reachable post-creation only through devpilot_move_ticket '
  '/ devpilot_create_ticket (20260762000000), which re-derive tenant and '
  'enforce the FSM/actor gates a row-level policy cannot express.';

-- ---------------------------------------------------------------------------
-- 1b. project_secrets — CLOSE A LATENT, PRE-EXISTING GAP: the table has
--    carried NO RLS policy for `authenticated` at all since it was created
--    (20260606000000, "DELIBERATELY NO member-read policy on the table
--    itself"), but a Supabase project auto-exposing new tables would have
--    handed `authenticated` a full TABLE-LEVEL grant on it the moment that
--    migration applied — silent, because with zero policies RLS blocks every
--    row regardless of the grant UNTIL some future policy addition
--    accidentally relies on "no grant" as a second line of defence that was
--    never actually there. Found by the same REVOKE-before-GRANT audit PR #8
--    ran against project_secrets specifically (see file header): explicitly
--    revoking it now makes "authenticated has zero standing privilege on
--    this table" a documented, re-verifiable fact rather than an assumption.
--    Values remain reachable ONLY via devpilot_set_project_secret /
--    devpilot_get_project_secret_names (20260762000000).
-- ---------------------------------------------------------------------------
revoke all on public.project_secrets from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. comments — plain tenant-member INSERT of agent/human authorship. 'system'
--    authorship is RESERVED for devpilot_system_comment (20260762000000): the
--    current comments_member_write ("for all", no author_type restriction —
--    core.sql) lets ANY tenant member forge author_type='system' with a
--    devpilot_* identity today, mitigated only by the fact that the trusted
--    runner-key-gated route is the only current caller. That mitigation is
--    gone once the service-role/runner-key boundary is gone for the desktop
--    app, so this migration closes it now rather than carrying it forward.
--
--    UPDATE/DELETE are dropped entirely (comments are an append-only thread
--    in every real write path — addComment() never updates or deletes a
--    row), matching project_handoffs' established append-only posture.
--
--    trg_comments_ticket_id_tenant (20260732000000) already re-derives and
--    enforces the ticket's tenant on every insert/update — no new trigger.
-- ---------------------------------------------------------------------------
drop policy if exists comments_member_write on public.comments;
create policy comments_member_write on public.comments
  for insert
  with check (
    tenant_id in (select public.current_user_tenants())
    and author_type in ('agent', 'human')
  );

revoke insert, update, delete on public.comments from authenticated, anon;
grant insert on public.comments to authenticated;

comment on column public.comments.author_type is
  'agent | human | system. A plain authenticated INSERT may write agent/human '
  'only (comments_member_write, 20260761000000) — system authorship (engine '
  'narration, verdicts) is reserved for devpilot_system_comment / '
  'devpilot_move_ticket (20260762000000), which whitelist author_id against '
  '^devpilot_[a-z_]+$ before writing it.';

-- ---------------------------------------------------------------------------
-- 3. project_handoffs — replace the deny-all INSERT policy (20260714000000:
--    `with check (false)` for every non-service writer) with a real
--    tenant+project-scoped member-insert policy. The table is append-only,
--    low-privilege, and has no forced/system column, so a plain policy is
--    sufficient (the probe's own verdict for this route).
--
--    project_handoffs_update_deny / project_handoffs_delete_deny stay exactly
--    as they are — append-only is unchanged.
--
--    trg_project_handoffs_project_id_tenant / _ticket_id_tenant / _run_id_tenant
--    (20260732000000) already independently re-verify every FK endpoint's
--    tenant — no new trigger.
--
--    project_id=NULL is refused by THIS POLICY, not by the column's NOT NULL
--    constraint — a correction to the original probe finding doc (§5), which
--    worded it as "falls out for free from the column's NOT NULL constraint".
--    Caught empirically by the devpilot-desktop companion harness (PR #8)
--    driving this exact policy against a real Postgres: `project_id in
--    (select ...)` evaluates to NULL (not TRUE) when project_id IS NULL, so
--    the WITH CHECK denies the row — observed as "new row violates row-level
--    security policy", the generic RLS refusal, never the NOT NULL
--    constraint's distinct error. The RULE holds either way (a NULL
--    project_id is refused); only the enforcing CONTROL differs from what the
--    finding doc says, and this repo's own harness (tests/14_handoff.sql)
--    reproduces the same observation.
-- ---------------------------------------------------------------------------
drop policy if exists project_handoffs_insert_deny on public.project_handoffs;
drop policy if exists project_handoffs_member_write on public.project_handoffs;
create policy project_handoffs_member_write on public.project_handoffs
  for insert
  with check (
    tenant_id in (select public.current_user_tenants())
    and project_id in (
      select id from public.projects where tenant_id in (select public.current_user_tenants())
    )
  );

comment on table public.project_handoffs is
  'Append-only agent handoff notes. INSERT is member-scoped on tenant AND '
  'project (project_handoffs_member_write, 20260761000000, superseding the '
  '20260714000000 deny-all policy); UPDATE/DELETE remain denied for every JWT '
  'role. FK tenant match enforced independently by '
  'trg_project_handoffs_project_id_tenant / _ticket_id_tenant / _run_id_tenant.';

-- ---------------------------------------------------------------------------
-- 4. merge_conflict_events — DB-level enforcement of the "runner-safe kind"
--    allowlist that today is enforced ONLY in the Next.js route handler
--    (RUNNER_ALLOWED_KINDS) — the current merge_conflict_events_member_write
--    ("for all", 20260607050000) has NO kind restriction at all, so any
--    tenant member can already insert a forged 'operator_overrode' row.
--
--    The 3 reserved kinds (detected, merger_spawned, operator_overrode) get
--    NO insert grant here, deliberately: today they are written by a
--    separate, trusted server process, and there is no Postgres-visible
--    "server" left to be their trusted origin once an agent write goes
--    straight through as the signed-in user. See the probe finding doc §9 —
--    the durable fix (moving them to local execution-layer telemetry) is a
--    WP 1.3+/2.2 scope decision, not resolved here.
--
--    UPDATE/DELETE dropped entirely — no current write path uses them
--    (logConflictEvent() only ever inserts, via supabaseService()).
--
--    trg_merge_conflict_events_pending_push_id_tenant / _project_id_tenant /
--    _ticket_id_tenant / _merger_ticket_id_tenant (20260732000000) already
--    independently re-verify every FK endpoint's tenant — no new trigger.
-- ---------------------------------------------------------------------------
drop policy if exists merge_conflict_events_member_write on public.merge_conflict_events;
create policy merge_conflict_events_member_write on public.merge_conflict_events
  for insert
  with check (
    tenant_id in (select public.current_user_tenants())
    and kind in ('merger_started', 'file_resolved', 'merger_completed', 'retry_pushed', 'retry_failed')
  );

revoke insert, update, delete on public.merge_conflict_events from authenticated, anon;
grant insert on public.merge_conflict_events to authenticated;

comment on column public.merge_conflict_events.kind is
  'merge_conflict_events_member_write (20260761000000) restricts a plain '
  'authenticated INSERT to the 5 runner-safe kinds (merger_started, '
  'file_resolved, merger_completed, retry_pushed, retry_failed). The 3 '
  'reserved kinds (detected, merger_spawned, operator_overrode) have NO '
  'insert path for authenticated at all — see the probe finding doc §9 for '
  'why this is a real, deliberately-unresolved architecture gap and not an '
  'oversight.';

-- ---------------------------------------------------------------------------
-- 5. runs — READ-ONLY for authenticated. None of the four spawn caps (depth,
--    fan-out, global-active-per-tenant, budget-inheritance) are expressible
--    as a static WITH CHECK — two are correlated-subquery caps against the
--    SAME parent row, two need atomic-under-concurrency claims a naive
--    check-then-insert would race. The current runs_member_write ("for all",
--    core.sql) lets a signed-in user insert a runs row with ANY budget_cents/
--    depth, bypassing every cap — so runs gets NO INSERT/UPDATE/DELETE grant
--    to authenticated at all; every mutation goes through devpilot_spawn_run
--    (20260762000000).
--
--    This matches an invariant the app already treats as load-bearing: see
--    apps/web/app/api/runs/[id]/release-takeover/route.ts's own comment,
--    "service-role write (RLS forbids user writes to runs)".
-- ---------------------------------------------------------------------------
drop policy if exists runs_member_write on public.runs;
revoke insert, update, delete on public.runs from authenticated, anon;

comment on table public.runs is
  'READ-ONLY for authenticated (runs_member_read, core.sql; no write policy, '
  'no INSERT/UPDATE/DELETE grant — 20260761000000). Every mutation goes '
  'through the atomic-capped devpilot_spawn_run RPC (20260762000000), because '
  'none of the depth/fan-out/global-active/budget-inheritance spawn caps are '
  'expressible as a row-level policy.';

commit;
