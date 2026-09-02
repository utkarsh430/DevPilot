import "server-only";

// The PDF runtime boundary.
//
// `@react-pdf/renderer` is imported DYNAMICALLY and only from here, for the same
// reason `mammoth`/`unpdf` are (see `next.config.ts`): it is a heavy, node-
// oriented server-only dependency (it drags in pdfkit + fontkit + a layout
// engine), and it is listed in `serverExternalPackages` so Next resolves it from
// node_modules at runtime instead of bundling it. A static top-level import here
// would pull the whole PDF stack into every server chunk that transitively
// touches this module.
//
// Renderer choice (locked): pure JS, not a headless browser. Puppeteer/Chromium
// does not fit Vercel's serverless size/cold-start budget, needs a binary this
// repo has no convention for shipping, and would reintroduce an HTML/DOM/script
// channel for agent-authored content. react-pdf draws glyphs — there is no HTML
// to inject into — and it gives real PDF bookmarks + `render`-callback page
// numbering for free.
//
// Streaming vs buffering is the one place the two scopes differ, and it is not
// an accident:
//   • TICKET (synchronous download): `renderToStream` → the response starts
//     flowing while later pages are still laying out. The user clicked a button
//     and is watching.
//   • PROJECT (background job): `renderToBuffer` → we need the complete bytes in
//     hand to upload them to Storage and to know the length. Nobody is watching;
//     there is no latency to hide.

import React from "react";
import { ensureExportFonts } from "@/lib/export/fonts.server";
import { TicketDocument } from "@/lib/export/ticket-document";
import { ProjectDocument } from "@/lib/export/project-document";
import { GuideDocument } from "@/lib/export/guide-document";
import { resolveGuideFigures } from "@/lib/export/guide-figures.server";
import { GUIDE_FIGURES } from "@/lib/guide/figures";
import { guideContentVersion } from "@/lib/guide/manual-version";
import type { ProjectAuditExport, TicketAuditExport } from "@/lib/export/types";

async function pdf() {
  const mod = await import("@react-pdf/renderer");
  // Idempotent — the pure helper guards, so this is a no-op after the first
  // render on a warm instance.
  ensureExportFonts(mod.Font);
  return mod;
}

/**
 * react-pdf's render entry points are typed as `ReactElement<DocumentProps>` —
 * i.e. they want the props of `<Document>` itself, not the props of a component
 * that RETURNS a `<Document>`. Every custom document component therefore fails
 * to typecheck at the call site (a known wart in the published types; the
 * runtime only ever looks at what the element renders to).
 *
 * `asDocumentElement` is the single, named place that gap is absorbed, so the
 * casts do not spread across three render functions and so the reason is
 * written down once.
 */
type DocumentElement = Parameters<Awaited<ReturnType<typeof pdf>>["renderToBuffer"]>[0];

function asDocumentElement(element: React.ReactElement): DocumentElement {
  return element as unknown as DocumentElement;
}

/** Render a ticket export to a Node stream, for a streamed HTTP response. */
export async function renderTicketPdfStream(args: {
  data: TicketAuditExport;
  projectName: string | null;
  generatedAt: string;
}): Promise<NodeJS.ReadableStream> {
  const { renderToStream } = await pdf();
  return renderToStream(
    asDocumentElement(
      React.createElement(TicketDocument, {
        data: args.data,
        projectName: args.projectName,
        generatedAt: args.generatedAt,
      }),
    ),
  );
}

/** Render a ticket export to a complete buffer (tests, and any non-streaming caller). */
export async function renderTicketPdfBuffer(args: {
  data: TicketAuditExport;
  projectName: string | null;
  generatedAt: string;
}): Promise<Buffer> {
  const { renderToBuffer } = await pdf();
  return renderToBuffer(
    asDocumentElement(
      React.createElement(TicketDocument, {
        data: args.data,
        projectName: args.projectName,
        generatedAt: args.generatedAt,
      }),
    ),
  );
}

/**
 * Render the user manual to a Node stream.
 *
 * STREAMED, like the ticket download and for the same reason: a human clicked a
 * button and is watching, so the response starts flowing while later pages are
 * still laying out. This is the longest document the export produces, which
 * makes that matter more here than anywhere else — and unlike the project
 * export there is nothing to upload and no length to know in advance.
 *
 * Figures are resolved to bytes BEFORE the render begins. The renderer does no
 * IO of its own: a `readFile` interleaved with layout would make a slow disk a
 * source of layout stalls, and — more usefully — keeping the resolution outside
 * means the whole document, including every degraded-figure path, renders under
 * Vitest from an injected map.
 */
export async function renderGuidePdfStream(args: {
  generatedAt: string;
}): Promise<NodeJS.ReadableStream> {
  const { renderToStream } = await pdf();
  const figures = await resolveGuideFigures(GUIDE_FIGURES);
  return renderToStream(
    asDocumentElement(
      React.createElement(GuideDocument, {
        figures,
        generatedAt: args.generatedAt,
        version: guideContentVersion(),
      }),
    ),
  );
}

/** Render a project export to a complete buffer, for the upload step. */
export async function renderProjectPdfBuffer(data: ProjectAuditExport): Promise<Buffer> {
  const { renderToBuffer } = await pdf();
  return renderToBuffer(asDocumentElement(React.createElement(ProjectDocument, { data })));
}
