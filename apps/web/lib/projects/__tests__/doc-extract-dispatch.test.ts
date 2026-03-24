import { describe, expect, it, vi } from "vitest";
import {
  MAX_EXTRACTED_CHARS,
  MAX_UPLOAD_BYTES,
  extractUploadTextWith,
  type Extractors,
} from "@/lib/projects/doc-extract";

/** A fake extractor set that records which kind was invoked and echoes a
 *  kind-tagged string, so we can assert routing without the real libs. */
function fakeExtractors(overrides: Partial<Extractors> = {}): {
  extractors: Extractors;
  calls: string[];
} {
  const calls: string[] = [];
  const tag = (kind: string): Extractors[keyof Extractors] =>
    vi.fn(async () => {
      calls.push(kind);
      return `text-from-${kind}`;
    });
  const extractors: Extractors = {
    text: tag("text"),
    pdf: tag("pdf"),
    docx: tag("docx"),
    ...overrides,
  };
  return { extractors, calls };
}

function input(name: string, size = 100, content = "hello") {
  return { name, size, bytes: async () => new TextEncoder().encode(content) };
}

describe("extractUploadTextWith — routing", () => {
  it("routes md/txt to the text extractor", async () => {
    for (const name of ["spec.md", "notes.markdown", "brief.txt"]) {
      const { extractors, calls } = fakeExtractors();
      const res = await extractUploadTextWith(input(name), extractors);
      expect(res).toEqual({ ok: true, text: "text-from-text" });
      expect(calls).toEqual(["text"]);
    }
  });

  it("routes .pdf to the pdf extractor only", async () => {
    const { extractors, calls } = fakeExtractors();
    const res = await extractUploadTextWith(input("prd.pdf"), extractors);
    expect(res).toEqual({ ok: true, text: "text-from-pdf" });
    expect(calls).toEqual(["pdf"]);
  });

  it("routes .docx to the docx extractor only", async () => {
    const { extractors, calls } = fakeExtractors();
    const res = await extractUploadTextWith(input("design.docx"), extractors);
    expect(res).toEqual({ ok: true, text: "text-from-docx" });
    expect(calls).toEqual(["docx"]);
  });
});

describe("extractUploadTextWith — rejects and bounds", () => {
  it("rejects an unknown type before touching any extractor", async () => {
    const { extractors, calls } = fakeExtractors();
    const res = await extractUploadTextWith(input("archive.zip"), extractors);
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("rejects an oversized file before touching any extractor", async () => {
    const { extractors, calls } = fakeExtractors();
    const res = await extractUploadTextWith(input("big.pdf", MAX_UPLOAD_BYTES + 1), extractors);
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("applies the truncation cap to extracted text", async () => {
    const huge = "x".repeat(MAX_EXTRACTED_CHARS + 1_000);
    const { extractors } = fakeExtractors({ text: async () => huge });
    const res = await extractUploadTextWith(input("spec.txt"), extractors);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text.length).toBe(MAX_EXTRACTED_CHARS);
  });

  it("maps an extractor throw to a friendly hard reject", async () => {
    const { extractors } = fakeExtractors({
      pdf: async () => {
        throw new Error("boom");
      },
    });
    const res = await extractUploadTextWith(input("prd.pdf"), extractors);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Couldn't read text from that PDF/i);
  });

  it("rejects a document that extracts to only whitespace", async () => {
    const { extractors } = fakeExtractors({ text: async () => "   \n\n  " });
    const res = await extractUploadTextWith(input("empty.txt"), extractors);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/No readable text/i);
  });
});
