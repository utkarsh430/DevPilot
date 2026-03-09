-- Phase 1 / M4 — materialize four new built-in role agents per tenant.
--
-- Adds devops, techwriter, designer, dataeng to `public.materialize_builtin_agents`,
-- so the existing trigger (`on_tenant_created`) auto-provisions them for new
-- tenants. Also backfills for existing tenants.
--
-- Tickets gain `requested_role text` — when set, the dispatcher honors it
-- ahead of the deterministic state-machine. M4 acceptance scripts and Phase 2's
-- LLM classifier both write into this column.
--
-- Idempotent: re-runnable.

alter table public.tickets
  add column if not exists requested_role text;

create index if not exists tickets_requested_role_idx
  on public.tickets(tenant_id, requested_role)
  where requested_role is not null;

-- Replace the materializer with the 7-role version. -----------------------------
create or replace function public.materialize_builtin_agents(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_roles jsonb := jsonb_build_array(
    jsonb_build_object('role', 'pm',         'name', 'PM',            'model_tier', 'default'),
    jsonb_build_object('role', 'engineer',   'name', 'Engineer',      'model_tier', 'default'),
    jsonb_build_object('role', 'qa',         'name', 'QA',            'model_tier', 'default'),
    jsonb_build_object('role', 'devops',     'name', 'DevOps',        'model_tier', 'default'),
    jsonb_build_object('role', 'techwriter', 'name', 'Tech Writer',   'model_tier', 'default'),
    jsonb_build_object('role', 'designer',   'name', 'Designer',      'model_tier', 'default'),
    jsonb_build_object('role', 'dataeng',    'name', 'Data Engineer', 'model_tier', 'heavy')
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

-- Backfill the four new roles for existing tenants. ----------------------------
-- The function's per-role `where not exists` guard means this is a no-op for
-- tenants that already have any of these rows.
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.materialize_builtin_agents(t.id);
  end loop;
end;
$$;
