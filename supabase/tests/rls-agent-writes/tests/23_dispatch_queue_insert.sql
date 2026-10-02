-- Policy under test: dispatch_queue_member_insert (20260765000000) - the
-- FIRST of the three F6 gaps (devpilot-desktop PR #24 phase-2-acceptance.md):
-- `enqueueDispatch: new row violates row-level security policy for table
-- "dispatch_queue"`, live in criterion 2. Replaces the deny-all
-- dispatch_queue_insert_deny with a real, tenant-scoped policy.
--
-- Uses the dedicated agent a4...0002 rather than a4...0001 - the successful
-- insert below leaves a genuine PENDING row behind, and a4...0001 is the
-- agent tests/24_dispatch_queue_claim_next.sql exercises; sharing it would
-- let that pending row be claimed INSTEAD of test 24's own pre-seeded one,
-- making its no-double-claim assertion depend on execution order.

\echo '--- [dispatch-queue-insert] Alice (tenant A) inserts a valid pending row against her own ticket/agent - expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.dispatch_queue (tenant_id, ticket_id, agent_id, wip_limit_snapshot)
values ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000032',
        'a4000000-0000-0000-0000-000000000002', 3)
returning id, tenant_id, ticket_id, agent_id, status;
reset role;

\echo '--- [dispatch-queue-insert] Alice tries to insert a row already at status=dispatched (bypassing the atomic claim RPC) - expect REFUSED (WITH CHECK requires status=pending) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.dispatch_queue (tenant_id, ticket_id, agent_id, wip_limit_snapshot, status, dispatched_at)
values ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000032',
        'a4000000-0000-0000-0000-000000000002', 3, 'dispatched', now());
reset role;

\echo '--- [dispatch-queue-insert] control: Bob (tenant B only) attempts to insert claiming tenant_id=tenant A - expect REFUSED (RLS membership check: tenant_id not in current_user_tenants()) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
insert into public.dispatch_queue (tenant_id, ticket_id, agent_id, wip_limit_snapshot)
values ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000032',
        'a4000000-0000-0000-0000-000000000002', 3);
reset role;

\echo '--- [dispatch-queue-insert] control: Bob attempts to insert his OWN tenant_id (B) but pointing ticket_id/agent_id at TENANT A - isolates "the row''s tenant must be re-derived from its anchor, not trusted" - expect REFUSED by assert_tenant_matches_parent (cross-tenant anchor mismatch), not by the RLS membership check ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
insert into public.dispatch_queue (tenant_id, ticket_id, agent_id, wip_limit_snapshot)
values ('b0000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000032',
        'a4000000-0000-0000-0000-000000000002', 3);
reset role;

\echo '--- [dispatch-queue-insert] control: anon (unauthenticated) attempts insert - expect REFUSED. anon never had EXECUTE on current_user_tenants() (core.sql''s own revoke/grant), so the WITH CHECK cannot even evaluate - Postgres refuses with permission denied for function current_user_tenants, an earlier and stronger wall than the RLS violation an unaffiliated authenticated caller would hit ---'
set role anon;
insert into public.dispatch_queue (tenant_id, ticket_id, agent_id, wip_limit_snapshot)
values ('a0000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000032',
        'a4000000-0000-0000-0000-000000000002', 3);
reset role;

\echo '--- [dispatch-queue-insert] standing regression: UPDATE remains denied for every JWT role (dispatch_queue_update_deny, using(false), unchanged by this migration) - expect UPDATE 0 (a same-tenant, same-row attempt still matches zero rows; RLS filters the row out before the UPDATE can see it, so no error is raised, only zero rows affected) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.dispatch_queue set priority = 1 where id = 'a8000000-0000-0000-0000-000000000001';
reset role;

\echo '--- [dispatch-queue-insert] standing regression: DELETE remains denied for every JWT role (dispatch_queue_delete_deny, using(false), unchanged by this migration) - expect DELETE 0, same reasoning ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
delete from public.dispatch_queue where id = 'a8000000-0000-0000-0000-000000000001';
reset role;
