// The operator-facing surface, rendered for real.
//
// `StepArtifacts` is where the honesty requirement actually lands: the retention
// line and the precision note are the difference between evidence and a
// misleading label, and both are strings a well-intentioned edit could weaken
// without any other test noticing. So this renders the REAL component with
// `renderToStaticMarkup` under the repo's node-environment Vitest — the same
// approach as lib/marketplace/__tests__/skill-preview-render.test.ts, including
// its `React.createElement` style (vitest.config.ts collects `.test.ts` only,
// deliberately: a test file never needs JSX of its own).
//
// That constrains the component, on purpose: no Radix primitive and no browser
// API, so it stays renderable here.

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StepArtifacts } from "@/components/runs/StepArtifacts";
import { MAX_ARTIFACTS_PER_STEP, type RunArtifact } from "@/lib/runs/artifacts";

function artifact(over: Partial<RunArtifact> = {}): RunArtifact {
  return {
    id: "a1",
    stepIdx: 3,
    mime: "image/png",
    bytes: 2048,
    sequence: 0,
    capturedTotal: 1,
    capturedAt: "2026-07-19T10:11:12.000Z",
    url: "https://signed.example/tenant/run/3/a1.png",
    ...over,
  };
}

function render(artifacts: RunArtifact[]): string {
  return renderToStaticMarkup(React.createElement(StepArtifacts, { artifacts }));
}

describe("StepArtifacts", () => {
  it("renders nothing at all for a step that captured no images", () => {
    // The overwhelmingly common case. An empty "Browser screenshots" heading on
    // every step would be noise that trains the operator to skip the section.
    expect(render([])).toBe("");
  });

  it("renders the image with its signed URL", () => {
    const html = render([artifact()]);
    expect(html).toContain("Browser screenshots");
    expect(html).toContain("https://signed.example/tenant/run/3/a1.png");
    // Opening full-size must not hand the target window a reference back.
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('loading="lazy"');
  });

  it("states the precision limit — step attribution, NOT per-action", () => {
    const html = render([artifact()]);
    expect(html).toMatch(/during this step/i);
    expect(html).toMatch(/not to a specific action/i);
  });

  it("says the cap dropped images, rather than silently showing fewer", () => {
    const shown = Array.from({ length: MAX_ARTIFACTS_PER_STEP }, (_, i) =>
      artifact({ id: `a${i}`, sequence: 5 + i, capturedTotal: 9 }),
    );
    const html = render(shown);
    expect(html).toContain("9");
    expect(html).toMatch(/5 oldest were dropped/);
    expect(html).toMatch(/most recent/);
  });

  it("says 'all kept' when nothing was dropped", () => {
    const html = render([artifact({ capturedTotal: 1 })]);
    expect(html).toMatch(/all kept/);
    expect(html).not.toMatch(/dropped/);
  });

  it("shows a stored-but-unloadable image as such, never by omitting it", () => {
    // A row with no signed URL still represents evidence that exists. Dropping
    // it would under-report — the exact false-negative this feature exists to
    // end — so the slot is rendered with an explanation.
    const html = render([artifact({ url: null })]);
    expect(html).toMatch(/could not be loaded/i);
    expect(html).not.toContain("<img");
  });

  it("numbers images by capture sequence, so a kept tail is visible", () => {
    const html = render([
      artifact({ id: "x", sequence: 5, capturedTotal: 9 }),
      artifact({ id: "y", sequence: 6, capturedTotal: 9 }),
    ]);
    // 1-based for display; #6/#7 rather than #1/#2 makes the gap legible.
    expect(html).toContain("#6");
    expect(html).toContain("#7");
  });

  it("reports against the real capture count even if some uploads were lost", () => {
    // Only one row survived, but it still knows the step captured 9.
    const html = render([artifact({ capturedTotal: 9 })]);
    expect(html).toContain("9");
    expect(html).toMatch(/8 oldest were dropped/);
  });
});
