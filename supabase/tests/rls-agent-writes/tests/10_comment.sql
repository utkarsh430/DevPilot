-- Route under test: comment (plain policy) + the tickets UPDATE column-grant
-- narrowing AND the tickets INSERT status='backlog' gate from 20260761000000.

\echo '--- [comment] Alice (tenant A member): INSERT author_type=agent on her own tenant ticket — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.comments (tenant_id, ticket_id, author_type, author_id, body)
values ('a0000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001','agent','claude','agent comment body')
returning id, author_type, author_id;
reset role;

\echo '--- [comment] control: Bob (tenant B member only) attempts the identical write against a tenant-A ticket — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
insert into public.comments (tenant_id, ticket_id, author_type, author_id, body)
values ('a0000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001','agent','claude','forged agent comment');
reset role;

\echo '--- [comment] gap closed by 20260761000000: Alice attempts author_type=system directly (bypassing devpilot_system_comment) — expect REFUSED by WITH CHECK ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.comments (tenant_id, ticket_id, author_type, author_id, body)
values ('a0000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001','system','devpilot_move_ticket','forged system comment');
reset role;

\echo '--- [comment] append-only: Alice attempts to UPDATE her own comment — expect REFUSED with "permission denied for table comments" (a hard PRIVILEGE-level denial, not a soft RLS zero-row match: 20260761000000 explicitly REVOKEs update/delete on comments from authenticated, so there is no grant for the executor to even attempt evaluating a policy against) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.comments set body = 'edited' where ticket_id = 'a3000000-0000-0000-0000-000000000001' and author_id = 'claude';
reset role;

\echo '--- [tickets UPDATE column grant] Alice UPDATEs an ALLOWED column (title) on her own tenant ticket — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.tickets set title = 'A: comment route target (edited)' where id = 'a3000000-0000-0000-0000-000000000001';
reset role;
select id, title from public.tickets where id = 'a3000000-0000-0000-0000-000000000001';

\echo '--- [tickets UPDATE column grant] Alice attempts to UPDATE a FORCED column (status) directly, bypassing devpilot_move_ticket — expect REFUSED (permission denied: no column-level UPDATE grant), even though row-level RLS would allow the row ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.tickets set status = 'in_review' where id = 'a3000000-0000-0000-0000-000000000004';
reset role;
select id, status from public.tickets where id = 'a3000000-0000-0000-0000-000000000004';

\echo '--- [tickets UPDATE column grant] Alice attempts to UPDATE another FORCED column (safety_critical) directly — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.tickets set safety_critical = true where id = 'a3000000-0000-0000-0000-000000000001';
reset role;

\echo '--- [tickets INSERT unrestricted at the COLUMN level, matching the human New-Ticket path] Alice creates a ticket with an explicit requested_role + column_position (exactly what createTicketCore does today), status=backlog — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.tickets (tenant_id, project_id, title, status, requested_role, column_position)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','A: operator-picked-role ticket','backlog','engineer',99999)
returning id, status, requested_role, column_position;
reset role;

\echo '--- [tickets INSERT status gate, tickets_member_insert] Alice attempts to INSERT a ticket ALREADY at status=done, bypassing every FSM transition gate — expect REFUSED. Found by the devpilot-desktop companion harness (PR #8) against the probe''s original candidate policy, which left INSERT status-unrestricted; 20260761000000 requires status=''backlog'' on every direct authenticated INSERT ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.tickets (tenant_id, project_id, title, status)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','A: forged pre-done ticket','done');
reset role;
select count(*) as should_be_zero from public.tickets where title = 'A: forged pre-done ticket';

\echo '--- [tickets INSERT status gate] the same attempt at every OTHER non-backlog status — expect REFUSED on all ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.tickets (tenant_id, project_id, title, status) values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','A: forged in_progress ticket','in_progress');
insert into public.tickets (tenant_id, project_id, title, status) values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','A: forged in_review ticket','in_review');
insert into public.tickets (tenant_id, project_id, title, status) values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','A: forged failed ticket','failed');
reset role;
select count(*) as should_be_zero from public.tickets
  where title in ('A: forged in_progress ticket', 'A: forged in_review ticket', 'A: forged failed ticket');
