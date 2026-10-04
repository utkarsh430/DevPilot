-- Route under test: project_handoffs (20260761000000). devpilot's CURRENT
-- (pre-migration) policy is `with check (false)` for every non-service
-- writer — this migration is a pure widening, replacing it with a real
-- tenant+project-scoped member-insert policy.

\echo '--- [handoff] Alice: INSERT project_handoffs on her own tenant/project/ticket — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.project_handoffs (tenant_id, project_id, ticket_id, role, kind, body)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
        'a3000000-0000-0000-0000-000000000001','impl_a','decision','need human input on X')
returning id, project_id, ticket_id;
reset role;

\echo '--- [handoff] control: Bob (tenant B only) attempts the identical write against tenant-A rows — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
insert into public.project_handoffs (tenant_id, project_id, ticket_id, role, kind, body)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
        'a3000000-0000-0000-0000-000000000001','impl_a','decision','forged handoff');
reset role;

\echo '--- [handoff] trigger proof: Alice references a tenant-A project but a TENANT-B ticket (a cross-tenant FK mismatch the tenant-only WITH CHECK alone would miss) — expect REFUSED by trg_project_handoffs_ticket_id_tenant ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.project_handoffs (tenant_id, project_id, ticket_id, role, kind, body)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
        'b3000000-0000-0000-0000-000000000002','impl_a','decision','mismatched ticket tenant');
reset role;

\echo '--- [handoff] the route''s "no project" business rule: project_id=NULL — expect REFUSED. NOTE (correction to the original probe finding doc, caught by the devpilot-desktop companion harness, PR #8): this is NOT the column''s plain NOT NULL constraint (23502) firing first — it is project_handoffs_member_write''s own WITH CHECK: `NULL in (select ...)` evaluates to NULL, not TRUE, so the POLICY denies the row (42501) before the NOT NULL constraint is ever reached. Read the actual SQLSTATE/message in the transcript below rather than assuming 23502 ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.project_handoffs (tenant_id, project_id, ticket_id, role, kind, body)
values ('a0000000-0000-0000-0000-000000000001', null,
        'a3000000-0000-0000-0000-000000000013','impl_a','decision','no project on this handoff row');
reset role;

\echo '--- [handoff] append-only: UPDATE/DELETE stay denied for every JWT role (untouched by 20260761000000, still `using (false)`) — expect UPDATE 0 / DELETE 0 (RLS matches zero rows; the deny policies pre-date this migration and are unchanged) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.project_handoffs set body = 'edited' where ticket_id = 'a3000000-0000-0000-0000-000000000001';
delete from public.project_handoffs where ticket_id = 'a3000000-0000-0000-0000-000000000001';
reset role;
