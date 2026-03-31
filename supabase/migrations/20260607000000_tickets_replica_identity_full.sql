-- Phase 2 — fix: realtime DELETE events on the board never reach the client.
--
-- The board's `useLiveTickets` hook subscribes to DELETE on `tickets` with a
-- `tenant_id=eq.<id>` filter. By default Postgres ships only the primary key
-- in the OLD record on DELETE, so the filter has no `tenant_id` to match
-- against and Supabase Realtime silently drops the event for filtered
-- subscribers. The card visually sticks around until a manual refresh.
--
-- REPLICA IDENTITY FULL emits every column in the OLD record, so the
-- channel filter resolves and the DELETE event reaches the client. Cost is
-- a small WAL increase per delete — acceptable for a low-volume table like
-- tickets / pending_pushes.
--
-- We apply the same fix to `pending_pushes` because its realtime hook has
-- the identical filter shape (see lib/realtime/use-pending-pushes.ts).

alter table public.tickets replica identity full;
alter table public.pending_pushes replica identity full;
