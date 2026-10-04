-- RPC under test: devpilot_system_comment (20260762000000).

\echo '--- [system-comment] Alice: devpilot_system_comment on her own tenant ticket — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'devpilot_runner', 'system narration body', null
) as new_comment_id;
reset role;

select author_type, author_id, body from public.comments
  where ticket_id = 'a3000000-0000-0000-0000-000000000001' and author_id = 'devpilot_runner';

\echo '--- [system-comment] reject a non-whitelisted author_id (closes the gap where any tenant member could forge devpilot_* today) — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'not_a_reserved_identity', 'x', null
);
reset role;

\echo '--- [system-comment] reject an author_id trying to sneak past the anchors with extra text — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'devpilot_move_ticket; drop table comments;--', 'x', null
);
reset role;

\echo '--- [system-comment] control: Bob (tenant B only) calls it against a tenant-A ticket — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
select public.devpilot_system_comment(
  'a3000000-0000-0000-0000-000000000001', 'devpilot_runner', 'x', null
);
reset role;

\echo '--- [system-comment] control: nonexistent ticket — expect REFUSED (ticket not found) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
select public.devpilot_system_comment(
  '00000000-0000-0000-0000-000000000000', 'devpilot_runner', 'x', null
);
reset role;
