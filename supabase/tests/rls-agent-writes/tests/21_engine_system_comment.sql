-- RPC under test: devpilot_engine_system_comment (20260764000000) — the
-- ENGINE-scoped sibling of devpilot_system_comment (11_system_comment.sql),
-- with a WIDER, engine-specific author_id allowlist covering the identities
-- lib/engine/dispatcher.ts, lib/engine/aggregator.ts,
-- lib/engine/builds-on-cascade.ts, lib/engine/supervision.ts,
-- lib/engine/ticket-reconciler.ts, lib/engine/ticket-scheduler.ts and
-- lib/billing/gate.ts actually use — none of which fit
-- devpilot_system_comment's agent-route-scoped ^devpilot_[a-z_]+$ whitelist.
-- See 20260764000000's file header for the full derivation.

\echo '--- [engine-system-comment] Alice: engine author "dispatcher" (WIP-limit deferral, lib/engine/dispatcher.ts) on her own tenant ticket — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'dispatcher', 'Engineer agent at WIP limit (3/3). Queued.', null
) as new_comment_id;
reset role;
select author_type, author_id, body from public.comments
  where ticket_id = 'a3000000-0000-0000-0000-000000000001' and author_id = 'dispatcher';

\echo '--- [engine-system-comment] Alice: engine author "ticket-reconciler" (lib/engine/ticket-reconciler.ts, hyphenated — does NOT match devpilot_system_comment''s ^devpilot_[a-z_]+$) — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'ticket-reconciler', 'run completed without advancing the ticket; reconciled forward', null
) as new_comment_id;
reset role;

\echo '--- [engine-system-comment] Alice: engine author "billing-gate" (lib/billing/gate.ts, hyphenated, no devpilot_ prefix) — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'billing-gate', 'dispatch refused: over the configured budget cap', null
) as new_comment_id;
reset role;

\echo '--- [engine-system-comment] Alice: dynamic scheduler author "schedule:1a2b3c4d" (lib/engine/ticket-scheduler.ts''s `schedule:${scheduleId.slice(0,8)}` pattern) — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'schedule:1a2b3c4d', 'scheduled drain fired', null
) as new_comment_id;
reset role;

\echo '--- [engine-system-comment] Alice: dynamic scheduler author "schedule:adhoc" — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'schedule:adhoc', 'ad-hoc drain fired', null
) as new_comment_id;
reset role;

\echo '--- [engine-system-comment] Alice: a devpilot_*-shaped author (e.g. devpilot_orphan_reaper) is ALSO accepted here — expect SUCCESS (the two allowlists overlap on purpose) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'devpilot_orphan_reaper', 'recovered an orphaned ticket', null
) as new_comment_id;
reset role;

\echo '--- [engine-system-comment] reject a non-whitelisted author_id — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'not_a_reserved_identity', 'x', null
);
reset role;

\echo '--- [engine-system-comment] reject an author_id trying to sneak past the dynamic schedule: pattern with extra text — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'schedule:1a2b3c4d; drop table comments;--', 'x', null
);
reset role;

\echo '--- [engine-system-comment] reject a short-form schedule id (fewer than 8 hex chars) — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'schedule:abc', 'x', null
);
reset role;

\echo '--- [engine-system-comment] control: Bob (tenant B only) calls it against a tenant-A ticket — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'dispatcher', 'x', null
);
reset role;

\echo '--- [engine-system-comment] control: anon (unauthenticated) has EXECUTE revoked entirely — expect REFUSED (permission denied on the function itself) ---'
set role anon;
select public.devpilot_engine_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'dispatcher', 'x', null
);
reset role;

\echo '--- [engine-system-comment] control: nonexistent ticket — expect REFUSED (ticket not found) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_engine_system_comment(
  '00000000-0000-0000-0000-000000000000', 'dispatcher', 'x', null
);
reset role;
