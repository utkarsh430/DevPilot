-- Phase 1 / M3 — materialize built-in agent rows per tenant and surface
-- per-agent WIP limits + assignment mode + runner policy + model tier on
-- `agents.config`.
--
-- Phase 0 carried `role` in event payloads and left `runs.agent_id` null. M3
-- finally creates one row per built-in role (pm / engineer / qa) per tenant
-- so the dispatcher can:
--   - look up an agent by (tenant_id, role)
--   - enforce per-agent WIP limits (config.wip_limit, default 3)
--   - distinguish 'push' vs 'pull' assignment modes (config.assignment_mode)
--   - stamp runs.agent_id with a real id so the inspector role badge no longer
--     has to fall back to scanning run_steps.payload.role
--
-- This migration is IDEMPOTENT: re-running it does nothing because (a) the
-- backfill `insert ... select ... where not exists` is a no-op for tenants
-- that already have rows for that role, and (b) the trigger and index use
-- `create or replace` / `if not exists`.

-- Speed up the dispatcher lookup. Without this index every dispatch event
-- triggers a tenant-wide scan of `agents`.
create index if not exists agents_tenant_role_idx
  on public.agents(tenant_id, role);

-- Materializer ----------------------------------------------------------------
-- Runs as security definer so it can insert agent rows from the auth.users
-- trigger context (where RLS would otherwise block, because the new user
-- isn't yet a tenant_member at insert-time during signup).
create or replace function public.materialize_builtin_agents(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- pm
  insert into public.agents (tenant_id, name, role, config)
  select p_tenant_id,
         'PM',
         'pm',
         jsonb_build_object(
           'wip_limit', 3,
           'assignment_mode', 'push',
           'runner_policy', 'local-cc',
           'model_tier', 'default'
         )
  where not exists (
    select 1 from public.agents
    where tenant_id = p_tenant_id and role = 'pm'
  );

  -- engineer
  insert into public.agents (tenant_id, name, role, config)
  select p_tenant_id,
         'Engineer',
         'engineer',
         jsonb_build_object(
           'wip_limit', 3,
           'assignment_mode', 'push',
           'runner_policy', 'local-cc',
           'model_tier', 'default'
         )
  where not exists (
    select 1 from public.agents
    where tenant_id = p_tenant_id and role = 'engineer'
  );

  -- qa
  insert into public.agents (tenant_id, name, role, config)
  select p_tenant_id,
         'QA',
         'qa',
         jsonb_build_object(
           'wip_limit', 3,
           'assignment_mode', 'push',
           'runner_policy', 'local-cc',
           'model_tier', 'default'
         )
  where not exists (
    select 1 from public.agents
    where tenant_id = p_tenant_id and role = 'qa'
  );
end;
$$;

revoke all on function public.materialize_builtin_agents(uuid) from public;
grant execute on function public.materialize_builtin_agents(uuid) to service_role;

-- Trigger: every new tenant gets a built-in agent set automatically. -----------
create or replace function public.handle_new_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.materialize_builtin_agents(new.id);
  return new;
end;
$$;

drop trigger if exists on_tenant_created on public.tenants;
create trigger on_tenant_created
  after insert on public.tenants
  for each row execute function public.handle_new_tenant();

-- Backfill --------------------------------------------------------------------
-- Idempotent against tenants that already have rows for any of the built-in
-- roles (handled by the per-role `where not exists` inside the function).
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.materialize_builtin_agents(t.id);
  end loop;
end;
$$;
