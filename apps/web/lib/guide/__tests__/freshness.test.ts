import { describe, expect, it } from "vitest";
import {
  GUIDE_FRESHNESS_FALSE_POSITIVE_EXAMPLE,
  GUIDE_FRESHNESS_UNCAUGHT_EXAMPLE,
  GUIDE_MAX_FIGURES,
  GUIDE_MAX_FIGURES_TOTAL_BYTES,
  GUIDE_MAX_FIGURE_BYTES,
  GUIDE_PROVENANCE_UNPROVEN_EXAMPLE,
  checkFigureFreshness,
  checkFigureProvenance,
  fingerprintWatchedFiles,
  type WatchedFile,
} from "@/lib/guide/freshness";
import type { GuideFigure } from "@/lib/guide/blocks";

const FILES: WatchedFile[] = [
  { path: "a.tsx", contents: "alpha" },
  { path: "b.tsx", contents: "beta" },
];

function figure(over: Partial<GuideFigure> = {}): GuideFigure {
  return {
    id: "board-overview",
    file: "board-overview.png",
    alt: "The board with four columns",
    caption: "Tickets move left to right as agents pick them up.",
    width: 1280,
    height: 800,
    route: "/board",
    watch: ["a.tsx", "b.tsx"],
    fingerprint: fingerprintWatchedFiles(FILES),
    capturedAt: "2026-07-20T09:15:00.000Z",
    theme: "light",
    build: "a1b2c3d",
    ...over,
  };
}

describe("fingerprintWatchedFiles", () => {
  it("is deterministic", () => {
    expect(fingerprintWatchedFiles(FILES)).toBe(fingerprintWatchedFiles(FILES));
  });

  it("does not depend on the order `watch` is written in", () => {
    // Reordering the array is a no-op; going red on it would train people to
    // acknowledge drift reflexively, which is how the gate stops meaning anything.
    expect(fingerprintWatchedFiles([...FILES].reverse())).toBe(fingerprintWatchedFiles(FILES));
  });

  it("changes when a watched file's contents change", () => {
    const edited = [FILES[0]!, { path: "b.tsx", contents: "beta!" }];
    expect(fingerprintWatchedFiles(edited)).not.toBe(fingerprintWatchedFiles(FILES));
  });

  it("changes when a file is added to or removed from the watch set", () => {
    expect(fingerprintWatchedFiles([FILES[0]!])).not.toBe(fingerprintWatchedFiles(FILES));
    expect(fingerprintWatchedFiles([...FILES, { path: "c.tsx", contents: "" }])).not.toBe(
      fingerprintWatchedFiles(FILES),
    );
  });

  it("distinguishes a rename from an edit", () => {
    // Path is part of the preimage, so moving a file is drift even when its
    // bytes are identical — the screen is now composed of different files.
    const renamed = [{ path: "a2.tsx", contents: "alpha" }, FILES[1]!];
    expect(fingerprintWatchedFiles(renamed)).not.toBe(fingerprintWatchedFiles(FILES));
  });

  it("cannot be forged by contents that concatenate the same way", () => {
    // Each file is hashed before joining, so no arrangement of bytes can span a
    // path boundary.
    const a = fingerprintWatchedFiles([{ path: "x", contents: "ab" }]);
    const b = fingerprintWatchedFiles([
      { path: "x", contents: "a" },
      { path: "", contents: "b" },
    ]);
    expect(a).not.toBe(b);
  });
});

describe("checkFigureFreshness", () => {
  const live = fingerprintWatchedFiles(FILES);
  const drifted = fingerprintWatchedFiles([FILES[0]!, { path: "b.tsx", contents: "beta!" }]);

  it("is fresh when the fingerprint matches", () => {
    expect(checkFigureFreshness(figure(), live)).toEqual({ state: "fresh" });
  });

  it("is stale — the RED case — when it does not", () => {
    expect(checkFigureFreshness(figure(), drifted).state).toBe("stale");
  });

  it("goes green when the drift is acknowledged at the live fingerprint", () => {
    const ack = figure({
      staleAcknowledged: { fingerprint: drifted, note: "copy-only change", since: "2026-07-21" },
    });
    expect(checkFigureFreshness(ack, drifted)).toEqual({
      state: "acknowledged",
      note: "copy-only change",
      since: "2026-07-21",
    });
  });

  it("goes RED AGAIN on further drift — the acknowledgement pins ONE fingerprint", () => {
    // This is the property that makes the escape hatch safe to offer. A boolean
    // `stale: true` would have excused every future edit too, silently, forever.
    const ack = figure({
      staleAcknowledged: { fingerprint: drifted, note: "copy-only change", since: "2026-07-21" },
    });
    const driftedAgain = fingerprintWatchedFiles([
      { path: "a.tsx", contents: "alpha rewritten" },
      { path: "b.tsx", contents: "beta!" },
    ]);
    expect(checkFigureFreshness(ack, driftedAgain).state).toBe("acknowledgement-expired");
  });

  it("an acknowledgement does not excuse a figure that is already fresh", () => {
    const ack = figure({
      staleAcknowledged: { fingerprint: drifted, note: "n", since: "2026-07-21" },
    });
    expect(checkFigureFreshness(ack, live).state).toBe("fresh");
  });
});

// ── The three limits, asserted in the direction each is claimed ────────────

describe("GUIDE_FRESHNESS_UNCAUGHT_EXAMPLE — what this check CANNOT see", () => {
  it("a design-token change outside the watch set leaves the fingerprint UNCHANGED", () => {
    const { before, after, unwatchedEdit } = GUIDE_FRESHNESS_UNCAUGHT_EXAMPLE;
    // The token edit repaints every figure in the guide.
    expect(unwatchedEdit.before).not.toBe(unwatchedEdit.after);
    // And the gate says nothing at all.
    expect(fingerprintWatchedFiles(after)).toBe(fingerprintWatchedFiles(before));
  });

  it("the unwatched file is genuinely not in the watch set — non-vacuity", () => {
    const { watch, unwatchedEdit } = GUIDE_FRESHNESS_UNCAUGHT_EXAMPLE;
    expect(watch).not.toContain(unwatchedEdit.path);
  });
});

describe("GUIDE_FRESHNESS_FALSE_POSITIVE_EXAMPLE — this check OVER-reports", () => {
  it("a comment-only edit to a watched file DOES change the fingerprint", () => {
    // Known and accepted. A false positive costs one look; a false negative
    // ships a manual that quietly disagrees with the product.
    const { path, before, after } = GUIDE_FRESHNESS_FALSE_POSITIVE_EXAMPLE;
    expect(fingerprintWatchedFiles([{ path, contents: after }])).not.toBe(
      fingerprintWatchedFiles([{ path, contents: before }]),
    );
  });
});

describe("GUIDE_PROVENANCE_UNPROVEN_EXAMPLE — a claim, never the pixels", () => {
  it("a hand-authored entry with no capture behind it PASSES", () => {
    expect(checkFigureProvenance(GUIDE_PROVENANCE_UNPROVEN_EXAMPLE)).toEqual({ ok: true });
  });

  it("the check is still non-vacuous — malformed claims are refused", () => {
    const base = GUIDE_PROVENANCE_UNPROVEN_EXAMPLE;
    expect(checkFigureProvenance({ ...base, capturedAt: "yesterday" }).ok).toBe(false);
    expect(checkFigureProvenance({ ...base, theme: "dark" }).ok).toBe(false);
    expect(checkFigureProvenance({ ...base, build: "HEAD" }).ok).toBe(false);
    expect(checkFigureProvenance({ ...base, host: "not a url" }).ok).toBe(false);
    expect(checkFigureProvenance({ ...base, host: "https://devpilot.example" }).ok).toBe(false);
  });

  it("the host is compared by HOSTNAME, never by string prefix", () => {
    // `https://localhost.evil.example` starts with the right characters and is
    // not local. A prefix check is exactly the mistake to avoid here.
    expect(
      checkFigureProvenance({
        ...GUIDE_PROVENANCE_UNPROVEN_EXAMPLE,
        host: "https://localhost.evil.example",
      }).ok,
    ).toBe(false);
    expect(
      checkFigureProvenance({ ...GUIDE_PROVENANCE_UNPROVEN_EXAMPLE, host: "http://localhost:3000" })
        .ok,
    ).toBe(true);
  });
});

describe("budget constants", () => {
  it("are ordered so a single figure can never exceed the total", () => {
    expect(GUIDE_MAX_FIGURE_BYTES).toBeLessThan(GUIDE_MAX_FIGURES_TOTAL_BYTES);
  });

  it("leave the total binding before the per-figure count does", () => {
    // 12 × 400 KiB is 4.6 MiB, above the 3 MiB total — deliberate. The total is
    // the ceiling that actually protects the download; the per-file cap is what
    // steers authors toward cropped detail shots.
    expect(GUIDE_MAX_FIGURES * GUIDE_MAX_FIGURE_BYTES).toBeGreaterThan(
      GUIDE_MAX_FIGURES_TOTAL_BYTES,
    );
  });
});
