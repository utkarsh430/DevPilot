// Render tests for the guide's page chrome, plus the two nav-config facts the
// guide's routes depend on.
//
// The nav assertions look trivial and are not: `GLOBAL_NAV` and
// `BREADCRUMB_LABELS` are hand-maintained lists in a file the guide does not
// own, and an entry silently missing from either produces a page that is live
// and unreachable, or a crumb that reads as a raw path segment. Neither errors.

import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DownloadManualButton,
  GuideBreadcrumbs,
  GuidePagerNav,
  GuideSectionCard,
} from "@/components/guide/chrome";
import { BREADCRUMB_LABELS, GLOBAL_NAV } from "@/components/shell/nav-config";
import { GUIDE, GUIDE_SECTIONS, guidePager } from "@/lib/guide/manifest";

describe("navigation wiring", () => {
  it("has a /guide entry in the global nav", () => {
    const entry = GLOBAL_NAV.find((i) => i.href === "/guide");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Guide");
  });

  it("has a breadcrumb label for /guide", () => {
    expect(BREADCRUMB_LABELS["/guide"]).toBe("Guide");
  });
});

describe("breadcrumbs", () => {
  const html = renderToStaticMarkup(
    React.createElement(GuideBreadcrumbs, {
      chapterLabel: "Set up",
      sectionTitle: "Connect a runner",
    }),
  );

  it("links the guide root", () => {
    expect(html).toContain('href="/guide"');
  });

  it("renders the CHAPTER as plain text, never a link", () => {
    // Chapters have no URL — `GuideChapter` carries a label and a section list
    // and nothing addressable — so a chapter link would 404.
    expect(html).toContain("Set up");
    expect(html).not.toContain('href="/guide/set-up"');
    expect(html.match(/<a /g) ?? []).toHaveLength(1);
  });

  it("marks the section as the current page", () => {
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Connect a runner");
  });
});

describe("the pager", () => {
  it("spans chapters rather than dead-ending at a chapter boundary", () => {
    // Derive the boundary rather than assuming it falls between sections 0 and
    // 1 — that held only while chapter 1 had exactly one section, and it is an
    // artifact of the corpus, not the property being asserted. The claim is
    // that the LAST section of a chapter pages forward into the NEXT chapter's
    // first, which is what would dead-end a reader if paging were
    // chapter-local.
    const firstChapter = GUIDE[0];
    const secondChapter = GUIDE[1];
    if (!firstChapter || !secondChapter) return;
    const lastOfFirst = firstChapter.sections[firstChapter.sections.length - 1];
    const firstOfSecond = secondChapter.sections[0];
    if (!lastOfFirst || !firstOfSecond) return;
    // Non-vacuity: the two really are in different chapters.
    expect(GUIDE.find((c) => c.sections.includes(lastOfFirst))).not.toBe(
      GUIDE.find((c) => c.sections.includes(firstOfSecond)),
    );
    expect(guidePager(lastOfFirst.slug).next?.slug).toBe(firstOfSecond.slug);
  });

  it("links both neighbours when they exist", () => {
    const middleish = GUIDE_SECTIONS[1];
    if (!middleish) return;
    const html = renderToStaticMarkup(
      React.createElement(GuidePagerNav, { pager: guidePager(middleish.slug) }),
    );
    expect(html).toContain(`href="/guide/${GUIDE_SECTIONS[0]?.slug}"`);
    expect(html).toContain("Previous");
  });

  it("renders nothing at all when there is no neighbour in either direction", () => {
    const html = renderToStaticMarkup(
      React.createElement(GuidePagerNav, { pager: { prev: null, next: null } }),
    );
    expect(html).toBe("");
  });
});

describe("the index card", () => {
  it("links the section and shows its one-line summary", () => {
    const section = GUIDE_SECTIONS[0];
    if (!section) throw new Error("the guide has no sections");
    const html = renderToStaticMarkup(React.createElement(GuideSectionCard, { section }));
    expect(html).toContain(`href="/guide/${section.slug}"`);
    expect(html).toContain(section.title);
    expect(html).toContain(section.summary);
  });
});

describe("the download control", () => {
  it("is disabled when no handler is wired, rather than looking live", () => {
    // The route and hook belong to the manual crew; a control that appears
    // clickable and does nothing is worse than one that plainly cannot be used.
    const html = renderToStaticMarkup(React.createElement(DownloadManualButton, {}));
    expect(html).toContain("disabled");
  });

  it("reports a failure as a failure", () => {
    const html = renderToStaticMarkup(
      React.createElement(DownloadManualButton, {
        onDownload: () => {},
        error: "The manual could not be built (HTTP 500).",
      }),
    );
    expect(html).toContain("The manual could not be built (HTTP 500).");
  });

  it("says what it is doing while it works", () => {
    const html = renderToStaticMarkup(
      React.createElement(DownloadManualButton, { onDownload: () => {}, busy: true }),
    );
    expect(html).toContain("Building the manual…");
  });
});
