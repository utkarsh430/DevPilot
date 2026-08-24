-- Realign first-party skill `targets` onto the roles that exist today.
--
-- THE DEFECT. `targets` was seeded once, in 20260603090000_m11_marketplace.sql,
-- against the eight roles that existed then: engineer, pm, qa, devops,
-- techwriter, designer, dataeng, security. Phase 2 added ~43 more. Selection
-- matches EXACTLY (`targets.includes(role)`, apps/web/lib/skills/select.ts), so
-- every later role resolved to zero skills — the role that writes the markup
-- could not receive the accessibility skill, and appsec_engineer, whose prompt
-- names the OWASP Top 10 as its hunting ground, could not receive the OWASP
-- skill. Nothing errored; the coverage simply was not there.
--
-- WHY THIS UPDATES IN PLACE RATHER THAN BUMPING THE VERSION. `installSkillAction`
-- copies `targets` into the tenant's own row at install time, and
-- `loadInstalledSkills` reads `targets` from THAT row — so a targets fix is
-- subject to exactly the same staleness as a body fix. Editing only the public
-- seed row would reach nobody who has already installed. A version bump would
-- reach them only if they noticed and re-installed, which is the failure mode
-- that produced this drift in the first place. Bodies are NOT touched here, so
-- there is no new prompt text for an operator to consent to: this changes only
-- which roles already-accepted text is routed to. That is what makes an
-- in-place update the honest option rather than a shortcut.
--
-- THE SCOPING PREDICATE IS THE SAFETY PROPERTY, not a formality. Operators can
-- author their own skills (apps/web/lib/skills/authoring-store.ts), and nothing
-- stops one being named "RFC writer". Such a row has `tenant_id` set and
-- `installed_from_skill_id` NULL. Every statement below is therefore scoped to
--   (tenant_id is null            -- the public seed row
--    or installed_from_skill_id is not null)  -- a clone OF a seed row
-- so an operator's own same-named skill is never rewritten. Dropping that
-- clause would silently retarget hand-authored operator content.
--
-- No body, name, version or manifest is modified. No row is inserted or
-- deleted. Rationale for each individual role addition — and for the three
-- skills deliberately NOT widened — lives in
-- apps/web/lib/skills/first-party-targets.ts, which the test suite asserts
-- against this file so the two cannot drift.

do $$
declare
  -- name -> targets. Mirrors FIRST_PARTY_SKILL_TARGETS in
  -- apps/web/lib/skills/first-party-targets.ts (drift-asserted by
  -- apps/web/lib/skills/__tests__/first-party-targets.test.ts).
  spec jsonb := jsonb_build_object(
    'RFC writer',
      '["engineer","techwriter","pm","frontend_engineer","backend_engineer","fullstack_engineer","mobile_engineer"]'::jsonb,
    'OWASP Top 10 checklist',
      '["security","engineer","appsec_engineer","security_engineer","backend_engineer","fullstack_engineer","frontend_engineer","cloud_engineer"]'::jsonb,
    'PostgreSQL index advisor',
      '["dataeng","engineer","dba","backend_engineer","fullstack_engineer","analytics_engineer"]'::jsonb,
    'WCAG 2.1 AA quick audit',
      '["designer","engineer","frontend_engineer","fullstack_engineer","mobile_engineer","ui_designer","ux_designer","product_designer"]'::jsonb,
    'Test pyramid reviewer',
      '["qa","engineer","qa_automation_engineer","sdet","backend_engineer","frontend_engineer","fullstack_engineer"]'::jsonb,
    'API docs from handler',
      '["techwriter","engineer","backend_engineer","fullstack_engineer","staff_engineer"]'::jsonb,
    'PM ticket refiner',
      '["pm","product_owner","business_analyst"]'::jsonb,
    'QA acceptance verifier',
      '["qa","verifier","product_owner","qa_automation_engineer"]'::jsonb,
    'Designer empty-state checklist',
      '["designer","engineer","ui_designer","ux_designer","product_designer","frontend_engineer","fullstack_engineer","mobile_engineer"]'::jsonb
  );
  skill_name text;
  updated_count int;
begin
  for skill_name in select jsonb_object_keys(spec) loop
    update public.skills
       set targets = spec -> skill_name
     where name = skill_name
       and (tenant_id is null or installed_from_skill_id is not null)
       and targets is distinct from spec -> skill_name;

    get diagnostics updated_count = row_count;
    raise notice 'skill targets realigned: % (% row(s))', skill_name, updated_count;
  end loop;
end $$;

-- Deliberately absent from the spec above, and therefore untouched:
--
--   K8s rollback runbook  — the body instructs `kubectl` against a stack with
--     no Kubernetes, and devops.ts forbids inventing off-stack infra. It
--     already contradicts the one prompt it merges into; widening it would
--     multiply that across sre / cloud_engineer / platform_engineer.
--   SQL safety checks     — the body names `ace_query_db`, a tool renamed to
--     `devpilot_query_db` in the batch-2b rename. data_analyst / data_scientist
--     are the roles a name match would add; adding them would put a dead tool
--     name into two more prompts.
--   Conventional commits  — the rule is already spelled out in the prompts of
--     the roles a widening would add (frontend_engineer, sre,
--     security_engineer, appsec_engineer each state the format themselves).
--
-- All three are on the content audit's cut/replace list. Correcting a body is
-- out of scope for a targets change; wrong guidance in a prompt is worse than
-- absent guidance, so they stay where they are until their bodies are fixed.
