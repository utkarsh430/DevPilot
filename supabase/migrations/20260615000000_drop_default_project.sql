-- =============================================================================
-- Migration : 20260615000000_drop_default_project.sql
-- Project-first model — stop auto-creating the "Default" shim project and
-- delete the existing ones.
--
-- The "Default" project was a backwards-compat shim (repo_url = NULL) created
-- per-tenant by handle_new_user() + a backfill (20260603130000 / 20260603180000)
-- so that tickets always resolved to a project row. ACE is now project-first:
-- a tenant with no project is guided through onboarding (/welcome) instead, and
-- every page scopes to a real, selected project. The shim only cluttered the
-- switcher and masked the "no projects yet" empty state.
--
-- Two changes, both idempotent:
--   1. Redefine handle_new_user() to create ONLY the tenant + owner membership
--      (drop the projects insert). Re-running is safe (create or replace).
--   2. Delete every project named 'Default'. tickets.project_id is
--      ON DELETE SET NULL, so any attached tickets are nulled (they fall back to
--      ENGINEER_REPO_URL on dispatch, same as before) — acceptable for these
--      legacy shim rows.
-- =============================================================================
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

  -- No default project: a fresh tenant starts empty and is guided through
  -- onboarding (/welcome) to create its first real, repo-backed project.
  return new;
end;
$$;

-- Remove the existing shim projects. Tickets attached to them get
-- project_id = NULL via the FK's ON DELETE SET NULL.
delete from public.projects where name = 'Default';

commit;
