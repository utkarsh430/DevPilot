// Render smoke test: a fixture `TicketAuditExport` must become a real,
// non-empty PDF with the outline structure the audit reader navigates by.
//
// This is deliberately an end-to-end render rather than a snapshot of the
// element tree. The failure modes this feature actually has are all inside the
// PDF runtime — an unregistered font family throws, a bad style value throws,
// fontkit chokes on a font format, an image data URI is rejected — and none of
// them are visible from a component tree. Only drawing it proves it draws.
//
// It cannot import `render.server.ts` (that pulls `server-only`, which refuses
// to load outside a Next server), so it wires the same two pieces the server
// wrapper does: `registerExportFonts` + `renderToBuffer` on the same document.
// That keeps the test honest about the font path — the historical break here is
// fonts, not JSX.

import { createRequire } from "node:module";
import React from "react";
import { describe, expect, it } from "vitest";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import { registerExportFonts, resetExportFontsForTest, FONT_FILES } from "@/lib/export/fonts";
import { TicketDocument } from "@/lib/export/ticket-document";
import { makeTicketExport } from "@/lib/export/__tests__/fixtures";

const require = createRequire(import.meta.url);

function render(): Promise<Buffer> {
  resetExportFontsForTest();
  registerExportFonts(Font as unknown as Parameters<typeof registerExportFonts>[0], (s) =>
    require.resolve(s),
  );
  return renderToBuffer(
    React.createElement(TicketDocument, {
      data: makeTicketExport(),
      projectName: "DevPilot",
      generatedAt: "2026-07-16T00:00:00.000Z",
    }) as never,
  );
}

describe("ticket PDF render", () => {
  it("renders a non-empty PDF", async () => {
    const buf = await render();
    expect(buf.byteLength).toBeGreaterThan(2000);
    // The PDF magic number — we produced an actual PDF, not an error page.
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);

  it("embeds the brand fonts rather than falling back to a base-14 face", async () => {
    const pdf = (await render()).toString("latin1");
    // A `/FontFile` stream is the proof of an EMBEDDED font. Without
    // registration react-pdf silently draws Helvetica, which is a base-14 face
    // that needs no embedding — so its absence would mean the brand type never
    // made it in and nobody would notice from a byte-length check.
    expect(/\/FontFile[23]?/.test(pdf)).toBe(true);
  }, 30_000);

  it("produces a PDF outline with the expected bookmarks", async () => {
    const pdf = (await render()).toString("latin1");
    expect(/\/Outlines/.test(pdf)).toBe(true);
    // Bookmark titles land in the outline dictionary. These are the entries an
    // auditor navigates by; losing them is a silent regression the naked eye
    // would not catch in a 40-page document.
    expect(pdf).toContain("/Title (Cover)");
    expect(pdf).toContain("DevPilot-42");
  }, 30_000);

  it("registers every declared face without throwing", () => {
    // `.woff` is load-bearing — `.woff2` crashes fontkit 2.0.4's glyf
    // reconstruction on realistic text (see lib/export/fonts.ts). If someone
    // "optimises" the extension, this fails at resolve time rather than at
    // render time on a customer's ticket.
    expect(FONT_FILES.length).toBeGreaterThan(0);
    for (const f of FONT_FILES) {
      expect(f.specifier.endsWith(".woff")).toBe(true);
      expect(() => require.resolve(f.specifier)).not.toThrow();
    }
  });
});
