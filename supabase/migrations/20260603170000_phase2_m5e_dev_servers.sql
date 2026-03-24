-- =============================================================================
-- Migration : 20260603170000_phase2_m5e_dev_servers.sql
-- Phase 2 / M5e — "Run" button substrate: per-project dev-server sessions.
--
-- Purpose
-- ────────
-- M5a–M5d move commits onto per-project repos and gate them behind a Push
-- review. M5e closes the inner loop: an operator clicks Run on a project (or
-- a pending push) and the runner spawns the project's dev server attached to
-- the same workspace the agents have been editing, then surfaces a live
-- preview URL + log tail in the UI.
--
-- The orchestration substrate is a single table written below — one row per
-- spawn attempt, with the full status timeline (port, pid, runner_id,
-- last_log_tail, heartbeat timestamps). The runner's dev-server control loop
-- consumes start/stop messages from the Redis queue `ace:jobs:dev-server:control`
-- and POSTs heartbeat updates back to the engine, which UPDATEs the matching
-- row here. Supabase realtime fan-out drives the live status pill in /projects
-- and the Live tab on /changes without any client polling.
--
-- Key columns:
--   • `workspace_path` — absolute path on the runner host the child process
--     was spawned in (typically `~/.ace/workspaces/<ticketId>/`). Mirrors
--     pending_pushes.workspace_path so the same checkout is shared with the
--     agent run that wrote the unpushed commits.
--   • `command` — single-line shell command (e.g. `pnpm dev`). The runner
--     re-splits by whitespace; stack-detect (B3) builds this from the
--     workspace's package.json / pyproject.toml.
--   • `port` / `url` — assigned by the runner after probing for a free port
--     starting at `ACE_DEV_SERVER_PORT_START` (default 3100). null until
--     `status='running'`.
--   • `pid` — the child process pid on the runner host, kept so the runner's
--     stop handler (and the runner-side SIGTERM hook) can target the right
--     process group when killing.
--   • `runner_id` — which runner owns this session, used by the reaper to
--     route cleanup events to the right host.
--   • `last_heartbeat_at` — bumped every 3s by the runner. Reaper flips
--     status='errored' if this falls more than 90s stale.
--   • `last_interaction_at` — bumped when the operator hits the preview URL
--     or opens the Live tab. Reaper emits a stop_requested(reason='idle')
--     after 30 min of no interaction. Distinct from heartbeat so a healthy
--     long-running server doesn't trip the idle reaper.
--   • `last_log_tail` — last ~8 KB of stdout+stderr, replaced on each
--     heartbeat. Bounded by the runner's circular buffer.
--   • `pending_push_id` — optional FK so the /changes Run button can resolve
--     the active session for a specific pending push without scanning by
--     ticket_id (which may have been cleared on push).
--
-- RLS
-- ───
-- Standard tenant-member pattern, read-only. All writes come from the runner
-- via the heartbeat HTTP endpoint (service_role) or from server actions
-- (also service_role for cross-tenant supervisor operations). No member-write
-- policy — operators trigger start/stop via server actions, never direct
-- SQL.
--
-- Idempotency
-- ───────────
-- Forward-only; `create table if not exists` + `create index if not exists`
-- + `drop policy if exists` + `create policy`.
-- =============================================================================
begin;

create table if not exists public.dev_server_sessions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  project_id          uuid not null references public.projects(id) on delete cascade,
  -- Optional links back to the originating ticket / pending push. Both
  -- `on delete set null` because the session row outlives its triggers (it
  -- stays for 24h as audit before the reaper prunes it).
  ticket_id           uuid references public.tickets(id) on delete set null,
  pending_push_id     uuid references public.pending_pushes(id) on delete set null,
  -- Absolute path on the runner host (e.g. `~/.ace/workspaces/<ticketId>/`).
  -- Same shape as pending_pushes.workspace_path; the runner re-attaches to
  -- the existing checkout rather than re-cloning.
  workspace_path      text not null,
  -- Branch the workspace is currently on. Recorded for the UI ("Running
  -- ace/feat-x on :3100") and so the reaper can detect a mismatch if the
  -- branch is force-moved out from under the dev server.
  branch              text not null,
  -- Single-line shell command (e.g. "pnpm dev"). The runner splits by
  -- whitespace; M5e v1 doesn't support shell metacharacters.
  command             text not null,
  -- Assigned by the runner after probing for a free port starting at
  -- ACE_DEV_SERVER_PORT_START. null until status='running'.
  port                int,
  url                 text,
  -- Child process pid on the runner host. Used by the runner's stop handler
  -- and the runner-side SIGTERM hook for process-group kill.
  pid                 int,
  -- Which runner host owns this session. Reaper routes cleanup to the right
  -- host via this FK.
  runner_id           uuid references public.runners(id) on delete set null,
  -- Status timeline. starting → running on first successful heartbeat;
  -- running → stopped on clean exit / user-stop; → errored on crash or
  -- heartbeat timeout.
  status              text not null default 'starting'
                        check (status in ('starting', 'running', 'stopped', 'errored')),
  -- Free-form status detail ("no-heartbeat", "idle", "exit-code-1", …).
  -- Surfaced in the UI status pill tooltip.
  status_reason       text,
  -- Last ~8 KB of stdout+stderr, replaced on each heartbeat. Bounded by the
  -- runner's circular buffer.
  last_log_tail       text,
  started_by_user_id  uuid references auth.users(id) on delete set null,
  started_at          timestamptz not null default now(),
  -- Bumped every ~3s by the runner heartbeat. Reaper flips to 'errored' if
  -- this falls more than 90s stale.
  last_heartbeat_at   timestamptz not null default now(),
  -- Bumped when the operator opens the Live tab or hits the preview URL.
  -- Reaper emits stop_requested(reason='idle') after 30 min of no
  -- interaction. Distinct from heartbeat so a healthy long-running server
  -- doesn't trip the idle reaper.
  last_interaction_at timestamptz not null default now(),
  stopped_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists dev_server_sessions_tenant_project_idx
  on public.dev_server_sessions(tenant_id, project_id);

-- Partial index for the active-session lookup
-- (`WHERE project_id = ? AND status IN ('starting','running')`). Cheap to
-- maintain because stopped sessions vastly outnumber active ones.
create index if not exists dev_server_sessions_active_idx
  on public.dev_server_sessions(tenant_id)
  where status in ('starting', 'running');

-- Partial index for runner-side cleanup queries. The reaper and the
-- SIGTERM-on-runner-shutdown path both walk active sessions by runner_id;
-- this keeps that walk index-only.
create index if not exists dev_server_sessions_runner_active_idx
  on public.dev_server_sessions(runner_id)
  where status in ('starting', 'running');

alter table public.dev_server_sessions enable row level security;

-- Tenant members can read sessions for any project they have access to.
-- No member-write policy: all writes flow through the runner heartbeat
-- endpoint and server actions, both using service_role.
drop policy if exists dev_server_sessions_member_read on public.dev_server_sessions;
create policy dev_server_sessions_member_read on public.dev_server_sessions
  for select using (tenant_id in (select public.current_user_tenants()));

-- Wire into Supabase Realtime so the /projects status pill and the Live
-- tab on /changes update without polling.
do $$
begin
  begin
    alter publication supabase_realtime add table public.dev_server_sessions;
  exception
    when duplicate_object then null;
  end;
end$$;

-- updated_at trigger using the existing helper from core.sql.
drop trigger if exists dev_server_sessions_updated_at on public.dev_server_sessions;
create trigger dev_server_sessions_updated_at
  before update on public.dev_server_sessions
  for each row execute function public.touch_updated_at();

commit;
