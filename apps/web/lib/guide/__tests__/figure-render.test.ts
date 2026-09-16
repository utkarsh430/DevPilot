// Render tests for the guide's figure treatment.
//
// A screenshot in a manual carries two risks that are invisible until a reader
// hits them: it can be captured in a theme the reader is not in (so it must read
// as a PICTURE of the app, not as the app), and it can be absent (so the guide
// must say so rather than quietly rendering one section short). Both are
// assertions here rather than conventions in a comment.

import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuideFigureCard, GuideStaleSummary } from "@/components/guide/figure";
import type { GuideFigure } from "@/lib/guide/blocks";

function figure(patch: Partial<GuideFigure> = {}): GuideFigure {
  return {
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
    ...patch,
  };
}

const render = (id: string, f: GuideFigure | undefined) =>
  renderToStaticMarkup(React.createElement(GuideFigureCard, { figureId: id, figure: f }));

describe("a captured figure", () => {
  const html = render("board-overview", figure());

  it("uses a plain <img>, not next/image", () => {
    // next/image does not render under renderToStaticMarkup in this node
    // Vitest — using it would make this whole file impossible.
    expect(html).toContain("<img");
  });

  it("carries alt text", () => {
    expect(html).toContain('alt="The DevPilot board with tickets in four columns"');
  });

  it("carries explicit intrinsic width and height so layout is reserved", () => {
    expect(html).toContain('width="1280"');
    expect(html).toContain('height="800"');
  });

  it("points at the committed path under public/guide", () => {
    expect(html).toContain('src="/guide/board-overview.png"');
  });

  it("frames the shot and names the depicted route", () => {
    // Figures are captured in one theme and read in any of six. An unframed
    // light screenshot in a dark page reads as the app being broken.
    expect(html).toContain("/board");
    expect(html).toContain("rounded border");
  });

  it("draws the caption, which is not a repeat of the alt text", () => {
    expect(html).toContain("The board, mid-run.");
    expect(figure().caption).not.toBe(figure().alt);
  });

  it("renders no stale badge when nothing is acknowledged", () => {
    expect(html).not.toContain("May be out of date");
  });
});

describe("an acknowledged-stale figure", () => {
  const html = render(
    "board-overview",
    figure({
      staleAcknowledged: {
        fingerprint: "abc123",
        note: "the column header moved, the flow is unchanged",
        since: "2026-07-21",
      },
    }),
  );

  it("says so, in the product, carrying the note and the date", () => {
    // The escape hatch's cost is paid HERE rather than in CI — that is the whole
    // bargain that keeps the freshness gate from being deleted the first time it
    // blocks an unrelated PR.
    expect(html).toContain("May be out of date");
    expect(html).toContain("the column header moved, the flow is unchanged");
    expect(html).toContain("2026-07-21");
  });

  it("still renders the image — stale is not missing", () => {
    expect(html).toContain("<img");
  });
});

describe("a figure with no capture behind it", () => {
  const html = render("not-captured-yet", undefined);

  it("degrades visibly rather than omitting the block", () => {
    // Mirrors `components/runs/StepArtifacts.tsx`'s dashed card: a guide that
    // silently drops a screenshot looks complete and is not.
    expect(html).toContain("border-dashed");
    expect(html).toContain("Screenshot not captured yet");
  });

  it("names the id, so the gap is fixable rather than mysterious", () => {
    expect(html).toContain("not-captured-yet");
  });

  it("renders no <img> pointing nowhere", () => {
    expect(html).not.toContain("<img");
  });
});

describe("the guide-level stale summary", () => {
  it("renders the count when figures are acknowledged", () => {
    const html = renderToStaticMarkup(
      React.createElement(GuideStaleSummary, { stale: 3, total: 11 }),
    );
    expect(html).toContain("3 of 11 figures may be out of date");
  });

  it("renders NOTHING when everything is fresh", () => {
    // A banner that shows while everything is fine is a banner people stop
    // reading — and then miss the one that matters.
    const html = renderToStaticMarkup(
      React.createElement(GuideStaleSummary, { stale: 0, total: 11 }),
    );
    expect(html).toBe("");
  });
});
