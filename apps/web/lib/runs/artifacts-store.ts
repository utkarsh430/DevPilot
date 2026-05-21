// Run artifacts — the DB + storage half. Injected client, resolved tenant id.
//
// ── Why a plain module (no `server-only`, no session) ──
// Every function takes an injected `SupabaseClient` and an ALREADY-RESOLVED
// `tenantId`, so the store path is unit-testable with a fake client (the
// `lib/learning/write.ts` / `bulk.ts` split). The ingest route derives the
// tenant from the RUN ROW and passes `supabaseService()`; the page loader passes
// the RLS-bound server client. Neither re-implements the SQL.
//
// ── Security (load-bearing) ──
// `run_artifacts` denies ALL JWT writes (migration 20260748000000), so the
// ingest path runs on the SERVICE client with RLS off and the co-located
// `.eq("tenant_id", tenantId)` on every read and write is the ENTIRE tenant
// boundary there. It matters unusually much on the READ path: what is returned
// is a SIGNED URL to an image that is then rendered in an operator's browser
// under a step of THEIR run, so a leaked foreign row does not merely disclose
// another tenant's screen — it files it as evidence about this tenant's work.
// The storage key is re-checked with `isKeyUnderTenant` before any URL is
// signed, so even a row that somehow carried a foreign key cannot be signed.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ARTIFACT_BUCKET,
  ARTIFACT_MAX_BYTES,
  buildArtifactStorageKey,
  isAllowedArtifactMime,
  isKeyUnderTenant,
  MAX_ARTIFACTS_PER_RUN,
  type ArtifactMime,
  type RunArtifact,
} from "@/lib/runs/artifacts";

const TABLE = "run_artifacts";

/**
 * Signed-URL lifetime for the inspector. Long enough that a page left open
 * while an operator reads a run does not go blank, short enough that a copied
 * link is not a durable handle to the image.
 */
export const ARTIFACT_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

export type StoreArtifactInput = {
  tenantId: string;
  runId: string;
  stepIdx: number;
  mime: ArtifactMime;
  bytes: Uint8Array;
  sequence: number;
  capturedTotal: number;
  capturedAt: string;
};

export type StoreArtifactResult =
  | { ok: true; id: string; storageKey: string }
  | { ok: false; code: "invalid" | "run_cap" | "upload_failed" | "insert_failed"; reason: string };

/**
 * Persist ONE captured image: upload the bytes, then insert the row.
 *
 * Ordering is upload-then-insert deliberately. The reverse would leave a row
 * pointing at an object that does not exist — the inspector would render a
 * broken image and the operator would be looking at a claim of evidence that
 * has none behind it. This ordering can instead orphan an OBJECT when the insert
 * fails, which is invisible, bounded by the same caps, and swept when the run is
 * deleted. A missing image is the safer failure.
 *
 * Never throws: every failure is a typed refusal the caller logs and moves past.
 * Evidence handling must never fail a run.
 */
export async function storeRunArtifact(
  db: SupabaseClient,
  input: StoreArtifactInput,
): Promise<StoreArtifactResult> {
  if (!isAllowedArtifactMime(input.mime)) {
    return { ok: false, code: "invalid", reason: `mime not allowed: ${input.mime}` };
  }
  const byteLength = input.bytes.byteLength;
  if (byteLength <= 0 || byteLength > ARTIFACT_MAX_BYTES) {
    return { ok: false, code: "invalid", reason: `bytes out of range: ${byteLength}` };
  }
  if (!Number.isInteger(input.sequence) || input.sequence < 0) {
    return { ok: false, code: "invalid", reason: `bad sequence: ${input.sequence}` };
  }
  if (!Number.isInteger(input.capturedTotal) || input.capturedTotal <= 0) {
    return { ok: false, code: "invalid", reason: `bad capturedTotal: ${input.capturedTotal}` };
  }
  const capturedAt = new Date(input.capturedAt);
  if (Number.isNaN(capturedAt.getTime())) {
    return { ok: false, code: "invalid", reason: `bad capturedAt: ${input.capturedAt}` };
  }

  // Per-RUN cap. Enforced HERE rather than on the runner because the runner has
  // no cross-step memory that survives a restart, and because a cap that bounds
  // a storage bucket has to be enforced by whoever owns the bucket. Counting
  // before the upload means an over-cap image costs no bytes at all.
  const { count, error: countErr } = await db
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .eq("run_id", input.runId)
    .eq("tenant_id", input.tenantId);
  if (countErr) {
    return { ok: false, code: "insert_failed", reason: `cap count failed: ${countErr.message}` };
  }
  if ((count ?? 0) >= MAX_ARTIFACTS_PER_RUN) {
    return {
      ok: false,
      code: "run_cap",
      reason: `run already has ${count} artifacts (cap ${MAX_ARTIFACTS_PER_RUN})`,
    };
  }

  const fileId = crypto.randomUUID();
  const storageKey = buildArtifactStorageKey({
    tenantId: input.tenantId,
    runId: input.runId,
    stepIdx: input.stepIdx,
    fileId,
    mime: input.mime,
  });
  // Belt AND braces: the key is derived from validated ids above, and re-checked
  // against the boundary predicate the bucket RLS mirrors. A derivation bug must
  // not be able to write outside the tenant's folder.
  if (!storageKey || !isKeyUnderTenant(storageKey, input.tenantId)) {
    return { ok: false, code: "invalid", reason: "could not derive a tenant-scoped key" };
  }

  const { error: upErr } = await db.storage
    .from(ARTIFACT_BUCKET)
    .upload(storageKey, input.bytes, { contentType: input.mime, upsert: false });
  if (upErr) {
    return { ok: false, code: "upload_failed", reason: upErr.message };
  }

  const { data, error: insErr } = await db
    .from(TABLE)
    .insert({
      run_id: input.runId,
      tenant_id: input.tenantId,
      step_idx: input.stepIdx,
      storage_key: storageKey,
      mime: input.mime,
      bytes: byteLength,
      source: "browser",
      sequence: input.sequence,
      captured_total: input.capturedTotal,
      captured_at: capturedAt.toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (insErr || !data) {
    return {
      ok: false,
      code: "insert_failed",
      reason: insErr?.message ?? "insert returned no row",
    };
  }

  return { ok: true, id: data.id as string, storageKey };
}

/**
 * Load a run's artifacts with fresh signed URLs, newest step first is NOT
 * imposed here — rows come back in (step, sequence) order so the inspector can
 * group them without re-sorting.
 *
 * A row whose stored key is not under `tenantId` is DROPPED rather than signed.
 * Under RLS that row is already unreachable; under the service client it is the
 * boundary. A failure to sign drops the URL (`url: null`) but keeps the row, so
 * the inspector can still say an image exists and could not be loaded rather
 * than silently under-reporting the evidence.
 */
export async function loadRunArtifacts(
  db: SupabaseClient,
  args: { runId: string; tenantId: string },
): Promise<RunArtifact[]> {
  const { data, error } = await db
    .from(TABLE)
    .select("id, step_idx, storage_key, mime, bytes, sequence, captured_total, captured_at")
    .eq("run_id", args.runId)
    .eq("tenant_id", args.tenantId)
    .order("step_idx", { ascending: true })
    .order("sequence", { ascending: true });
  if (error) {
    // Don't swallow — a silent [] reads as "this run captured nothing", which is
    // exactly the false-negative this whole feature exists to end.
    console.error(`[run-artifacts] load failed for run ${args.runId}: ${error.message}`);
    return [];
  }

  const out: RunArtifact[] = [];
  for (const r of data ?? []) {
    const storageKey = r.storage_key as string;
    const mime = r.mime as string;
    if (!isAllowedArtifactMime(mime)) continue;
    if (!isKeyUnderTenant(storageKey, args.tenantId)) continue;
    let url: string | null = null;
    const { data: signed, error: signErr } = await db.storage
      .from(ARTIFACT_BUCKET)
      .createSignedUrl(storageKey, ARTIFACT_SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      console.warn(
        `[run-artifacts] sign failed for ${r.id as string}: ${signErr?.message ?? "no url"}`,
      );
    } else {
      url = signed.signedUrl;
    }
    out.push({
      id: r.id as string,
      stepIdx: Number(r.step_idx),
      mime,
      bytes: Number(r.bytes),
      sequence: Number(r.sequence),
      capturedTotal: Number(r.captured_total),
      capturedAt: String(r.captured_at),
      url,
    });
  }
  return out;
}
