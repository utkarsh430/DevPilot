-- Regression check for 20260765000000: it must not widen any of the
-- 20260761000000/20260762000000/20260764000000 column grants, and its two
-- new function grants must land ONLY on authenticated (service_role keeps
-- its pre-existing grant from 20260603020000/20260715000000; anon and
-- public gain nothing).

\echo '--- [grant-regression-queue] standing regression: tickets.status/retry_count still have NO UPDATE grant to authenticated (20260765000000 touches neither) - expect both FALSE ---'
select
  has_column_privilege('authenticated', 'public.tickets', 'status', 'UPDATE')      as status_grantable,
  has_column_privilege('authenticated', 'public.tickets', 'retry_count', 'UPDATE') as retry_count_grantable;

\echo '--- [grant-regression-queue] dispatch_queue_claim_next: authenticated and service_role can EXECUTE, anon and public cannot - expect TRUE, TRUE, FALSE, FALSE ---'
select
  has_function_privilege('authenticated', 'public.dispatch_queue_claim_next(uuid, uuid)', 'EXECUTE') as authenticated_can_exec,
  has_function_privilege('service_role',  'public.dispatch_queue_claim_next(uuid, uuid)', 'EXECUTE') as service_role_can_exec,
  has_function_privilege('anon',          'public.dispatch_queue_claim_next(uuid, uuid)', 'EXECUTE') as anon_can_exec,
  has_function_privilege('public',        'public.dispatch_queue_claim_next(uuid, uuid)', 'EXECUTE') as public_can_exec;

\echo '--- [grant-regression-queue] integration_queue_claim_next: same shape - expect TRUE, TRUE, FALSE, FALSE ---'
select
  has_function_privilege('authenticated', 'public.integration_queue_claim_next(uuid)', 'EXECUTE') as authenticated_can_exec,
  has_function_privilege('service_role',  'public.integration_queue_claim_next(uuid)', 'EXECUTE') as service_role_can_exec,
  has_function_privilege('anon',          'public.integration_queue_claim_next(uuid)', 'EXECUTE') as anon_can_exec,
  has_function_privilege('public',        'public.integration_queue_claim_next(uuid)', 'EXECUTE') as public_can_exec;

\echo '--- [grant-regression-queue] ticket_land_open is unchanged: still service_role-only (called internally by integration_queue_claim_next, never needs its own authenticated grant) - expect FALSE for authenticated, TRUE for service_role ---'
select
  has_function_privilege('authenticated', 'public.ticket_land_open(uuid)', 'EXECUTE') as authenticated_can_exec,
  has_function_privilege('service_role',  'public.ticket_land_open(uuid)', 'EXECUTE') as service_role_can_exec;

\echo '--- [grant-regression-queue] the agent RPC family (20260762000000) is untouched by this migration - spot-check devpilot_move_ticket still authenticated-only, unaffected - expect TRUE, FALSE ---'
select
  has_function_privilege('authenticated', 'public.devpilot_move_ticket(uuid, public.ticket_status, text, text, uuid)', 'EXECUTE') as authenticated_can_exec,
  has_function_privilege('anon',          'public.devpilot_move_ticket(uuid, public.ticket_status, text, text, uuid)', 'EXECUTE') as anon_can_exec;
