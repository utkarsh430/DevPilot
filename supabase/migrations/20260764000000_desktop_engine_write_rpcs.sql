-- =============================================================================
-- Migration : 20260764000000_desktop_engine_write_rpcs.sql
-- Purpose   : A SECOND SECURITY DEFINER RPC family — sibling to WP 1.3's
--             agent-scoped `devpilot_*` RPCs (20260762000000), not a widening
--             of them — closing the write-privilege gap the devpilot-desktop
--             Phase 2 acceptance gate found in the ENGINE's own board writes.
--
-- Provenance
-- ──────────
-- WP 1.3 (20260761000000/20260762000000) classified and closed the write gap
-- for the 9 AGENT MCP tool-relay ROUTES (docs/probes/04-rls-agent-writes.md).
-- Those routes are what an agent calls over stdio; they say nothing about
-- what the ENGINE ITSELF writes when it is not relaying an agent tool call —
-- the dispatcher assigning/advancing a ticket, the stuck-ticket/orphan/
-- verdictless-review reapers parking or reconciling one, the QA-retry-ceiling
-- park, the backlog drain promoting a dependent, the supervisor escalating a
-- failed run to a human. Upstream (this repo's own Next.js app) those run as
-- `service_role`, which bypasses RLS entirely — so the gap was invisible
-- until devpilot-desktop's Phase 2 acceptance gate ran the ported engine
-- against a REAL signed-in-user session with no service key and hit
-- `permission denied for table tickets` (42501) at
-- `lib/board/transitions.ts`'s main ticket-status UPDATE, the first board
-- write on its critical path (report: devpilot-desktop
-- `docs/phase-2-acceptance.md`, finding "F1").
--
-- Rejected alternatives (from that report's own options list, reproduced here
-- because the "why not" is exactly what shapes this migration):
--   1. Widen `devpilot_move_ticket` to accept the extra columns/gates this
--      write needs. REJECTED: `devpilot_move_ticket` RAISES on every refusal
--      (illegal edge, reopen, safety-critical-done). The ENGINE's own
--      `transitionTicket` (lib/board/transitions.ts) does NOT — it RETURNS a
--      typed `{ transitioned: false, gateRefusal }` for the safety gate (and,
--      when the L1 QA gate is enabled, for that too), because a refusal there
--      is recoverable business logic the caller inspects and reacts to
--      (park to blocked, 422-and-retry), not an exceptional failure. Widening
--      the existing RPC would force one of its TWO current callers (the live
--      MCP `devpilot_move_ticket` route, which wants a throw-and-422) or this
--      migration's engine callers (which want the returned-refusal shape) to
--      adapt to a contract that isn't theirs. A SIBLING function is what lets
--      each keep its own contract.
--   2. Give the sidecar a privileged principal for engine writes. REJECTED —
--      `docs/PLAN.md` and devpilot-desktop's CI grep gate both forbid a
--      service-role key in the binary; not revisited here.
--   3. Grant `authenticated` the columns the engine needs directly. REJECTED
--      — it re-opens exactly the hole 20260761000000 closed on purpose:
--      `tickets_member_insert` forces `status = 'backlog'` so nothing can be
--      created dispatchable, and an unguarded `status`/`retry_count`/
--      `gate_retry_count` column grant would let ANY signed-in tenant member
--      drive the FSM directly, bypassing every reopen/safety/plan-hold gate.
--
-- What this migration does NOT touch: 20260761000000's policies/grants and
-- every function in 20260762000000/20260763000000 (`devpilot_system_comment`,
-- `devpilot_move_ticket`, `devpilot_create_ticket`, `devpilot_spawn_run`,
-- `devpilot_set_project_secret`, `devpilot_get_project_secret_names`,
-- `require_tenant_member`) are byte-for-byte unchanged. This file only
-- CREATEs two new functions.
--
-- Deriving the write-shape list (not copied verbatim from devpilot-desktop's
-- gate report — independently re-derived against THIS repo's actual source
-- and actual shipped WP 1.3 grants, per the task's own instruction not to
-- guess)
-- ─────────────────────────────────────────────────────────────────────────
-- The desktop gate's F1 table names 9 write call sites in the ported engine,
-- 6 of them refused. Re-deriving from devpilot's real source
-- (lib/board/transitions.ts, lib/engine/dispatcher.ts, and the reaper/
-- reconciler/aggregator/scheduler/supervision modules that call them):
--
--   grep '\.from("tickets")\.update(' across lib/ (excluding tests) finds
--   exactly FOUR raw UPDATE call sites:
--     • lib/board/transitions.ts `transitionTicket`'s main patch — status,
--       retry_count, gate_retry_count, auto_promote_when_unblocked,
--       description, acceptance_criteria, assignee_agent_id. REFUSED under
--       20260761000000 (only title/description/acceptance_criteria/
--       assignee_agent_id are column-granted; status/retry_count/
--       gate_retry_count/auto_promote_when_unblocked are not).
--     • lib/engine/dispatcher.ts's "pull-mark-ready" step — a raw
--       {assignee_agent_id, status: 'ready' if currently backlog} patch,
--       bypassing transitionTicket entirely. Same refused shape as above
--       whenever the status half fires.
--     • lib/engine/dispatcher.ts's "prepare-run" mid-flight assignee stamp —
--       {assignee_agent_id} ONLY. Already reaches the table: the plain
--       column grant already covers this. No new SQL needed.
--     • lib/engine/supervision.ts's `escalate_to_human` branch — a raw
--       {status: 'input_required'} patch, ALSO bypassing transitionTicket
--       (no FSM/actor check at the TS layer either — a pre-existing
--       app-level gap, out of scope here per the task's "no app code
--       changes"). Same refused shape as the main patch.
--   → ONE shared write shape needs new SQL: a FSM-gated tickets patch. Both
--     of the two genuinely-refused UPDATE sites, plus the two engine paths
--     found by the desktop gate (dispatcher's own pull-mark-ready and
--     supervision's park), collapse onto it.
--
--   grep 'authorType: "system"' across lib/ (excluding tests) finds every
--   engine-authored comment call site (all funnel through
--   lib/board/transitions.ts's `addComment`, or — for supervision.ts — a raw
--   insert). The `author_id` literals used, derived from source (not
--   assumed):
--     devpilot_qa_retry_ceiling, devpilot_nothing_to_land, devpilot_supervisor,
--     devpilot_workspace_precondition, devpilot_orphan_reaper, devpilot_qa_gate,
--     devpilot_role_post, devpilot_deploy, devpilot_request_secret,
--     devpilot_agent_ticket (agent-RPC-issued already) — all match
--     `devpilot_system_comment`'s existing `^devpilot_[a-z_]+$` whitelist and
--     so are ALREADY reachable through that RPC.
--     dispatcher, aggregator, builds_on_cascade, supervision,
--     ticket-reconciler, ticket-reconcile-cap, billing-gate,
--     unpushed_work_guard, and the dynamic `schedule:<8-hex>` /
--     `schedule:adhoc` (lib/engine/ticket-scheduler.ts) — NONE of these match
--     `^devpilot_[a-z_]+$` (no prefix, a hyphen, or a colon), so all are
--     REFUSED via `devpilot_system_comment` too. This is a materially WIDER
--     set than the desktop gate's own two-sample F1 rows (`supervision`,
--     and whatever `transitions.ts:607`'s caller happened to be) — sampling
--     only the two write sites on the gate's specific run path under-counted
--     the actual gap.
--   → ONE shared write shape needs new SQL: a system comment under an
--     ENGINE-scoped (not agent-scoped) author identity.
--
--   The other 3 rows in the desktop gate's F1 table need NO new SQL, verified
--   against THIS repo's actually-shipped grants (not assumed from the gate's
--   own snapshot, which may have been running against an earlier revision):
--     • the dispatcher's mid-flight assignee-only stamp — already covered by
--       20260761000000's `assignee_agent_id` column grant.
--     • `ticket_dependencies` inserts (lib/engine/conflict-audit.ts) — the
--       table's `ticket_dependencies_member_write` policy (20260729000000)
--       was never narrowed by WP 1.3 and its WITH CHECK reads a DIFFERENT
--       table (the documented "safe" RLS pattern) — already reachable.
--     • `merge_conflict_events` inserts with kind='retry_pushed'
--       (lib/engine/builds-on-cascade.ts) — 20260761000000's
--       `merge_conflict_events_member_write` policy explicitly allows this
--       exact kind (it is one of the 5 runner-safe kinds). Independently
--       re-checked here because the desktop report shows this write
--       REFUSED — the most plausible explanation is a stale/earlier snapshot
--       of the WP-1.3 SQL in that harness, not a real gap in what actually
--       shipped; if the gate still shows a refusal here after resuming from
--       this migration, re-check the *preceding* `pending_pushes` SELECT on
--       that same call site rather than assuming the INSERT itself needs
--       covering (pending_pushes carries a plain member-read policy, never
--       narrowed by any WP 1.3 migration, so that SELECT is not expected to
--       be the culprit either — but it is the one candidate this migration's
--       own re-derivation cannot rule out from source alone).
--     • `schedule_activity` inserts (lib/schedules/activity.ts) — the
--       report's own row says this "reached the table" and hit a `23514`
--       CHECK-constraint violation, not a `42501` permission refusal; an app
--       data-shape issue, unrelated to the RLS/grant gap this migration
--       closes.
--
-- So the write-privilege gap collapses to exactly TWO new SECURITY DEFINER
-- RPCs, matching the "6 of 9 refused" framing while explaining precisely
-- which write SHAPES those 6 sites share and why the other 3 need nothing:
--   1. devpilot_engine_transition_ticket — the FSM-gated tickets patch.
--   2. devpilot_engine_system_comment    — the engine-authored system comment.
--
-- Both follow 20260762000000's exact pattern: SECURITY DEFINER, pinned
-- search_path, tenant re-derived from a server-trusted FK chain (never from a
-- caller-supplied tenant_id — neither function accepts one), membership
-- re-checked via the EXISTING `require_tenant_member` (reused, not
-- redefined), EXECUTE revoked from public+anon before being granted to
-- authenticated.
--
-- Contract-shape parity with `transitionTicket` (the specific thing option 1
-- above was rejected for getting wrong)
-- ─────────────────────────────────────────────────────────────────────────
-- `devpilot_engine_transition_ticket` returns jsonb shaped exactly like
-- `transitionTicket`'s TS return type, `{ transitioned: boolean, gateRefusal?
-- : GateRefusal }`, plus the updated row (the caller needs the new state to
-- react/emit its own dispatch event — event emission itself stays
-- caller-side, same posture as `devpilot_spawn_run` leaving `agent/
-- run.requested` to its caller):
--   • Illegal FSM edge, the reopen gate, and the plan-hold gate RAISE — this
--     mirrors `transitionTicket` THROWING for these three (`assertTransition`,
--     `decideReopenGate`, `decidePlanHoldGate` all call `throw`, never
--     return a typed refusal — no legitimate caller targets these edges).
--   • The SME safety-critical-done gate RETURNS `{transitioned: false,
--     gate_refusal: {...}}` — this mirrors `transitionTicket` RETURNING
--     (never throwing) for `decideSafetyGate`, because the caller inspects
--     and reacts to this one (parks to blocked pending human approval).
--     THIS is the one gate where `devpilot_move_ticket`'s RAISE and
--     `transitionTicket`'s RETURN genuinely disagree, and is exactly the
--     mismatch that ruled out widening the existing RPC.
--   • A CAS miss (`p_expected_from` set and the row has already moved)
--     RETURNS `{transitioned: false, gate_refusal: null}` — mirrors
--     `transitionTicket`'s `return { transitioned: false }` short-circuit.
--
-- DELIBERATELY NOT implemented, matching 20260762000000's own explicit scope
-- note for `devpilot_move_ticket` verbatim ("Belongs with WP 1.3's own
-- follow-up ... a design decision") and NOT claimed as closed by this
-- migration: the L1 QA-verification gate (`decideQaGate`, which reads
-- `run_verifications` + a role's code-producing-ness — resolvable in SQL, but
-- risky to keep byte-for-byte in sync with `lib/board/qa-gate.ts`'s business
-- logic across two independently-editable copies, and NOT read by any env
-- var a Postgres function can see, `ENGINEER_QA_GATE_ENABLED` included — see
-- 20260762000000's own note on `devpilot_create_ticket`'s env-var limits for
-- the same reason applied there), its `gate_retry_count`-ceiling park, and
-- cascading `promoteUnblockedDependents`. A caller needing the QA-gate
-- VERDICT computes it TS-side (the decision logic is pure and portable — no
-- vendor SDK, no Postgres access required to evaluate it) and calls this RPC
-- only for the privileged WRITE once the verdict is known; the counter
-- values it needs to persist (`retry_delta`, or leaving `gate_retry_count`
-- untouched) are ordinary parameters here, same as `devpilot_create_ticket`
-- takes its already-decided `title`/`agent_alias` rather than deriving them.
--
-- ALSO deliberately not implemented, for the same "matches devpilot_move_
-- ticket's existing scope, not a new gap" reason: the `→ ready` open-
-- blockers guard (`BlockedByDependencyError`, thrown by `hasOpenBlockers`
-- in `lib/board/transitions.ts`, BEFORE `assertTransition`). A ticket this
-- RPC moves to `ready` does NOT re-check open blockers — `devpilot_move_
-- ticket`'s own file header states the identical gap for the same reason.
-- Both of the two real TS callers that promote to `ready` already compute
-- blocker-eligibility THEMSELVES before calling `transitionTicket`
-- (`promoteUnblockedDependents`'s own `hasOpenBlockers` re-check;
-- `ticket-scheduler.ts`'s backlog drain), so the in-function guard is
-- defence in depth for those two, not their only protection.
--
-- `devpilot_engine_system_comment`'s author allowlist is a FIXED list plus one
-- narrow dynamic pattern (`schedule:<8-hex>|adhoc`), not a permissive regex —
-- deliberately narrower than a blanket "any non-devpilot_ string", because the
-- point of a whitelist is that a caller cannot forge an identity nothing
-- issues. Extending it to a new engine author id is a one-line, reviewed
-- change here, matching the discipline `devpilot_system_comment`'s own regex
-- established for the agent-scoped identity space.
--
-- Idempotent: CREATE OR REPLACE FUNCTION throughout, matching 20260762000000.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 0. tickets.auto_promote_when_unblocked column-level grant note.
--
--    This column is NOT added to the authenticated UPDATE grant here (and
--    never should be) — 20260761000000 deliberately left it, like `status`
--    and the retry counters, reachable only through a gated RPC (a plain
--    grant would let a caller silently arm/disarm auto-promotion on any
--    ticket with no FSM/tenant re-check beyond RLS's row scoping). This RPC
--    is that gated path for it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. devpilot_engine_transition_ticket — the FSM-gated tickets patch every
--    engine write site (dispatcher, reconciler, reapers, aggregator,
--    scheduler, supervision, qa-retry ceiling, request-secret's park) needs.
--    Mirrors lib/board/transitions.ts's `transitionTicket` write, not the
--    (deliberately narrower) `devpilot_move_ticket` MCP-route RPC.
-- ---------------------------------------------------------------------------
create or replace function public.devpilot_engine_transition_ticket(
  p_ticket_id uuid,
  p_to_status public.ticket_status,
  p_actor text,
  p_run_id uuid default null,
  p_reason text default null,
  p_retry_delta int default null,
  p_description text default null,
  p_acceptance_criteria text default null,
  p_clear_assignee boolean default false,
  p_assignee_agent_id uuid default null,
  p_expected_from public.ticket_status default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.tickets;
  v_allowed boolean;
  v_retry_count int;
  v_gate_retry_count int;
  v_auto_promote boolean;
begin
  select * into v_ticket from public.tickets where id = p_ticket_id;
  if v_ticket.id is null then
    raise exception 'ticket % not found', p_ticket_id;
  end if;
  perform public.require_tenant_member(v_ticket.tenant_id);

  if p_actor not in ('agent', 'human', 'system') then
    raise exception 'unknown actor %', p_actor using errcode = '22023';
  end if;

  -- CAS short-circuit — mirrors transitionTicket's `input.expectedFrom` check
  -- (`return { transitioned: false }`, no gate touched, nothing written).
  if p_expected_from is not null and v_ticket.status <> p_expected_from then
    return jsonb_build_object('transitioned', false, 'gate_refusal', null, 'ticket', null);
  end if;

  -- Reopen gate — verbatim from devpilot_move_ticket / decideReopenGate
  -- (lib/board/reopen-policy.ts's HUMAN_ONLY_BACKLOG_RESET_SOURCES).
  -- RAISE: transitionTicket THROWS here (`throw new Error(...)`), never
  -- returns a typed refusal — no legitimate caller targets this edge.
  if p_to_status = 'backlog'
     and v_ticket.status in ('done', 'in_progress', 'input_required', 'blocked')
     and p_actor <> 'human'
  then
    raise exception 'actor % may not reset % ticket % to backlog (human-only)',
      p_actor, v_ticket.status, p_ticket_id
      using errcode = '42501';
  end if;

  -- Plan-hold gate — verbatim from decidePlanHoldGate
  -- (lib/plan/scaffolder.ts: `!planHold || to !== 'ready'` allows). RAISE:
  -- transitionTicket throws PlanHoldError here — same "no legitimate caller
  -- targets this edge" reasoning as the reopen gate.
  if v_ticket.plan_hold and p_to_status = 'ready' then
    raise exception 'ticket % is held for its pending plan commit', p_ticket_id
      using errcode = '42501';
  end if;

  -- SME safety-critical-done gate — decideSafetyGate
  -- (lib/board/safety-gate.ts). RETURN a typed refusal here — the ONE gate
  -- transitionTicket returns instead of throwing for, and the specific
  -- contract shape that ruled out widening devpilot_move_ticket (see file
  -- header): the caller inspects `gate_refusal` and parks the ticket to
  -- `blocked` pending human approval rather than treating this as an error.
  if p_to_status = 'done' and v_ticket.safety_critical and p_actor <> 'human' then
    return jsonb_build_object(
      'transitioned', false,
      'gate_refusal', jsonb_build_object(
        'code', 'safety_approval_required',
        'reason',
          'safety-critical: requires human approval before Done. This ticket is ' ||
          'flagged safety-critical, so an agent or the engine cannot complete it - a ' ||
          'human must review the work and approve it to Done from the board. The ' ||
          'ticket has been parked to blocked pending that approval; the work itself ' ||
          'is not rejected.'
      ),
      'ticket', null
    );
  end if;

  -- FSM edge check — verbatim from devpilot_move_ticket, kept in sync with
  -- lib/board/state.ts's ALLOWED_TRANSITIONS (10 statuses, 33 edges) BY HAND.
  -- Deliberately duplicated rather than shared with devpilot_move_ticket via a
  -- new helper function: this migration must not touch (or retrofit) any
  -- existing agent RPC (see file header). Compared as text for the same
  -- reason devpilot_move_ticket's own comment gives: never depend on a
  -- Postgres version's type-inference behaviour for unknown-type literals
  -- against a composite row comparison.
  select (v_ticket.status::text, p_to_status::text) in (
    ('backlog', 'ready'), ('backlog', 'failed'),
    ('ready', 'assigned'), ('ready', 'in_progress'), ('ready', 'backlog'), ('ready', 'failed'),
    ('assigned', 'in_progress'), ('assigned', 'ready'), ('assigned', 'paused'), ('assigned', 'failed'),
    ('in_progress', 'ready'), ('in_progress', 'in_review'), ('in_progress', 'input_required'),
      ('in_progress', 'blocked'), ('in_progress', 'paused'), ('in_progress', 'backlog'),
      ('in_progress', 'done'), ('in_progress', 'failed'),
    ('input_required', 'in_progress'), ('input_required', 'paused'), ('input_required', 'backlog'),
      ('input_required', 'failed'),
    ('blocked', 'in_progress'), ('blocked', 'paused'), ('blocked', 'backlog'), ('blocked', 'done'),
      ('blocked', 'failed'),
    ('in_review', 'in_progress'), ('in_review', 'blocked'), ('in_review', 'paused'),
      ('in_review', 'done'), ('in_review', 'failed'),
    ('paused', 'in_progress'), ('paused', 'backlog'), ('paused', 'failed'),
    ('done', 'backlog')
    -- 'failed' is terminal — no outbound edges.
  ) into v_allowed;

  if not v_allowed then
    raise exception 'illegal transition % -> % for ticket %', v_ticket.status, p_to_status, p_ticket_id
      using errcode = '22023';
  end if;

  -- Counters — mirrors transitionTicket's patch derivation exactly.
  -- `retry_delta`: bump `retry_count` by the caller-supplied amount (used on
  -- a QA reject; the decision to bump and by how much is made TS-side, this
  -- RPC just performs the gated write).
  -- Human-unblock reset: leaving `blocked` as a human, with no explicit
  -- retry_delta on THIS call, resets BOTH counters to 0 — the QA retry
  -- ceiling's reset half (lib/board/qa-retry.ts): the park asked for a human
  -- intervention, and it just happened. `retry_delta` deliberately takes
  -- precedence (never set on this path in the real caller, but the guard
  -- makes that explicit here too, matching transitionTicket's own comment).
  v_retry_count := v_ticket.retry_count;
  v_gate_retry_count := v_ticket.gate_retry_count;
  if p_retry_delta is not null then
    v_retry_count := v_retry_count + p_retry_delta;
  elsif p_actor = 'human' and v_ticket.status = 'blocked' and p_to_status <> 'blocked' then
    v_retry_count := 0;
    v_gate_retry_count := 0;
  end if;

  -- Clear the auto-promote flag whenever the ticket leaves Backlog, so a
  -- manual bump + later blocker-completion can't double-fire the promotion —
  -- verbatim from transitionTicket.
  v_auto_promote := v_ticket.auto_promote_when_unblocked;
  if v_ticket.status = 'backlog' and p_to_status <> 'backlog' then
    v_auto_promote := false;
  end if;

  update public.tickets set
    status = p_to_status,
    retry_count = v_retry_count,
    gate_retry_count = v_gate_retry_count,
    auto_promote_when_unblocked = v_auto_promote,
    description = coalesce(p_description, description),
    acceptance_criteria = coalesce(p_acceptance_criteria, acceptance_criteria),
    assignee_agent_id = case
      when p_clear_assignee then null
      when p_assignee_agent_id is not null then p_assignee_agent_id
      else assignee_agent_id
    end
  where id = p_ticket_id and tenant_id = v_ticket.tenant_id
  returning * into v_ticket;

  return jsonb_build_object('transitioned', true, 'gate_refusal', null, 'ticket', to_jsonb(v_ticket));
end;
$$;

revoke all on function public.devpilot_engine_transition_ticket(
  uuid, public.ticket_status, text, uuid, text, int, text, text, boolean, uuid, public.ticket_status
) from public, anon;
grant execute on function public.devpilot_engine_transition_ticket(
  uuid, public.ticket_status, text, uuid, text, int, text, text, boolean, uuid, public.ticket_status
) to authenticated;

comment on function public.devpilot_engine_transition_ticket(
  uuid, public.ticket_status, text, uuid, text, int, text, text, boolean, uuid, public.ticket_status
) is
  'ENGINE-scoped sibling of devpilot_move_ticket (20260762000000), for '
  'lib/board/transitions.ts''s transitionTicket call sites (dispatcher, '
  'reapers, reconciler, aggregator, scheduler, supervision, qa-retry '
  'ceiling) rather than the agent MCP move-ticket route. Returns a '
  '{transitioned, gate_refusal, ticket} jsonb rather than raising on a '
  'safety-gate refusal, matching transitionTicket''s own return-not-throw '
  'contract for that gate — see 20260764000000''s file header for why '
  'widening devpilot_move_ticket instead was rejected. Does NOT implement '
  'the L1 QA-verification gate, its retry-ceiling park, or cascading '
  'dependent promotion — deliberately deferred, same scope note as '
  'devpilot_move_ticket''s own header.';

-- ---------------------------------------------------------------------------
-- 2. devpilot_engine_system_comment — the engine-authored system comment,
--    under an ENGINE identity allowlist (not the agent-scoped `^devpilot_
--    [a-z_]+$` `devpilot_system_comment` already covers). Sibling RPC, not a
--    widening of devpilot_system_comment's whitelist — see file header.
-- ---------------------------------------------------------------------------
create or replace function public.devpilot_engine_system_comment(
  p_ticket_id uuid,
  p_author_id text,
  p_body text,
  p_metadata jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_id uuid;
begin
  select tenant_id into v_tenant_id from public.tickets where id = p_ticket_id;
  if v_tenant_id is null then
    raise exception 'ticket % not found', p_ticket_id;
  end if;
  perform public.require_tenant_member(v_tenant_id);

  -- Engine author identities, derived from source (see file header for the
  -- grep-derived list) rather than guessed. A `devpilot_*` identity is
  -- accepted here too (some engine call sites — devpilot_qa_retry_ceiling,
  -- devpilot_orphan_reaper, devpilot_deploy, etc. — already use that shape),
  -- widening this allowlist for a new engine author id is a one-line,
  -- reviewed addition here.
  if not (
    p_author_id ~ '^devpilot_[a-z_]+$'
    or p_author_id in (
      'dispatcher', 'aggregator', 'builds_on_cascade', 'supervision',
      'ticket-reconciler', 'ticket-reconcile-cap', 'billing-gate',
      'unpushed_work_guard'
    )
    or p_author_id ~ '^schedule:([0-9a-f]{8}|adhoc)$'
  ) then
    raise exception 'author_id % is not a reserved engine system identity', p_author_id
      using errcode = '42501';
  end if;

  insert into public.comments (tenant_id, ticket_id, author_type, author_id, body, metadata)
  values (v_tenant_id, p_ticket_id, 'system', p_author_id, p_body, p_metadata)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.devpilot_engine_system_comment(uuid, text, text, jsonb) from public, anon;
grant execute on function public.devpilot_engine_system_comment(uuid, text, text, jsonb) to authenticated;

comment on function public.devpilot_engine_system_comment(uuid, text, text, jsonb) is
  'ENGINE-scoped sibling of devpilot_system_comment (20260762000000): same '
  'reserved author_type=''system'' shape, but a WIDER, ENGINE-specific '
  'author_id allowlist (dispatcher/aggregator/builds_on_cascade/supervision/'
  'ticket-reconciler/ticket-reconcile-cap/billing-gate/unpushed_work_guard/'
  'schedule:<id>, plus any devpilot_* identity) covering the engine''s own '
  'system-comment authors that do not fit devpilot_system_comment''s '
  'agent-route-scoped ^devpilot_[a-z_]+$ whitelist. See 20260764000000''s '
  'file header for the full derivation.';

commit;
