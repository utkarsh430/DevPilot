-- RPC under test: devpilot_engine_transition_ticket (20260764000000) — the
-- ENGINE-scoped sibling of devpilot_move_ticket (13_move_ticket.sql), for
-- lib/board/transitions.ts's `transitionTicket` write shape rather than the
-- agent MCP move-ticket route. See 20260764000000's file header for the full
-- derivation of why this RPC exists as a SIBLING (contract-shape mismatch)
-- rather than a widening of devpilot_move_ticket.

\echo '--- [engine-transition] column-level grant proof: Alice tries to UPDATE tickets.status DIRECTLY (bypassing the RPC) on her own tenant ticket — expect REFUSED (permission denied — status has no UPDATE grant to authenticated) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.tickets set status = 'in_progress' where id = 'a3000000-0000-0000-0000-000000000020';
reset role;

\echo '--- [engine-transition] ready -> in_progress, system actor, WITH an assignee stamp in the same call (mirrors dispatcher.ts prepare-run) — expect SUCCESS, transitioned=true, gate_refusal=null ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id      => 'a3000000-0000-0000-0000-000000000020',
  p_to_status      => 'in_progress',
  p_actor          => 'system',
  p_assignee_agent_id => 'a4000000-0000-0000-0000-000000000001'
) as result;
reset role;
select status, assignee_agent_id from public.tickets where id = 'a3000000-0000-0000-0000-000000000020';

\echo '--- [engine-transition] backlog -> ready, system actor (mirrors dispatcher.ts pull-mark-ready / promoteUnblockedDependents) — expect SUCCESS and auto_promote_when_unblocked cleared to false ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000021',
  p_to_status => 'ready',
  p_actor     => 'system'
) as result;
reset role;
select status, auto_promote_when_unblocked from public.tickets where id = 'a3000000-0000-0000-0000-000000000021';

\echo '--- [engine-transition] reopen gate: agent actor tries in_progress -> backlog (a LEGAL FSM edge, so this genuinely exercises the reopen gate rather than being pre-empted by the FSM check) — expect REFUSED (raised, human-only) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000022',
  p_to_status => 'backlog',
  p_actor     => 'agent'
);
reset role;

\echo '--- [engine-transition] reopen gate: human actor sends the SAME ticket in_progress -> backlog — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000022',
  p_to_status => 'backlog',
  p_actor     => 'human'
) as result;
reset role;
select status from public.tickets where id = 'a3000000-0000-0000-0000-000000000022';

\echo '--- [engine-transition] safety gate: agent actor tries to mark a safety_critical, in_review ticket done — expect a RETURNED gate_refusal (NOT a raised exception), ticket UNCHANGED. This is the specific contract devpilot_move_ticket cannot express (it raises here) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000023',
  p_to_status => 'done',
  p_actor     => 'agent'
) as result;
reset role;
select status from public.tickets where id = 'a3000000-0000-0000-0000-000000000023';

\echo '--- [engine-transition] safety gate: system actor (e.g. a reconciler/aggregator) tries the SAME completion — expect the SAME returned refusal (only human, not just non-agent) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000023',
  p_to_status => 'done',
  p_actor     => 'system'
) as result;
reset role;

\echo '--- [engine-transition] safety gate: human actor completes the SAME safety_critical ticket — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000023',
  p_to_status => 'done',
  p_actor     => 'human'
) as result;
reset role;
select status from public.tickets where id = 'a3000000-0000-0000-0000-000000000023';

\echo '--- [engine-transition] plan-hold gate: backlog ticket with plan_hold=true -> ready, ANY actor — expect REFUSED (raised) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000024',
  p_to_status => 'ready',
  p_actor     => 'system'
);
reset role;

\echo '--- [engine-transition] illegal FSM edge: backlog -> done directly, even as a human actor — expect REFUSED (raised) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000025',
  p_to_status => 'done',
  p_actor     => 'human'
);
reset role;

\echo '--- [engine-transition] illegal FSM edge #2: `done` is terminal except its one reopen edge (-> backlog) — done -> in_review has no edge at all, even as a human actor — expect REFUSED (raised) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000023',
  p_to_status => 'in_review',
  p_actor     => 'human'
);
reset role;

\echo '--- [engine-transition] illegal FSM edge #3: `failed` is fully terminal (zero outbound edges) — failed -> backlog, even as a human actor — expect REFUSED (raised) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000031',
  p_to_status => 'backlog',
  p_actor     => 'human'
);
reset role;

\echo '--- [engine-transition] CAS: p_expected_from does not match the ticket''s CURRENT status (in_progress, caller expects ready) — expect a RETURNED {transitioned:false, gate_refusal:null} (NOT raised), ticket UNCHANGED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id     => 'a3000000-0000-0000-0000-000000000026',
  p_to_status     => 'blocked',
  p_actor         => 'system',
  p_expected_from => 'ready'
) as result;
reset role;
select status from public.tickets where id = 'a3000000-0000-0000-0000-000000000026';

\echo '--- [engine-transition] human-unblock reset: blocked (retry_count=3, gate_retry_count=2) -> in_progress, human actor, NO retry_delta — expect SUCCESS and BOTH counters reset to 0 ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000027',
  p_to_status => 'in_progress',
  p_actor     => 'human'
) as result;
reset role;
select status, retry_count, gate_retry_count from public.tickets where id = 'a3000000-0000-0000-0000-000000000027';

\echo '--- [engine-transition] retry_delta: in_review -> in_progress, system actor, retry_delta=1 (mirrors a QA reject bump) — expect retry_count=1, gate_retry_count untouched (0) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id   => 'a3000000-0000-0000-0000-000000000028',
  p_to_status   => 'in_progress',
  p_actor       => 'system',
  p_retry_delta => 1
) as result;
reset role;
select status, retry_count, gate_retry_count from public.tickets where id = 'a3000000-0000-0000-0000-000000000028';

\echo '--- [engine-transition] full patch: ready -> in_progress with assignee_agent_id + description + acceptance_criteria ALL in the same call — expect all four fields set ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id            => 'a3000000-0000-0000-0000-000000000029',
  p_to_status            => 'in_progress',
  p_actor                => 'system',
  p_assignee_agent_id    => 'a4000000-0000-0000-0000-000000000001',
  p_description          => 'engine-patched description',
  p_acceptance_criteria  => 'engine-patched acceptance criteria'
) as result;
reset role;
select status, assignee_agent_id, description, acceptance_criteria
  from public.tickets where id = 'a3000000-0000-0000-0000-000000000029';

\echo '--- [engine-transition] p_clear_assignee=true clears the assignee just set above — expect assignee_agent_id back to NULL ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id       => 'a3000000-0000-0000-0000-000000000029',
  p_to_status       => 'ready',
  p_actor           => 'system',
  p_clear_assignee  => true
) as result;
reset role;
select status, assignee_agent_id from public.tickets where id = 'a3000000-0000-0000-0000-000000000029';

\echo '--- [engine-transition] unknown actor string — expect REFUSED before any FSM/gate logic ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000030',
  p_to_status => 'in_review',
  p_actor     => 'robot'
);
reset role;

\echo '--- [engine-transition] unrecognised status value — expect REFUSED by Postgres''s own enum-input check, before this function body runs at all ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000030',
  p_to_status => 'not_a_real_status',
  p_actor     => 'system'
);
reset role;

\echo '--- [engine-transition] control: Bob (tenant B only) attempts a transition that WOULD be legal on the merits (in_progress -> in_review, agent actor) against a tenant-A ticket — isolates the refusal to the tenant-membership check ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000030',
  p_to_status => 'in_review',
  p_actor     => 'agent'
);
reset role;
select status from public.tickets where id = 'a3000000-0000-0000-0000-000000000030';

\echo '--- [engine-transition] control: anon (unauthenticated) has EXECUTE revoked entirely — expect REFUSED (permission denied on the function itself) ---'
set role anon;
select public.devpilot_engine_transition_ticket(
  p_ticket_id => 'a3000000-0000-0000-0000-000000000020',
  p_to_status => 'in_review',
  p_actor     => 'agent'
);
reset role;

\echo '--- [engine-transition] control: nonexistent ticket — expect REFUSED (ticket not found) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_transition_ticket(
  p_ticket_id => '00000000-0000-0000-0000-000000000000',
  p_to_status => 'in_review',
  p_actor     => 'agent'
);
reset role;
