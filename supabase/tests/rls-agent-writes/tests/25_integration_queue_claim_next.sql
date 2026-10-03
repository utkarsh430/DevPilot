-- RPC under test: integration_queue_claim_next (20260715000000, CREATE OR
-- REPLACEd by 20260765000000 to add a require_tenant_member() guard) - the
-- THIRD of the three F6 gaps: `42501`, the land pipeline cannot claim work.
--
-- The function takes only p_project_id (no p_tenant_id of its own), so the
-- guard derives tenant from the project row itself - this file's controls
-- exercise both halves: a foreign caller of a REAL project, and a caller
-- naming a project that does not exist at all.
--
-- Row order matters, same reasoning as 24_dispatch_queue_claim_next.sql: the
-- refusal controls run first and do not consume the pre-seeded pending row
-- (a9000000...0001, against ticket a3000000...0034 / project
-- a2000000...0001).

\echo '--- [integration-queue-claim] control: Bob (tenant B only) calls with p_project_id=Project A (a real tenant-A project) - expect REFUSED (require_tenant_member raises 42501, before the claim query touches any row) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select * from public.integration_queue_claim_next('a2000000-0000-0000-0000-000000000001');
reset role;
select status from public.integration_queue where id = 'a9000000-0000-0000-0000-000000000001';

\echo '--- [integration-queue-claim] control: anon (unauthenticated) - expect REFUSED (permission denied on the function itself; EXECUTE was never granted to anon) ---'
set role anon;
select * from public.integration_queue_claim_next('a2000000-0000-0000-0000-000000000001');
reset role;

\echo '--- [integration-queue-claim] control: nonexistent project - expect REFUSED (project not found; the guard cannot resolve a tenant to check membership against, so it fails closed rather than silently allowing) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select * from public.integration_queue_claim_next('00000000-0000-0000-0000-000000000000');
reset role;

\echo '--- [integration-queue-claim] Alice (tenant A) claims her own tenant''s pending row - expect SUCCESS, one row returned naming the pre-seeded ticket a3000000...0034 ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select * from public.integration_queue_claim_next('a2000000-0000-0000-0000-000000000001');
reset role;
select status, claimed_at is not null as claimed_at_set, heartbeat_at is not null as heartbeat_at_set, attempts
  from public.integration_queue where id = 'a9000000-0000-0000-0000-000000000001';

\echo '--- [integration-queue-claim] no-double-claim: Alice calls AGAIN with the same project - expect ZERO rows (the row already left status=pending, so it is not reclaimed) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select * from public.integration_queue_claim_next('a2000000-0000-0000-0000-000000000001');
reset role;
