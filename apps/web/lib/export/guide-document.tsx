// The DevPilot manual — the whole user guide as one downloadable PDF.
//
// Structure: cover → contents → one bookmarked run per SECTION, with the
// section's derived depth-2 headings as sub-bookmarks under it.
//
// ── This is not the audit export, and the differences are deliberate ────────
//
// The audit documents are per-tenant records of live data. This is STATIC: it is
// byte-identical for every reader, carries no tenant data, and changes only when
// the repo does. That is why its route can cache as hard as it does, and why it
// has no trust notice — there is no agent-authored content in it. Everything
// visual is nonetheless reused wholesale (`Chrome`, `primitives`, `theme`,
// `fonts`), because a manual that did not look like the exports would be a
// second brand nobody chose.
//
// ── One page per section, on purpose ───────────────────────────────────────
//
// Sections start on a fresh page rather than flowing continuously. A manual is
// read by jumping to a chapter, and a chapter that begins two-thirds down the
// page after the previous one makes the outline's landing point feel wrong. It
// also bounds how deep any single page-splitting run gets, which matters here
// more than anywhere else in the repo — see below.
//
// ── THE LONG-DOCUMENT CONSTRAINT ────────────────────────────────────────────
//
// This is the longest PDF this codebase produces, and long is exactly where
// react-pdf's fixed-element bug bites. `@react-pdf/layout`'s `splitPage` builds
// each continuation page with its `height` OMITTED, so a `bottom`-anchored
// `fixed` element resolves its top against an absent height and diverges to
// ~-2.996e21 on deep pages; the vendored pdfkit clamp coerces that to 0, which
// puts the footer at the TOP of the page over the header AND corrupts that
// page's coordinate frame, collapsing anything that splits there.
//
// `Chrome.Footer` is already top-anchored off `A4_HEIGHT_PT` and must stay that
// way. Do not add `bottom`-anchored fixed chrome to this document — a manual is
// where the divergence has the most pages to accumulate over, and
// `__tests__/guide-render.test.ts` asserts the clamp never logs for exactly that
// reason.

import React from "react";
import { Document, Text, View } from "@react-pdf/renderer";
import { BookmarkPage, BookmarkView, styles } from "@/lib/export/components/primitives";
import { Cover, Footer, RunningHeader } from "@/lib/export/components/Chrome";
import { COLORS } from "@/lib/export/theme";
import { GuideBlocks, type GuideFigureLookup } from "@/lib/export/guide-pdf-blocks";
import { GUIDE, GUIDE_SECTIONS, guideSubsections, lowerGuideSection } from "@/lib/guide/manifest";
import type { GuideSection } from "@/lib/guide/manifest";
import {
  GUIDE_BOOKMARK_REF,
  GUIDE_MAX_SUBSECTION_BOOKMARKS,
  guideSectionBookmarkRef,
  guideSubsectionBookmarkRef,
} from "@/lib/guide/bookmarks";

const DOC_TITLE = "The DevPilot manual";
const FOOTER_LABEL = "DevPilot manual · devpilot.dev/guide";

/** Flattened index of a section — the position its outline refs are derived from. */
function sectionIndex(section: GuideSection): number {
  return GUIDE_SECTIONS.findIndex((s) => s.slug === section.slug);
}

function Contents() {
  return (
    <View>
      {GUIDE.map((chapter) => (
        <View key={chapter.label} style={{ marginBottom: 12 }}>
          <Text style={{ ...styles.eyebrow, marginBottom: 4 }}>{chapter.label}</Text>
          {chapter.sections.map((section) => (
            <View key={section.slug} style={{ marginBottom: 6 }}>
              <Text style={{ ...styles.body, fontWeight: 600 }}>{section.title}</Text>
              <Text style={{ ...styles.muted, marginTop: 1 }}>{section.summary}</Text>
            </View>
          ))}
        </View>
      ))}
      {/* No page numbers. react-pdf resolves those only inside a per-page
          `render` callback, which cannot reach back into a contents page laid
          out earlier — a two-pass render would be the only honest way to print
          them, and a wrong page number in a manual is worse than none. The PDF
          outline is the navigation that actually works here, and it is real. */}
      <Text style={{ ...styles.muted, fontSize: 7, marginTop: 6, color: COLORS.mutedForeground }}>
        Use your reader&rsquo;s bookmark panel to jump to any section or heading.
      </Text>
    </View>
  );
}

function SectionPage({
  section,
  figures,
  chapterLabel,
}: {
  section: GuideSection;
  figures: GuideFigureLookup;
  chapterLabel: string;
}) {
  const index = sectionIndex(section);
  const sectionRef = guideSectionBookmarkRef(index);
  const blocks = lowerGuideSection(section);

  // Sub-bookmark refs are assigned from the section's DERIVED depth-2 headings,
  // in document order, and the renderer looks them up by anchor. Deriving the
  // map here rather than counting headings inside the renderer is what keeps the
  // ref namespace in one place: the renderer never computes a ref, it only asks.
  const subs = guideSubsections(section).slice(0, GUIDE_MAX_SUBSECTION_BOOKMARKS);
  const refByAnchor = new Map(
    subs.map((sub, i) => [
      sub.anchor,
      { title: sub.title, ref: guideSubsectionBookmarkRef(index, i) },
    ]),
  );

  return (
    <BookmarkPage
      size="A4"
      style={styles.page}
      bookmark={{ title: section.title, ref: sectionRef }}
    >
      <RunningHeader title={`${DOC_TITLE} · ${section.title}`} />
      <Footer label={FOOTER_LABEL} />

      <BookmarkView style={{ marginBottom: 12 }}>
        <Text style={styles.eyebrow}>{chapterLabel}</Text>
        <Text style={{ ...styles.h1, marginTop: 4 }}>{section.title}</Text>
        <View
          style={{
            height: 3,
            width: 34,
            backgroundColor: COLORS.primary,
            borderRadius: 1.5,
            marginTop: 8,
          }}
        />
        <Text style={{ ...styles.muted, marginTop: 8, lineHeight: 1.5 }}>{section.summary}</Text>
      </BookmarkView>

      <GuideBlocks
        blocks={blocks}
        figures={figures}
        headingBookmark={(anchor) => {
          const hit = refByAnchor.get(anchor);
          // A depth-2 heading beyond the per-section cap gets no bookmark rather
          // than a ref that would land in the NEXT section's range and silently
          // re-parent its entries. Undefined is a legal `bookmark`.
          return hit ? { title: hit.title, ref: hit.ref, parent: sectionRef } : undefined;
        }}
      />
    </BookmarkPage>
  );
}

export function GuideDocument({
  figures,
  generatedAt,
  version,
}: {
  figures: GuideFigureLookup;
  /** ISO instant. Printed on the cover so a printed copy dates itself. */
  generatedAt: string;
  /** Short content hash — the same value the route's ETag is built from. */
  version: string;
}) {
  return (
    <Document
      title={DOC_TITLE}
      author="DevPilot"
      subject="DevPilot user guide"
      creator="DevPilot"
      producer="DevPilot"
    >
      <BookmarkPage
        size="A4"
        style={styles.page}
        bookmark={{ title: "Cover", ref: GUIDE_BOOKMARK_REF.cover }}
      >
        <Footer label={FOOTER_LABEL} />
        <Cover
          eyebrow="User guide"
          title={DOC_TITLE}
          subtitle="Building and running teams of agents on the board."
          meta={[
            { label: "Chapters", value: String(GUIDE.length) },
            { label: "Sections", value: String(GUIDE_SECTIONS.length) },
            { label: "Generated", value: generatedAt.slice(0, 10) },
            { label: "Content version", value: version },
          ]}
          notice={
            "This manual is generated from the same source as the in-app guide at /guide — one set " +
            "of words, two renderers, so the two cannot disagree. The online version is always " +
            "current; a downloaded copy is a snapshot of the content version named above."
          }
        />
      </BookmarkPage>

      <BookmarkPage
        size="A4"
        style={styles.page}
        bookmark={{ title: "Contents", ref: GUIDE_BOOKMARK_REF.contents }}
      >
        <RunningHeader title={DOC_TITLE} />
        <Footer label={FOOTER_LABEL} />
        <Text style={{ ...styles.h1, marginBottom: 4 }}>Contents</Text>
        <View
          style={{
            height: 3,
            width: 34,
            backgroundColor: COLORS.primary,
            borderRadius: 1.5,
            marginBottom: 14,
          }}
        />
        <Contents />
      </BookmarkPage>

      {GUIDE.flatMap((chapter) =>
        chapter.sections.map((section) => (
          <SectionPage
            key={section.slug}
            section={section}
            figures={figures}
            chapterLabel={chapter.label}
          />
        )),
      )}
    </Document>
  );
}
