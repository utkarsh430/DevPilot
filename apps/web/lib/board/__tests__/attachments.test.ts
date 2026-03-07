// Ticket image attachments — the pure guardrails. A regression here is a hole
// in the tenant-isolation boundary (a mis-scoped storage key) or in the
// MIME/size validation the bucket also enforces, so these are pinned tests, not
// cosmetic ones.

import { describe, it, expect } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  buildAttachmentStorageKey,
  extensionForMime,
  isAllowedAttachmentMime,
  isKeyUnderTenant,
  sanitizeAttachmentsForInsert,
  validateAttachmentFile,
  type AttachmentInput,
} from "@/lib/board/attachments";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const DRAFT = "33333333-3333-3333-3333-333333333333";
const FILE = "44444444-4444-4444-4444-444444444444";

describe("isAllowedAttachmentMime", () => {
  it("accepts the four allowlisted image types", () => {
    for (const m of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(isAllowedAttachmentMime(m)).toBe(true);
    }
  });
  it("rejects everything else, including svg and pdf", () => {
    for (const m of ["image/svg+xml", "application/pdf", "text/html", "", "image/PNG"]) {
      expect(isAllowedAttachmentMime(m)).toBe(false);
    }
  });
});

describe("extensionForMime", () => {
  it("maps allowlisted types to a bare extension", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/webp")).toBe("webp");
    expect(extensionForMime("image/gif")).toBe("gif");
  });
  it("returns null for a disallowed type", () => {
    expect(extensionForMime("image/svg+xml")).toBeNull();
  });
});

describe("validateAttachmentFile", () => {
  it("accepts a normal png under the cap", () => {
    const r = validateAttachmentFile({ type: "image/png", size: 1024 });
    expect(r.ok).toBe(true);
  });
  it("rejects a disallowed MIME", () => {
    const r = validateAttachmentFile({ type: "application/pdf", size: 1024 });
    expect(r).toEqual({ ok: false, refusal: expect.objectContaining({ code: "mime" }) });
  });
  it("rejects an empty file", () => {
    const r = validateAttachmentFile({ type: "image/png", size: 0 });
    expect(r).toEqual({ ok: false, refusal: expect.objectContaining({ code: "empty" }) });
  });
  it("rejects a file over the size cap", () => {
    const r = validateAttachmentFile({ type: "image/png", size: ATTACHMENT_MAX_BYTES + 1 });
    expect(r).toEqual({ ok: false, refusal: expect.objectContaining({ code: "too-large" }) });
  });
  it("accepts a file exactly at the cap", () => {
    const r = validateAttachmentFile({ type: "image/png", size: ATTACHMENT_MAX_BYTES });
    expect(r.ok).toBe(true);
  });
});

describe("buildAttachmentStorageKey", () => {
  it("derives a tenant-first path with the right extension", () => {
    expect(
      buildAttachmentStorageKey({
        tenantId: TENANT,
        draftId: DRAFT,
        fileId: FILE,
        mime: "image/png",
      }),
    ).toBe(`${TENANT}/${DRAFT}/${FILE}.png`);
  });
  it("returns null for a disallowed mime", () => {
    expect(
      buildAttachmentStorageKey({
        tenantId: TENANT,
        draftId: DRAFT,
        fileId: FILE,
        mime: "image/svg+xml",
      }),
    ).toBeNull();
  });
  it("returns null when any segment is not a uuid (no path injection)", () => {
    expect(
      buildAttachmentStorageKey({
        tenantId: "../../etc",
        draftId: DRAFT,
        fileId: FILE,
        mime: "image/png",
      }),
    ).toBeNull();
    expect(
      buildAttachmentStorageKey({
        tenantId: TENANT,
        draftId: "a/b",
        fileId: FILE,
        mime: "image/png",
      }),
    ).toBeNull();
  });
});

describe("isKeyUnderTenant", () => {
  it("accepts a key whose first segment is exactly the tenant", () => {
    expect(isKeyUnderTenant(`${TENANT}/${DRAFT}/${FILE}.png`, TENANT)).toBe(true);
  });
  it("rejects a key scoped to another tenant", () => {
    expect(isKeyUnderTenant(`${OTHER_TENANT}/${DRAFT}/${FILE}.png`, TENANT)).toBe(false);
  });
  it("rejects a prefix-collision attempt (tenant id as a substring)", () => {
    expect(isKeyUnderTenant(`${TENANT}-evil/x.png`, TENANT)).toBe(false);
  });
  it("rejects a key with no folder segment", () => {
    expect(isKeyUnderTenant(`${TENANT}.png`, TENANT)).toBe(false);
    expect(isKeyUnderTenant(`/${TENANT}/x.png`, TENANT)).toBe(false);
  });
});

describe("sanitizeAttachmentsForInsert", () => {
  const good: AttachmentInput = {
    storageKey: `${TENANT}/${DRAFT}/${FILE}.png`,
    mime: "image/png",
    bytes: 2048,
  };

  it("keeps a valid tenant-scoped attachment", () => {
    expect(sanitizeAttachmentsForInsert({ tenantId: TENANT, attachments: [good] })).toEqual([good]);
  });

  it("drops a cross-tenant key (the isolation boundary)", () => {
    const evil: AttachmentInput = {
      storageKey: `${OTHER_TENANT}/${DRAFT}/${FILE}.png`,
      mime: "image/png",
      bytes: 2048,
    };
    expect(sanitizeAttachmentsForInsert({ tenantId: TENANT, attachments: [evil] })).toEqual([]);
  });

  it("drops disallowed MIME and oversized/empty byte counts", () => {
    const badMime: AttachmentInput = { ...good, mime: "application/pdf" };
    const tooBig: AttachmentInput = { ...good, bytes: ATTACHMENT_MAX_BYTES + 1 };
    const empty: AttachmentInput = { ...good, bytes: 0 };
    expect(
      sanitizeAttachmentsForInsert({ tenantId: TENANT, attachments: [badMime, tooBig, empty] }),
    ).toEqual([]);
  });

  it("de-duplicates repeated storage keys", () => {
    expect(
      sanitizeAttachmentsForInsert({ tenantId: TENANT, attachments: [good, { ...good }] }),
    ).toEqual([good]);
  });

  it("caps the number of accepted attachments", () => {
    const many: AttachmentInput[] = Array.from({ length: ATTACHMENT_MAX_COUNT + 3 }, (_, i) => ({
      storageKey: `${TENANT}/${DRAFT}/${"5".repeat(8)}-5555-5555-5555-${String(i).padStart(12, "0")}.png`,
      mime: "image/png",
      bytes: 1024,
    }));
    expect(sanitizeAttachmentsForInsert({ tenantId: TENANT, attachments: many })).toHaveLength(
      ATTACHMENT_MAX_COUNT,
    );
  });

  it("floors a fractional byte count", () => {
    const frac: AttachmentInput = { ...good, bytes: 2048.9 };
    expect(sanitizeAttachmentsForInsert({ tenantId: TENANT, attachments: [frac] })[0]?.bytes).toBe(
      2048,
    );
  });
});
