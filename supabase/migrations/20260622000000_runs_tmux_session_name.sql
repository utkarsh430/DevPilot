-- =============================================================================
-- Migration : 20260622000000_runs_tmux_session_name.sql
--
-- Track 2 — every local-cc agent run now spawns inside a named tmux session
-- (`ace-run-<runId-16char>`) so operators can `tmux attach -t <name>` from the
-- moment a step starts and watch what the agent is doing — without going
-- through the "Take the wheel" UI flow.
--
-- The runner stamps the session name onto the runs row via:
--   1. POST /api/runs/{id}/claim   { runnerId, tmuxSession }
--      Called once per job, right after claude.ts opens the tmux pane. This is
--      the fast path — the UI sees the name within ~200ms of the agent
--      starting.
--   2. PATCH /api/runners/{id}/heartbeat { status, tmuxSession }
--      Called every 15s as a recovery channel in case the claim race lost.
--      The engine resolves "the runner's current run" by looking up the most
--      recent `runs` row with `runner_id = $1` AND `status = 'running'`.
--
-- Column is nullable because:
--   • The API runner path never sets it (no tmux involved).
--   • Hosts without tmux installed fall back to direct child_process spawn.
--   • Historical runs predating this migration won't have one either.
--
-- The UI (Track 3 / RunInspector) uses this to render an attach command when
-- present; absence simply means no attach affordance.
-- =============================================================================

alter table public.runs
  add column if not exists tmux_session_name text;

-- No index — looked up by run id (already a PK) or by runner_id (already
-- indexed). The column is small and rarely queried in isolation.
