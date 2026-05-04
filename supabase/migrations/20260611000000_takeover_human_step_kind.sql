-- "Take the wheel" — interactive Claude takeover.
--
-- During a takeover the runner mirrors the interactive session's transcript
-- into the ticket log as run_steps. Human-typed turns get a dedicated `human`
-- kind so the Run Inspector can render them distinctly from agent `think`
-- steps. Extend the run_steps.kind check constraint to allow it.
--
-- The original constraint is the inline column check from 20260601000000_core.sql
-- (`run_steps.kind text not null check (kind in ('think','tool_call',
-- 'tool_result','human_wait','system'))`), which Postgres named
-- `run_steps_kind_check`. Drop + re-add with `human` included.

alter table public.run_steps
  drop constraint if exists run_steps_kind_check;

alter table public.run_steps
  add constraint run_steps_kind_check
  check (kind in ('think', 'tool_call', 'tool_result', 'human_wait', 'system', 'human'));
