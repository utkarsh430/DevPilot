-- Phase 1 / M2 — Wave 2 (run inspector Realtime substrate).
--
-- Wave 1's publication migration added `tickets` and `comments` so the board
-- and (in Wave 2) the TicketDrawer can stream deltas. The Run Inspector now
-- tails `run_steps` live as the durable engine appends them, so add that
-- table to the `supabase_realtime` publication too.
--
-- Idempotent: `add table` errors if the table is already a member, so we
-- guard with a DO block that swallows duplicate_object — same shape as
-- 20260602000000_realtime_publication.sql.

do $$
begin
  begin
    alter publication supabase_realtime add table public.run_steps;
  exception
    when duplicate_object then null;
  end;
end$$;
