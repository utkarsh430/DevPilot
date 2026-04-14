import { describe, expect, it } from "vitest";
import {
  ACCEPTED_EXTENSIONS,
  ACCEPT_ATTR,
  MAX_EXTRACTED_CHARS,
  MAX_UPLOAD_BYTES,
  classifyUpload,
  truncateExtractedText,
} from "@/lib/projects/doc-extract";

describe("classifyUpload", () => {
  it("routes each supported extension to the right kind", () => {
    expect(classifyUpload({ filename: "spec.md", size: 100 })).toEqual({ ok: true, kind: "text" });
    expect(classifyUpload({ filename: "notes.markdown", size: 100 })).toEqual({
      ok: true,
      kind: "text",
    });
    expect(classifyUpload({ filename: "brief.txt", size: 100 })).toEqual({
      ok: true,
      kind: "text",
    });
    expect(classifyUpload({ filename: "prd.pdf", size: 100 })).toEqual({ ok: true, kind: "pdf" });
    expect(classifyUpload({ filename: "design.docx", size: 100 })).toEqual({
      ok: true,
      kind: "docx",
    });
  });

  it("is case-insensitive on the extension", () => {
    expect(classifyUpload({ filename: "SPEC.PDF", size: 100 })).toEqual({ ok: true, kind: "pdf" });
    expect(classifyUpload({ filename: "Notes.DOCX", size: 100 })).toEqual({
      ok: true,
      kind: "docx",
    });
  });

  it("uses the FINAL extension (a spoofed inner one doesn't matter)", () => {
    expect(classifyUpload({ filename: "resume.pdf.txt", size: 100 })).toEqual({
      ok: true,
      kind: "text",
    });
  });

  it("rejects an unknown extension with an actionable message", () => {
    const res = classifyUpload({ filename: "archive.zip", size: 100 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Unsupported file type/i);
  });

  it("rejects a file with no extension", () => {
    expect(classifyUpload({ filename: "README", size: 100 }).ok).toBe(false);
    expect(classifyUpload({ filename: "trailing.", size: 100 }).ok).toBe(false);
  });

  it("rejects an empty file", () => {
    const res = classifyUpload({ filename: "spec.md", size: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/empty/i);
  });

  it("rejects an oversized file at the byte cap", () => {
    expect(classifyUpload({ filename: "spec.pdf", size: MAX_UPLOAD_BYTES }).ok).toBe(true);
    const res = classifyUpload({ filename: "spec.pdf", size: MAX_UPLOAD_BYTES + 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too large/i);
  });

  it("keeps the accept-list and the accept attribute in sync", () => {
    expect(ACCEPTED_EXTENSIONS).toEqual(["md", "markdown", "txt", "pdf", "docx"]);
    expect(ACCEPT_ATTR).toBe(".md,.markdown,.txt,.pdf,.docx");
  });
});

describe("truncateExtractedText", () => {
  it("returns short text unchanged (trimmed)", () => {
    expect(truncateExtractedText("  hello world  ")).toBe("hello world");
  });

  it("normalises CRLF so the budget isn't spent on \\r", () => {
    expect(truncateExtractedText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("hard-caps to MAX_EXTRACTED_CHARS, keeping the HEAD", () => {
    const long = "H" + "x".repeat(MAX_EXTRACTED_CHARS + 5_000);
    const out = truncateExtractedText(long);
    expect(out.length).toBe(MAX_EXTRACTED_CHARS);
    expect(out[0]).toBe("H"); // head kept, not tail
  });

  it("honours a caller-supplied cap", () => {
    expect(truncateExtractedText("abcdef", 3)).toBe("abc");
  });
});
