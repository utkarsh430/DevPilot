// The outline's ref namespace.
//
// Every `PdfBookmark` carries a `ref`, and a `parent` names its parent's ref.
// See the `PdfBookmark` doc comment for why these are stated explicitly rather
// than left to react-pdf's auto-assignment: the auto ids come from a
// breadth-first walk and shift when a conditional page appears, which is how
// every ticket ended up nested under "Configuration & stack" on any project
// under the detail cap.
//
// These are opaque ids, NOT positions — that is the whole point. react-pdf uses
// them only as registry keys, so the numbers need to be unique and stable and
// nothing more. They live in one place so a new bookmark cannot reuse one; a
// collision would silently re-parent an entry, which is invisible in the
// rendered pages.

/** Fixed entries. The values are arbitrary — only their uniqueness matters. */
export const BOOKMARK_REF = {
  cover: 1,
  contents: 2,
  config: 3,
  rollups: 4,
  summary: 5,
  tickets: 6,
  /** The standalone ticket document's single record page. */
  ticketRecord: 7,
} as const;

/**
 * Per-ticket refs, in their own range above the fixed entries.
 *
 * A ticket section nests UNDER `BOOKMARK_REF.tickets`, and needs a ref of its
 * own to be addressable. The base is far enough above the fixed ids that adding
 * a section later cannot collide with a ticket.
 */
const TICKET_REF_BASE = 1000;

export function ticketBookmarkRef(index: number): number {
  return TICKET_REF_BASE + index;
}
