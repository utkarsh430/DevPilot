-- Regression check, not a new write shape: this migration (20260764000000)
-- adds RPCs, never widens a table-level or column-level grant. The two write
-- shapes it covers (the tickets FSM patch, the system comment) must stay
-- reachable ONLY through the new RPCs, exactly as WP 1.3 (20260761000000)
-- intended for `devpilot_move_ticket`/`devpilot_system_comment`.
--
-- `has_column_privilege` is a direct, unambiguous assertion of the grant
-- itself (independent of RLS, independent of any particular row) — a
-- stronger check than "an UPDATE attempt raised 42501", which could in
-- principle succeed for an unrelated reason on a future schema change.

\echo '--- [grant-regression] tickets: gated columns (status, retry_count, gate_retry_count, auto_promote_when_unblocked) have NO UPDATE grant to authenticated — expect all four FALSE ---'
select
  has_column_privilege('authenticated', 'public.tickets', 'status', 'UPDATE')                       as status_grantable,
  has_column_privilege('authenticated', 'public.tickets', 'retry_count', 'UPDATE')                   as retry_count_grantable,
  has_column_privilege('authenticated', 'public.tickets', 'gate_retry_count', 'UPDATE')              as gate_retry_count_grantable,
  has_column_privilege('authenticated', 'public.tickets', 'auto_promote_when_unblocked', 'UPDATE')   as auto_promote_grantable,
  has_column_privilege('authenticated', 'public.tickets', 'plan_hold', 'UPDATE')                     as plan_hold_grantable,
  has_column_privilege('authenticated', 'public.tickets', 'safety_critical', 'UPDATE')               as safety_critical_grantable;

\echo '--- [grant-regression] tickets: the WP 1.3 column-grant carve-out (title, description, acceptance_criteria, assignee_agent_id) is UNCHANGED — expect all four TRUE ---'
select
  has_column_privilege('authenticated', 'public.tickets', 'title', 'UPDATE')               as title_grantable,
  has_column_privilege('authenticated', 'public.tickets', 'description', 'UPDATE')         as description_grantable,
  has_column_privilege('authenticated', 'public.tickets', 'acceptance_criteria', 'UPDATE') as acceptance_criteria_grantable,
  has_column_privilege('authenticated', 'public.tickets', 'assignee_agent_id', 'UPDATE')   as assignee_agent_id_grantable;

\echo '--- [grant-regression] comments: no UPDATE/DELETE grant at all (append-only) — expect FALSE for both ---'
select
  has_table_privilege('authenticated', 'public.comments', 'UPDATE') as comments_update_grantable,
  has_table_privilege('authenticated', 'public.comments', 'DELETE') as comments_delete_grantable;

\echo '--- [grant-regression] runs: still NO INSERT/UPDATE/DELETE grant to authenticated at all — every mutation goes through devpilot_spawn_run / devpilot_create_ticket, unaffected by this migration ---'
select
  has_table_privilege('authenticated', 'public.runs', 'INSERT') as runs_insert_grantable,
  has_table_privilege('authenticated', 'public.runs', 'UPDATE') as runs_update_grantable,
  has_table_privilege('authenticated', 'public.runs', 'DELETE') as runs_delete_grantable;

\echo '--- [grant-regression] anon has EXECUTE revoked on both new RPCs (defence in depth alongside the RLS/require_tenant_member refusal) — expect FALSE for both ---'
select
  has_function_privilege(
    'anon',
    'public.devpilot_engine_transition_ticket(uuid, public.ticket_status, text, uuid, text, int, text, text, boolean, uuid, public.ticket_status)',
    'EXECUTE'
  ) as anon_can_exec_transition,
  has_function_privilege(
    'anon',
    'public.devpilot_engine_system_comment(uuid, text, text, jsonb)',
    'EXECUTE'
  ) as anon_can_exec_system_comment;

\echo '--- [grant-regression] public (the implicit PUBLIC pseudo-role, whose default EXECUTE grant on a new function this migration explicitly revokes) — expect FALSE for both ---'
select
  has_function_privilege(
    'public',
    'public.devpilot_engine_transition_ticket(uuid, public.ticket_status, text, uuid, text, int, text, text, boolean, uuid, public.ticket_status)',
    'EXECUTE'
  ) as public_can_exec_transition,
  has_function_privilege(
    'public',
    'public.devpilot_engine_system_comment(uuid, text, text, jsonb)',
    'EXECUTE'
  ) as public_can_exec_system_comment;
