// Ticket image attachments (Phase 1-2) — the pure, IO-free half.
//
// Capture-side validation (MIME allowlist, size cap, max count) and the
// tenant-scoped storage-key derivation both live here so the browser dialog,
// the create server action, and the migration's bucket config all agree on ONE
// set of rules and ONE path shape — and so the path/validation logic is
// unit-testable without a browser or a live Supabase.
//
// Security posture (AGENTS.md — tenant isolation is the boundary): every object
// path is scoped to `<tenant_id>/…`. The storage bucket RLS keys on that first
// segment, the client derives it from its own tenant, and the create server
// action re-checks it (`isKeyUnderTenant`) before writing any `ticket_attachments`
// row, so a tampered client cannot slip a key that points at another tenant's
// folder. A pasted image is UNTRUSTED content (principle 6): storing/displaying
// is fine, but Phase 3 (delivering it to a working agent) MUST fence it as data.

/** The bucket declared in `supabase/config.toml` and the prod migration. */
export const ATTACHMENT_BUCKET = "ticket-attachments";

/** MIME allowlist — enforced client-side (UX), by the bucket config (boundary),
 *  and re-checked when a row is written. Keep in sync with the bucket's
 *  `allowed_mime_types`. */
export const ATTACHMENT_MIME_ALLOWLIST = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIME_ALLOWLIST)[number];

/** 10 MiB per file — must match the bucket `file_size_limit`. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Max images per ticket. A capture cap so a paste-storm can't balloon a ticket. */
export const ATTACHMENT_MAX_COUNT = 6;

export function isAllowedAttachmentMime(mime: string): mime is AttachmentMime {
  return (ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

const EXT_BY_MIME: Record<AttachmentMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** File extension for a supported MIME, or null for anything off the allowlist. */
export function extensionForMime(mime: string): string | null {
  return isAllowedAttachmentMime(mime) ? EXT_BY_MIME[mime] : null;
}

export function maxBytesLabel(): string {
  return `${Math.floor(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB`;
}

export type AttachmentRefusalCode = "mime" | "too-large" | "empty";
export type AttachmentRefusal = { code: AttachmentRefusalCode; reason: string };

/**
 * Client-side per-file validation. The bucket config is the real boundary
 * (Supabase rejects a disallowed MIME / oversized upload server-side), but the
 * dialog checks first so the operator gets an instant, specific message instead
 * of an opaque upload failure.
 */
export function validateAttachmentFile(file: {
  type: string;
  size: number;
}): { ok: true; mime: AttachmentMime } | { ok: false; refusal: AttachmentRefusal } {
  if (!isAllowedAttachmentMime(file.type)) {
    return {
      ok: false,
      refusal: {
        code: "mime",
        reason: `Unsupported image type ${file.type || "(unknown)"} — PNG, JPEG, WebP or GIF only.`,
      },
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, refusal: { code: "empty", reason: "File is empty." } };
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      refusal: { code: "too-large", reason: `Image is too large (max ${maxBytesLabel()}).` },
    };
  }
  return { ok: true, mime: file.type };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive the tenant-scoped object path `"<tenantId>/<draftId>/<fileId>.<ext>"`.
 *
 * `draftId` is the ticket id when it already exists, or a per-dialog draft uuid
 * when the ticket hasn't been created yet (upload happens before create — the
 * key is stable and never moved, only the `ticket_attachments` row ties it to
 * the ticket). Every segment is a validated uuid so the path can't be steered
 * with attacker-controlled text, and the first segment is ALWAYS the tenant so
 * the bucket RLS scopes it. Returns null on any invalid input.
 */
export function buildAttachmentStorageKey(args: {
  tenantId: string;
  draftId: string;
  fileId: string;
  mime: string;
}): string | null {
  const ext = extensionForMime(args.mime);
  if (!ext) return null;
  if (!UUID_RE.test(args.tenantId) || !UUID_RE.test(args.draftId) || !UUID_RE.test(args.fileId)) {
    return null;
  }
  return `${args.tenantId}/${args.draftId}/${args.fileId}.${ext}`;
}

/**
 * The server boundary check: a storage key is acceptable only when its first
 * path segment is EXACTLY the caller's tenant id. Mirrors the bucket RLS's
 * `(storage.foldername(name))[1] = tenant_id` so a tampered client payload can
 * never register a row pointing at another tenant's folder.
 */
export function isKeyUnderTenant(storageKey: string, tenantId: string): boolean {
  if (!UUID_RE.test(tenantId)) return false;
  const firstSlash = storageKey.indexOf("/");
  if (firstSlash <= 0) return false;
  return storageKey.slice(0, firstSlash) === tenantId;
}

export type AttachmentInput = { storageKey: string; mime: string; bytes: number };

/**
 * Filter a client-supplied attachment list down to the rows that are safe to
 * insert: tenant-scoped key, allowlisted MIME, sane byte count, de-duplicated,
 * and capped at `ATTACHMENT_MAX_COUNT`. Pure and total — never throws — so the
 * best-effort create path can call it and simply drop anything invalid rather
 * than failing the ticket create.
 */
export function sanitizeAttachmentsForInsert(args: {
  tenantId: string;
  attachments: readonly AttachmentInput[];
}): AttachmentInput[] {
  const clean: AttachmentInput[] = [];
  const seen = new Set<string>();
  for (const a of args.attachments) {
    if (clean.length >= ATTACHMENT_MAX_COUNT) break;
    if (!isKeyUnderTenant(a.storageKey, args.tenantId)) continue;
    if (!isAllowedAttachmentMime(a.mime)) continue;
    if (!Number.isFinite(a.bytes) || a.bytes <= 0 || a.bytes > ATTACHMENT_MAX_BYTES) continue;
    if (seen.has(a.storageKey)) continue;
    seen.add(a.storageKey);
    clean.push({ storageKey: a.storageKey, mime: a.mime, bytes: Math.floor(a.bytes) });
  }
  return clean;
}
