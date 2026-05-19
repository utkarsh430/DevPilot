// Run artifacts — visual evidence OUT of a run. The pure, IO-free half.
//
// An agent driving `@playwright/mcp` can screenshot what it sees. Until now
// those images landed in a fixed temp directory that nothing read, uploaded, or
// cleaned. This module holds the rules that turn one of those files into a
// stored, attributable object: the MIME allowlist, the byte-signature sniff, the
// tenant-scoped key derivation, the caps, and the phrasing that makes the
// retention rule legible to the operator.
//
// Direction: this is the OPPOSITE path to lib/board/attachments.ts, which
// carries operator-supplied images INTO a run. The storage shape is deliberately
// the same (private bucket, `<tenant>/…` first segment); the trust direction is
// not. An inbound attachment is untrusted TO THE AGENT and gets a prompt fence.
// An outbound artifact is untrusted TO THE OPERATOR'S BROWSER, which is why the
// allowlist here is PNG/JPEG only (no SVG — an SVG is an active document, not a
// picture) and why the ingest route sniffs the body's magic bytes rather than
// believing a filename.
//
// Security posture (AGENTS.md — tenant isolation is the boundary): every object
// path is `"<tenant_id>/<run_id>/<step_idx>/<uuid>.<ext>"`, the bucket RLS keys
// on that first segment, and both the ingest route and the read path re-check it
// with `isKeyUnderTenant`.

// `isKeyUnderTenant` is the boundary check "this object path's first segment is
// EXACTLY this tenant". It is written once, in the attachments module, and
// imported here rather than copied: it mirrors a storage RLS predicate, and two
// copies of a boundary check is how one of them drifts.
import { isKeyUnderTenant } from "@/lib/board/attachments";

export { isKeyUnderTenant };

/** The bucket declared in `supabase/config.toml` and migration 20260748000000. */
export const ARTIFACT_BUCKET = "run-artifacts";

/**
 * MIME allowlist. Exactly the two formats @playwright/mcp emits — admitting
 * more would widen what the operator's browser is asked to render for no
 * capability gained. Keep in sync with the bucket's `allowed_mime_types` and the
 * table's CHECK constraint.
 */
export const ARTIFACT_MIME_ALLOWLIST = ["image/png", "image/jpeg"] as const;
export type ArtifactMime = (typeof ARTIFACT_MIME_ALLOWLIST)[number];

/** 5 MiB per file — must match the bucket `file_size_limit`. */
export const ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * How many images are kept per STEP, and per RUN.
 *
 * A long browser flow can capture many frames. Uploading all of them is a
 * storage bill and a haystack; uploading none defeats the feature. The per-step
 * cap keeps the NEWEST images (a flow's final frames are the assertion or the
 * failure; the earlier ones are usually navigation), and the per-run cap bounds
 * a run that screenshots on every one of its ~20 iterations.
 *
 * Neither cap is silent: every stored row carries `captured_total`, so the
 * inspector states what was dropped instead of quietly showing fewer.
 */
export const MAX_ARTIFACTS_PER_STEP = 4;
export const MAX_ARTIFACTS_PER_RUN = 20;

export function isAllowedArtifactMime(mime: string): mime is ArtifactMime {
  return (ARTIFACT_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

const EXT_BY_MIME: Record<ArtifactMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

/** File extension for a supported MIME, or null for anything off the allowlist. */
export function extensionForArtifactMime(mime: string): string | null {
  return isAllowedArtifactMime(mime) ? EXT_BY_MIME[mime] : null;
}

/**
 * Identify an image by its LEADING BYTES, not by its name.
 *
 * The bytes are agent-produced and end up rendered in an operator's browser, so
 * "the runner called it screenshot.png" is not evidence that it is a PNG. A
 * mismatch between the sniffed type and the claimed extension is a refusal at
 * the ingest route, not a correction — silently storing a file as whatever it
 * turned out to be would let a future capture source smuggle a type past the
 * allowlist review this list represents.
 *
 * Returns null for anything that is not a PNG or JPEG, including an empty or
 * truncated header.
 */
export function sniffImageMime(bytes: Uint8Array): ArtifactMime | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF (SOI + the first marker)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive the tenant-scoped object path
 * `"<tenantId>/<runId>/<stepIdx>/<fileId>.<ext>"`.
 *
 * Every segment is a validated uuid or a validated non-negative integer, so the
 * path can never be steered by attacker-controlled text, and the FIRST segment
 * is always the tenant so the bucket RLS scopes it. Returns null on any invalid
 * input — the caller drops the upload rather than guessing a path.
 */
export function buildArtifactStorageKey(args: {
  tenantId: string;
  runId: string;
  stepIdx: number;
  fileId: string;
  mime: string;
}): string | null {
  const ext = extensionForArtifactMime(args.mime);
  if (!ext) return null;
  if (!UUID_RE.test(args.tenantId) || !UUID_RE.test(args.runId) || !UUID_RE.test(args.fileId)) {
    return null;
  }
  if (!Number.isInteger(args.stepIdx) || args.stepIdx < 0) return null;
  return `${args.tenantId}/${args.runId}/${args.stepIdx}/${args.fileId}.${ext}`;
}

/** A stored artifact as the inspector needs it. `url` is a short-lived signed
 *  link minted at read time; it is never persisted. */
export type RunArtifact = {
  id: string;
  stepIdx: number;
  mime: ArtifactMime;
  bytes: number;
  /** 0-based position among the images the step captured, in capture order. */
  sequence: number;
  /** How many the step captured in total, including any the cap dropped. */
  capturedTotal: number;
  /** When the browser wrote the file (runner-host mtime), NOT when it was stored. */
  capturedAt: string;
  url: string | null;
};

/**
 * Group a run's artifacts by the step they were captured during. Steps with no
 * artifacts are absent (the inspector renders nothing for them).
 */
export function groupArtifactsByStep(
  artifacts: readonly RunArtifact[],
): Map<number, RunArtifact[]> {
  const out = new Map<number, RunArtifact[]>();
  for (const a of artifacts) {
    const list = out.get(a.stepIdx);
    if (list) list.push(a);
    else out.set(a.stepIdx, [a]);
  }
  for (const list of out.values()) list.sort((x, y) => x.sequence - y.sequence);
  return out;
}

/**
 * The sentence the inspector shows above a step's images.
 *
 * This exists so the cap is a stated rule rather than a silent truncation: when
 * a step captured more than it kept, the operator is told how many are missing
 * and which ones (the oldest). When nothing was dropped it says so plainly, so
 * "4 images" never has to be read as "at least 4 images".
 */
export function describeRetention(args: { shown: number; capturedTotal: number }): string {
  const { shown, capturedTotal } = args;
  const noun = (n: number) => (n === 1 ? "image" : "images");
  if (capturedTotal <= shown) {
    return `${shown} ${noun(shown)} captured during this step — all kept.`;
  }
  const dropped = capturedTotal - shown;
  return (
    `Showing the ${shown} most recent of ${capturedTotal} ${noun(capturedTotal)} captured ` +
    `during this step — the ${dropped} oldest ${dropped === 1 ? "was" : "were"} dropped ` +
    `(cap: ${MAX_ARTIFACTS_PER_STEP} per step).`
  );
}

/**
 * The precision disclaimer rendered beside a step's images.
 *
 * DevPilot can prove WHICH STEP wrote each file — the browser server runs inside
 * exactly one `claude -p` invocation with an output directory unique to that
 * invocation — but not which tool call inside the step. Saying so is the
 * difference between evidence and a misleading label; an operator who believes
 * an image is pinned to a specific action will read a false story into it.
 */
export const ARTIFACT_PRECISION_NOTE =
  "Captured by the agent's browser during this step. DevPilot can attribute each " +
  "image to the step that wrote it, but not to a specific action within the step — " +
  "use the capture time to order them.";
