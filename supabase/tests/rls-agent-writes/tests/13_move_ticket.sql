-- RPC under test: devpilot_move_ticket (20260762000000) — the FULL real FSM
-- (lib/board/state.ts's ALLOWED_TRANSITIONS), the real human-only reopen gate
-- (lib/board/reopen-policy.ts), and the real human-only safety-completion
-- gate (lib/board/safety-gate.ts).

\echo '--- [move-ticket] column-level grant proof: Alice tries to UPDATE tickets.status DIRECTLY (bypassing the RPC) on her own tenant ticket — expect REFUSED (permission denied — status has no UPDATE grant to authenticated), even though row-level RLS would allow the row ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.tickets set status = 'in_review' where id = 'a3000000-0000-0000-0000-000000000004';
reset role;

\echo '--- [move-ticket] valid edge, agent actor: in_progress -> in_review via devpilot_move_ticket — expect SUCCESS + audit comment ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select (public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000004', 'in_review', 'agent', 'moving to review')).status;
reset role;
select author_type, author_id, body from public.comments
  where ticket_id = 'a3000000-0000-0000-0000-000000000004' and author_id = 'devpilot_move_ticket';

\echo '--- [move-ticket] reopen gate: agent actor tries in_review -> backlog — expect REFUSED (human-only) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000005', 'backlog', 'agent', 'agent trying to reopen');
reset role;

\echo '--- [move-ticket] reopen gate: human actor sends the SAME ticket in_review -> backlog — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select (public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000005', 'backlog', 'human', 'human reopen')).status;
reset role;

\echo '--- [move-ticket] reopen gate is FROM-STATE scoped, not blanket: paused -> backlog is reachable by ANY actor (predates the gate; ticket a3..0011 is seeded paused) — expect SUCCESS even as agent ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select (public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000011', 'backlog', 'agent', 'paused resumes to backlog')).status;
reset role;

\echo '--- [move-ticket] safety gate: agent actor tries to mark a safety_critical, in_review ticket done — expect REFUSED (human-only) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000003', 'done', 'agent', 'agent trying to close safety-critical work');
reset role;

\echo '--- [move-ticket] safety gate: system actor (e.g. an engine reconciler) tries the SAME completion — expect REFUSED too (only human, not just non-agent) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000003', 'done', 'system', 'system trying to close safety-critical work');
reset role;

\echo '--- [move-ticket] safety gate: human actor completes the SAME safety_critical ticket — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select (public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000003', 'done', 'human', 'human approved')).status;
reset role;

\echo '--- [move-ticket] illegal FSM edge: backlog -> done directly (skipping the whole pipeline), even as a human actor — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000008', 'done', 'human', 'skip the pipeline');
reset role;

\echo '--- [move-ticket] `done` is otherwise terminal except the human reopen edge: complete a3..0004 (currently in_review after the first call) to done as human, then confirm done -> in_review is ILLEGAL for anyone ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select (public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000004', 'done', 'human', 'complete it')).status;
select public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000004', 'in_review', 'human', 'illegal: done has no in_review edge');
reset role;

\echo '--- [move-ticket] unknown actor string — expect REFUSED before any FSM/gate logic ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000006', 'input_required', 'robot', 'bad actor value');
reset role;

\echo '--- [move-ticket] unrecognised status value — expect REFUSED by Postgres''s own enum-input check, before this function body runs at all ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000006', 'not_a_real_status', 'agent', 'bad status literal');
reset role;

\echo '--- [move-ticket] control: Bob (tenant B only) attempts a transition that WOULD be legal on the merits (in_progress -> in_review, agent actor) against a tenant-A ticket — isolates the refusal to the tenant-membership check ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000006', 'in_review', 'agent', 'cross-tenant attempt');
reset role;
