-- Dev-server enhancements — new lifecycle states + missing-env tracking.
--
-- `building`  — the runner is running a build step (e.g. `pnpm build`) before
--               serving (only when needed: prod `start` / missing artifacts).
-- `needs_env` — the runner detected required env vars (from the workspace
--               `.env.example`) that aren't in the project secrets vault, and
--               parked WITHOUT spawning. The UI prompts for them; once provided
--               the run is re-triggered.
--
-- The original status CHECK is the inline column constraint from
-- 20260603170000_phase2_m5e_dev_servers.sql, which Postgres named
-- `dev_server_sessions_status_check`. Drop + re-add with the two new states.
-- Idempotent (drop if exists) so re-running is safe.

alter table public.dev_server_sessions
  drop constraint if exists dev_server_sessions_status_check;

alter table public.dev_server_sessions
  add constraint dev_server_sessions_status_check
  check (status in ('starting', 'running', 'stopped', 'errored', 'needs_env', 'building'));

-- Keys the runner detected as required-but-missing while in `needs_env`. The
-- dev-server panel renders a masked-input form for these. NULL otherwise.
alter table public.dev_server_sessions
  add column if not exists missing_env_keys text[];
