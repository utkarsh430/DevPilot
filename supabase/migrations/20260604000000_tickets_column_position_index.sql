-- Phase 2.5++ / C3 — Backlog DAG ordering.
--
-- Adds an index supporting the new `loadBoardTickets` order clause
-- `column_position ASC, updated_at DESC`. The `tickets.column_position` column
-- itself has lived since the initial core migration (default 0, never written
-- until C3); this index makes the (tenant_id, status, column_position) read
-- cheap as the backlog grows. Legacy rows with `column_position = 0` tie and
-- the secondary `updated_at` ordering preserves today's recency behaviour for
-- non-plan-committed backlogs.

create index if not exists tickets_tenant_status_position_idx
  on public.tickets (tenant_id, status, column_position, updated_at desc);

comment on index public.tickets_tenant_status_position_idx is
  'Supports board reads ordered by (column_position, updated_at desc) — used by loadBoardTickets to honor the topological-DAG ordering written by commitPlanAction.';
