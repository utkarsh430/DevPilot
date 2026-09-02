// A long, page-spanning ticket must render without emitting an out-of-range
// coordinate — the regression test for the audit-PDF overlap crash.
//
// The class the earlier export work missed: verification read the PDF's TEXT
// (which extracts fine even when glyphs draw on top of each other) instead of
// LOOKING at the rendered geometry. The concrete symptom, on the captain's real
// project, was chrome/metadata drawing on top of each other on a deep page —
// unreadable — while every fit-on-one-page element rendered fine.
//
// Root cause (verified by rendering to PNG and inspecting — see the PR): the
// running FOOTER was `bottom`-anchored. A `fixed` element is re-laid-out per page,
// and react-pdf builds each continuation page with its `height` OMITTED
// (`@react-pdf/layout` `splitPage`: `nextBox = omit('height', page.box)`). A
// `bottom`-anchored box resolves its top from that now-absent height, so on deep
// continuation pages its computed `top` diverges to -2.996737976248788e+21 — the
// exact value in the pdfkit clamp logs. The clamp coerces it to 0, so the footer
// jumps to the TOP of the page (over the header) AND corrupts that page's
// coordinate frame, so any box splitting there — including a run card — inherits
// the garbage. The fix top-anchors the footer (and its page-number), which never
// consults the absent height; the run-card border was a symptom, not a cause.
//
// The assertion is on the pdfkit clamp's `console.error`: the patch logs
// "out-of-range number coerced to 0" every time it fires. A clean render never
// trips it. This drives a REAL, page-spanning render — the thing text-extraction
// verification could not see.

import { createRequire } from "node:module";
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import { registerExportFonts, resetExportFontsForTest } from "@/lib/export/fonts";
import { TicketDocument } from "@/lib/export/ticket-document";
import { makeSplittingRunTicket } from "@/lib/export/__tests__/fixtures";

const require = createRequire(import.meta.url);

async function renderSplitting(): Promise<Buffer> {
  resetExportFontsForTest();
  registerExportFonts(
    Font as unknown as Parameters<typeof registerExportFonts>[0],
    (s) => require.resolve(s),
    { force: true },
  );
  return renderToBuffer(
    React.createElement(TicketDocument, {
      data: makeSplittingRunTicket(),
      generatedAt: "2026-07-16T00:00:00.000Z",
      projectName: "Todo App",
    }) as never,
  );
}

const CLAMP_LOG = "out-of-range number coerced to 0";

describe("run card that splits across a page boundary", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Capture the vendored pdfkit patch's diagnostic. If the run card's geometry
    // emits an out-of-range coordinate, the patch logs exactly this string as it
    // coerces the value to 0 — the coercion that collapses the metadata rows.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders many multi-page runs without emitting an out-of-range coordinate", async () => {
    const buf = await renderSplitting();
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // The fixture is rich enough to paginate hard — this is the regime where a
    // run card is forced to cross a page boundary. If it did not paginate, the
    // test would prove nothing about the split case.
    const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(6);

    const clampFired = errorSpy.mock.calls.some((args: unknown[]) =>
      String(args[0]).includes(CLAMP_LOG),
    );
    expect(
      clampFired,
      "the pdfkit clamp fired — a page-spanning element emitted an out-of-range coordinate " +
        "(the footer-divergence crash has regressed)",
    ).toBe(false);
  }, 120_000);
});
