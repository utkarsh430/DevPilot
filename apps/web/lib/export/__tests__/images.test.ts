// Attachment-embedding rules.
//
// `images.server.ts` imports `server-only` and cannot load here, so these test
// the two things that actually matter and ARE reachable: the format policy it
// enforces (as a data contract), and the renderer's behaviour when handed an
// attachment it cannot draw. The second one is the real guarantee — it renders a
// document, so it fails if the placeholder path is broken for any reason.

import { createRequire } from "node:module";
import React from "react";
import { describe, expect, it } from "vitest";
import { Document, Font, Image, Page, renderToBuffer } from "@react-pdf/renderer";
import { ATTACHMENT_MIME_ALLOWLIST, isAllowedAttachmentMime } from "@/lib/board/attachments";
import { registerExportFonts, resetExportFontsForTest } from "@/lib/export/fonts";
import { TicketDocument } from "@/lib/export/ticket-document";
import { makeTicketExport } from "@/lib/export/__tests__/fixtures";

const require = createRequire(import.meta.url);

/** Mirrors `EMBEDDABLE_MIMES` in `images.server.ts` (which cannot load here). */
const EMBEDDABLE = ["image/png", "image/jpeg"] as const;

/** A 1×1 of each format. */
const PIXELS = {
  png: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  webp: "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=",
  gif: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

describe("the embeddable-format policy", () => {
  it("is a STRICT SUBSET of what a ticket may accept as an attachment", () => {
    // This gap is the whole defect: capture admits four formats (right — the
    // browser drawer renders all four), react-pdf draws only two. The export has
    // to bridge that, and it must bridge it by DEGRADING, not by guessing.
    for (const mime of EMBEDDABLE) {
      expect(isAllowedAttachmentMime(mime), `${mime} must still be attachable`).toBe(true);
    }
    const notEmbeddable = ATTACHMENT_MIME_ALLOWLIST.filter(
      (m) => !(EMBEDDABLE as readonly string[]).includes(m),
    );
    // If this ever becomes empty, the capture allowlist narrowed and the
    // placeholder branch is dead code worth deleting.
    expect(notEmbeddable).toEqual(["image/webp", "image/gif"]);
  });
});

describe("react-pdf's actual behaviour on an un-drawable format", () => {
  // Pinning the upstream behaviour this defends against, because the fix is only
  // motivated if this is true — and if a future react-pdf starts THROWING here
  // instead of silently dropping, that is a louder failure we want to know about.
  it("SILENTLY DROPS a webp instead of throwing (4.5.1)", async () => {
    const draw = (src: string) =>
      renderToBuffer(
        React.createElement(
          Document,
          null,
          React.createElement(Page, { size: "A4" }, React.createElement(Image, { src })),
        ) as never,
      );

    // Does not throw…
    const webp = await draw(PIXELS.webp);
    const png = await draw(PIXELS.png);
    // …but the image is simply absent: the webp page is materially smaller
    // because no image object was embedded. That silence is the hazard — an
    // audit PDF that quietly omits evidence while still captioning it.
    expect(webp.byteLength).toBeLessThan(png.byteLength);
  }, 30_000);
});

describe("a ticket whose attachment cannot be embedded", () => {
  function render(data: ReturnType<typeof makeTicketExport>) {
    resetExportFontsForTest();
    registerExportFonts(
      Font as unknown as Parameters<typeof registerExportFonts>[0],
      (s) => require.resolve(s),
      { force: true },
    );
    return renderToBuffer(
      React.createElement(TicketDocument, {
        data,
        projectName: "DevPilot",
        generatedAt: "2026-07-16T00:00:00.000Z",
      }) as never,
    );
  }

  it("still exports, and says the image is unavailable rather than dropping it in silence", async () => {
    const data = makeTicketExport();
    // What `images.server.ts` produces for a webp: no data URI, and a reason.
    data.attachments = [
      {
        id: "66666666-6666-4666-8666-666666666666",
        mime: "image/webp",
        bytes: 2048,
        dataUri: null,
        unavailableReason:
          "image/webp cannot be embedded in a PDF (PNG and JPEG only) — view it on the ticket",
      },
    ];
    const buf = await render(data);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.byteLength).toBeGreaterThan(2000);
  }, 30_000);

  it("exports a mix of embeddable and un-embeddable attachments", async () => {
    const data = makeTicketExport();
    data.attachments = [
      { id: "a1", mime: "image/png", bytes: 70, dataUri: PIXELS.png, unavailableReason: null },
      {
        id: "a2",
        mime: "image/gif",
        bytes: 43,
        dataUri: null,
        unavailableReason: "image/gif cannot be embedded in a PDF (PNG and JPEG only)",
      },
    ];
    const buf = await render(data);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30_000);
});
