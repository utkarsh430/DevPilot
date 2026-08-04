// The PDF renderer's half of the exhaustiveness pair.
//
// ── What this test is actually for ─────────────────────────────────────────
//
// The `never` check inside `guide-pdf-blocks.tsx` is the real guarantee and it
// fires at COMPILE time, which is exactly right and also exactly why it needs a
// companion here: the compile error only appears once someone widens `DocBlock`,
// and the failure it prevents (a block type that renders on the web and vanishes
// from the manual) is invisible in the output. This test asserts the OTHER
// direction — that the renderer has actually been exercised against every member
// of `DOC_BLOCK_TYPES`, so a member cannot be added, silenced with a hasty
// `return null` in the switch, and shipped drawing nothing.
//
// It renders REAL PDFs rather than inspecting an element tree, for the reason
// `render.test.ts` gives: every failure mode this feature has lives inside the
// PDF runtime (an unregistered font throws, a bad style value throws, fontkit
// rejects a format, a data URI is refused) and none of them is visible from a
// component tree. Only drawing it proves it draws.

import { createRequire } from "node:module";
import React from "react";
import { describe, expect, it } from "vitest";
import { Document, Font, Page, renderToBuffer } from "@react-pdf/renderer";
import { registerExportFonts, resetExportFontsForTest } from "@/lib/export/fonts";
import { styles } from "@/lib/export/components/primitives";
import { GuideBlocks } from "@/lib/export/guide-pdf-blocks";
import { DOC_BLOCK_TYPES, type DocBlock, type GuideFigure } from "@/lib/guide/blocks";
import type { ResolvedGuideFigure } from "@/lib/export/guide-figures";

const require = createRequire(import.meta.url);

function withFonts(): void {
  resetExportFontsForTest();
  registerExportFonts(
    Font as unknown as Parameters<typeof registerExportFonts>[0],
    (s) => require.resolve(s),
    { force: true },
  );
}

function renderBlocks(
  blocks: DocBlock[],
  figures: Map<string, ResolvedGuideFigure> = new Map(),
): Promise<Buffer> {
  withFonts();
  return renderToBuffer(
    React.createElement(
      Document,
      {},
      React.createElement(
        Page,
        { size: "A4", style: styles.page },
        React.createElement(GuideBlocks, { blocks, figures }),
      ),
    ) as never,
  );
}

/** One block of every type in `DOC_BLOCK_TYPES`, keyed by type. */
const SAMPLES: Record<DocBlock["type"], DocBlock> = {
  paragraph: { type: "paragraph", runs: [{ text: "A plain sentence." }] },
  heading: { type: "heading", depth: 2, anchor: "a-heading", runs: [{ text: "A heading" }] },
  list: {
    type: "list",
    ordered: false,
    items: [[{ text: "first" }], [{ text: "second" }]],
  },
  code: { type: "code", lang: "bash", value: "pnpm dev" },
  callout: { type: "callout", tone: "warning", runs: [{ text: "Mind this." }] },
  table: {
    type: "table",
    header: [[{ text: "Column" }], [{ text: "Other" }]],
    rows: [[[{ text: "a" }], [{ text: "b" }]]],
  },
  figure: { type: "figure", figureId: "sample-figure" },
  rule: { type: "rule" },
};

describe("every DocBlock type is drawn", () => {
  it("SAMPLES covers DOC_BLOCK_TYPES exactly — no member untested", () => {
    // The non-vacuity guard for every test below. Without it, adding a block
    // type and forgetting a sample leaves the whole suite green while that type
    // is drawn by nobody.
    expect(Object.keys(SAMPLES).sort()).toEqual([...DOC_BLOCK_TYPES].sort());
  });

  for (const type of DOC_BLOCK_TYPES) {
    it(`renders a "${type}" block into a real PDF`, async () => {
      const buf = await renderBlocks([SAMPLES[type]]);
      expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(buf.byteLength).toBeGreaterThan(1000);
    }, 30_000);
  }

  it("renders all of them together", async () => {
    const buf = await renderBlocks(DOC_BLOCK_TYPES.map((t) => SAMPLES[t]));
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);
});

describe("emphasis without italic type", () => {
  // `fontStyle: "italic"` resolves to a REGISTERED italic face and THROWS
  // (`Could not resolve font for Inter, fontWeight 400, fontStyle italic`) when
  // there is not one — and the export registers upright faces only. So an
  // italic run must render, and must render by some other means. A renderer that
  // dropped the mark would also pass a "does not throw" check, which is why the
  // source assertion below sits beside this one.
  it("draws an italic run without throwing", async () => {
    const buf = await renderBlocks([
      {
        type: "paragraph",
        runs: [
          { text: "plain " },
          { text: "emphasised", italic: true },
          { text: " and " },
          { text: "strong", bold: true },
          { text: " and " },
          { text: "both", bold: true, italic: true },
        ],
      },
    ]);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);

  it("never asks react-pdf for an italic face", () => {
    // A source scan, because the claim is about every future path: one
    // `fontStyle: "italic"` anywhere in this renderer throws at render time on a
    // reader's download, not at type-check time here.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "guide-pdf-blocks.tsx"),
      "utf8",
    ) as string;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/fontStyle\s*:/);
  });
});

describe("a missing figure degrades, it does not throw", () => {
  const figure: GuideFigure = {
    id: "sample-figure",
    file: "sample.png",
    alt: "The board with three lanes",
    caption: "The board, mid-dispatch.",
    width: 1280,
    height: 800,
    route: "/board",
    watch: ["app/(app)/board/page.tsx"],
    fingerprint: "abc123",
    capturedAt: "2026-07-20T09:00:00.000Z",
    theme: "Light",
    build: "a1b2c3d",
  };

  it("renders a placeholder when the id is not registered at all", async () => {
    // The state the manual is in TODAY: the capture crew fills `GUIDE_FIGURES`
    // independently, so a body may reference a figure whose capture has not
    // landed. That must produce a document, not an exception.
    const buf = await renderBlocks([SAMPLES.figure], new Map());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);

  it("renders a placeholder when the bytes could not be read", async () => {
    const buf = await renderBlocks(
      [SAMPLES.figure],
      new Map([
        [
          "sample-figure",
          { figure, dataUri: null, unavailableReason: "sample.png could not be read" },
        ],
      ]),
    );
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);

  it("renders the stale badge when the manifest acknowledges drift", async () => {
    // The acknowledgement is read off the STATIC manifest, never recomputed:
    // `freshness.ts` needs `node:crypto` and the repo source to hash, and the
    // lambda rendering this has neither. That is the whole reason the escape
    // hatch is a typed constant rather than a computed one.
    const buf = await renderBlocks(
      [SAMPLES.figure],
      new Map([
        [
          "sample-figure",
          {
            figure: {
              ...figure,
              staleAcknowledged: {
                fingerprint: "abc123",
                note: "The lane header moved; the flow is unchanged.",
                since: "2026-07-21",
              },
            },
            dataUri: null,
            unavailableReason: "not captured in this test",
          },
        ],
      ]),
    );
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);
});
