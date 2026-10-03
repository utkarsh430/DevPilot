-- Route under test: log-conflict-event / merge_conflict_events (20260761000000).
-- DB-level enforcement of the "runner-safe kind" allowlist that today is
-- enforced ONLY in the Next.js route handler.

\echo '--- [log-conflict-event] Alice: INSERT a runner-safe kind on her own tenant''s pending_push — expect SUCCESS ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.merge_conflict_events (tenant_id, project_id, pending_push_id, ticket_id, kind, payload)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
        'a7000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001',
        'merger_started', '{}'::jsonb)
returning id, kind;
reset role;

\echo '--- [log-conflict-event] Alice attempts to forge a RESERVED kind (operator_overrode) — expect REFUSED by WITH CHECK ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.merge_conflict_events (tenant_id, project_id, pending_push_id, ticket_id, kind, payload)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
        'a7000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001',
        'operator_overrode', '{}'::jsonb);
reset role;

\echo '--- [log-conflict-event] Alice attempts each OTHER reserved kind (detected, merger_spawned) — expect REFUSED on both ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.merge_conflict_events (tenant_id, project_id, pending_push_id, ticket_id, kind, payload)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
        'a7000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001',
        'detected', '{}'::jsonb);
insert into public.merge_conflict_events (tenant_id, project_id, pending_push_id, ticket_id, kind, payload)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
        'a7000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001',
        'merger_spawned', '{}'::jsonb);
reset role;

\echo '--- [log-conflict-event] control: Bob (tenant B only) attempts a runner-safe kind against tenant A''s pending_push — expect REFUSED ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','b1000000-0000-0000-0000-000000000002')::text, false);
insert into public.merge_conflict_events (tenant_id, project_id, pending_push_id, ticket_id, kind, payload)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
        'a7000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001',
        'merger_started', '{}'::jsonb);
reset role;

\echo '--- [log-conflict-event] trigger proof: Alice references her own tenant_id/project_id but a TENANT-B pending_push_id — expect REFUSED by trg_merge_conflict_events_pending_push_id_tenant ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.merge_conflict_events (tenant_id, project_id, pending_push_id, kind, payload)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001',
        'b7000000-0000-0000-0000-000000000002', 'merger_started', '{}'::jsonb);
reset role;

\echo '--- [log-conflict-event] append-only: UPDATE/DELETE — expect REFUSED with "permission denied for table merge_conflict_events" (a hard PRIVILEGE-level denial: 20260761000000 explicitly REVOKEs update/delete from authenticated alongside replacing the old "for all" policy with an insert-only one) ---'
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
update public.merge_conflict_events set kind = 'file_resolved' where pending_push_id = 'a7000000-0000-0000-0000-000000000001';
delete from public.merge_conflict_events where pending_push_id = 'a7000000-0000-0000-0000-000000000001';
reset role;
