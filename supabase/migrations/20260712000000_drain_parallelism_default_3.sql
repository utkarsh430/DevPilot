-- Migration: 20260712000000_drain_parallelism_default_3.sql
--
-- WI-13 / the concurrency fix. `drain_parallelism` landed in
-- 20260609010000_drain_parallelism.sql defaulting to 1, but the drain loop
-- discarded the value entirely and no UI ever exposed the column - so every
-- backlog drain ran strictly one ticket at a time regardless of what the row
-- said. The drain now honours it (sliding window in `lib/engine/drain-window.ts`).
--
-- Two changes so the fix is actually exercised:
--
--   1. Column default 1 → 3. 3 matches the per-agent WIP default and the
--      local-cc concurrency guidance in AGENTS.md ("~1–3 steady concurrent
--      agents"). Operators can still pick anything in 1..10 (1 = the old
--      strictly-serial behaviour) from the Schedule dialog.
--
--   2. Backfill existing rows that still hold 1. Because the column was never
--      settable - not by the server action (which didn't accept the field), not
--      by the UI - a stored 1 is the old default, never an operator's choice.
--      There is nothing to preserve.
--
-- Hard cap stays 10 (the CHECK from the original migration is unchanged).

begin;

alter table public.ticket_schedules
  alter column drain_parallelism set default 3;

update public.ticket_schedules
  set drain_parallelism = 3
  where drain_parallelism = 1;

comment on column public.ticket_schedules.drain_parallelism is
  'Max tickets the backlog drain keeps in flight concurrently (sliding window). Default 3; 1 = strictly serial. Dependency-blocked tickets never occupy a slot. Subscription-backed (local-cc) runners stay <= 3 per AGENTS.md.';

commit;
