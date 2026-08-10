// Resolving figure bytes: the refusals, which are the whole of the logic.
//
// The interesting property is that this function is TOTAL — every input yields
// a `ResolvedGuideFigure` and none throws — because a figure that cannot be
// drawn must never be able to fail the manual. The prose is the substance; a
// placeholder naming the cause is itself an honest thing for the document to
// say, and is strictly better than the alternative react-pdf offers, which is
// to render the page with the image silently missing.

import { describe, expect, it } from "vitest";
import {
  MAX_FIGURE_BYTES,
  isSafeFigureFilename,
  resolveFigureBytes,
} from "@/lib/export/guide-figures";
import type { GuideFigure } from "@/lib/guide/blocks";

const FIGURE: GuideFigure = {
  id: "board-overview",
  file: "board-overview.png",
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
// A real RIFF/WEBP header. This is the case that matters most: react-pdf does
// NOT throw on a webp data URI — verified on 4.5.1 it logs `Base64 image invalid
// format: webp` and renders the page with the image SILENTLY MISSING.
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

describe("content decides the type, never the filename", () => {
  it("accepts a PNG", () => {
    const r = resolveFigureBytes(FIGURE, PNG);
    expect(r.dataUri?.startsWith("data:image/png;base64,")).toBe(true);
    expect(r.unavailableReason).toBeNull();
  });

  it("accepts a JPEG", () => {
    expect(resolveFigureBytes(FIGURE, JPEG).dataUri?.startsWith("data:image/jpeg;base64,")).toBe(
      true,
    );
  });

  it("refuses a webp wearing a .png filename", () => {
    // The whole reason the sniff exists. Trusting the name here would hand
    // react-pdf a format it cannot draw and cannot complain about usefully, and
    // the manual would ship with a caption, a chrome bar, and no picture.
    const r = resolveFigureBytes({ ...FIGURE, file: "board.png" }, WEBP);
    expect(r.dataUri).toBeNull();
    expect(r.unavailableReason).toMatch(/not a PNG or JPEG/);
  });

  it("refuses an empty file", () => {
    const r = resolveFigureBytes(FIGURE, new Uint8Array(0));
    expect(r.dataUri).toBeNull();
    expect(r.unavailableReason).toMatch(/empty/);
  });

  it("refuses a file over the embed ceiling", () => {
    const big = new Uint8Array(MAX_FIGURE_BYTES + 1);
    big.set(PNG.subarray(0, 8));
    const r = resolveFigureBytes(FIGURE, big);
    expect(r.dataUri).toBeNull();
    expect(r.unavailableReason).toMatch(/ceiling/);
  });

  it("always returns the figure, so a caption can still be drawn", () => {
    // A refusal is a DEGRADATION, not an omission: the caller still needs the
    // figure's caption and provenance to explain the gap to a reader.
    for (const bytes of [PNG, WEBP, new Uint8Array(0)]) {
      expect(resolveFigureBytes(FIGURE, bytes).figure).toBe(FIGURE);
    }
  });
});

describe("figure filenames are allowlisted, not blocklisted", () => {
  it("accepts an ordinary capture name", () => {
    expect(isSafeFigureFilename("board-overview.png")).toBe(true);
    expect(isSafeFigureFilename("runner_connected.2.jpg")).toBe(true);
  });

  it("refuses anything that could escape the figure directory", () => {
    // First-party data, so this defends against a TYPO becoming a traversal
    // rather than against an attacker — the value is joined onto a fixed root
    // and would otherwise read an arbitrary file into a published PDF. An
    // allowlist makes that unrepresentable; a `..` blocklist would not.
    for (const bad of ["../secrets.png", "a/b.png", "..", ".env", "/etc/passwd", "a\\b.png"]) {
      expect(isSafeFigureFilename(bad), `${bad} should be refused`).toBe(false);
    }
  });
});
