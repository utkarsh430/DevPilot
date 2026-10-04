-- RPC under test: devpilot_spawn_run (20260762000000). None of the four caps
-- (depth, fan-out, global-active, budget-inheritance) are expressible as a
-- static WITH CHECK — the clearest "RPC, full stop" case of the ten.

\echo '--- [spawn] direct-table proof: Alice tries a bare INSERT into runs — expect REFUSED (no INSERT grant to authenticated at all, 20260761000000) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.runs (tenant_id, depth, budget_cents, status)
values ('a0000000-0000-0000-0000-000000000001', 0, 999999, 'running');
reset role;

\echo '--- [spawn] Alice: spawn off run a6..0001 (depth 0, children 0, budget 1000/spent 200 -> 800 remaining), requesting 100 — expect SUCCESS, agent_id NOT inherited onto the child (matches the real spawn route, not the probe''s candidate SQL) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_spawn_run('a6000000-0000-0000-0000-000000000001', 100) as new_run_id;
reset role;
select id, parent_run_id, depth, budget_cents, spent_cents, status, agent_id, ticket_id from public.runs
  where parent_run_id = 'a6000000-0000-0000-0000-000000000001';
select id, children_count from public.runs where id = 'a6000000-0000-0000-0000-000000000001';

\echo '--- [spawn] budgetCents validation: zero or negative — expect REFUSED before any cap check runs ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_spawn_run('a6000000-0000-0000-0000-000000000001', 0);
select public.devpilot_spawn_run('a6000000-0000-0000-0000-000000000001', -5);
reset role;

\echo '--- [spawn] depth cap: run a6..0002 is already at depth=3 (MAX_DEPTH). A child would be depth 4 — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_spawn_run('a6000000-0000-0000-0000-000000000002', 50);
reset role;

\echo '--- [spawn] fan-out cap: run a6..0003 already has children_count=4 (MAX_FAN_OUT) — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_spawn_run('a6000000-0000-0000-0000-000000000003', 50);
reset role;

\echo '--- [spawn] budget-inheritance cap: run a6..0004 has budget_cents=100, spent_cents=90 -> only 10c left. Requesting 50c — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_spawn_run('a6000000-0000-0000-0000-000000000004', 50);
reset role;

\echo '--- [spawn] budget-inheritance cap, boundary: same run, requesting EXACTLY the 10c remaining — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_spawn_run('a6000000-0000-0000-0000-000000000004', 10) as new_run_id;
reset role;

\echo '--- [spawn] control: Bob (tenant B only) attempts to spawn off tenant A''s run a6..0001 — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select public.devpilot_spawn_run('a6000000-0000-0000-0000-000000000001', 10);
reset role;

\echo '--- [spawn] global active-run cap: tenant A currently has some active runs from the calls above. Seed enough MORE directly (as the harness superuser, not through the RPC — this is test setup, not the thing under test) to reach exactly 20, the MAX_TOTAL_AGENTS ceiling. ---'
do $$
declare
  v_current int;
  v_needed int;
begin
  select count(*) into v_current from public.runs
    where tenant_id = 'a0000000-0000-0000-0000-000000000001' and status in ('running', 'awaiting_human');
  v_needed := 20 - v_current;
  if v_needed > 0 then
    insert into public.runs (tenant_id, agent_id, depth, budget_cents, spent_cents, status)
    select 'a0000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 0, 10, 0, 'running'
    from generate_series(1, v_needed);
  end if;
end $$;

select count(*) as tenant_a_active_runs from public.runs
  where tenant_id = 'a0000000-0000-0000-0000-000000000001' and status in ('running','awaiting_human');

\echo '--- [spawn] at the cap: Alice tries one more spawn off a6..0001 — expect REFUSED (tenant already at MAX_TOTAL_AGENTS=20) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_spawn_run('a6000000-0000-0000-0000-000000000001', 1);
reset role;
