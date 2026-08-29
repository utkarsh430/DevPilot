-- Ambient agent-activity indicator — Realtime substrate.
--
-- The app chrome now carries a persistent "is anything working right now"
-- indicator (`components/shell/activity-indicator.tsx`), driven by a Realtime
-- subscription on `public.runs`. `run_steps` has been in the publication since
-- 20260602010000 (the Run Inspector tails it), but `runs` itself never was —
-- so a run STARTING or FINISHING produced no delta any client could observe,
-- and the only way to notice was to navigate to the Runs page and reload.
--
-- Adding the table here is what lets the indicator tick up and down without
-- polling. Nothing else changes: `runs` already has `runs_member_read` scoping
-- SELECT to `tenant_id in current_user_tenants()`, and Realtime enforces RLS on
-- the subscribing client's JWT, so this exposes no row a member could not
-- already read through PostgREST.
--
-- Note on payload shape: under the default replica identity a DELETE event
-- carries only the primary key. The consuming hook therefore matches deletes on
-- `id` in the handler rather than server-filtering them on `tenant_id`, which
-- would silently drop every delete (see the Realtime notes in AGENTS.md).
--
-- Idempotent: `add table` errors if the table is already a member, so guard
-- with a DO block that swallows duplicate_object — same shape as
-- 20260602000000_realtime_publication.sql and 20260602010000.

do $$
begin
  begin
    alter publication supabase_realtime add table public.runs;
  exception
    when duplicate_object then null;
  end;
end$$;
