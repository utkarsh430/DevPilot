-- =============================================================================
-- Migration : 20260765000000_desktop_engine_queue_rls.sql
-- Purpose   : The THIRD and final RLS slice for the devpilot-desktop migration
--             - closes finding F6 of the Phase 2 chaos-gate acceptance report
--             (devpilot-desktop PR #24, `docs/phase-2-acceptance.md`), the
--             three refusals that stop criteria 2 and 3 from running at all:
--               1. `dispatch_queue` INSERT (`enqueueDispatch`) - RLS policy
--                  refusal, live in criterion 2.
--               2. `dispatch_queue_claim_next` EXECUTE - 42501, fails
--                  `dispatchOnRunComplete` after every run.
--               3. `integration_queue_claim_next` EXECUTE - 42501, the land
--                  pipeline cannot claim work.
--
-- Provenance
-- ──────────
-- Same situation as 20260762000000/20260764000000: `dispatch_queue` and
-- `integration_queue` were built (20260603020000, 20260715000000) as
-- `service_role`-only tables - a signed-in-user RLS gap that is invisible in
-- THIS repo (every caller here is `supabaseService()`) and was only found by
-- the devpilot-desktop sidecar, which holds a signed-in user's access token
-- with no service key by design.
--
-- Rejected alternative for items 2/3, and why a plain `grant execute` is NOT
-- enough on its own
-- ─────────────────────────────────────────────────────────────────────────
-- Both `dispatch_queue_claim_next(p_tenant_id, p_agent_id)` and
-- `integration_queue_claim_next(p_project_id)` are `security definer` and, as
-- shipped, take the caller's `p_tenant_id`/`p_project_id` at face value -
-- there is no `require_tenant_member()` call anywhere in either body, because
-- their only caller has always been the trusted service-role engine. A bare
-- `grant execute ... to authenticated` on the UNCHANGED functions would let
-- ANY signed-in user of ANY tenant call `dispatch_queue_claim_next` with a
-- FOREIGN `p_tenant_id`/`p_agent_id` and claim (and dispatch) another
-- tenant's queued ticket, or call `integration_queue_claim_next` with a
-- foreign `p_project_id` and claim another tenant's land row - a real
-- cross-tenant hole, exploitable the moment the grant lands, not merely
-- theoretical. This is exactly the property 20260762000000's own header
-- states as the rule for every RPC in this family: "none trust the caller's
-- own claims about tenant/project/run identity, only server-derived
-- lookups." Both claim functions violated it; they simply never had to pay
-- for it while `service_role` was their only caller.
--
-- So this migration does NOT touch the pre-existing `service_role`-only
-- grant lines from 20260603020000/20260715000000 - it `create or replace`s
-- both functions, ADDING a `require_tenant_member()` check at the top (tenant
-- re-derived from the project for the integration-queue function, since it
-- takes no `p_tenant_id` of its own) and changing NOTHING else about their
-- bodies - same signature, same return shape, same atomic
-- `FOR UPDATE SKIP LOCKED` claim, byte-for-byte - then grants EXECUTE to
-- `authenticated` on top. This is "PR 204's family conventions exactly": the
-- functions are SECURITY DEFINER, `set search_path = public`, tenant
-- re-derived from a server-trusted FK chain rather than trusted from the
-- caller, and EXECUTE is granted to `authenticated` only after that guard is
-- in place. `ticket_land_open(uuid)`, called internally by
-- `integration_queue_claim_next`'s dependency gate, needs no new grant: it is
-- itself `security definer` and is invoked from WITHIN another
-- `security definer` function, so it runs under the calling function's
-- privileges regardless of what `authenticated` itself can reach.
--
-- The `dispatch_queue` INSERT policy
-- ─────────────────────────────────────────────────────────────────────────
-- `dispatch_queue`'s INSERT/UPDATE/DELETE table-level grant to `authenticated`
-- was NEVER revoked by WP 1.3 - only `tickets`/`comments`/`runs`/
-- `merge_conflict_events`/`project_secrets` got the REVOKE-then-narrower-GRANT
-- treatment (20260761000000). `dispatch_queue`'s three write policies
-- (`_insert_deny`/`_update_deny`/`_delete_deny`, all `using/with check
-- (false)`) have been the ONLY thing standing between `authenticated` and the
-- table since 20260603020000. So closing item 1 needs no grant change at
-- all - only replacing `dispatch_queue_insert_deny` with a real, tenant-
-- scoped policy. The row's tenant is re-derived from its anchor by the
-- EXISTING triggers (20260732000000's `trg_dispatch_queue_agent_id_tenant` /
-- `trg_dispatch_queue_ticket_id_tenant`, `assert_tenant_matches_parent`
-- against `agents`/`tickets`), so the WITH CHECK below only needs the
-- membership test - the anchor re-derivation is already load-bearing and
-- already applies to every INSERT, this policy or not.
-- `status = 'pending'` is added to the WITH CHECK for the same reason
-- 20260761000000's `tickets_member_insert` constrains the initial `status` at
-- INSERT time: it keeps `dispatch_queue_claim_next` (the only path that may
-- ever flip a row to `dispatched`) the sole writer of that transition, rather
-- than letting a caller insert a row already claiming to be dispatched.
-- `dispatch_queue_update_deny`/`_delete_deny` are UNCHANGED - this migration
-- does not widen them.
--
-- The independent write-site reconciliation
-- ─────────────────────────────────────────────────────────────────────────
-- devpilot-desktop's own F5 finding is a methodology warning, not merely a
-- headline count: its FIRST scan compared its declared write-site list
-- against a source scan derived by the SAME flawed single-line regex, so the
-- two agreed about a set that was short - a scan agreeing with itself is not
-- a check. Its FIXED scan (multi-line, comment-stripped, run against
-- `apps/sidecar/src`, the ported engine) found 32 board-write call sites of
-- which only 9 had been probed; the remaining ~23 are "enumerated, not
-- probed" in that report specifically because guessing at 23 more would
-- manufacture findings rather than measure them.
--
-- Re-deriving independently against THIS repo's actual source (the same
-- multi-line, comment-stripped technique, applied to
-- apps/web/lib/{engine,board,integration,schedules}) rather than trusting
-- either scan, and mapping every one of the desktop's unprobed sidecar sites
-- back to its devpilot equivalent by file:
--
--   COVERED already - no SQL needed here (confirms "expect a similar mix" to
--   PR 204's own "3 of 9 needed nothing"):
--     • `ticket_dependencies` (conflict-audit.ts, ticket-deps.server.ts,
--       parse-mentions.ts) - `ticket_dependencies_member_write`'s WITH CHECK
--       reads a DIFFERENT table (the documented "safe" RLS pattern), never
--       narrowed by any WP 1.3 migration.
--     • `pending_pushes` (conflict-audit.ts x4, land-outcome-write.ts,
--       landed-push.ts) - `pending_pushes_member_write` is a plain tenant-
--       scoped "for all" policy, never narrowed.
--     • `run_steps` (cascade-kill.ts, pause-resume.ts, run-agent.ts,
--       runner-watchdog.ts, stale-run-reaper.ts, replay.ts, ticket-
--       reconciler.ts) - same "safe pattern" as `ticket_dependencies`, per
--       20260761000000's own file header.
--     • `schedule_activity` (schedules/activity.ts) - `schedule_activity_
--       member_write` is a plain "for all" policy; confirmed independently
--       of the desktop gate's own F1 finding for this exact site ("not a
--       privilege problem - 23514, a CHECK violation, i.e. it reached the
--       table").
--     • `ticket_schedules` (ticket-scheduler.ts, 4 sites: the drain window)
--       - `ticket_schedules_member_write` is a plain "for all" policy, never
--       narrowed.
--     • `merge_conflict_events` kind='retry_pushed' (builds-on-cascade.ts)
--       - already reconciled by 20260764000000's own header: the 5 runner-
--       safe kinds are admitted by `merge_conflict_events_member_write`.
--
--   OUT OF SCOPE BY EXISTING, EXPLICIT DESIGN - not new findings, and not
--   reopened here:
--     • `runs` (budget.ts, cascade-kill.ts, dispatcher.ts, pause-resume.ts,
--       replay.ts, run-agent.ts, runner-watchdog.ts, stale-run-reaper.ts,
--       supervision.ts) - 20260761000000's own file header states the
--       invariant directly: "every mutation goes through devpilot_spawn_run"
--       (insert-only; the desktop's own sidecar source confirms this table's
--       LIVE state is kept in the sidecar's own SQLite and only a subset is
--       projected back, per `run-agent.ts`'s own "`runs` is SQLite's"
--       comments there - status/spend writes are not attempted against this
--       table's RLS surface at all in the port this migration is closing a
--       gap for).
--     • `merge_conflict_events` kind IN ('detected','merger_spawned')
--       (land-worker.ts) - 20260761000000's own file header: "today they are
--       written by a separate, trusted server process, and there is no
--       Postgres-visible 'server' left to be their trusted origin... the
--       durable fix... is a WP 1.3+/2.2 scope decision, not resolved here."
--       Unchanged by this migration.
--     • `tickets.gate_retry_count` bump on an L1 QA-gate refusal
--       (transitions.ts, the counter-only update beside the main FSM patch)
--       - 20260764000000's own file header: "DELIBERATELY NOT implemented...
--       the L1 QA-verification gate... its gate_retry_count-ceiling park...
--       belongs with WP 1.3's own follow-up... a design decision." Unchanged.
--
--   GENUINELY MISSING, but NOT closed by this migration - real gaps this
--   reconciliation surfaced that are outside the two named subsystems
--   (`dispatch_queue`/`integration_queue`) or are non-blocking, each large
--   enough (CAS-guarded stamps, a merger-ticket spawn, several independent
--   `tickets` columns) to deserve its own reviewed migration rather than
--   being folded in here under time pressure:
--     • `dispatch_queue`'s two CANCEL call sites (`cancelDispatchedAsStale`,
--       `cancelPendingForTicket`, engine/dispatch-queue.ts) - both raw
--       UPDATEs, refused by the unchanged `dispatch_queue_update_deny`.
--       Non-blocking: `cancelPendingForTicket` is wrapped in try/catch in
--       `transitionTicket` ("Best-effort - drain re-checks status too"), and
--       `cancelDispatchedAsStale` only fires on the rare edge where a
--       claimed row's ticket has vanished or gone terminal between claim and
--       verify.
--     • `integration_queue`'s post-claim lifecycle (queue.server.ts:
--       `enqueueForLanding`'s insert + the parked-row reset update,
--       `stampLanded`, `moveQueueRow`, `recordLandPullRequest`,
--       `heartbeatQueueRow`) and the ticket `landed_sha`/`integrated_at`
--       stamp it shares with `merger-outcome-store.ts` - all raw writes
--       refused by the unchanged `integration_queue_insert_deny`/
--       `_update_deny` and by `tickets`'s column-level UPDATE grant (which
--       does not include `landed_sha`/`integrated_at`). Item 3 above
--       unblocks CLAIMING a land row; it does not make the land pipeline
--       land anything end-to-end. The devpilot-desktop gate's own criterion 1
--       explicitly notes "The land pipeline did not run" (no GitHub token in
--       its local-only environment), so none of this is MEASURED as
--       blocking the chaos gate yet - closing it deserves its own migration
--       once it is.
--     • `conflict-audit.ts`'s merger-ticket spawn - a `tickets` INSERT with
--       `status: "ready"` (not `'backlog'`), refused by
--       `tickets_member_insert`'s `status = 'backlog'` check. Part of the
--       same conflict-resolution pathway as the `detected`/`merger_spawned`
--       event kinds above (which fire earlier in the same flow and are
--       already, deliberately, out of scope) - closing one without the
--       other would not make conflict resolution work, so both stay
--       deferred together.
--     • Several independent `tickets` UPDATE call sites outside the FSM/
--       comment shapes `devpilot_engine_transition_ticket`/`devpilot_engine_
--       system_comment` already cover: `ticket-dep-suggester.ts`
--       (`suggested_dependencies`), `ticket-enricher.ts` (enrichment
--       fields), `ticket-role-classifier.ts` (`requested_role`). Each is its
--       own column, its own caller, its own gate - not a single shared
--       shape, and none is on the path the chaos gate exercises (dep
--       suggestion, enrichment and role classification are async/best-
--       effort side paths off ticket creation, not the run-dispatch loop).
--     • `fan_in_decisions` (aggregator.ts) and `supervisor_actions`
--       (supervisor-store.ts) - both deny-all for `authenticated`, matching
--       `dispatch_queue`'s ORIGINAL shape before this migration. Fan-in only
--       matters for multi-agent cohorts; supervision is off by default
--       (`projects.supervisor_enabled = false`). Neither is exercised by the
--       gate's described single-agent, single-ticket scenario.
--
-- What this migration does NOT touch: 20260761000000's policies/grants,
-- every function and policy in 20260762000000/20260763000000/20260764000000,
-- `dispatch_queue_update_deny`/`_delete_deny`, `integration_queue_insert_
-- deny`/`_update_deny`/`_delete_deny`, and the pre-existing `service_role`
-- grants on both claim functions from 20260603020000/20260715000000. This
-- file only replaces `dispatch_queue_insert_deny` and CREATE-OR-REPLACEs the
-- two claim functions (adding a membership guard, changing nothing else).
--
-- Idempotent: DROP POLICY IF EXISTS / CREATE OR REPLACE throughout.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. dispatch_queue - replace the deny-all INSERT policy with a real,
--    tenant-scoped one. UPDATE/DELETE stay denied (unchanged).
-- ---------------------------------------------------------------------------
drop policy if exists dispatch_queue_insert_deny on public.dispatch_queue;
drop policy if exists dispatch_queue_member_insert on public.dispatch_queue;
create policy dispatch_queue_member_insert on public.dispatch_queue
  for insert
  with check (
    tenant_id in (select public.current_user_tenants())
    and status = 'pending'
  );

comment on table public.dispatch_queue is
  'WIP-gated ticket holding area. INSERT (dispatch_queue_member_insert, '
  '20260765000000) is tenant-scoped and forces status=''pending''; the row''s '
  'tenant is re-derived from its ticket_id/agent_id anchor by the pre-existing '
  'assert_tenant_matches_parent triggers (20260732000000), not trusted from '
  'the caller. UPDATE/DELETE remain denied for every JWT role '
  '(dispatch_queue_update_deny/_delete_deny, 20260603020000, unchanged) - '
  'every mutation past insert goes through the atomic '
  'dispatch_queue_claim_next RPC, now callable by authenticated members of '
  'the row''s own tenant (require_tenant_member, 20260765000000).';

-- ---------------------------------------------------------------------------
-- 2. dispatch_queue_claim_next - add a tenant-membership guard (the function
--    otherwise trusted p_tenant_id at face value, which is safe only while
--    its sole caller is service_role) and grant EXECUTE to authenticated.
--    Signature, return shape and the atomic FOR UPDATE SKIP LOCKED claim are
--    byte-for-byte unchanged from 20260603020000.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_queue_claim_next(
  p_tenant_id uuid,
  p_agent_id  uuid
)
returns table (id uuid, ticket_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_tenant_member(p_tenant_id);

  return query
  with claimed as (
    select dq.id
      from public.dispatch_queue dq
     where dq.tenant_id = p_tenant_id
       and dq.agent_id  = p_agent_id
       and dq.status    = 'pending'
     order by dq.priority asc, dq.enqueued_at asc
     limit 1
     for update skip locked
  )
  update public.dispatch_queue dq
     set status        = 'dispatched',
         dispatched_at = now()
    from claimed
   where dq.id = claimed.id
  returning dq.id, dq.ticket_id;
end;
$$;

-- The pre-existing service_role grant (20260603020000) is untouched; this
-- adds authenticated on top, now that the function checks membership.
grant execute on function public.dispatch_queue_claim_next(uuid, uuid) to authenticated;
revoke all on function public.dispatch_queue_claim_next(uuid, uuid) from anon;

comment on function public.dispatch_queue_claim_next(uuid, uuid) is
  'Atomic WIP-queue dequeue (FOR UPDATE SKIP LOCKED). Callable by '
  'service_role (20260603020000) and, as of 20260765000000, by an '
  'authenticated member of p_tenant_id (require_tenant_member) - added '
  'because the function trusts p_tenant_id/p_agent_id at face value and has '
  'no other membership check of its own.';

-- ---------------------------------------------------------------------------
-- 3. integration_queue_claim_next - same treatment: the function takes no
--    p_tenant_id of its own, so the guard derives tenant from p_project_id
--    (a project with no matching row is refused, never silently treated as
--    "no tenant to check"). Signature, return shape and the atomic claim are
--    byte-for-byte unchanged from 20260715000000.
-- ---------------------------------------------------------------------------
create or replace function public.integration_queue_claim_next(
  p_project_id uuid
)
returns table (id uuid, ticket_id uuid, tenant_id uuid, attempts integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  select p.tenant_id into v_tenant_id from public.projects p where p.id = p_project_id;
  if v_tenant_id is null then
    raise exception 'project % not found', p_project_id;
  end if;
  perform public.require_tenant_member(v_tenant_id);

  return query
  with claimed as (
    select q.id
      from public.integration_queue q
     where q.project_id = p_project_id
       and q.status = 'pending'
       and not exists (
         select 1
           from public.ticket_dependencies d
           join public.tickets b on b.id = d.blocks_ticket_id
          where d.ticket_id = q.ticket_id
            and d.relation_type in ('blocked_by','builds_on')
            and case
                  when d.relation_type = 'builds_on'
                    then public.ticket_land_open(b.id)
                  else b.status <> 'done'
                end
       )
     order by q.priority asc, q.enqueued_at asc
     limit 1
     for update skip locked
  )
  update public.integration_queue q
     set status       = 'landing',
         claimed_at   = now(),
         heartbeat_at = now(),
         attempts     = q.attempts + 1
    from claimed
   where q.id = claimed.id
  returning q.id, q.ticket_id, q.tenant_id, q.attempts;
end;
$$;

-- The pre-existing service_role grant (20260715000000) is untouched; this
-- adds authenticated on top, now that the function checks membership.
grant execute on function public.integration_queue_claim_next(uuid) to authenticated;
revoke all on function public.integration_queue_claim_next(uuid) from anon;

comment on function public.integration_queue_claim_next(uuid) is
  'Atomic land-queue dequeue (FOR UPDATE SKIP LOCKED), dependency-gated on '
  'ticket_land_open()/builds_on/blocked_by. Callable by service_role '
  '(20260715000000) and, as of 20260765000000, by an authenticated member of '
  'the project''s own tenant (require_tenant_member, tenant derived from '
  'p_project_id - the function takes no p_tenant_id of its own) - added '
  'because the function trusted p_project_id at face value and had no other '
  'membership check of its own.';

commit;
