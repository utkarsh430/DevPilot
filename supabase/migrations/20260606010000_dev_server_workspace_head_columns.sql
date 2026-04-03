-- =============================================================================
-- Migration : 20260606010000_dev_server_workspace_head_columns.sql
-- Phase 2.5++ / Slice C — Workspace head SHA + dirty-file watcher columns.
--
-- Purpose
-- ────────
-- Slice C adds a file-system watcher to the runner's dev-server-loop that
-- emits a tiny payload alongside the existing 3s heartbeat:
--
--   {
--     workspace_head_sha: <short SHA of HEAD>,
--     workspace_dirty_file_count: <int>
--   }
--
-- The Live tab reads these via the existing `dev_server_sessions` realtime
-- subscription and renders:
--   • A "Workspace updated — refresh" pill when the SHA differs from the
--     pending_pushes row's last-known head_sha (i.e. the operator just
--     made a commit locally, not the agent).
--   • An "N uncommitted edits" badge in the Live tab header when
--     workspace_dirty_file_count > 0.
--
-- Both columns are nullable — older sessions that pre-date the watcher
-- simply omit them.
-- =============================================================================
begin;

alter table public.dev_server_sessions
  add column if not exists workspace_head_sha text;

alter table public.dev_server_sessions
  add column if not exists workspace_dirty_file_count integer;

alter table public.dev_server_sessions
  add column if not exists workspace_dirty_at timestamptz;

commit;
