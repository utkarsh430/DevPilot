-- Async dependency suggestions surface.
--
-- The board's "New ticket" create used to BLOCK on a synchronous Haiku
-- dep-suggestion rerank (createTicketCore → loadAndSuggestDeps → the local-cc
-- one-shot runner) before the create action returned, so the "Creating…"
-- button hung whenever the runner was busy. That LLM call now runs in a
-- background Inngest function (`ticket/suggest-deps.requested` →
-- `suggestTicketDepsFn`, mirroring the existing `ticket/auto-enrich.requested`
-- pattern) and the create returns the moment the row is inserted.
--
-- This column is where the background job parks the result so the operator can
-- still act on it asynchronously: the board already subscribes to `tickets`
-- realtime (INSERT/UPDATE), so writing the ranked suggestions here lights up a
-- "review suggested dependencies" chip on the card, which opens the SAME
-- accept/skip modal the old synchronous flow showed. The operator's
-- accept/skip (acceptTicketDependenciesAction) clears it back to NULL.
--
-- JSONB (not a child table) because the payload is a transient, whole-set
-- suggestion snapshot (title + status + score + rationale, already denormalized
-- for the modal), not a durable relation — durable blocker rows live in
-- `ticket_dependencies` and are written only once the operator confirms. NULL =
-- "no pending suggestions" (nothing computed, none met the score bar, or the
-- operator already dealt with them); every pre-existing ticket reads as NULL and
-- shows no chip, so the board behaves exactly as before until the job writes.
--
-- No publication change: `tickets` is already in `supabase_realtime` (the board
-- subscribes to it), and a Postgres publication is per-table, so a new column
-- rides the existing UPDATE payload automatically.

alter table public.tickets
  add column if not exists suggested_dependencies jsonb;

comment on column public.tickets.suggested_dependencies is
  'Pending Haiku dependency suggestions for this ticket, parked by suggestTicketDepsFn for the operator to accept/skip. NULL when there are none pending; cleared to NULL on accept/skip.';
