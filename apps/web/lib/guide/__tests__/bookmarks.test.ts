// The manual's outline ref namespace must stay disjoint from the audit
// export's, and internally collision-free.
//
// A colliding ref does not throw and does not change a single drawn page — it
// silently re-parents an outline entry, which is only visible in a reader's
// bookmark panel. That is precisely how the audit export shipped with every
// ticket nested under "Configuration & stack", with every title spelled
// correctly. So the invariant needs a test; nothing else can see it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GUIDE_BOOKMARK_REF,
  GUIDE_MAX_SUBSECTION_BOOKMARKS,
  guideSectionBookmarkRef,
  guideSubsectionBookmarkRef,
} from "@/lib/guide/bookmarks";
import { BOOKMARK_REF, ticketBookmarkRef } from "@/lib/export/bookmarks";
import { GUIDE_SECTIONS, guideSubsections } from "@/lib/guide/manifest";

/** Every ref the manual would emit for the CURRENT manifest. */
function manualRefs(): number[] {
  const refs = Object.values(GUIDE_BOOKMARK_REF) as number[];
  GUIDE_SECTIONS.forEach((section, i) => {
    refs.push(guideSectionBookmarkRef(i));
    guideSubsections(section)
      .slice(0, GUIDE_MAX_SUBSECTION_BOOKMARKS)
      .forEach((_, j) => refs.push(guideSubsectionBookmarkRef(i, j)));
  });
  return refs;
}

describe("the manual's refs are internally unique", () => {
  it("no two entries share a ref for the real manifest", () => {
    const refs = manualRefs();
    expect(refs.length).toBeGreaterThan(2); // non-vacuity: sections were walked
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("a section's subsections stay inside that section's range", () => {
    // The property the stride buys: adding a subsection to section 0 must never
    // reach into section 1's range. Checked across a generous synthetic span
    // rather than only the two sections the manifest has today.
    for (let i = 0; i < 20; i += 1) {
      const start = guideSectionBookmarkRef(i);
      const next = guideSectionBookmarkRef(i + 1);
      for (let j = 0; j < GUIDE_MAX_SUBSECTION_BOOKMARKS; j += 1) {
        const ref = guideSubsectionBookmarkRef(i, j);
        expect(ref).toBeGreaterThan(start);
        expect(ref).toBeLessThan(next);
      }
    }
  });

  it("refuses a subsection index that would spill into the next section", () => {
    // Throws rather than wrapping. A wrap produces a perfectly valid PDF whose
    // outline nests one chapter's headings under the following chapter, with
    // nothing in the pages to show it — the exact silent failure this module
    // exists to prevent.
    expect(() => guideSubsectionBookmarkRef(0, GUIDE_MAX_SUBSECTION_BOOKMARKS)).toThrow(RangeError);
    expect(() => guideSectionBookmarkRef(-1)).toThrow(RangeError);
    expect(() => guideSubsectionBookmarkRef(0, 1.5)).toThrow(RangeError);
  });
});

describe("the two namespaces never overlap", () => {
  /**
   * How many ticket refs the audit export is assumed never to exceed.
   *
   * `MAX_FULL_TICKETS` is 30 (`project-audit.server.ts` — a `.server.ts`, so it
   * cannot be imported here), and this bound is ~16x that. It is stated as a
   * number rather than left implicit because it IS the separation guarantee:
   * `ticketBookmarkRef(n)` is `1000 + n`, so the two namespaces meet at n=1000
   * exactly. That is comfortable today and is not a law of nature — raising the
   * project export's detail cap into the thousands would collide, silently, and
   * this test is what turns that into a red build instead.
   */
  const ASSUMED_MAX_TICKET_REFS = 500;

  it("no manual ref collides with an audit-export ref", () => {
    const audit = new Set<number>([
      ...(Object.values(BOOKMARK_REF) as number[]),
      ...Array.from({ length: ASSUMED_MAX_TICKET_REFS }, (_, i) => ticketBookmarkRef(i)),
    ]);
    for (const ref of manualRefs()) {
      expect(audit.has(ref), `manual ref ${ref} collides with an audit-export ref`).toBe(false);
    }
  });

  it("the manual's whole reserved range sits above the audit export's", () => {
    // Stronger than the collision check above, and the reason it is here: that
    // check only covers the refs each side emits TODAY. This pins the structural
    // separation, so a future audit-export section added at, say, ref 8 cannot
    // silently drift into the manual's space.
    const auditMax = Math.max(
      ...(Object.values(BOOKMARK_REF) as number[]),
      ticketBookmarkRef(ASSUMED_MAX_TICKET_REFS),
    );
    const manualMin = Math.min(...manualRefs());
    expect(manualMin).toBeGreaterThan(auditMax);
  });

  it("neither module hardcodes the other's base — they are separate files", () => {
    // The regression this guards is the tidying instinct: "these are both
    // bookmark refs, merge them". Merging is what makes a guide edit able to
    // re-parent an audit entry.
    const root = join(__dirname, "..", "..", "..");
    const auditSrc = readFileSync(join(root, "lib", "export", "bookmarks.ts"), "utf8");
    expect(auditSrc).not.toMatch(/guide/i);
  });
});
