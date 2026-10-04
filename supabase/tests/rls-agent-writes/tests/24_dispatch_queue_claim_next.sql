-- RPC under test: dispatch_queue_claim_next (20260603020000, CREATE OR
-- REPLACEd by 20260765000000 to add a require_tenant_member() guard) - the
-- SECOND of the three F6 gaps: `42501`, fails `dispatchOnRunComplete` after
-- every run.
--
-- Row order matters in this file: the cross-tenant/anon controls run FIRST
-- and must NOT consume the pre-seeded pending row (a8000000...0001,
-- inserted in 02_seed.sql against ticket a3000000...0033) - both refusals
-- happen before the claim query ever runs, so the row is still there for the
-- success assertion at the end.

\echo '--- [dispatch-queue-claim] control: Bob (tenant B only) calls with p_tenant_id/p_agent_id belonging to tenant A - expect REFUSED (require_tenant_member raises 42501, before the claim query touches any row) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select * from public.dispatch_queue_claim_next(
  'a0000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001'
);
reset role;
select status from public.dispatch_queue where id = 'a8000000-0000-0000-0000-000000000001';

\echo '--- [dispatch-queue-claim] control: anon (unauthenticated) - expect REFUSED (permission denied on the function itself; EXECUTE was never granted to anon) ---'
set role anon;
select * from public.dispatch_queue_claim_next(
  'a0000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001'
);
reset role;

\echo '--- [dispatch-queue-claim] Alice (tenant A) claims her own tenant''s pending row - expect SUCCESS, one row returned naming the pre-seeded ticket a3000000...0033 ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select * from public.dispatch_queue_claim_next(
  'a0000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001'
);
reset role;
select status, dispatched_at is not null as dispatched_at_set
  from public.dispatch_queue where id = 'a8000000-0000-0000-0000-000000000001';

\echo '--- [dispatch-queue-claim] no-double-claim: Alice calls AGAIN with the identical (tenant, agent) pair - expect ZERO rows (the row already left status=pending, so it is not reclaimed) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select * from public.dispatch_queue_claim_next(
  'a0000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001'
);
reset role;
