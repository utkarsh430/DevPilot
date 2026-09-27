-- Route under test: request-human — split verdict. The question comment is a
-- plain author_type=agent insert (20260761000000). The transition to
-- input_required must go through devpilot_move_ticket (20260762000000) — a
-- bare UPDATE has no FSM/actor primitive.

\echo '--- [request-human] Alice: question comment (author_type=agent) — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.comments (tenant_id, ticket_id, author_type, author_id, body)
values ('a0000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000006','agent','impl_a','which endpoint should this call?')
returning id;
reset role;

\echo '--- [request-human] transition in_progress -> input_required via devpilot_move_ticket — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select (public.devpilot_move_ticket('a3000000-0000-0000-0000-000000000006', 'input_required', 'agent', 'escalated to human')).status;
reset role;

\echo '--- [request-human] system breadcrumb via devpilot_system_comment — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_system_comment(
  'a3000000-0000-0000-0000-000000000006', 'devpilot_request_human',
  'agent escalated: which endpoint should this call?', null
);
reset role;

\echo '--- [request-human] gap this migration demonstrates: a plain UPDATE-tickets policy (no column restriction) would let ANY tenant member force input_required from ANY status with no actor distinction — the RPC is the only thing enforcing the FSM edge. Prove it directly: an attempted UPDATE bypassing the RPC is REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.tickets set status = 'input_required' where id = 'a3000000-0000-0000-0000-000000000007';
reset role;
