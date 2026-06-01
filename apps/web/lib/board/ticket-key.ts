// The human-friendly ticket key — `DevPilot-<N>`.
//
// `tickets.ticket_number` is assigned once at insert by the DB trigger
// `assign_ticket_number` (migration 20260713000000): creation-order, unique
// within the project, and never rewritten when the ticket moves column. It is
// the ticket's IDENTITY, and it is deliberately NOT `column_position` — that
// is an intra-column sort key which repeats across columns and changes on every
// drag-reorder.
//
// A ticket with `project_id IS NULL` belongs to no project, so no per-project
// counter can number it; those rows keep `ticket_number = null` and fall back
// to the short hex id (never a blank).

/** Prefix of the key. Matches the `DevPilot-142` form already referenced in the
 *  role prompts (`lib/roles/business_analyst.ts`). */
const TICKET_KEY_PREFIX = "DevPilot";

/** Short hex id — a stable, non-colliding fallback for unnumbered tickets. */
export function shortTicketId(id: string): string {
  return id.slice(0, 6);
}

/**
 * Display key for a ticket: `DevPilot-<N>` when the ticket carries a number,
 * else the short hex id.
 */
export function formatTicketKey(ticketNumber: number | null | undefined, id: string): string {
  return typeof ticketNumber === "number"
    ? `${TICKET_KEY_PREFIX}-${ticketNumber}`
    : shortTicketId(id);
}
