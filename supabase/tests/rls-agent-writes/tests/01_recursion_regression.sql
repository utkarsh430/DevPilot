-- Regression test for the 2026-08-06 RLS infinite-recursion incident
-- (devpilot's 20260730000000 -> 20260732000000 / 20260759000000), replayed
-- against the schema AFTER 20260761000000/20260762000000 have applied their
-- own tickets grant changes — proving those new REVOKE/GRANT statements did
-- not resurrect the recursion or otherwise break the RLS-bound human "New
-- Ticket" INSERT path.

\echo '=== [1/3] baseline: authenticated ticket INSERT (parent_ticket_id IS NULL) works cleanly post-migration — expect SUCCESS, no 42P17 ==='
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.tickets (tenant_id, project_id, title, status)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','regression: null parent insert','backlog')
returning id, title, status, parent_ticket_id;
reset role;

\echo '=== [2/3] reproduce the INCIDENT SHAPE (a WITH CHECK that selects from tickets itself) against THIS schema, confirm it still 42P17s — proving the regression really would be visible if 20260761000000 had somehow reintroduced it ==='
drop policy if exists tickets_member_write on public.tickets;
create policy tickets_member_write on public.tickets
  for all
  using (tenant_id in (select public.current_user_tenants()))
  with check (
    tenant_id in (select public.current_user_tenants())
    and (
      parent_ticket_id is null
      or parent_ticket_id in (select id from public.tickets where tenant_id in (select public.current_user_tenants()))
    )
  );

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.tickets (tenant_id, project_id, title, status)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','recursion repro (should 42P17)','backlog');
reset role;

\echo '=== [3/3] restore the REAL (post-20260759000000) policy shape and retry the identical insert — expect SUCCESS. Also re-verify a genuine cross-tenant parent_ticket_id is STILL refused, now via trg_tickets_parent_ticket_id_tenant rather than the removed self-referential clause ==='
drop policy if exists tickets_member_write on public.tickets;
create policy tickets_member_write on public.tickets
  for all
  using (tenant_id in (select public.current_user_tenants()))
  with check (
    tenant_id in (select public.current_user_tenants())
    and (project_id is null or project_id in (select id from public.projects where tenant_id in (select public.current_user_tenants())))
  );

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','a1000000-0000-0000-0000-000000000001')::text, false);
insert into public.tickets (tenant_id, project_id, title, status)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','recursion repro (fixed policy, restored)','backlog')
returning id, title, parent_ticket_id;

\echo '    -- cross-tenant parent_ticket_id, expect REFUSED by the trigger --'
insert into public.tickets (tenant_id, project_id, title, status, parent_ticket_id)
values ('a0000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','cross-tenant parent attempt','backlog','b3000000-0000-0000-0000-000000000002');
reset role;

\echo '=== cleanup: DROP the tickets_member_write this file installed for steps [2/3]/[3/3] ==='
\echo '    This is NOT optional housekeeping. 20260761000000 replaced tickets_member_write'
\echo '    with three narrower policies (tickets_member_insert/_update/_delete); the real'
\echo '    post-migration schema has no tickets_member_write at all. RLS policies are'
\echo '    PERMISSIVE and OR''d together, so leaving this combined, tenant+project-only'
\echo '    policy installed would silently widen every later test in this suite back to'
\echo '    the pre-migration behaviour it exists to close off -- in particular it would'
\echo '    let tickets_member_insert''s status=''backlog'' gate (10_comment.sql) be bypassed,'
\echo '    since tickets_member_write''s WITH CHECK never mentions status at all. Caught by'
\echo '    running this suite end to end and finding the insert-as-done test in'
\echo '    10_comment.sql unexpectedly SUCCEED once this file had run before it.'
drop policy if exists tickets_member_write on public.tickets;
