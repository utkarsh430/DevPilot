import "server-only";

// Resolve a ticket's image attachments to BYTES so the exported PDF is
// self-contained.
//
// An audit artifact that reaches back to a 5-minute signed URL at view time is
// not a record — it is a viewer that stops working. So the export embeds the
// image data directly, which means the server has to fetch each object once,
// under tight bounds, on the request path.
//
// ── The bounds, and why each one is here ────────────────────────────────────
//  • WHICH rows: `selectDeliverableAttachments` (the same predicate the runner
//    delivery path uses) — image MIME on the allowlist, storage key scoped to
//    the ticket's OWN tenant, per-file and total-byte caps, count cap. Reused
//    rather than re-implemented so there is one answer to "which images may
//    leave the tenant boundary".
//  • WHERE from: the signed URL is minted server-side from the key we read off
//    the ticket's own row. A caller never supplies a URL or a key, so there is
//    no parameter to point at someone else's object or at an internal host.
//  • SSRF: the signed URL's origin is re-checked against the configured Supabase
//    URL before the fetch. `createSignedUrl` returns a URL derived from our own
//    config today, but a fetch of a value that came back from a service is still
//    a fetch of a value we did not construct — pinning the host makes that
//    explicit and keeps a future config/proxy change from turning this into an
//    open fetcher.
//  • SVG: rejected. It is not on the attachment MIME allowlist, and it is an
//    active-content format (scripts, external refs) that has no business being
//    parsed here. Stated explicitly because "it's an image" is exactly how SVG
//    gets waved through.
//  • Time + size: `AbortSignal.timeout` per object, plus a hard byte ceiling
//    checked against the ROW's recorded size BEFORE anything is signed or
//    fetched — so an oversized object costs no round trip at all. The buffered
//    length is re-checked afterwards as defence in depth (the row's `bytes` is
//    what the uploader reported; the object is the truth). The header used to
//    claim a ceiling "read off the response" while the only check ran after
//    `arrayBuffer()` had already buffered the whole body — the doc described the
//    intent and the code did something laxer.
//
// ── Failure posture: degrade, never fail ────────────────────────────────────
// Every failure yields `dataUri: null` + an `unavailableReason` the renderer
// draws as a placeholder. The rest of the record — narration, cost, evidence,
// the thread — is still worth delivering, and an image that would not load is
// itself an honest thing for the artifact to say. This is deliberately the
// OPPOSITE of the land-state / verification reads, which fail loud: a missing
// picture misleads nobody, a missing QA verdict does.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ATTACHMENT_BUCKET } from "@/lib/board/attachments";
import { selectDeliverableAttachments, type AttachmentRow } from "@/lib/board/attachment-delivery";
import type { ExportAttachment } from "@/lib/export/types";

/** Signed-URL lifetime. Only has to outlive our own immediate fetch. */
const SIGNED_URL_TTL_SECONDS = 120;
/** Per-object fetch timeout. */
const FETCH_TIMEOUT_MS = 8_000;
/** Hard per-object byte ceiling for the embed (below the 10 MiB capture cap:
 *  an embedded image is base64, which costs ~33% more again in the PDF). */
const MAX_EMBED_BYTES = 6 * 1024 * 1024;

/**
 * The formats react-pdf can actually DRAW — a strict subset of what the ticket
 * attachment allowlist accepts.
 *
 * `lib/board/attachments.ts` admits png/jpeg/**webp/gif** (right for capture and
 * for the browser drawer, which renders all four). react-pdf's decoder
 * (@react-pdf/image) handles only PNG, JPEG and SVG. Hand it a `data:image/webp`
 * and — on 4.5.1, verified — it does NOT throw: it logs `Base64 image invalid
 * format: webp` to the server console and renders the page with the image
 * SILENTLY MISSING. No error, no placeholder, no gap in the layout.
 *
 * That is worse than a crash for this document, not better: an audit PDF that
 * quietly omits a piece of attached evidence, while still showing the caption
 * that says an attachment exists, misleads a reader who has no way to know
 * anything was dropped. And webp is not exotic — Chrome's "copy image" and many
 * capture tools produce it by default.
 *
 * So the check moves here, BEFORE the data URI is built: an un-drawable format
 * degrades through exactly the same `dataUri: null` + reason path as a missing
 * object, which the renderer already draws as a visible placeholder. It also
 * means a future react-pdf that DOES throw on a bad format can never be handed
 * one.
 *
 * SVG is deliberately absent even though react-pdf supports it: it is not on the
 * attachment MIME allowlist (it is active content — scripts, external refs), so
 * it can never reach here, and listing it would invite someone to add it.
 *
 * Follow-up if operators paste webp often: transcode to PNG server-side. That
 * needs a native image dep (sharp), which is a real cost to weigh against a
 * placeholder that tells the truth.
 */
const EMBEDDABLE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

function unavailable(row: AttachmentRow, reason: string): ExportAttachment {
  return { id: row.id, mime: row.mime, bytes: row.bytes, dataUri: null, unavailableReason: reason };
}

/**
 * True iff `url` is on the same origin as our configured Supabase project.
 * Compared as parsed ORIGINS, never as a string prefix — `https://evil.com/?x=
 * https://proj.supabase.co` starts with nothing useful, but a naive
 * `startsWith` on a crafted URL is the classic way this check gets defeated.
 */
function isSupabaseOrigin(url: string): boolean {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return false;
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

async function fetchOne(supabase: SupabaseClient, row: AttachmentRow): Promise<ExportAttachment> {
  // Cheap refusals FIRST, before signing or fetching anything: neither of these
  // can be fixed by pulling the bytes, so pulling them is pure waste.

  // A webp/gif is never going to be drawable (see EMBEDDABLE_MIMES).
  if (!EMBEDDABLE_MIMES.has(row.mime)) {
    return unavailable(
      row,
      `${row.mime} cannot be embedded in a PDF (PNG and JPEG only) — view it on the ticket`,
    );
  }

  // Oversized per the row's recorded size. Checking here rather than only after
  // `arrayBuffer()` means an oversized object costs no round trip; the buffered
  // length is still re-checked below, because `bytes` is what the uploader
  // claimed and the object itself is the truth.
  if (Number.isFinite(row.bytes) && row.bytes > MAX_EMBED_BYTES) {
    return unavailable(row, "too large to embed in the export");
  }

  const { data: signed, error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(row.storageKey, SIGNED_URL_TTL_SECONDS);
  if (error || !signed?.signedUrl) {
    return unavailable(row, "could not be signed for export");
  }
  if (!isSupabaseOrigin(signed.signedUrl)) {
    return unavailable(row, "storage URL failed the origin check");
  }

  // The fetch AND the body read are both inside the try. The body read is the
  // half that used to sit outside it, which was a real hole: `fetch` resolves as
  // soon as HEADERS arrive, so a storage stall mid-body — or the 8s abort firing
  // during the read — throws from `arrayBuffer()`, and that throw escaped this
  // function, propagated out of `renderToStream`, and killed the whole export.
  // Every other image failure degrades to a placeholder; this one has to as well.
  let buf: Buffer;
  try {
    const res = await fetch(signed.signedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return unavailable(row, `storage returned HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    return unavailable(row, "storage fetch failed or timed out");
  }

  if (buf.byteLength === 0) return unavailable(row, "stored object is empty");
  // Re-check against what actually arrived: `row.bytes` above is the uploader's
  // claim, this is the object.
  if (buf.byteLength > MAX_EMBED_BYTES) {
    return unavailable(row, "too large to embed in the export");
  }

  return {
    id: row.id,
    // Trust the row's MIME (CHECK-constrained, allowlisted at write time, and
    // re-checked against EMBEDDABLE_MIMES above) rather than the response's
    // Content-Type — the latter is the storage service's opinion, and we have
    // already decided what this object is allowed to be.
    mime: row.mime,
    bytes: buf.byteLength,
    dataUri: `data:${row.mime};base64,${buf.toString("base64")}`,
    unavailableReason: null,
  };
}

/**
 * Resolve a ticket's attachment rows into embeddable images.
 *
 * `tenantId` MUST be the tenant of the ticket the rows were loaded from (the
 * caller derives it from the row, never from a request parameter) — it is what
 * `selectDeliverableAttachments` scopes the storage keys against.
 *
 * Fetches run concurrently but are individually bounded, and the whole function
 * is total: it always returns one entry per accepted row.
 */
export async function resolveAttachmentImages(args: {
  supabase: SupabaseClient;
  tenantId: string;
  rows: readonly AttachmentRow[];
}): Promise<ExportAttachment[]> {
  const deliverable = selectDeliverableAttachments({ tenantId: args.tenantId, rows: args.rows });
  if (deliverable.length === 0) return [];

  // `selectDeliverableAttachments` returns a vetted projection without the
  // storage key; pair each back to its source row to get the key we sign.
  const byId = new Map(args.rows.map((r) => [r.id, r]));
  const accepted = deliverable
    .map((d) => byId.get(d.id))
    .filter((r): r is AttachmentRow => r !== undefined);

  return Promise.all(accepted.map((row) => fetchOne(args.supabase, row)));
}
