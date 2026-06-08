// Run-artifact rules — the pure half.
//
// Two of these carry real weight rather than being schema restatements:
//
//  • `sniffImageMime` is what stops a name deciding a type. These bytes are
//    agent-produced and end up rendered in an operator's browser, so a file
//    called `shot.png` that is actually something else must be refused, not
//    stored as whatever it turned out to be.
//  • `describeRetention` is the cap made legible. A cap the operator cannot see
//    is indistinguishable from "that is all there was", so the wording has to
//    state the drop AND which end it came from.

import { describe, expect, it } from "vitest";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_PRECISION_NOTE,
  buildArtifactStorageKey,
  describeRetention,
  extensionForArtifactMime,
  groupArtifactsByStep,
  isAllowedArtifactMime,
  isKeyUnderTenant,
  MAX_ARTIFACTS_PER_STEP,
  sniffImageMime,
  type RunArtifact,
} from "@/lib/runs/artifacts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const RUN = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe("mime allowlist", () => {
  it("admits exactly the two formats @playwright/mcp emits", () => {
    expect(isAllowedArtifactMime("image/png")).toBe(true);
    expect(isAllowedArtifactMime("image/jpeg")).toBe(true);
  });

  it("refuses SVG — an SVG is an active document, not a picture", () => {
    expect(isAllowedArtifactMime("image/svg+xml")).toBe(false);
    expect(extensionForArtifactMime("image/svg+xml")).toBeNull();
  });

  it("refuses types the inbound attachment path allows but this one does not", () => {
    // ticket-attachments admits webp/gif; widening here would enlarge what the
    // operator's browser renders from agent-produced bytes for no capability.
    expect(isAllowedArtifactMime("image/webp")).toBe(false);
    expect(isAllowedArtifactMime("image/gif")).toBe(false);
  });

  it("refuses text/html", () => {
    expect(isAllowedArtifactMime("text/html")).toBe(false);
  });
});

describe("sniffImageMime — content decides the type, never the name", () => {
  it("identifies a PNG by its 8-byte signature", () => {
    expect(sniffImageMime(PNG_HEADER)).toBe("image/png");
  });

  it("identifies a JPEG by SOI + marker", () => {
    expect(sniffImageMime(JPEG_HEADER)).toBe("image/jpeg");
  });

  it("refuses an HTML document even though it could be named .png", () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect(sniffImageMime(html)).toBeNull();
  });

  it("refuses an SVG document", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageMime(svg)).toBeNull();
  });

  it("refuses a truncated PNG signature rather than guessing", () => {
    expect(sniffImageMime(PNG_HEADER.slice(0, 4))).toBeNull();
  });

  it("refuses empty input", () => {
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });
});

describe("storage key derivation", () => {
  it("puts the tenant first, so the bucket RLS scopes it", () => {
    const key = buildArtifactStorageKey({
      tenantId: TENANT,
      runId: RUN,
      stepIdx: 3,
      fileId: FILE,
      mime: "image/png",
    });
    expect(key).toBe(`${TENANT}/${RUN}/3/${FILE}.png`);
    expect(isKeyUnderTenant(key!, TENANT)).toBe(true);
    expect(isKeyUnderTenant(key!, OTHER_TENANT)).toBe(false);
  });

  it("refuses a non-uuid segment rather than composing a path from it", () => {
    expect(
      buildArtifactStorageKey({
        tenantId: "../etc",
        runId: RUN,
        stepIdx: 0,
        fileId: FILE,
        mime: "image/png",
      }),
    ).toBeNull();
    expect(
      buildArtifactStorageKey({
        tenantId: TENANT,
        runId: "not-a-uuid",
        stepIdx: 0,
        fileId: FILE,
        mime: "image/png",
      }),
    ).toBeNull();
  });

  it("refuses a negative or fractional step index", () => {
    for (const stepIdx of [-1, 1.5, NaN]) {
      expect(
        buildArtifactStorageKey({
          tenantId: TENANT,
          runId: RUN,
          stepIdx,
          fileId: FILE,
          mime: "image/png",
        }),
      ).toBeNull();
    }
  });

  it("refuses an off-allowlist mime before it can pick an extension", () => {
    expect(
      buildArtifactStorageKey({
        tenantId: TENANT,
        runId: RUN,
        stepIdx: 0,
        fileId: FILE,
        mime: "image/svg+xml",
      }),
    ).toBeNull();
  });
});

describe("describeRetention — the cap is stated, never silent", () => {
  it("says outright when nothing was dropped", () => {
    const s = describeRetention({ shown: 2, capturedTotal: 2 });
    expect(s).toContain("all kept");
    // "2 images" must not be readable as "at least 2 images".
    expect(s).not.toContain("most recent");
  });

  it("names the number dropped AND which end they came from", () => {
    const s = describeRetention({ shown: 4, capturedTotal: 9 });
    expect(s).toContain("4");
    expect(s).toContain("9");
    expect(s).toContain("5 oldest");
    expect(s).toContain("most recent");
    expect(s).toContain(String(MAX_ARTIFACTS_PER_STEP));
  });

  it("uses singular wording for a single dropped image", () => {
    expect(describeRetention({ shown: 4, capturedTotal: 5 })).toContain("1 oldest was dropped");
  });
});

describe("the precision note", () => {
  it("claims step attribution and explicitly disclaims per-action attribution", () => {
    // The honesty requirement: an operator who reads an image as pinned to a
    // specific tool call will draw a confident wrong conclusion. Both halves of
    // the sentence have to survive an edit.
    expect(ARTIFACT_PRECISION_NOTE).toContain("step");
    expect(ARTIFACT_PRECISION_NOTE).toMatch(/not to a specific action/i);
  });
});

describe("groupArtifactsByStep", () => {
  const art = (id: string, stepIdx: number, sequence: number): RunArtifact => ({
    id,
    stepIdx,
    mime: "image/png",
    bytes: 100,
    sequence,
    capturedTotal: 3,
    capturedAt: "2026-07-19T00:00:00.000Z",
    url: null,
  });

  it("keys on the step index and orders within a step by capture sequence", () => {
    const byStep = groupArtifactsByStep([art("b", 1, 2), art("a", 1, 0), art("c", 4, 1)]);
    expect(byStep.get(1)!.map((a) => a.id)).toEqual(["a", "b"]);
    expect(byStep.get(4)!.map((a) => a.id)).toEqual(["c"]);
  });

  it("has no entry for a step that captured nothing", () => {
    expect(groupArtifactsByStep([art("a", 1, 0)]).has(2)).toBe(false);
  });
});

describe("caps agree with the bucket", () => {
  it("pins the per-file cap that the bucket file_size_limit mirrors", () => {
    // 5 MiB — migration 20260748000000 and config.toml both say so.
    expect(ARTIFACT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});
