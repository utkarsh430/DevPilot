import { describe, expect, it } from "vitest";
import {
  GUIDE,
  GUIDE_BY_SLUG,
  GUIDE_CHAPTER_BY_SLUG,
  GUIDE_SECTIONS,
  guidePager,
  guideSectionFigureRefs,
  guideSubsections,
  lowerGuideSection,
} from "@/lib/guide/manifest";
import { docRunsToPlainText } from "@/lib/guide/blocks";

describe("slugs", () => {
  it("are unique", () => {
    const slugs = GUIDE_SECTIONS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("are URL-safe — a slug is a path segment and a PDF bookmark key", () => {
    for (const s of GUIDE_SECTIONS) expect(s.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("index every section exactly once", () => {
    expect(GUIDE_BY_SLUG.size).toBe(GUIDE_SECTIONS.length);
    for (const s of GUIDE_SECTIONS) expect(GUIDE_BY_SLUG.get(s.slug)).toBe(s);
  });

  it("resolve to their chapter", () => {
    for (const chapter of GUIDE) {
      for (const s of chapter.sections) expect(GUIDE_CHAPTER_BY_SLUG.get(s.slug)).toBe(chapter);
    }
  });
});

describe("section metadata", () => {
  it("carries a non-empty title and summary", () => {
    for (const s of GUIDE_SECTIONS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.summary.trim().length).toBeGreaterThan(0);
      // The summary is a TOC subtitle and a <meta description>; echoing the
      // title tells a reader choosing between sections nothing at all.
      expect(s.summary.trim()).not.toBe(s.title.trim());
    }
  });

  it("has a non-empty body", () => {
    for (const s of GUIDE_SECTIONS) expect(s.body.trim().length).toBeGreaterThan(0);
  });
});

describe("guidePager", () => {
  it("is a total ordering covering every section exactly once", () => {
    const seen: string[] = [];
    let cursor = GUIDE_SECTIONS[0] ?? null;
    while (cursor) {
      expect(seen).not.toContain(cursor.slug); // no cycle
      seen.push(cursor.slug);
      cursor = guidePager(cursor.slug).next;
    }
    expect(seen).toEqual(GUIDE_SECTIONS.map((s) => s.slug));
  });

  it("has open ends — no wrap-around", () => {
    const first = GUIDE_SECTIONS[0];
    const last = GUIDE_SECTIONS[GUIDE_SECTIONS.length - 1];
    expect(first && guidePager(first.slug).prev).toBeNull();
    expect(last && guidePager(last.slug).next).toBeNull();
  });

  it("pages ACROSS chapters, not within one", () => {
    // Chapter-local paging dead-ends a reader with no forward control, which on
    // a linear manual reads as the guide having ended.
    const firstChapter = GUIDE[0];
    const lastOfFirst = firstChapter?.sections[firstChapter.sections.length - 1];
    if (lastOfFirst && GUIDE.length > 1) {
      expect(guidePager(lastOfFirst.slug).next?.slug).toBe(GUIDE[1]?.sections[0]?.slug);
    }
  });

  it("returns empty ends for an unknown slug rather than throwing", () => {
    expect(guidePager("no-such-section")).toEqual({ prev: null, next: null });
  });
});

describe("guideSubsections", () => {
  it("matches the depth-2 headings actually written in the body", () => {
    for (const section of GUIDE_SECTIONS) {
      const fromBody = lowerGuideSection(section)
        .filter((b) => b.type === "heading")
        .filter((b) => b.depth === 2)
        .map((b) => ({ anchor: b.anchor, title: docRunsToPlainText(b.runs) }));
      expect(guideSubsections(section)).toEqual(fromBody);
    }
  });

  it("yields unique anchors per section — five consumers read these strings", () => {
    for (const section of GUIDE_SECTIONS) {
      const anchors = guideSubsections(section).map((s) => s.anchor);
      expect(new Set(anchors).size).toBe(anchors.length);
      for (const a of anchors) expect(a).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("is non-vacuous — at least one section really has subsections", () => {
    expect(GUIDE_SECTIONS.some((s) => guideSubsections(s).length > 0)).toBe(true);
  });
});

describe("figures", () => {
  it("every `figure:` reference is declared by its section", () => {
    for (const section of GUIDE_SECTIONS) {
      for (const id of guideSectionFigureRefs(section)) {
        expect(section.figures).toContain(id);
      }
    }
  });

  it("every declared figure is referenced — an orphan is bytes no reader sees", () => {
    for (const section of GUIDE_SECTIONS) {
      const refs = new Set(guideSectionFigureRefs(section));
      for (const id of section.figures) expect(refs.has(id)).toBe(true);
    }
  });

  it("figure ids are unique across the whole guide", () => {
    const ids = GUIDE_SECTIONS.flatMap((s) => [...s.figures]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("internal links", () => {
  // The check that keeps a 14-page manual honest as it grows. A `/guide/*` link
  // to a renamed or not-yet-written slug is a 404 in the app and a dead
  // cross-reference in the PDF, and neither surface errors — the page just loads.
  const INTERNAL = /\]\((\/guide\/[^)\s]*)\)/g;

  it("every internal /guide/ link resolves to a real slug", () => {
    const bad: string[] = [];
    for (const section of GUIDE_SECTIONS) {
      for (const [, href = ""] of section.body.matchAll(INTERNAL)) {
        const slug = href.replace(/^\/guide\//, "").split("#")[0] ?? "";
        if (slug !== "" && !GUIDE_BY_SLUG.has(slug)) bad.push(`${section.slug} → ${href}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("is non-vacuous — the corpus really does contain internal links", () => {
    const total = GUIDE_SECTIONS.reduce((n, s) => n + [...s.body.matchAll(INTERNAL)].length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("an internal link with a fragment points at a heading that exists", () => {
    for (const section of GUIDE_SECTIONS) {
      for (const [, href = ""] of section.body.matchAll(INTERNAL)) {
        const [slug = "", fragment] = href.replace(/^\/guide\//, "").split("#");
        if (!fragment) continue;
        const target = GUIDE_BY_SLUG.get(slug);
        expect(target, `${section.slug} → ${href}`).toBeDefined();
        if (!target) continue;
        const anchors = lowerGuideSection(target)
          .filter((b) => b.type === "heading")
          .map((b) => b.anchor);
        expect(anchors, `${section.slug} → ${href}`).toContain(fragment);
      }
    }
  });
});

describe("every body lowers", () => {
  it("without throwing, and produces blocks", () => {
    // The lowering refuses constructs it cannot represent faithfully. Running it
    // over the real corpus here is what turns an authoring mistake into a red
    // test rather than a runtime failure on a page nobody opened yet.
    for (const section of GUIDE_SECTIONS) {
      expect(lowerGuideSection(section).length).toBeGreaterThan(0);
    }
  });
});
