// Document upload → project seed: the PURE half of the text-extraction step.
//
// Classifies an uploaded file (by extension, cross-checked against a size cap)
// into one of the three supported kinds, and bounds the extracted text before
// it reaches the model. The actual PDF/docx parsing (which needs the extractor
// libraries) lives server-side in `doc-extract.server.ts`; this module is
// dependency-free so it can be unit-tested and reasoned about in isolation.
//
// Security posture: the uploaded document is attacker-influenced content that
// lands near the top of a plan prompt (principle 6). The extension is the
// authority for routing (a browser-supplied MIME type is trivially spoofed and
// often empty), the byte cap is enforced BEFORE any parse, and the extracted
// text is hard-truncated to `MAX_EXTRACTED_CHARS` BEFORE the LLM call — the
// same "cap it before the model sees it" discipline as dep-suggest's 2000-char
// bound and infer-capabilities' fence budgets.

/** The three upload kinds we can turn into text server-side. */
export type UploadKind = "text" | "pdf" | "docx";

/** Hard ceiling on the uploaded file size. A spec/PRD is prose; anything past
 *  this is not a seed doc and is rejected rather than parsed. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/** Hard ceiling on extracted text handed to the model. Bounds the untrusted
 *  content's footprint in the prompt AND the token spend of the distill call. */
export const MAX_EXTRACTED_CHARS = 16_000;

/** Extension → kind. The extension is the routing authority; MIME is advisory
 *  only (spoofable, frequently empty from the browser). */
const EXTENSION_KIND: ReadonlyMap<string, UploadKind> = new Map([
  ["md", "text"],
  ["markdown", "text"],
  ["txt", "text"],
  ["pdf", "pdf"],
  ["docx", "docx"],
]);

/** Human-facing list of accepted extensions, for error copy and the `accept`
 *  attribute. Derived from the map so the two can't drift. */
export const ACCEPTED_EXTENSIONS: readonly string[] = [...EXTENSION_KIND.keys()];

/** The `accept` attribute value for the file input. */
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(",");

export type ClassifyResult = { ok: true; kind: UploadKind } | { ok: false; error: string };

/** Lowercased final extension of a filename, or "" when there is none. */
function extensionOf(filename: string): string {
  const base = filename.trim().toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1);
}

/**
 * Validate + classify an uploaded file. Rejects empty, oversized, and
 * unknown-extension files with an operator-actionable message; on success
 * returns the parse route. Pure — takes only the metadata, never the bytes.
 */
export function classifyUpload(args: { filename: string; size: number }): ClassifyResult {
  if (args.size <= 0) {
    return { ok: false, error: "That file is empty — nothing to read." };
  }
  if (args.size > MAX_UPLOAD_BYTES) {
    const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
    return { ok: false, error: `That file is too large — keep it under ${mb} MB.` };
  }
  const ext = extensionOf(args.filename);
  const kind = EXTENSION_KIND.get(ext);
  if (!kind) {
    return {
      ok: false,
      error: `Unsupported file type. Upload one of: ${ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(", ")}.`,
    };
  }
  return { ok: true, kind };
}

/**
 * Bound extracted text to `MAX_EXTRACTED_CHARS`. Keeps the HEAD of the document
 * (a spec/PRD front-loads the summary, name, and goals — the tail is appendix),
 * which is the opposite of `fenceUntrustedOutput`'s tail-keep for chronological
 * command output. Normalises CRLF so the char budget isn't spent on `\r`.
 */
export function truncateExtractedText(text: string, cap: number = MAX_EXTRACTED_CHARS): string {
  const normalised = text.replace(/\r\n?/g, "\n").trim();
  return normalised.length > cap ? normalised.slice(0, cap) : normalised;
}

// ─── extraction orchestration (pure; extractors injected) ────────────────────

export type ExtractTextResult = { ok: true; text: string } | { ok: false; error: string };

/** Decode raw bytes for one kind into text. Throws on a corrupt document. The
 *  real implementations (unpdf / mammoth / UTF-8) are supplied by the server
 *  wrapper; tests inject fakes at this exact boundary. */
export type KindExtractor = (bytes: Uint8Array) => Promise<string>;
export type Extractors = Record<UploadKind, KindExtractor>;

/** A minimal `File`-shaped input, so the orchestration is testable without the
 *  DOM/Node `File` global and without importing the extractor libs. */
export type UploadInput = {
  name: string;
  size: number;
  bytes: () => Promise<Uint8Array>;
};

/**
 * Validate → extract (via the injected extractor for the classified kind) →
 * truncate → reject-if-empty. Pure: the only IO is the caller-supplied
 * `bytes()` and `extractors`. This is the single orchestration both the server
 * wrapper and the unit tests exercise.
 *
 * `ok:false` is a HARD reject of an unusable FILE (unknown type / oversized /
 * empty / a document we couldn't read, i.e. an extractor throw). It is distinct
 * from the downstream DISTILL failing, which degrades to raw text and never
 * blocks the create (see extract-seed.server.ts).
 */
export async function extractUploadTextWith(
  file: UploadInput,
  extractors: Extractors,
): Promise<ExtractTextResult> {
  const classified = classifyUpload({ filename: file.name, size: file.size });
  if (!classified.ok) return classified;

  let raw: string;
  try {
    const bytes = await file.bytes();
    raw = await extractors[classified.kind](bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[project-seed] text extraction failed (${classified.kind}): ${msg}`);
    return {
      ok: false,
      error: `Couldn't read text from that ${
        classified.kind === "text" ? "file" : classified.kind.toUpperCase()
      }. It may be corrupt or password-protected.`,
    };
  }

  const text = truncateExtractedText(raw);
  if (text.length === 0) {
    return {
      ok: false,
      error:
        "No readable text found in that document (a scanned/image-only PDF has no text layer).",
    };
  }
  return { ok: true, text };
}
