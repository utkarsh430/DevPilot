// Font-registration guards: the FONT CHOICES (woff-not-woff2, no ligatures).
//
// These are regression tests for two real, already-hit failures, not decoration.
// Both were discovered by rendering rather than by reading, and both fail in a
// way that reads as fine until a specific customer's ticket 500s.
//
// ── What this file deliberately does NOT cover ──────────────────────────────
// It does not test how the SERVER resolves these specifiers. The `require` below
// is built here, in the Vitest process, and handed to the pure
// `registerExportFonts` — so it is correct by construction, and `fonts.server.ts`
// (the module that actually supplies the resolver in production) is never loaded.
// It cannot be: it is `server-only`.
//
// That gap shipped a fatal bug. webpack rewrites `fonts.server.ts`'s resolver at
// BUILD time into a stub that throws `Cannot find module '@fontsource/…woff'` for
// every specifier, and this file stayed green throughout, because a bundler
// transform is invisible to source-level tests. The two guards that close it:
//   • `fonts-server-resolver.test.ts` — pins the source property, runs in `pnpm test`
//   • `scripts/export-fonts-accept.mjs` — runs the COMPILED module out of
//     `.next/server` and renders a real PDF; needs a build, so it is not in `pnpm test`
// If you are here because the export broke again, run the accept script first.

import { createRequire } from "node:module";
import React from "react";
import { describe, expect, it } from "vitest";
import { Document, Font, Page, Text, renderToBuffer } from "@react-pdf/renderer";
import {
  FONT_FAMILY,
  FONT_FILES,
  LIGATURE_BAIT,
  registerExportFonts,
  resetExportFontsForTest,
} from "@/lib/export/fonts";

const require = createRequire(import.meta.url);

function register() {
  resetExportFontsForTest();
  registerExportFonts(
    Font as unknown as Parameters<typeof registerExportFonts>[0],
    (s) => require.resolve(s),
    { force: true },
  );
}

function draw(text: string, fontFamily: string): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(
      Document,
      null,
      React.createElement(
        Page,
        { size: "A4" },
        React.createElement(Text, { style: { fontFamily, fontSize: 9 } }, text),
      ),
    ) as never,
  );
}

describe("export font registration", () => {
  it("declares only .woff sources", () => {
    // `.woff2` is the obvious "smaller is better" edit and it is BROKEN:
    // fontkit 2.0.4's woff2 glyf reconstruction throws `Offset is outside the
    // bounds of the DataView` once the glyph subset grows past a handful of
    // characters. It passes a trivial smoke test and fails on real content.
    for (const f of FONT_FILES) {
      expect(f.specifier, `${f.family} ${f.weight} must be a .woff`).toMatch(/\.woff$/);
    }
  });

  it("resolves every declared font file", () => {
    for (const f of FONT_FILES) {
      expect(() => require.resolve(f.specifier)).not.toThrow();
    }
  });

  it("registers every family the documents draw with", () => {
    const families = new Set(FONT_FILES.map((f) => f.family));
    expect(families).toContain(FONT_FAMILY.display);
    expect(families).toContain(FONT_FAMILY.body);
    expect(families).toContain(FONT_FAMILY.mono);
  });

  describe("the mono face must not carry programming ligatures", () => {
    // The audit document is made of shas, repo URLs, `--flags`, `=>` in code
    // blocks and `…` truncation markers, all drawn in the mono face. JetBrains
    // Mono (the app's brand mono) ships these as `calt` ligatures, and fontkit
    // 2.0.4 throws while decoding the resulting composite glyphs — inside
    // `font.layout()`, so no amount of react-pdf configuration avoids it, and
    // react-pdf hardcodes `features: undefined` so `calt` cannot be turned off.
    //
    // If someone swaps the mono face back to a ligature font "for brand
    // consistency", these fail loudly here instead of 500-ing a real export.
    it.each(LIGATURE_BAIT)(
      "lays out %j without throwing",
      async (text) => {
        register();
        await expect(draw(text, FONT_FAMILY.mono)).resolves.toBeInstanceOf(Buffer);
      },
      20_000,
    );
  });

  it("registration is idempotent", () => {
    register();
    // A serverless instance renders many documents; re-parsing ~8 font files per
    // request would be pure waste. The second call must be a no-op, not a
    // duplicate registration.
    expect(() =>
      registerExportFonts(Font as unknown as Parameters<typeof registerExportFonts>[0], () => {
        throw new Error("resolver must not be called on a repeat registration");
      }),
    ).not.toThrow();
  });
});
