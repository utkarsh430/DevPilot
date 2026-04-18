-- Migration: 20260609010000_drain_parallelism.sql
--
-- Scheduler windowing — let a single drain run more than one ticket at a
-- time. Default 1 preserves the existing strictly-serial behaviour from
-- 20260605000000_ticket_schedules.sql.
--
-- Hard cap is 10 (DB-side CHECK). Soft guidance per CLAUDE.md non-negotiable
-- on subscription rate limits: keep this ≤ 3 for local-cc runners; the API
-- Runner has no equivalent cap. The server action layer narrows further
-- (rejects anything outside 1..3 today; bump the action's validator if you
-- have multiple runner hosts or are using the API path).

begin;

alter table public.ticket_schedules
  add column if not exists drain_parallelism int not null default 1
    check (drain_parallelism between 1 and 10);

comment on column public.ticket_schedules.drain_parallelism is
  'Max tickets the scheduler keeps in flight concurrently. Default 1 (serial). Operators bump for parallel drains; subscription runners stay ≤ 3 per CLAUDE.md.';

commit;
