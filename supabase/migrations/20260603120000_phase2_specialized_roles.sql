-- Phase 2 — Widen `materialize_builtin_agents` to 49 specialized roles.
--
-- Phase 0 + M4/M6/M7 shipped 10 built-in roles (pm, engineer, qa, devops,
-- techwriter, designer, dataeng, security, triage, tech_lead). This migration
-- adds 39 specialized roles spanning leadership/product, engineering
-- specializations, data, infrastructure, quality, security, design, GTM, and
-- operations — see `apps/web/lib/roles/` for the per-role system prompts.
--
-- Mechanism: replace the materializer function so the existing
-- `on_tenant_created` trigger auto-provisions all 49 roles for new tenants,
-- then backfill for existing tenants. The function's per-role
-- `where not exists` guard makes the backfill idempotent — tenants that
-- already have any of the original 10 rows keep them untouched.
--
-- Idempotent: re-runnable.

create or replace function public.materialize_builtin_agents(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_roles jsonb := jsonb_build_array(
    -- Phase 0 + M4 + M6 + M7 — original built-ins -----------------------------
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
    jsonb_build_object('role', 'it_admin',                    'name', 'IT / Systems Administrator',  'model_tier', 'default')
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

-- Backfill the 39 new roles for existing tenants. ------------------------------
-- The function's per-role `where not exists` guard means this is a no-op for
-- tenants that already have any specific role row.
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.materialize_builtin_agents(t.id);
  end loop;
end;
$$;
