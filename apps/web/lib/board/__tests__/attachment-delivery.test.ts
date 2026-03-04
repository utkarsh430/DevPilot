// Phase 3 delivery selection — the pure guardrails that decide WHICH of a
// ticket's attachment rows are safe to hand to a run. A regression here is a
// tenant-isolation hole (a mis-scoped key delivered to a runner) or a broken
// cap (a huge/over-count payload), so these are pinned tests.

import { describe, it, expect } from "vitest";
import {
  ATTACHMENT_DELIVERY_MAX_TOTAL_BYTES,
  ESTIMATED_TOKENS_PER_IMAGE,
  attachmentFilename,
  estimateImageDeliveryCents,
  estimateImageTokens,
  selectDeliverableAttachments,
  type AttachmentRow,
} from "@/lib/board/attachment-delivery";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@/lib/board/attachments";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function id(n: number): string {
  const h = n.toString(16).padStart(2, "0");
  return `${h}0000${h}-0000-4000-8000-0000000000${h}`;
}

function row(over: Partial<AttachmentRow> & { n: number }): AttachmentRow {
  const rid = id(over.n);
  return {
    id: over.id ?? rid,
    storageKey: over.storageKey ?? `${TENANT}/aaaaaaaa-0000-4000-8000-000000000000/${rid}.png`,
    mime: over.mime ?? "image/png",
    bytes: over.bytes ?? 1000,
  };
}

describe("attachmentFilename", () => {
  it("derives <id>.<ext> for an allowlisted mime + uuid id", () => {
    expect(attachmentFilename(id(1), "image/png")).toBe(`${id(1)}.png`);
    expect(attachmentFilename(id(2), "image/jpeg")).toBe(`${id(2)}.jpg`);
    expect(attachmentFilename(id(3), "image/webp")).toBe(`${id(3)}.webp`);
    expect(attachmentFilename(id(4), "image/gif")).toBe(`${id(4)}.gif`);
  });
  it("returns null for a non-uuid id or an off-allowlist mime", () => {
    expect(attachmentFilename("../etc/passwd", "image/png")).toBeNull();
    expect(attachmentFilename(id(1), "application/pdf")).toBeNull();
    expect(attachmentFilename(id(1), "text/plain")).toBeNull();
  });
  it("never yields a path separator", () => {
    const f = attachmentFilename(id(1), "image/png");
    expect(f).not.toBeNull();
    expect(f!.includes("/")).toBe(false);
    expect(f!.includes("\\")).toBe(false);
  });
});

describe("selectDeliverableAttachments", () => {
  it("keeps image rows whose key is scoped to the run's tenant", () => {
    const out = selectDeliverableAttachments({
      tenantId: TENANT,
      rows: [row({ n: 1 }), row({ n: 2 })],
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.filename).toBe(`${id(1)}.png`);
    expect(out[0]!.mime).toBe("image/png");
    expect(out[0]!.bytes).toBe(1000);
  });

  it("DROPS a row whose storage key points at another tenant (scope refused)", () => {
    const foreign = row({
      n: 9,
      storageKey: `${OTHER}/aaaaaaaa-0000-4000-8000-000000000000/${id(9)}.png`,
    });
    const out = selectDeliverableAttachments({ tenantId: TENANT, rows: [row({ n: 1 }), foreign] });
    expect(out).toHaveLength(1);
    expect(out.map((a) => a.id)).not.toContain(foreign.id);
  });

  it("drops a non-image / off-allowlist mime", () => {
    const out = selectDeliverableAttachments({
      tenantId: TENANT,
      rows: [row({ n: 1, mime: "application/pdf" }), row({ n: 2, mime: "image/svg+xml" })],
    });
    expect(out).toHaveLength(0);
  });

  it("drops zero/negative/oversized byte rows", () => {
    const out = selectDeliverableAttachments({
      tenantId: TENANT,
      rows: [
        row({ n: 1, bytes: 0 }),
        row({ n: 2, bytes: -5 }),
        row({ n: 3, bytes: ATTACHMENT_MAX_BYTES + 1 }),
      ],
    });
    expect(out).toHaveLength(0);
  });

  it("caps the count at ATTACHMENT_MAX_COUNT", () => {
    const rows = Array.from({ length: ATTACHMENT_MAX_COUNT + 3 }, (_, i) => row({ n: i + 1 }));
    const out = selectDeliverableAttachments({ tenantId: TENANT, rows });
    expect(out).toHaveLength(ATTACHMENT_MAX_COUNT);
  });

  it("caps the aggregate bytes at ATTACHMENT_DELIVERY_MAX_TOTAL_BYTES", () => {
    // Two 8 MiB files fit; the third would cross the 20 MiB total cap.
    const eightMiB = 8 * 1024 * 1024;
    const rows = [
      row({ n: 1, bytes: eightMiB }),
      row({ n: 2, bytes: eightMiB }),
      row({ n: 3, bytes: eightMiB }),
    ];
    const out = selectDeliverableAttachments({ tenantId: TENANT, rows });
    expect(out).toHaveLength(2);
    const total = out.reduce((s, a) => s + a.bytes, 0);
    expect(total).toBeLessThanOrEqual(ATTACHMENT_DELIVERY_MAX_TOTAL_BYTES);
  });

  it("de-duplicates by id", () => {
    const dup = row({ n: 1 });
    const out = selectDeliverableAttachments({ tenantId: TENANT, rows: [dup, { ...dup }] });
    expect(out).toHaveLength(1);
  });

  it("is total — empty input yields empty output, never throws", () => {
    expect(selectDeliverableAttachments({ tenantId: TENANT, rows: [] })).toEqual([]);
  });
});

describe("image token / cost estimate", () => {
  it("estimates a flat upper-bound per image", () => {
    expect(estimateImageTokens(0)).toBe(0);
    expect(estimateImageTokens(1)).toBe(ESTIMATED_TOKENS_PER_IMAGE);
    expect(estimateImageTokens(3)).toBe(3 * ESTIMATED_TOKENS_PER_IMAGE);
    expect(estimateImageTokens(-2)).toBe(0);
  });
  it("prices images as input tokens only, rounding up", () => {
    // default tier input price is $3/Mtok → 1600 tok ≈ 0.0048$ → 1¢ (ceil).
    expect(estimateImageDeliveryCents(0, "default")).toBe(0);
    expect(estimateImageDeliveryCents(1, "default")).toBeGreaterThan(0);
    // A few images stay cheap (images are capped ~1600 tok each).
    expect(estimateImageDeliveryCents(ATTACHMENT_MAX_COUNT, "default")).toBeLessThan(10);
  });
});
