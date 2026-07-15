// Build-order sorting for the project export — PURE, so it is Vitest-testable.
//
// The project document reads front-to-back: the FIRST ticket a board produced,
// then forward in the order the work actually happened. That order is
// `tickets.ticket_number` ASCENDING — the per-project counter assigned once at
// insert by the `assign_ticket_number` trigger and never rewritten, i.e. the
// stable "issue number" of the board (see the ticket-identity note in AGENTS.md).
//
// This deliberately does NOT reuse `selectFullTicketIds`' `updatedAt DESC` order:
// that order also decides WHICH tickets get full detail under the cap, and is
// correct for that. The rendered order is a separate concern, applied to the
// already-selected set just before it is returned.

/** The fields build-order needs off a ticket. `createdAt` is the tiebreak. */
export type BuildOrdered = {
  ticketNumber: number | null;
  createdAt?: string;
};

/**
 * Compare two tickets by build order: `ticket_number` ASCENDING, then
 * `created_at` ASCENDING as a tiebreak.
 *
 * A null `ticket_number` (a ticket with no project counter — not expected on a
 * project board, but possible) sorts AFTER every numbered ticket rather than
 * colliding at 0, so the numbered tickets still read in order. When neither side
 * has a usable number or date the result is 0, which `Array.prototype.sort`
 * treats as "keep relative order" — a stable no-op, never a reshuffle.
 */
export function compareByBuildOrder(a: BuildOrdered, b: BuildOrdered): number {
  const an = a.ticketNumber;
  const bn = b.ticketNumber;
  if (an !== null && bn !== null) {
    if (an !== bn) return an - bn;
  } else if (an !== null) {
    return -1; // a numbered, b not → a first
  } else if (bn !== null) {
    return 1; // b numbered, a not → b first
  }
  const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
  if (Number.isNaN(at) || Number.isNaN(bt)) return 0;
  return at - bt;
}

/** Return a NEW array sorted into build order; the input is left untouched. */
export function sortByBuildOrder<T extends BuildOrdered>(items: readonly T[]): T[] {
  return [...items].sort(compareByBuildOrder);
}
