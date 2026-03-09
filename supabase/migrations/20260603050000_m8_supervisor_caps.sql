-- =============================================================================
-- Migration : 20260603050000_m8_supervisor_caps.sql
-- Phase     : 1 / M8 — Supervisor trees + hard caps
-- Purpose   : Add the columns/indexes the supervisor's cap-checks read at
--             spawn time, plus a per-parent monotonic child counter so the
--             MAX_FAN_OUT check is atomic.
--
-- What this adds
-- ──────────────
-- • runs.children_count int default 0 — incremented atomically when a child
--   run is registered against this parent. Used by assertCanSpawn to refuse
--   when adding one more child would exceed MAX_FAN_OUT.
-- • runs_parent_id_idx — speeds up subtree queries (cascade-kill walks here,
--   the inspector's tree renderer walks here, the orphan reaper walks here).
-- • A SQL function `runs_increment_children` so the increment+read is one
--   atomic statement. Postgres rules out two concurrent spawns from racing
--   past the cap.
-- =============================================================================

begin;

alter table public.runs
  add column if not exists children_count int not null default 0
    check (children_count >= 0);

-- Subtree traversal. Partial isn't useful here because most queries care
-- about all children regardless of status (active set + audit/history).
create index if not exists runs_parent_id_idx
  on public.runs(parent_run_id)
  where parent_run_id is not null;

-- Atomic spawn helper.
--
-- Returns the post-increment count so the caller can compare against
-- MAX_FAN_OUT in the same round-trip. The function locks the parent row
-- FOR UPDATE so two concurrent spawn attempts serialize cleanly even when
-- both see the same pre-state.
--
-- The function is SECURITY DEFINER so service_role callers (Inngest) bypass
-- RLS on `runs` cleanly. search_path is pinned to public to neutralise
-- search_path injection.
create or replace function public.runs_increment_children(p_parent_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- Lock the row, then increment, then read in one statement.
  update public.runs
     set children_count = children_count + 1
   where id = p_parent_id
  returning children_count into v_count;
  if v_count is null then
    raise exception 'runs_increment_children: parent run % not found', p_parent_id;
  end if;
  return v_count;
end;
$$;

revoke all on function public.runs_increment_children(uuid) from public;
grant execute on function public.runs_increment_children(uuid) to service_role;

commit;
