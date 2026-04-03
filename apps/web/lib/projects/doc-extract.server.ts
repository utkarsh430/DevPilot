import "server-only";

// Document upload → project seed: the IO half of the text-extraction step.
//
// Supplies the REAL, lib-backed extractors to the pure orchestration in
// `doc-extract.ts` and adapts a browser `File` into its `UploadInput` shape.
// Extraction is server-side ONLY:
//   - text (.md/.markdown/.txt): decoded as UTF-8.
//   - pdf: `unpdf` (MIT, zero runtime deps — bundles pdf.js; serverless-safe,
//     no worker setup). Pinned in package.json.
//   - docx: `mammoth` (BSD-2). `extractRawText` gives the document text with
//     none of the HTML styling we don't need. Pinned in package.json.
//
// We deliberately do NOT extend the runner / one-shot seam to pass files to
// `claude` — extraction stays text-on-the-server, and only the resulting text
// crosses into the LLM distill (AGENTS.md: that cross-app change is out of
// scope). The file is parsed and discarded — never written to storage.

import {
  extractUploadTextWith,
  type ExtractTextResult,
  type Extractors,
} from "@/lib/projects/doc-extract";

const REAL_EXTRACTORS: Extractors = {
  text: async (bytes) => new TextDecoder("utf-8", { fatal: false }).decode(bytes),
  pdf: async (bytes) => {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  },
  docx: async (bytes) => {
    const mammoth = (await import("mammoth")).default;
    // mammoth wants a Node Buffer; convert from the Uint8Array we hold.
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return value;
  },
};

/**
 * Turn an uploaded `File` into bounded plain text. The single server entry
 * point for the text-extraction step. See `extractUploadTextWith` for the
 * validation/reject contract.
 */
export async function extractUploadText(file: File): Promise<ExtractTextResult> {
  return extractUploadTextWith(
    {
      name: file.name,
      size: file.size,
      bytes: async () => new Uint8Array(await file.arrayBuffer()),
    },
    REAL_EXTRACTORS,
  );
}
