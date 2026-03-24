-- =============================================================================
-- Migration : 20260603140000_phase2_scaffolder_role.sql
-- Phase 2 / M5b — Add the `project_scaffolder` built-in role.
--
-- Purpose
-- ────────
-- M5b's create-new-repo flow takes a natural-language project description
-- ("a Next.js + Supabase SaaS starter with Stripe", "a Python CLI for log
-- triage", …) and spins up the initial README + base scaffolding as a real
-- ACE run. That work needs its own first-class role so the user can see
-- the scaffolder show up in the board / agent list / model-tier picker.
--
-- We don't bolt this on as an ad-hoc INSERT; we extend the same
-- `materialize_builtin_agents(tenant_id)` function the rest of the platform
-- uses, so:
--   • The existing `on_tenant_created` trigger auto-provisions
--     `project_scaffolder` for new tenants.
--   • The backfill loop at the bottom of this migration provisions it for
--     every existing tenant, idempotently via the function's per-role
--     `where not exists` guard.
--
-- CRITICAL: this migration must REPRODUCE the full 49-role list from
-- `20260603120000_phase2_specialized_roles.sql` and add ONE new entry. Total
-- 50 entries. Regressing the list would silently drop roles for new tenants.
--
-- Idempotent: re-runnable.
-- =============================================================================

create or replace function public.materialize_builtin_agents(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_roles jsonb := jsonb_build_array(
    -- Phase 0 + M4 + M6 + M7 — original built-ins (10) -------------------------
    jsonb_build_object('role', 'pm',                          'name', 'PM',                          'model_tier', 'default'),
    jsonb_build_object('role', 'engineer',                    'name', 'Engineer',                    'model_tier', 'default'),
    jsonb_build_object('role', 'qa',                          'name', 'QA',                          'model_tier', 'default'),
    jsonb_build_object('role', 'devops',                      'name', 'DevOps',                      'model_tier', 'default'),
    jsonb_build_object('role', 'techwriter',                  'name', 'Tech Writer',                 'model_tier', 'default'),
    jsonb_build_object('role', 'designer',                    'name', 'Designer',                    'model_tier', 'default'),
    jsonb_build_object('role', 'dataeng',                     'name', 'Data Engineer',               'model_tier', 'heavy'),
    jsonb_build_object('role', 'security',                    'name', 'Security',                    'model_tier', 'default'),
    jsonb_build_object('role', 'triage',                      'name', 'Triage',                      'model_tier', 'default'),
    jsonb_build_object('role', 'tech_lead',                   'name', 'Tech Lead',                   'model_tier', 'heavy'),
    -- Phase 2 — Leadership / Product (6) ---------------------------------------
    jsonb_build_object('role', 'cto',                         'name', 'CTO',                         'model_tier', 'heavy'),
    jsonb_build_object('role', 'vp_engineering',              'name', 'VP of Engineering',           'model_tier', 'heavy'),
    jsonb_build_object('role', 'product_manager',             'name', 'Product Manager',             'model_tier', 'default'),
    jsonb_build_object('role', 'technical_product_manager',   'name', 'Technical Product Manager',   'model_tier', 'heavy'),
    jsonb_build_object('role', 'product_owner',               'name', 'Product Owner',               'model_tier', 'default'),
    jsonb_build_object('role', 'engineering_manager',         'name', 'Engineering Manager',         'model_tier', 'default'),
    -- Phase 2 — Engineering specialists (6) ------------------------------------
    jsonb_build_object('role', 'frontend_engineer',           'name', 'Frontend Engineer',           'model_tier', 'heavy'),
    jsonb_build_object('role', 'backend_engineer',            'name', 'Backend Engineer',            'model_tier', 'heavy'),
    jsonb_build_object('role', 'fullstack_engineer',          'name', 'Full-Stack Engineer',         'model_tier', 'heavy'),
    jsonb_build_object('role', 'mobile_engineer',             'name', 'Mobile Engineer',             'model_tier', 'heavy'),
    jsonb_build_object('role', 'staff_engineer',              'name', 'Staff Engineer',              'model_tier', 'heavy'),
    jsonb_build_object('role', 'software_architect',          'name', 'Software Architect',          'model_tier', 'heavy'),
    -- Phase 2 — Data (4) -------------------------------------------------------
    jsonb_build_object('role', 'data_scientist',              'name', 'Data Scientist',              'model_tier', 'heavy'),
    jsonb_build_object('role', 'data_analyst',                'name', 'Data Analyst',                'model_tier', 'default'),
    jsonb_build_object('role', 'ml_engineer',                 'name', 'ML / AI Engineer',            'model_tier', 'heavy'),
    jsonb_build_object('role', 'analytics_engineer',          'name', 'Analytics Engineer',          'model_tier', 'default'),
    -- Phase 2 — Infrastructure / Ops (4) ---------------------------------------
    jsonb_build_object('role', 'sre',                         'name', 'Site Reliability Engineer',   'model_tier', 'heavy'),
    jsonb_build_object('role', 'cloud_engineer',              'name', 'Cloud Engineer',              'model_tier', 'default'),
    jsonb_build_object('role', 'platform_engineer',           'name', 'Platform Engineer',           'model_tier', 'heavy'),
    jsonb_build_object('role', 'dba',                         'name', 'Database Administrator',      'model_tier', 'heavy'),
    -- Phase 2 — Quality + Security (5) -----------------------------------------
    jsonb_build_object('role', 'qa_automation_engineer',      'name', 'QA Automation Engineer',      'model_tier', 'default'),
    jsonb_build_object('role', 'sdet',                        'name', 'SDET',                        'model_tier', 'heavy'),
    jsonb_build_object('role', 'security_engineer',           'name', 'Security Engineer',           'model_tier', 'heavy'),
    jsonb_build_object('role', 'appsec_engineer',             'name', 'AppSec Engineer',             'model_tier', 'heavy'),
    jsonb_build_object('role', 'compliance_grc',              'name', 'Compliance / GRC',            'model_tier', 'default'),
    -- Phase 2 — Design specialists (4) -----------------------------------------
    jsonb_build_object('role', 'ux_designer',                 'name', 'UX Designer',                 'model_tier', 'default'),
    jsonb_build_object('role', 'ui_designer',                 'name', 'UI Designer',                 'model_tier', 'default'),
    jsonb_build_object('role', 'ux_researcher',               'name', 'UX Researcher',               'model_tier', 'default'),
    jsonb_build_object('role', 'product_designer',            'name', 'Product Designer',            'model_tier', 'default'),
    -- Phase 2 — Go-to-Market / Customer (6) ------------------------------------
    jsonb_build_object('role', 'sales_account_executive',     'name', 'Sales Account Executive',     'model_tier', 'default'),
    jsonb_build_object('role', 'solutions_engineer',          'name', 'Solutions Engineer',          'model_tier', 'default'),
    jsonb_build_object('role', 'customer_success_manager',    'name', 'Customer Success Manager',    'model_tier', 'default'),
    jsonb_build_object('role', 'implementation_specialist',   'name', 'Implementation Specialist',   'model_tier', 'default'),
    jsonb_build_object('role', 'technical_support_engineer',  'name', 'Technical Support Engineer',  'model_tier', 'default'),
    jsonb_build_object('role', 'marketing_manager',           'name', 'Marketing Manager',           'model_tier', 'default'),
    -- Phase 2 — Operations / Support (4) ---------------------------------------
    jsonb_build_object('role', 'project_program_manager',     'name', 'Project / Program Manager',   'model_tier', 'default'),
    jsonb_build_object('role', 'scrum_master',                'name', 'Scrum Master',                'model_tier', 'default'),
    jsonb_build_object('role', 'business_analyst',            'name', 'Business Analyst',            'model_tier', 'default'),
    jsonb_build_object('role', 'it_admin',                    'name', 'IT / Systems Administrator',  'model_tier', 'default'),
    -- Phase 2 / M5b — Scaffolding (1) ------------------------------------------
    jsonb_build_object('role', 'project_scaffolder',          'name', 'Project Scaffolder',          'model_tier', 'heavy')
  );
  v_row jsonb;
begin
  for v_row in select * from jsonb_array_elements(v_roles)
  loop
    insert into public.agents (tenant_id, name, role, config)
    select p_tenant_id,
           v_row->>'name',
           v_row->>'role',
           jsonb_build_object(
             'wip_limit', 3,
             'assignment_mode', 'push',
             'runner_policy', 'local-cc',
             'model_tier', v_row->>'model_tier'
           )
    where not exists (
      select 1 from public.agents
      where tenant_id = p_tenant_id and role = v_row->>'role'
    );
  end loop;
end;
$$;

revoke all on function public.materialize_builtin_agents(uuid) from public;
grant execute on function public.materialize_builtin_agents(uuid) to service_role;

-- Backfill the new `project_scaffolder` row for existing tenants. The
-- function's per-role `where not exists` guard means this is a no-op for
-- the 49 roles already provisioned by 20260603120000_*.
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.materialize_builtin_agents(t.id);
  end loop;
end;
$$;
