// The MANUAL's outline ref namespace — deliberately separate from the audit
// export's (`lib/export/bookmarks.ts`).
//
// ── Why a second namespace rather than more entries in the first ─────────────
//
// A `PdfBookmark.ref` is an opaque registry key, so two documents that never
// appear in the same PDF could in principle share a numbering scheme. They must
// not, for one reason: `resolveBookmarks` (@react-pdf/layout) does
//
//     const ref = refs++;
//     const newHierarchy = { ref, parent: parent?.ref, ...bookmark };
//
// i.e. it AUTO-ASSIGNS from a breadth-first walk and our explicit values only
// win because the spread puts them last. Any ref that is not explicitly set, or
// that collides with another entry's, silently re-parents an outline entry — the
// exact bug that put every ticket under "Configuration & stack" and spelled
// every title correctly while doing it. The rendered pages are identical; only a
// viewer's sidebar shows it.
//
// So sharing a namespace means a guide edit could re-parent an audit entry, and
// vice versa, with no compile error and no visible difference in the pages. Two
// namespaces with disjoint ranges make that unrepresentable. The audit export
// occupies 1–7 and 1000+ (`TICKET_REF_BASE`); the manual starts at 2000 and
// never overlaps — asserted by a test that reads BOTH modules, so the two cannot
// drift into overlapping ranges later.
//
// ── The one place that separation is not infinite ───────────────────────────
//
// `ticketBookmarkRef(n)` is `1000 + n`, so the two namespaces MEET at n = 1000.
// The project export caps detail at `MAX_FULL_TICKETS` (30), so today there are
// ~970 refs of headroom — ample, and not a law of nature. If that cap is ever
// raised into the thousands, move `GUIDE_SECTION_REF_BASE` and the fixed entries
// above it rather than assuming the gap holds;
// `lib/guide/__tests__/bookmarks.test.ts` pins the assumption so the change is a
// red build rather than a silently re-parented outline.

/** Fixed entries. Values are arbitrary; only uniqueness and the range matter. */
export const GUIDE_BOOKMARK_REF = {
  cover: 2000,
  contents: 2001,
} as const;

/**
 * The base of the per-section range, and the stride between sections.
 *
 * Each section owns `[BASE + i*STRIDE, BASE + i*STRIDE + STRIDE)`: the section
 * itself takes the first slot and its derived subsections take the rest. A
 * stride rather than a flat counter means adding a subsection to chapter 1
 * cannot shift chapter 9's refs — refs are stable per position, so a content
 * edit in one place never silently renumbers another.
 */
const GUIDE_SECTION_REF_BASE = 2100;
const GUIDE_SECTION_REF_STRIDE = 100;

/** Max subsections one section may contribute to the outline. */
export const GUIDE_MAX_SUBSECTION_BOOKMARKS = GUIDE_SECTION_REF_STRIDE - 1;

/** The outline ref for the `index`-th section of the flattened manifest. */
export function guideSectionBookmarkRef(index: number): number {
  assertIndex(index, "section");
  return GUIDE_SECTION_REF_BASE + index * GUIDE_SECTION_REF_STRIDE;
}

/**
 * The outline ref for a section's `subIndex`-th derived subsection.
 *
 * Throws rather than wrapping into the next section's range. A silent wrap is
 * precisely the failure this module exists to prevent: it would produce a valid
 * PDF whose outline nests one chapter's headings under the following chapter,
 * and nothing in the pages would show it. A manual with 100 depth-2 headings in
 * a single section is a content problem to be told about, not to be absorbed.
 */
export function guideSubsectionBookmarkRef(sectionIndex: number, subIndex: number): number {
  assertIndex(sectionIndex, "section");
  assertIndex(subIndex, "subsection");
  if (subIndex >= GUIDE_MAX_SUBSECTION_BOOKMARKS) {
    throw new RangeError(
      `guide section ${sectionIndex} has more than ${GUIDE_MAX_SUBSECTION_BOOKMARKS} subsections; ` +
        `a ref beyond the section's range would re-parent the next section's outline entries`,
    );
  }
  return guideSectionBookmarkRef(sectionIndex) + 1 + subIndex;
}

function assertIndex(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`guide ${what} bookmark index must be a non-negative integer, got ${n}`);
  }
}
