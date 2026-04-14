-- Migration: 20260609000000_pause_resume_schema.sql
--
-- Phase 0 follow-up — operator-initiated Pause/Resume + runner watchdog.
--
-- Three intent-blocks, all additive:
--
--   1. Ticket FSM extension. New 'paused' state distinct from input_required
--      (which means "agent asked human"). Operator clicks Pause -> ticket
--      lands here; click Resume -> existing replay primitive picks up from
--      the last good step. paused_at / paused_reason are audit-only.
--
--   2. Run cancellation + replay-reason split. runs.status_reason is a free
--      text reason ('user-pause', 'runner-disconnected', 'stale-15min') that
--      pairs with the existing text status column. runs.replay_reason
--      separates operator-driven replays (subject to the 5-per-original cap)
--      from auto-recovery + user-Resume (uncounted). Adding 'cancelled' as a
--      new runs.status value needs NO migration — that column is plain text.
--
--   3. Watchdog scan + runner restart convergence. The partial index on
--      runs(runner_id) where status='running' makes the watchdog's per-minute
--      scan O(active-runs-per-stale-runner) instead of a full table scan.
--      The unique (tenant_id, name) index on runners makes a runner that
--      restarts after a crash converge on the same id (today the register
--      endpoint blindly inserts, leaving the old id orphaned and undetectable).
--
-- Transactional note: ALTER TYPE ... ADD VALUE is allowed inside a tx on PG
-- 12+ as long as the new value isn't referenced in the same tx. We only add
-- it here (no inserts/updates using 'paused'), so the standard begin/commit
-- wrapper is safe.

begin;

-- ---------------------------------------------------------------------------
-- 1. Ticket FSM: 'paused'
-- ---------------------------------------------------------------------------

alter type public.ticket_status add value if not exists 'paused';

alter table public.tickets
  add column if not exists paused_at     timestamptz,
  add column if not exists paused_reason text;

-- ---------------------------------------------------------------------------
-- 2. Run cancellation + replay-reason split
-- ---------------------------------------------------------------------------

alter table public.runs
  add column if not exists status_reason text,
  add column if not exists replay_reason text
    check (replay_reason is null
           or replay_reason in ('operator', 'resume', 'auto-recover'));

-- ---------------------------------------------------------------------------
-- 3. Watchdog scan + runner restart convergence
-- ---------------------------------------------------------------------------

-- Partial index drives the runner-watchdog's "what's in flight for this dead
-- runner" lookup. Without this the watchdog full-scans runs every minute.
create index if not exists runs_runner_active_idx
  on public.runs(runner_id)
  where status = 'running' and runner_id is not null;

-- A runner that crashes and restarts (e.g. machine sleep -> wake) hits
-- POST /api/runners/register again. Today that always inserts a new row,
-- which means the old id keeps its `runner_id` references on in-flight runs
-- and the new id has no runs to claim. Uniqueness on (tenant_id, name) lets
-- register upsert into the existing row, so the watchdog's runner_id-based
-- liveness check converges on the restarted runner's heartbeat.
create unique index if not exists runners_tenant_name_idx
  on public.runners(tenant_id, name);

commit;
