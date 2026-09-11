// Render tests for the guide's WEB renderer.
//
// These render the REAL components with `renderToStaticMarkup` under the repo's
// node-environment Vitest — no jsdom, no React Testing Library — exactly as
// `lib/marketplace/__tests__/skill-preview-render.test.ts` does. That is the
// constraint that forces the component split: Vitest collects only
// `lib/**/__tests__/**/*.test.ts`, so a test living beside the components would
// never run, and anything that needs a hook or a browser API cannot be asserted
// here at all. Everything worth proving therefore lives in the presentational
// half (`doc-blocks.tsx`, `figure.tsx`, `chrome.tsx`); the stateful halves
// (sidebar active state, TOC scroll-spy, the mobile sheet, the download hook)
// are separate `"use client"` files.
//
// The headline test is the exhaustiveness one. `doc-blocks.tsx` has a `never`
// check in its `default:` arm, which turns a forgotten block type into a red
// typecheck — but a `never` check can be defeated by a cast and a LIST cannot,
// so this walks `DOC_BLOCK_TYPES` and asserts each member actually produces
// markup. The two guards fail in different ways on purpose.

import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocBlocks, GuideProse } from "@/components/guide/doc-blocks";
import { DOC_BLOCK_TYPES, type DocBlock, type GuideFigure } from "@/lib/guide/blocks";

const FIGURE: GuideFigure = {
  id: "board-overview",
  file: "board-overview.png",
  alt: "The DevPilot board with tickets in four columns",
  caption: "The board, mid-run.",
  width: 1280,
  height: 800,
  route: "/board",
  watch: ["app/(app)/board/page.tsx"],
  fingerprint: "abc123",
  capturedAt: "2026-07-20T10:00:00.000Z",
  theme: "light",
  build: "deadbee",
};

const figureFor = (id: string) => (id === FIGURE.id ? FIGURE : undefined);

function render(blocks: DocBlock[]): string {
  return renderToStaticMarkup(React.createElement(DocBlocks, { blocks, figureFor }));
}

/** One minimal, valid block of each type — the exhaustiveness fixture. */
const SAMPLES: { [K in DocBlock["type"]]: Extract<DocBlock, { type: K }> } = {
  paragraph: { type: "paragraph", runs: [{ text: "A paragraph of guide prose." }] },
  heading: { type: "heading", depth: 2, anchor: "a-heading", runs: [{ text: "A heading" }] },
  list: { type: "list", ordered: false, items: [[{ text: "A list item" }]] },
  code: { type: "code", lang: "bash", value: "pnpm --filter web dev" },
  callout: { type: "callout", tone: "warning", runs: [{ text: "A callout body." }] },
  table: {
    type: "table",
    header: [[{ text: "Column" }]],
    rows: [[[{ text: "A table cell" }]]],
  },
  figure: { type: "figure", figureId: FIGURE.id },
  rule: { type: "rule" },
};

describe("exhaustiveness over DOC_BLOCK_TYPES", () => {
  it("has a sample for every declared block type, and no extras", () => {
    // If this fails, `DocBlock` gained (or lost) a member and this file was not
    // updated — which is the signal that the renderer below is untested for it.
    expect(Object.keys(SAMPLES).sort()).toEqual([...DOC_BLOCK_TYPES].sort());
  });

  for (const type of DOC_BLOCK_TYPES) {
    it(`renders "${type}" to non-empty markup`, () => {
      const html = render([SAMPLES[type]]);
      expect(html.length).toBeGreaterThan(0);
      // A block that renders `<></>` would satisfy "no throw" while producing
      // nothing a reader can see — the exact silent-absence failure the whole
      // one-vocabulary design exists to prevent.
      expect(html).toMatch(/<[a-z]/);
    });
  }

  it("renders every block type together without dropping any", () => {
    const html = render(DOC_BLOCK_TYPES.map((t) => SAMPLES[t]));
    expect(html).toContain("A paragraph of guide prose.");
    expect(html).toContain("A heading");
    expect(html).toContain("A list item");
    expect(html).toContain("pnpm --filter web dev");
    expect(html).toContain("A callout body.");
    expect(html).toContain("A table cell");
    expect(html).toContain(FIGURE.alt);
    expect(html).toContain("<hr");
  });
});

describe("headings", () => {
  it("carries the anchor computed during lowering as its id", () => {
    const html = render([SAMPLES.heading]);
    expect(html).toContain('id="a-heading"');
  });

  it("scroll-margin clears the sticky top bar", () => {
    // Without this a TOC jump lands the heading under the `h-14` bar, which
    // reads to the user as the link being broken.
    expect(render([SAMPLES.heading])).toContain("scroll-mt-20");
  });

  it("offers a self-link to the anchor, revealed on hover AND focus", () => {
    const html = render([SAMPLES.heading]);
    expect(html).toContain('href="#a-heading"');
    // An opacity-0 control is still keyboard-reachable; without the focus rule a
    // keyboard user tabs onto a link they cannot see.
    expect(html).toContain("group-focus-within:opacity-100");
  });

  it("renders depth 3 as an h3, never a demoted h2", () => {
    const html = render([{ type: "heading", depth: 3, anchor: "sub", runs: [{ text: "Sub" }] }]);
    expect(html).toContain("<h3");
    expect(html).not.toContain("<h2");
  });
});

describe("links", () => {
  it("gives an external link rel=noopener noreferrer and a new tab", () => {
    const html = render([
      {
        type: "paragraph",
        runs: [{ text: "Vercel docs", href: "https://vercel.com/docs" }],
      },
    ]);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("treats a protocol-relative href as EXTERNAL", () => {
    // `//evil.example` is one character away from an internal path and is not
    // one. Erring toward the noopener treatment is the safe direction.
    const html = render([
      { type: "paragraph", runs: [{ text: "elsewhere", href: "//evil.example/x" }] },
    ]);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("routes an internal href through a plain same-origin anchor", () => {
    const html = render([{ type: "paragraph", runs: [{ text: "the board", href: "/board" }] }]);
    expect(html).toContain('href="/board"');
    expect(html).not.toContain('rel="noopener noreferrer"');
  });
});

describe("inline marks", () => {
  it("applies bold, italic and code together", () => {
    const html = render([
      { type: "paragraph", runs: [{ text: "loud", bold: true, italic: true, code: true }] },
    ]);
    expect(html).toContain("<strong");
    expect(html).toContain("<em");
    expect(html).toContain("<code");
  });
});

describe("overflow contract", () => {
  it("puts a code block in its own horizontal-scroll box", () => {
    expect(render([SAMPLES.code])).toContain("overflow-x-auto");
  });

  it("puts a table in its own horizontal-scroll box", () => {
    expect(render([SAMPLES.table])).toContain("overflow-x-auto");
  });
});

describe("GuideProse", () => {
  it("caps the prose measure at max-w-2xl inside the wider article column", () => {
    const html = renderToStaticMarkup(
      React.createElement(GuideProse, { blocks: [SAMPLES.paragraph], figureFor }),
    );
    expect(html).toContain("max-w-2xl");
  });
});
