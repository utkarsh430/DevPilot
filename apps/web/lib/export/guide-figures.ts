// Resolving a `GuideFigure` to drawable bytes — the PURE half.
//
// Split from `.server.ts` for the reason this repo splits every such pair: the
// interesting logic is the REFUSAL logic, and a module that imports `node:fs`
// and `server-only` cannot be loaded under Vitest at all. The disk read is three
// lines and is not what goes wrong; deciding what a byte sequence IS, and what
// to say when it is not drawable, is.
//
// ── Content decides the type, never the filename ────────────────────────────
//
// react-pdf's decoder handles PNG, JPEG and SVG. Hand it `data:image/webp` and —
// verified on 4.5.1 — it does NOT throw: it logs `Base64 image invalid format:
// webp` and renders the page with the image SILENTLY MISSING. No error, no
// placeholder, no gap. That is the worst available outcome for a manual: a
// caption and a chrome bar promising a screenshot, with nothing between them,
// and nothing anywhere saying so.
//
// So the format is established by MAGIC BYTES via `sniffImageMime` — the same
// function the run-artifact ingest route uses, imported rather than copied,
// because a second sniffer is a second thing that can disagree about what a PNG
// is. A `.png` filename that is really a webp degrades to a visible placeholder;
// it never reaches the decoder.
//
// SVG is deliberately absent even though react-pdf supports it: it is an ACTIVE
// document (scripts, external refs), not a picture, and listing it would invite
// someone to add it to the capture pipeline.

import type { GuideFigure } from "@/lib/guide/blocks";
import { sniffImageMime } from "@/lib/runs/artifacts";

/**
 * Hard per-figure byte ceiling for the embed.
 *
 * Below the plan's 400 KiB capture budget with room to spare — this is a
 * backstop against an unreviewed commit, not the budget itself (the budget is a
 * test the capture crew owns). Base64 costs ~33% more again inside the PDF, so
 * the ceiling that matters is the encoded one and this is the pre-encoding
 * figure that keeps it comfortable.
 */
export const MAX_FIGURE_BYTES = 1024 * 1024;

export type ResolvedGuideFigure = {
  figure: GuideFigure;
  /** `data:image/(png|jpeg);base64,…`, or null when it could not be built. */
  dataUri: string | null;
  /** Why there is no image. A cause a reader can act on, never a code. */
  unavailableReason: string | null;
};

/**
 * Turn raw bytes into a drawable data URI, or into a stated reason why not.
 *
 * TOTAL — every path returns a `ResolvedGuideFigure`, and none throws. A figure
 * that cannot be drawn must never be able to fail the manual: the prose is the
 * substance and it is still worth delivering, and a placeholder that names the
 * cause is itself an honest thing for the document to say.
 */
export function resolveFigureBytes(figure: GuideFigure, bytes: Uint8Array): ResolvedGuideFigure {
  if (bytes.byteLength === 0) {
    return unavailable(figure, `${figure.file} is empty`);
  }
  if (bytes.byteLength > MAX_FIGURE_BYTES) {
    return unavailable(
      figure,
      `${figure.file} is ${Math.round(bytes.byteLength / 1024)} KiB, over the ${Math.round(
        MAX_FIGURE_BYTES / 1024,
      )} KiB embed ceiling`,
    );
  }

  // The name is a claim; the bytes are the fact. A mismatch degrades rather than
  // being "corrected" to whatever it turned out to be — see the module header.
  const mime = sniffImageMime(bytes);
  if (!mime) {
    return unavailable(
      figure,
      `${figure.file} is not a PNG or JPEG (a PDF cannot embed any other raster format)`,
    );
  }

  return {
    figure,
    dataUri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
    unavailableReason: null,
  };
}

export function unavailable(figure: GuideFigure, reason: string): ResolvedGuideFigure {
  return { figure, dataUri: null, unavailableReason: reason };
}

/**
 * The on-disk basename a figure may name.
 *
 * Figure data is first-party, so this is not defending against an attacker —
 * it is defending against a typo becoming a path traversal. `file` is joined
 * onto a fixed root, and a value containing a separator or `..` would resolve
 * outside `public/guide/` and read an arbitrary file into a published PDF. An
 * allowlist is what makes that unrepresentable; a blocklist of `..` would not.
 */
export function isSafeFigureFilename(file: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(file) && !file.startsWith(".") && file.length <= 128;
}
