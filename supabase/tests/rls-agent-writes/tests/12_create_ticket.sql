-- RPC under test: devpilot_create_ticket (20260762000000). Dedupe/cycle-guard
-- stay app-layer per the probe's explicit scope (see the migration header);
-- this proves the parts RLS genuinely cannot express — the atomic per-run
-- cap, the forced status/requested_role columns, and the column_position
-- placement rule (new, matching lib/board/topo.ts — not in the probe).

\echo '--- [create-ticket] Alice: devpilot_create_ticket off run a6..0001 (agent_ticket_max_per_run=5, count starts at 0), WITH a depends_on blocker at column_position=0 — expect SUCCESS, status forced backlog, column_position = 1024 (max blocker pos 0 + 1024) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_create_ticket(
  'a3000000-0000-0000-0000-000000000010', 'a6000000-0000-0000-0000-000000000001',
  'agent-spawned ticket #1', 'impl_a', array['a3000000-0000-0000-0000-000000000002']::uuid[]
) as new_ticket_id;
reset role;

select id, status, requested_role, source_run_id, agent_alias, column_position from public.tickets
  where title = 'agent-spawned ticket #1';
select ticket_id, blocks_ticket_id, relation_type from public.ticket_dependencies
  where ticket_id = (select id from public.tickets where title = 'agent-spawned ticket #1');
select author_type, author_id, body from public.comments
  where ticket_id = 'a3000000-0000-0000-0000-000000000010' and author_id = 'devpilot_agent_ticket';

\echo '--- [create-ticket] a second ticket with NO depends_on — expect column_position = end-of-backlog max(+1024), independent of the first call''s blocker-based placement ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_create_ticket(
  'a3000000-0000-0000-0000-000000000010', 'a6000000-0000-0000-0000-000000000001',
  'agent-spawned ticket #2'
);
reset role;
select id, column_position from public.tickets where title = 'agent-spawned ticket #2';

\echo '--- [create-ticket] atomic per-run cap: 3 more calls should succeed (bringing the run to its cap of 5), the 6th must be REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_create_ticket('a3000000-0000-0000-0000-000000000010', 'a6000000-0000-0000-0000-000000000001', 'agent-spawned ticket #3');
select public.devpilot_create_ticket('a3000000-0000-0000-0000-000000000010', 'a6000000-0000-0000-0000-000000000001', 'agent-spawned ticket #4');
select public.devpilot_create_ticket('a3000000-0000-0000-0000-000000000010', 'a6000000-0000-0000-0000-000000000001', 'agent-spawned ticket #5');
\echo '    -- this 6th call is expected to fail (cap reached at 5) --'
select public.devpilot_create_ticket('a3000000-0000-0000-0000-000000000010', 'a6000000-0000-0000-0000-000000000001', 'agent-spawned ticket #6 (should be refused)');
reset role;

select id, tickets_created_count from public.runs where id = 'a6000000-0000-0000-0000-000000000001';
select count(*) as tickets_from_this_run from public.tickets where source_run_id = 'a6000000-0000-0000-0000-000000000001';

\echo '--- [create-ticket] control: Bob (tenant B only) calls it with a tenant-A spawning ticket — expect REFUSED before any cap/flag logic runs ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select public.devpilot_create_ticket('a3000000-0000-0000-0000-000000000010', 'a6000000-0000-0000-0000-000000000001', 'forged cross-tenant ticket');
reset role;

\echo '--- [create-ticket] project opt-in OFF: spawning from a ticket in a project with agent_ticket_creation=false — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_create_ticket('a3000000-0000-0000-0000-000000000012', 'a6000000-0000-0000-0000-000000000001', 'should be refused (opt-in off)');
reset role;

\echo '--- [create-ticket] no-project spawning ticket — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_create_ticket('a3000000-0000-0000-0000-000000000013', 'a6000000-0000-0000-0000-000000000001', 'should be refused (no project)');
reset role;

\echo '--- [create-ticket] cross-tenant depends_on: a valid same-tenant spawning ticket + run, but a dependency pointing at a TENANT-B ticket — expect REFUSED, and NO ticket/slot left behind ---'
select tickets_created_count as before_cap_attempt from public.runs where id = 'a6000000-0000-0000-0000-000000000004';
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_create_ticket(
  'a3000000-0000-0000-0000-000000000010', 'a6000000-0000-0000-0000-000000000004',
  'should be refused (cross-tenant dependency)', null, array['b3000000-0000-0000-0000-000000000002']::uuid[]
);
reset role;
\echo '    -- the cap counter for a6..0004 must be untouched by the refused call above (it claimed the slot before the dependency loop, then rolled back the WHOLE transaction on the exception) --'
select tickets_created_count as after_refused_attempt from public.runs where id = 'a6000000-0000-0000-0000-000000000004';
select count(*) as should_be_zero from public.tickets where title = 'should be refused (cross-tenant dependency)';
