-- Migration: 20260603220000_phase2_5_planning_sessions_realtime.sql
--
-- Phase 2.5+ / M7 follow-up — add `planning_sessions` to the
-- `supabase_realtime` publication. The original M7 migration
-- (`20260603200000_phase2_5_planning_sessions.sql`) only published
-- `planning_messages`, so the UI's `useLivePlanSession` hook gets
-- nothing when subscribing to status transitions
-- (`discussing` → `planning` → `planned`).
--
-- Without this publication add, the operator's "Building…" UI
-- state would never flip when the consolidator finishes — the
-- chat panel would receive the per-stage system pills but the
-- session row update wouldn't broadcast, so the proposed-tickets
-- review pane wouldn't reveal itself.
--
-- Idempotent — uses the same `do $$ begin begin … exception when
-- duplicate_object then null; end; end$$;` shape the M7 migration
-- used for `planning_messages` so re-applies are safe.

begin;

do $$
begin
  begin
    alter publication supabase_realtime add table public.planning_sessions;
  exception
    when duplicate_object then null;
  end;
end$$;

commit;
