// Render the REAL manifest into a real PDF, and assert the things that are
// invisible from an element tree.
//
// Every failure mode this feature has lives inside the PDF runtime — an
// unregistered font throws, a bad style value throws, fontkit rejects a format,
// an outline nests wrongly — and none of them shows up in a component snapshot.
// So this drives the actual manual, from the actual `GUIDE`, the same way
// `render.test.ts` drives the actual ticket document.
//
// It cannot import `render.server.ts` (that pulls `server-only`, which refuses
// to load outside a Next server), so it wires the same two pieces the server
// wrapper does: `registerExportFonts` + a render on the same document. Figures
// are injected as an empty map, which is both the state the repo is in today and
// the degraded path that must never throw.

import { createRequire } from "node:module";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Document, Font, Page, renderToBuffer } from "@react-pdf/renderer";
import { registerExportFonts, resetExportFontsForTest } from "@/lib/export/fonts";
import { styles } from "@/lib/export/components/primitives";
import { Footer, RunningHeader } from "@/lib/export/components/Chrome";
import { GuideDocument } from "@/lib/export/guide-document";
import { GuideBlocks } from "@/lib/export/guide-pdf-blocks";
import { GUIDE_SECTIONS, guideSubsections } from "@/lib/guide/manifest";
import type { DocBlock } from "@/lib/guide/blocks";

const require = createRequire(import.meta.url);

function withFonts(): void {
  resetExportFontsForTest();
  registerExportFonts(
    Font as unknown as Parameters<typeof registerExportFonts>[0],
    (s) => require.resolve(s),
    { force: true },
  );
}

function renderManual(): Promise<Buffer> {
  withFonts();
  return renderToBuffer(
    React.createElement(GuideDocument, {
      figures: new Map(),
      generatedAt: "2026-07-20T00:00:00.000Z",
      version: "0123456789ab",
    }) as never,
  );
}

/** Every outline entry, as `{ obj, title, parent }`, parsed out of the PDF. */
type OutlineEntry = { obj: string; title: string; parent: string };

function parseOutline(pdf: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  for (const m of pdf.matchAll(/(\d+) 0 obj\s*(<<[\s\S]*?>>)\s*endobj/g)) {
    const [, obj = "", body = ""] = m;
    // `/Title 52 0 R` is the document INFO dictionary's title (an indirect
    // string), not an outline entry. Outline titles are literal `(…)` strings.
    const title = /\/Title \(([^)]*)\)/.exec(body);
    const parent = /\/Parent (\d+) 0 R/.exec(body);
    if (title && parent) out.push({ obj, title: title[1] ?? "", parent: parent[1] ?? "" });
  }
  return out;
}

describe("the manual renders", () => {
  it("is a real, non-trivial PDF", async () => {
    const buf = await renderManual();
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.byteLength).toBeGreaterThan(10_000);
  }, 60_000);

  it("embeds the brand fonts rather than falling back to a base-14 face", async () => {
    // A `/FontFile` stream is the proof of an EMBEDDED font. Without
    // registration react-pdf silently draws Helvetica — a base-14 face needing
    // no embedding — so its absence means the brand type never made it in, and
    // nothing about the byte length would show that.
    const pdf = (await renderManual()).toString("latin1");
    expect(/\/FontFile[23]?/.test(pdf)).toBe(true);
  }, 60_000);
});

describe("the outline NESTS correctly — asserted on /Parent, never on titles", () => {
  // This is the shape of the historical bug and the reason the assertion is
  // structural. `resolveBookmarks` auto-assigns refs from a BREADTH-FIRST walk,
  // so the audit export once nested every ticket under "Configuration & stack"
  // while spelling every title perfectly. A titles-only test is green for that
  // bug; only the parent edges show it.

  it("every section hangs off the outline ROOT, not off another section", async () => {
    const entries = parseOutline((await renderManual()).toString("latin1"));
    expect(entries.length).toBeGreaterThan(0); // non-vacuity: the parse worked

    const byTitle = new Map(entries.map((e) => [e.title, e]));
    const cover = byTitle.get("Cover");
    expect(cover, "no Cover outline entry — did the parse shape change?").toBeDefined();
    const root = cover!.parent;

    for (const section of GUIDE_SECTIONS) {
      const entry = byTitle.get(section.title);
      expect(entry, `no outline entry for section "${section.title}"`).toBeDefined();
      expect(entry!.parent, `section "${section.title}" is not a top-level outline entry`).toBe(
        root,
      );
    }
  }, 60_000);

  it("every subsection hangs off ITS OWN section", async () => {
    const entries = parseOutline((await renderManual()).toString("latin1"));
    const byTitle = new Map(entries.map((e) => [e.title, e]));

    let checked = 0;
    for (const section of GUIDE_SECTIONS) {
      const sectionEntry = byTitle.get(section.title);
      expect(sectionEntry).toBeDefined();
      for (const sub of guideSubsections(section)) {
        const subEntry = byTitle.get(sub.title);
        expect(subEntry, `no outline entry for subsection "${sub.title}"`).toBeDefined();
        expect(
          subEntry!.parent,
          `subsection "${sub.title}" is nested under the wrong section`,
        ).toBe(sectionEntry!.obj);
        checked += 1;
      }
    }
    // Non-vacuity: a manifest whose bodies grew no depth-2 headings would make
    // every assertion above unreached and this test a green no-op.
    expect(checked).toBeGreaterThan(0);
  }, 60_000);
});

const CLAMP_LOG = "out-of-range number coerced to 0";

describe("fixed chrome does not diverge on a long document", () => {
  // THE constraint for this document. `@react-pdf/layout`'s `splitPage` builds
  // each continuation page with its `height` OMITTED, so a `bottom`-anchored
  // `fixed` element resolves its top against an absent height and runs away to
  // ~-2.996e21 on deep pages. The vendored pdfkit patch coerces that to 0 and
  // LOGS — which puts the footer at the top of the page over the header and
  // corrupts that page's coordinate frame, collapsing anything splitting there.
  //
  // The manual is the longest PDF this codebase produces, i.e. the document with
  // the most pages for the divergence to accumulate over. The assertion is on
  // the clamp's `console.error`: a clean render never trips it.
  //
  // Deliberately NOT verified by extracting text — the glyphs extract perfectly
  // while drawn on top of each other, which is exactly how the original bug
  // shipped green.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  function clampLogs(): string[] {
    return errorSpy.mock.calls
      .map((c: unknown[]) => c.map(String).join(" "))
      .filter((line: string) => line.includes(CLAMP_LOG));
  }

  it("the real manual renders without a single clamped coordinate", async () => {
    await renderManual();
    expect(clampLogs()).toEqual([]);
  }, 60_000);

  it("a deliberately page-spanning body renders without one either", async () => {
    // The real manifest is short today. This drives the SAME fixed chrome across
    // many more pages than the current content produces, so the guard keeps its
    // teeth while the guide is still being written — and stays honest once it is
    // long, rather than only becoming meaningful later.
    withFonts();
    const blocks: DocBlock[] = [];
    for (let i = 0; i < 120; i += 1) {
      blocks.push({ type: "heading", depth: 3, anchor: `h-${i}`, runs: [{ text: `Step ${i}` }] });
      blocks.push({
        type: "paragraph",
        runs: [
          { text: `Paragraph ${i}. ` },
          { text: "Emphasised", italic: true },
          { text: " and " },
          { text: "strong", bold: true },
          { text: ` — ${"filler text ".repeat(20)}` },
        ],
      });
      blocks.push({ type: "code", lang: "bash", value: `pnpm run step-${i}\npnpm test` });
    }

    await renderToBuffer(
      React.createElement(
        Document,
        {},
        React.createElement(
          Page,
          { size: "A4", style: styles.page },
          React.createElement(RunningHeader, { title: "The DevPilot manual" }),
          React.createElement(Footer, { label: "DevPilot manual" }),
          React.createElement(GuideBlocks, { blocks, figures: new Map() }),
        ),
      ) as never,
    );

    expect(clampLogs()).toEqual([]);
  }, 120_000);
});
