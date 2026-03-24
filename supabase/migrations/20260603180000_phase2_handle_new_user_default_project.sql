-- Migration: 20260603180000_phase2_handle_new_user_default_project.sql
--
-- Closes 2026-06-03 evening incident #3 (docs/SESSION_HANDOFF.md §8b):
-- the M5a backfill (20260603130000_phase2_projects_and_github_auth.sql §4)
-- only created a Default project for tenants existing at migration-apply
-- time. Tenants minted afterwards via Supabase Auth (GitHub OAuth sign-up
-- or magic-link) got tenant + tenant_member rows but no projects, so every
-- ticket they filed came in with project_id IS NULL. The runner fell back
-- to ENGINEER_REPO_URL and `pendingPushTracker` bailed early (it filters
-- on tickets.project_id IS NOT NULL), so real engineer commits landed
-- locally but /changes showed nothing. Tenant b9aacf58 (sokogakuen test)
-- is the known case.
--
-- Two fixes, both idempotent:
--   1. handle_new_user() now also inserts a Default project right after
--      the tenant + tenant_member rows. Trigger stays security definer
--      with search_path = public, so the insert bypasses RLS for the
--      duration of the auth.users insert.
--   2. Backfill loop matching M5a's shape and `where not exists` guard,
--      to rescue any tenant that signed up between M5a and now.

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_tenant_id uuid;
begin
  insert into public.tenants (name)
  values (coalesce(new.raw_user_meta_data->>'name', new.email, 'Personal'))
  returning id into new_tenant_id;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (new_tenant_id, new.id, 'owner');

  insert into public.projects (tenant_id, name, description, repo_url, default_branch, created_by)
  values (
    new_tenant_id,
    'Default',
    'Backwards-compat fallback project using ENGINEER_REPO_URL',
    null,
    'main',
    new.id
  );

  return new;
end;
$$;

do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    insert into public.projects (tenant_id, name, description, repo_url, default_branch)
    select t.id,
           'Default',
           'Backwards-compat fallback project using ENGINEER_REPO_URL',
           null,
           'main'
    where not exists (
      select 1 from public.projects p
      where p.tenant_id = t.id and p.name = 'Default'
    );
  end loop;
end$$;

commit;
