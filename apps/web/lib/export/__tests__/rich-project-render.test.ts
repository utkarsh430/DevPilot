// The project export at REAL richness — the gap that let two bugs ship.
//
// `project-document.test.ts` renders with `tickets: []`, and `render.test.ts`
// renders one ticket with one run. Both stayed green while a real 9-ticket
// export died in prod. A fixture that never fills a page cannot exercise
// pagination, the fixed running chrome across pages, or an outline with more
// than a couple of entries — i.e. it cannot exercise the parts of this document
// that are actually hard.
//
// So this renders a project shaped like the one that broke: 9 fully-detailed
// tickets, each with a long description, a full thread and several runs with
// narration, verification and cost, plus the stack table and embedded evidence.
// That lands at ~100 pages and takes a few seconds — the price of covering the
// thing that broke.
//
// Honest scope: this does NOT reproduce the `unsupported number` crash. That
// value comes back out of Yoga on data we could not reproduce offline, and the
// guard for it is `pdfkit-number-clamp.test.ts`. What this DOES cover is the
// structure — including the outline bug that only a multi-ticket render can
// show, and which the crash investigation turned up.

import { createRequire } from "node:module";
import React from "react";
import { describe, expect, it } from "vitest";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import { registerExportFonts, resetExportFontsForTest } from "@/lib/export/fonts";
import { ProjectDocument } from "@/lib/export/project-document";
import { makeRichProjectExport, RICH_TICKET_COUNT } from "@/lib/export/__tests__/fixtures";

const require = createRequire(import.meta.url);

async function render(opts: { truncated?: boolean } = {}): Promise<Buffer> {
  resetExportFontsForTest();
  registerExportFonts(
    Font as unknown as Parameters<typeof registerExportFonts>[0],
    (s) => require.resolve(s),
    { force: true },
  );
  return renderToBuffer(
    React.createElement(ProjectDocument, { data: makeRichProjectExport(opts) }) as never,
  );
}

// ─── Reading the outline back out of the PDF ────────────────────────────────
//
// Titles alone prove nothing here: the bug produced every title, correctly
// spelled, just wired to the wrong parent — and the rendered pages are entirely
// plausible either way. `/Parent` is the only thing that tells a real index
// apart from a mis-nested one, so these assertions read parents.

type OutlineItem = { obj: string; title: string; parent: string | null };

/** Undo pdfkit's UTF-16BE encoding, which every em-dashed title triggers. */
function decodePdfString(raw: string): string {
  if (!raw.startsWith("þÿ")) return raw;
  let out = "";
  for (let i = 2; i + 1 < raw.length; i += 2) out += raw[i + 1];
  return out;
}

function parseOutline(pdf: string): { root: string | null; items: OutlineItem[] } {
  const catalog = /\/Type\s*\/Catalog[\s\S]*?\/Outlines\s+(\d+)\s+0\s+R/.exec(pdf);
  const items: OutlineItem[] = [];
  for (const m of pdf.matchAll(/(\d+) 0 obj\s*<<([\s\S]*?)>>\s*endobj/g)) {
    const body = m[2] ?? "";
    const title = /\/Title\s*\(([\s\S]*?)\)\s*(?:\/[A-Z]|$)/.exec(body);
    if (!title) continue;
    const parent = /\/Parent\s+(\d+)\s+0\s+R/.exec(body);
    items.push({
      obj: m[1] ?? "",
      title: decodePdfString(title[1] ?? ""),
      parent: parent ? (parent[1] ?? null) : null,
    });
  }
  return { root: catalog ? (catalog[1] ?? null) : null, items };
}

const isTicketEntry = (i: OutlineItem) => /^DevPilot-\d+ /.test(i.title);

describe("project PDF render — real richness", () => {
  it("renders a valid, multi-page PDF for a fully-detailed project", async () => {
    const buf = await render();
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // `/Type /Page` (not `/Pages`) — one per rendered page object. The minimal
    // fixtures produced a handful; assert we are genuinely in the regime where
    // pagination, the fixed chrome and the outline all engage.
    const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(40);
    expect(buf.byteLength).toBeGreaterThan(100_000);
  }, 120_000);

  // Both truncation modes, because this is precisely where the bug hid. The
  // conditional "Ticket summary" page shifts react-pdf's breadth-first bookmark
  // numbering by one, so the old positional `parent: 4` landed on the
  // Ticket-detail page when truncated and on the Configuration section when
  // not. Testing one mode tests half the bug — and the truncated half passed.
  for (const truncated of [false, true]) {
    it(`nests every ticket under Ticket detail (truncated: ${truncated})`, async () => {
      const { items } = parseOutline((await render({ truncated })).toString("latin1"));
      const detail = items.find((i) => i.title === "Ticket detail");
      expect(detail, "no Ticket detail outline entry").toBeDefined();

      const tickets = items.filter(isTicketEntry);
      expect(tickets).toHaveLength(RICH_TICKET_COUNT);
      for (const t of tickets) {
        expect(t.parent, `${t.title} is not nested under Ticket detail`).toBe(detail?.obj);
      }
    }, 120_000);
  }

  it("puts the top-level sections at the top level", async () => {
    const { root, items } = parseOutline((await render()).toString("latin1"));
    expect(root, "no /Outlines in the catalog").not.toBeNull();
    for (const title of ["Cover", "Contents", "Rollups", "Ticket detail"]) {
      const entry = items.find((i) => i.title === title);
      expect(entry, `${title} missing from the outline`).toBeDefined();
      expect(entry?.parent, `${title} should be a root entry`).toBe(root);
    }
  }, 120_000);

  it("nests a section under the page it lives on", async () => {
    // "Configuration & stack" is a Section on the Contents page, so react-pdf's
    // tree-derived parent is that page — and we deliberately do NOT override it.
    // Asserted so the explicit-ref scheme cannot silently flatten the outline.
    const { items } = parseOutline((await render()).toString("latin1"));
    const contents = items.find((i) => i.title === "Contents");
    const config = items.find((i) => i.title === "Configuration & stack");
    expect(config, "no Configuration & stack entry").toBeDefined();
    expect(config?.parent).toBe(contents?.obj);
  }, 120_000);
});
