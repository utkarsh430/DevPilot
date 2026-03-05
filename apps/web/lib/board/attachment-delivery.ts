// Phase 3 — delivering a ticket's image attachments to the WORKING AGENT.
//
// Phase 1-2 (see lib/board/attachments.ts) captures/stores/displays a pasted
// screenshot. This module is the pure, IO-free half of Phase 3: it decides
// WHICH stored attachment rows are safe to hand to a run, derives a stable safe
// filename for each, and estimates their token cost for the pre-flight budget
// gate. The engine dispatch seam (run-agent's `lc-enqueue`) and the run-scoped
// runner endpoint (`GET /api/runs/[id]/attachments`) both funnel through
// `selectDeliverableAttachments`, so the caps and the tenant-scope check are
// enforced in ONE place and are unit-testable without a live Supabase.
//
// Security posture (AGENTS.md — tenant isolation is the boundary): a row is
// deliverable only when its `storage_key`'s first path segment is EXACTLY the
// run's tenant (`isKeyUnderTenant`, the same predicate the bucket RLS mirrors).
// The rows are always loaded by the RUN's own ticket id server-side, so a
// cross-tenant key can't normally occur — this check is defence-in-depth so a
// malformed/stray row can never be signed and handed to a runner. The image and
// its "read this" prompt section are UNTRUSTED (principle 6); the fence lives on
// the runner side (apps/runner/src/attachments.ts) because only the runner knows
// the absolute temp path each image is downloaded to.

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  extensionForMime,
  isAllowedAttachmentMime,
  isKeyUnderTenant,
  type AttachmentMime,
} from "@/lib/board/attachments";
import { costCents } from "@/lib/llm/cost";
import type { ModelTier } from "@/lib/llm/models";

/**
 * Hard ceiling on the TOTAL bytes delivered to a single run, across all its
 * images. The per-file cap (10 MiB) × the per-ticket count cap (6) is 60 MiB;
 * that is a lot to push over Redis-signalled HTTP and write to a runner's temp
 * dir, so we bound the aggregate independently. This is the concrete answer to
 * "a huge image can't silently blow the budget": the payload the agent can be
 * handed is bounded regardless of how the per-file/count caps interact.
 */
export const ATTACHMENT_DELIVERY_MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MiB

/**
 * Conservative per-image token estimate for the pre-flight budget gate.
 *
 * Anthropic vision resizes any image so its longest edge is ≤ 1568px and prices
 * it at roughly (width × height) / 750 tokens, which caps a single image at
 * ~1600 tokens no matter how many bytes it is on disk. We use that ceiling as a
 * flat per-image estimate: it is an upper bound (never an under-count), it needs
 * no image decode, and it keeps the gate deterministic. The REAL token cost is
 * billed post-hoc through the runner-reported `usage` (the Read tool's image
 * tokens land in `promptTokens` → `stepCost` → `recordSpend`); this estimate is
 * only a GATE, never a charge, so there is no double-counting.
 */
export const ESTIMATED_TOKENS_PER_IMAGE = 1600;

/** A `ticket_attachments` row as loaded from the DB (only the fields we need). */
export type AttachmentRow = {
  id: string;
  storageKey: string;
  mime: string;
  bytes: number;
};

/** A vetted attachment ready to sign + deliver. `filename` is derived, safe, and
 *  stable (`<attachmentId>.<ext>`); it never contains a path separator. */
export type DeliverableAttachment = {
  id: string;
  mime: AttachmentMime;
  bytes: number;
  filename: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deterministic, path-separator-free filename for a stored attachment:
 * `<attachmentId>.<ext>`. The id is a validated uuid and the extension comes
 * from the MIME allowlist, so the result is always a safe basename an untrusted
 * value could never steer. Returns null for a non-uuid id or an off-allowlist
 * MIME (the caller drops the row).
 */
export function attachmentFilename(id: string, mime: string): string | null {
  if (!UUID_RE.test(id)) return null;
  const ext = extensionForMime(mime);
  if (!ext) return null;
  return `${id}.${ext}`;
}

/**
 * Filter a ticket's attachment rows down to the ones safe to deliver to a run
 * whose tenant is `tenantId`: image MIME on the allowlist, storage key scoped to
 * the tenant, sane byte size, de-duplicated by id, and capped at BOTH
 * `ATTACHMENT_MAX_COUNT` and `ATTACHMENT_DELIVERY_MAX_TOTAL_BYTES`. Pure and
 * total — never throws — so the dispatch/endpoint paths can call it and simply
 * drop anything invalid rather than failing the run.
 *
 * A row whose key points outside `tenantId` is DROPPED, which is what makes a
 * foreign/stray row unreachable even though rows are already loaded by the run's
 * own ticket id.
 */
export function selectDeliverableAttachments(args: {
  tenantId: string;
  rows: readonly AttachmentRow[];
}): DeliverableAttachment[] {
  const out: DeliverableAttachment[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const r of args.rows) {
    if (out.length >= ATTACHMENT_MAX_COUNT) break;
    if (!isAllowedAttachmentMime(r.mime)) continue;
    if (!isKeyUnderTenant(r.storageKey, args.tenantId)) continue;
    if (!Number.isFinite(r.bytes) || r.bytes <= 0 || r.bytes > ATTACHMENT_MAX_BYTES) continue;
    if (seen.has(r.id)) continue;
    const filename = attachmentFilename(r.id, r.mime);
    if (!filename) continue;
    const bytes = Math.floor(r.bytes);
    if (totalBytes + bytes > ATTACHMENT_DELIVERY_MAX_TOTAL_BYTES) continue;
    seen.add(r.id);
    totalBytes += bytes;
    out.push({ id: r.id, mime: r.mime, bytes, filename });
  }
  return out;
}

/** Upper-bound token estimate for delivering `count` images (see
 *  `ESTIMATED_TOKENS_PER_IMAGE`). */
export function estimateImageTokens(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count) * ESTIMATED_TOKENS_PER_IMAGE;
}

/**
 * Estimated cents to deliver `count` images at `tier`, as an INPUT-token cost
 * (images only consume prompt tokens). Used by the enqueue-time pre-flight gate
 * to refuse delivery when the run has no headroom — never billed (the real cost
 * rides on the runner-reported usage). Rounds up so the gate is conservative.
 */
export function estimateImageDeliveryCents(count: number, tier: ModelTier): number {
  const promptTokens = estimateImageTokens(count);
  if (promptTokens <= 0) return 0;
  return costCents(tier, { promptTokens, completionTokens: 0 });
}
