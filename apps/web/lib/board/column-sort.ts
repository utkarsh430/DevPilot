// Per-column card ordering for the board. Pure so it can be unit-tested
// without rendering BoardClient.tsx (a "use client" component); BoardClient
// calls this from the `ticketsByColumn` sort and nowhere else.

import { TERMINAL_STATUSES, type TicketStatus } from "@/lib/board/state";

/** The subset of BoardTicket this comparator needs. */
export type SortableTicket = {
  columnPosition: number | null;
  ticketNumber: number | null;
  updatedAt: string;
};

/**
 * Comparator for `Array.prototype.sort` within one board column.
 *
 * Active columns (everything but Done/Failed) keep the existing C3 order:
 * `column_position` ASC — the plan-driven, dependency-aware DAG order written
 * by `computePlacementAfterBlockers` (lib/board/topo.ts) — with `updated_at`
 * DESC as the tiebreak. Legacy/operator-created tickets without a
 * `column_position` fall to MAX_SAFE_INTEGER so they sink below DAG-ordered
 * rows, matching the server-side query in lib/board/queries.ts.
 *
 * Terminal columns (Done, Failed) ignore `column_position` — the
 * dependencies it encodes are already spent once a ticket is finished — and
 * instead sort by `ticket_number` DESC, newest ticket first. The number is
 * what's printed on every card (`DevPilot-<N>`), so the resulting order is
 * always self-explanatory. A ticket with no number (`project_id IS NULL`,
 * the one case `ticket_number` can be null) sinks to the bottom. Ties are
 * only possible in "All projects" view — `ticket_number` is unique per
 * PROJECT, not globally, so two different projects can each have a
 * `DevPilot-1` — and break on `updated_at` DESC, same tiebreak as the active
 * columns.
 */
export function compareTicketsForColumn<T extends SortableTicket>(
  status: TicketStatus,
  a: T,
  b: T,
): number {
  if (TERMINAL_STATUSES.has(status)) {
    const na = a.ticketNumber ?? Number.NEGATIVE_INFINITY;
    const nb = b.ticketNumber ?? Number.NEGATIVE_INFINITY;
    if (na !== nb) return nb - na;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  }
  const pa = a.columnPosition ?? Number.MAX_SAFE_INTEGER;
  const pb = b.columnPosition ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}
