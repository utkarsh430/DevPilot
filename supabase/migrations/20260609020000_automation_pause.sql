-- Migration: 20260609020000_automation_pause.sql
--
-- Soft "off switch" for automation, at two layers:
--
--   tenants.automation_state    — workspace-wide master switch.
--   projects.automation_state   — per-project override.
--
-- Either being 'paused' suppresses new work emits from the dispatcher,
-- scheduler cron, WIP drain, and replay surfaces. In-flight runs finish
-- their current iteration cleanly — Pause means "stop spawning new work,"
-- not "kill what's running." For kill-everything, the existing per-ticket
-- pause-resume primitive remains the right tool.
--
-- Why two columns instead of one tenant-level field with a JSON map per
-- project: per-project lookups are on the hot path of every dispatch, and
-- a partial-indexed `automation_state = 'paused'` column is O(1) cheaper
-- than parsing jsonb on every dispatcher tick.
--
-- The audit columns (paused_at / resumed_at / paused_by_user_id) feed the
-- missed-schedules banner: on resume, the [paused_at, resumed_at] window
-- is used to compute schedules that would have fired during the pause.

begin;

-- ── Tenants ───────────────────────────────────────────────────────────
alter table public.tenants
  add column if not exists automation_state text not null default 'running'
    check (automation_state in ('running', 'paused'));
alter table public.tenants
  add column if not exists automation_paused_at timestamptz;
alter table public.tenants
  add column if not exists automation_resumed_at timestamptz;
-- Soft reference (uuid, no FK) — keep auth-schema decoupling for Supabase
-- multi-environment portability, matching the existing convention for
-- `paused_by_user_id` on tickets.
alter table public.tenants
  add column if not exists automation_paused_by_user_id uuid;

comment on column public.tenants.automation_state is
  'running | paused. Workspace-wide master switch. Either tenant or project being paused suppresses new emits.';
comment on column public.tenants.automation_paused_at is
  'Wallclock when the workspace last entered paused. Cleared to NULL on resume so the missed-schedules window stays accurate.';
comment on column public.tenants.automation_resumed_at is
  'Wallclock of the most recent resume. Used together with automation_paused_at (preserved across the resume call by the action) to compute the missed-schedules window for the banner.';

-- ── Projects ──────────────────────────────────────────────────────────
alter table public.projects
  add column if not exists automation_state text not null default 'running'
    check (automation_state in ('running', 'paused'));
alter table public.projects
  add column if not exists automation_paused_at timestamptz;
alter table public.projects
  add column if not exists automation_resumed_at timestamptz;
alter table public.projects
  add column if not exists automation_paused_by_user_id uuid;

comment on column public.projects.automation_state is
  'running | paused. Per-project override on top of tenant-level state. Either being paused suppresses new emits for that project.';

-- ── Hot-path indexes ─────────────────────────────────────────────────
-- Partial indexes — only paused rows need fast lookup; the common case
-- (running) hits the column directly and never traverses the index.
create index if not exists tenants_automation_paused_idx
  on public.tenants (id)
  where automation_state = 'paused';
create index if not exists projects_automation_paused_idx
  on public.projects (id)
  where automation_state = 'paused';

commit;
