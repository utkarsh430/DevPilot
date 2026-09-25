-- WP 1.3 RLS harness: seed data.
--
-- Two tenants (A, B) with disjoint membership, so every test can run the
-- same write as (1) a member of the owning tenant — expect success, and
-- (2) a member of the *other* tenant only — expect refusal. That paired
-- control is what turns a happy-path insert into an actual classification,
-- not just a demo. UUID scheme mirrors the devpilot-desktop probe's seed for
-- traceability (aNNNNNNN.../bNNNNNNN... = tenant A / tenant B fixtures).

insert into auth.users (id, email) values
  ('a1000000-0000-0000-0000-000000000001', 'alice@tenant-a.example'),
  ('b1000000-0000-0000-0000-000000000002', 'bob@tenant-b.example');

insert into public.tenants (id, name) values
  ('a0000000-0000-0000-0000-000000000001', 'Tenant A'),
  ('b0000000-0000-0000-0000-000000000002', 'Tenant B');

insert into public.tenant_members (user_id, tenant_id) values
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002');

insert into public.projects (id, tenant_id, name, agent_ticket_creation, agent_ticket_max_per_run) values
  ('a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Project A', true, 5),
  ('b2000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'Project B', true, 5),
  -- Opted-OUT project (agent_ticket_creation=false) — for the create-ticket
  -- opt-in refusal test.
  ('a2000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', 'Project A (no agent tickets)', false, null);

-- One dedicated ticket per test scenario, so test files don't depend on
-- execution order or on state another test file left behind.
insert into public.tickets (id, tenant_id, project_id, title, status, safety_critical) values
  ('a3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: comment route target', 'in_progress', false),
  ('a3000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: ready ticket (dependency target)', 'ready', false),
  ('a3000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: in_review, safety_critical ticket', 'in_review', true),
  ('a3000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: move-ticket valid-edge target', 'in_progress', false),
  ('a3000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: move-ticket reopen-gate target', 'in_review', false),
  ('a3000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: request-human target', 'in_progress', false),
  ('a3000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: request-secret target', 'in_progress', false),
  ('a3000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: move-ticket illegal-edge target', 'backlog', false),
  ('a3000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: create-ticket spawning ticket', 'in_progress', false),
  ('a3000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: paused ticket (human-only reopen n/a)', 'paused', false),
  -- Opted-out project's spawning ticket — create-ticket opt-in refusal test.
  ('a3000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000009', 'A: spawning ticket in opted-out project', 'in_progress', false),
  ('b3000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002',
    'b2000000-0000-0000-0000-000000000002', 'B: in progress ticket', 'in_progress', false);

-- A tenant-A ticket with NO project (project_id null) — the create-ticket
-- "spawning ticket has no project" refusal test.
insert into public.tickets (id, tenant_id, project_id, title, status, safety_critical) values
  ('a3000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000001',
    null, 'A: no-project spawning ticket', 'in_progress', false);

insert into public.agents (id, tenant_id, name, config) values
  ('a4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Test Engineer', '{}'::jsonb),
  -- Dedicated second tenant-A agent for 20260765000000's dispatch_queue
  -- INSERT tests (tests/23_dispatch_queue_insert.sql) - kept SEPARATE from
  -- a4...0001 (used by tests/24_dispatch_queue_claim_next.sql's claim
  -- scenarios) so a row test 23 legitimately leaves PENDING never competes
  -- with test 24's own pre-seeded row for the same (tenant, agent) pair.
  ('a4000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Test Engineer 2', '{}'::jsonb),
  -- Tenant B agent - needed for 20260765000000's cross-tenant dispatch_queue
  -- controls (a foreign agent, not just a foreign ticket).
  ('b4000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'B Test Engineer', '{}'::jsonb);

insert into public.runs (id, tenant_id, agent_id, ticket_id, depth, children_count, budget_cents, spent_cents, status) values
  ('a6000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
    'a4000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000010', 0, 0, 1000, 200, 'running'),
  ('a6000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
    'a4000000-0000-0000-0000-000000000001', null, 3, 0, 500, 0, 'running'), -- already at MAX_DEPTH
  ('a6000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001',
    'a4000000-0000-0000-0000-000000000001', null, 0, 4, 1000, 0, 'running'), -- already at MAX_FAN_OUT
  ('a6000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001',
    'a4000000-0000-0000-0000-000000000001', null, 0, 0, 100, 90, 'running'), -- only 10c budget left
  ('b6000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002',
    null, null, 0, 0, 1000, 0, 'running');

insert into public.pending_pushes (id, tenant_id, project_id, ticket_id, workspace_path, branch) values
  ('a7000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001',
    '/tmp/harness/tenant-a-workspace', 'devpilot/harness-a'),
  ('b7000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002',
    'b2000000-0000-0000-0000-000000000002', 'b3000000-0000-0000-0000-000000000002',
    '/tmp/harness/tenant-b-workspace', 'devpilot/harness-b');

-- ─────────────────────────────────────────────────────────────────────────
-- 20260764000000 — dedicated tickets for devpilot_engine_transition_ticket /
-- devpilot_engine_system_comment (tests/2{0,1}_*.sql), one per scenario so
-- those tests don't depend on execution order or on state another test file
-- left behind, matching the convention above.
-- ─────────────────────────────────────────────────────────────────────────
insert into public.tickets (
  id, tenant_id, project_id, title, status, safety_critical, plan_hold,
  auto_promote_when_unblocked, retry_count, gate_retry_count
) values
  -- ready -> in_progress, system actor, WITH an assignee stamp in the same
  -- call — mirrors dispatcher.ts's "prepare-run" transitionTicket call.
  ('a3000000-0000-0000-0000-000000000020', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition ready->in_progress',
    'ready', false, false, false, 0, 0),
  -- backlog -> ready, system actor, auto_promote_when_unblocked=true — mirrors
  -- dispatcher.ts's "pull-mark-ready" / promoteUnblockedDependents' `to:
  -- 'ready'` call; proves the flag is cleared on leaving backlog.
  ('a3000000-0000-0000-0000-000000000021', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition backlog->ready',
    'backlog', false, false, true, 0, 0),
  -- in_progress -> backlog: reopen-gate RAISE for agent, SUCCESS for human.
  -- MUST be a status that is BOTH in HUMAN_ONLY_BACKLOG_RESET_SOURCES
  -- (done/in_progress/input_required/blocked) AND has a real `-> backlog`
  -- FSM edge, or the FSM check (which devpilot_engine_transition_ticket
  -- evaluates AFTER the reopen gate, matching transitionTicket's real
  -- reopen-before-FSM order) would refuse the edge outright and the test
  -- would never actually exercise the reopen-gate branch. `in_review` does
  -- NOT have a `-> backlog` edge at all (lib/board/state.ts) — a trap this
  -- migration's own tests deliberately avoid, unlike 13_move_ticket.sql's
  -- pre-existing same-shaped scenario (see 20260764000000's PR notes).
  ('a3000000-0000-0000-0000-000000000022', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition reopen-gate target',
    'in_progress', false, false, false, 0, 0),
  -- in_review, safety_critical -> done: safety-gate RETURN (not raise) for
  -- agent/system, SUCCESS for human.
  ('a3000000-0000-0000-0000-000000000023', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition safety-gate target',
    'in_review', true, false, false, 0, 0),
  -- backlog, plan_hold=true -> ready: plan-hold-gate RAISE for any actor.
  ('a3000000-0000-0000-0000-000000000024', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition plan-hold target',
    'backlog', false, true, false, 0, 0),
  -- backlog -> done: illegal FSM edge, RAISE even for a human actor.
  ('a3000000-0000-0000-0000-000000000025', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition illegal-edge target',
    'backlog', false, false, false, 0, 0),
  -- in_progress: CAS (expected_from) mismatch target — the call passes a
  -- wrong expected_from and must return {transitioned:false} with no raise.
  ('a3000000-0000-0000-0000-000000000026', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition CAS-mismatch target',
    'in_progress', false, false, false, 0, 0),
  -- blocked, retry_count=3, gate_retry_count=2 -> in_progress, human actor,
  -- no retry_delta: both counters reset to 0 (the QA-retry-ceiling reset).
  ('a3000000-0000-0000-0000-000000000027', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition human-unblock-reset target',
    'blocked', false, false, false, 3, 2),
  -- in_review -> in_progress, system actor, retry_delta=1: mirrors a QA
  -- reject bump (retry_count increments, gate_retry_count untouched).
  ('a3000000-0000-0000-0000-000000000028', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition retry-delta target',
    'in_review', false, false, false, 0, 0),
  -- ready -> in_progress with assignee + description + acceptance_criteria
  -- all patched in the SAME call.
  ('a3000000-0000-0000-0000-000000000029', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition full-patch target',
    'ready', false, false, false, 0, 0),
  -- in_progress: cross-tenant control target (Bob attempts a
  -- legal-on-the-merits transition against a tenant-A ticket).
  ('a3000000-0000-0000-0000-000000000030', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition cross-tenant control target',
    'in_progress', false, false, false, 0, 0),
  -- failed: terminal, no outbound edges at all — a SECOND illegal-edge
  -- assertion (the first, backlog->done, proves one hardcoded edge is
  -- refused; this proves the WHOLE-STATE terminal case is too, not just
  -- that one pair).
  ('a3000000-0000-0000-0000-000000000031', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: engine-transition terminal-state target',
    'failed', false, false, false, 0, 0);

-- -----------------------------------------------------------------------
-- 20260765000000 - dedicated tickets for dispatch_queue/integration_queue
-- tests (tests/2{3,4,5}_*.sql), one per scenario, matching the convention
-- above.
-- -----------------------------------------------------------------------
insert into public.tickets (id, tenant_id, project_id, title, status, safety_critical) values
  -- dispatch_queue INSERT target - own-tenant member inserts a valid row
  -- against this ticket.
  ('a3000000-0000-0000-0000-000000000032', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: dispatch_queue insert target', 'ready', false),
  -- dispatch_queue claim target - a PENDING row is pre-seeded against this
  -- ticket below, for the claim-next success + no-double-claim tests.
  ('a3000000-0000-0000-0000-000000000033', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: dispatch_queue claim target', 'ready', false),
  -- integration_queue claim target - a PENDING row is pre-seeded against
  -- this ticket below, for the claim-next success test.
  ('a3000000-0000-0000-0000-000000000034', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'A: integration_queue claim target', 'done', false);

-- Pre-seeded PENDING dispatch_queue row. Consumed by the LAST assertion in
-- tests/24_dispatch_queue_claim_next.sql (own-tenant success); every earlier
-- assertion in that file (cross-tenant refusal) does not touch it, since
-- require_tenant_member raises before the claim query ever runs.
insert into public.dispatch_queue (id, tenant_id, ticket_id, agent_id, wip_limit_snapshot) values
  ('a8000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000033', 'a4000000-0000-0000-0000-000000000001', 1);

-- Pre-seeded PENDING integration_queue row, same posture as above -
-- consumed by the own-tenant success assertion in
-- tests/25_integration_queue_claim_next.sql.
insert into public.integration_queue (id, tenant_id, project_id, ticket_id, priority) values
  ('a9000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000034', 3);
