-- Phase 1 / M2 — Wave 1 (board Realtime substrate).
--
-- Supabase Realtime streams Postgres changes via the `supabase_realtime`
-- publication. The Phase 0 core migration didn't add anything to it, so
-- subscribers wouldn't receive INSERT/UPDATE/DELETE events on our tables
-- even with RLS green. Add the two tables the board hook subscribes to.
--
-- `comments` is included because the Wave 1 board surfaces the last-comment
-- preview on each card; Wave 2 extends the same channel to the TicketDrawer
-- comments stream and won't need another migration.
--
-- Idempotent: `add table` errors if the table is already a member, so we
-- guard with a DO block that swallows duplicate_object.

do $$
begin
  begin
    alter publication supabase_realtime add table public.tickets;
  exception
    when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.comments;
  exception
    when duplicate_object then null;
  end;
end$$;
