// The durable project-export worker.
//
// Flow: `POST /api/export/projects/[id]` authorises, writes an `exports` row
// (status `pending`, `tenant_id` stamped from the session), and emits
// `export/project.requested`. This function aggregates → renders → uploads →
// marks the row `ready`. The client polls the row; the download route mints a
// short-TTL signed URL.
//
// ── Authorisation without a session ─────────────────────────────────────────
// A durable function has no cookies, so RLS gives it nothing. The trust root is
// the JOB ROW: it was written by an already-authorised request that stamped its
// own tenant. So `load-job` re-reads the row and every subsequent step uses the
// tenant/project FROM THAT ROW — never from `event.data`, which is just data on
// a queue that happens to be shaped right. `loadProjectAuditExportForJob`
// re-scopes its service-role project read to the stamped tenant, so a job row
// pointing at a project outside its own tenant aggregates nothing.
//
// ── Failure posture ─────────────────────────────────────────────────────────
// The aggregator FAILS LOUD on land-state / verification reads (an export that
// cannot establish whether a blocker landed, or whether QA passed, must not
// exist). Here that must not become a red Inngest run that retries forever
// against a genuinely unreadable table — and, more importantly, it must not
// leave the row `pending` forever, which is what the UI would spin on. So the
// whole body is wrapped: any throw marks the row `failed` with the reason, which
// the operator sees, and the function RETURNS rather than re-throwing.
//
// `retries: 1` — a transient DB/storage blip deserves one retry. Beyond that the
// failure is real and a red row the operator can read beats a queue of retries
// nobody is watching.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { EXPORTS_BUCKET, exportStorageKey } from "@/lib/export/storage";
import { loadProjectAuditExportForJob } from "@/lib/export/project-audit.server";
import { renderProjectPdfBuffer } from "@/lib/export/render.server";

export type RunProjectExportResult =
  | { ok: true; bytes: number; storageKey: string }
  | { ok: false; reason: string };

async function markFailed(exportId: string, reason: string): Promise<void> {
  const supabase = supabaseService();
  await supabase
    .from("exports")
    .update({ status: "failed", error: reason.slice(0, 500) })
    .eq("id", exportId);
}

/**
 * Aggregate → render → upload → mark ready, for one `exports` job row.
 *
 * `generatedAt` is passed IN rather than read from the clock inside, so a retry
 * of the same job stamps the same time on the cover — the artifact is a record,
 * and a record whose "generated" line moves on every retry is confusing at best.
 */
export async function runProjectExport(args: {
  exportId: string;
  generatedAt: string;
}): Promise<RunProjectExportResult> {
  const supabase = supabaseService();

  // The trust root. Everything downstream reads tenancy from THIS row.
  const { data: job, error: jobErr } = await supabase
    .from("exports")
    .select("id, tenant_id, project_id, status")
    .eq("id", args.exportId)
    .maybeSingle();
  if (jobErr) return { ok: false, reason: `job load failed: ${jobErr.message}` };
  if (!job) return { ok: false, reason: "job row not found" };
  if (job.status !== "pending") {
    // Already settled — a duplicate delivery, not an error.
    return { ok: false, reason: `job already ${job.status}` };
  }

  const tenantId = job.tenant_id as string;
  const projectId = job.project_id as string;

  const data = await loadProjectAuditExportForJob({
    projectId,
    tenantId,
    generatedAt: args.generatedAt,
  });
  if (!data) return { ok: false, reason: "project not found in this tenant" };

  const buffer = await renderProjectPdfBuffer(data);
  // Tenant-scoped path — the first segment is what the bucket RLS keys on.
  const storageKey = exportStorageKey(tenantId, args.exportId);

  const { error: uploadErr } = await supabase.storage
    .from(EXPORTS_BUCKET)
    .upload(storageKey, buffer, { contentType: "application/pdf", upsert: true });
  if (uploadErr) return { ok: false, reason: `upload failed: ${uploadErr.message}` };

  // The CHECK constraint makes "ready with no object" unrepresentable, so this
  // update is the moment the export becomes downloadable — after the bytes are
  // durably stored, never before.
  const { error: updErr } = await supabase
    .from("exports")
    .update({ status: "ready", storage_key: storageKey, bytes: buffer.byteLength, error: null })
    .eq("id", args.exportId)
    .eq("status", "pending");
  if (updErr) return { ok: false, reason: `mark-ready failed: ${updErr.message}` };

  return { ok: true, bytes: buffer.byteLength, storageKey };
}

export const projectExportFn = inngest.createFunction(
  {
    id: "export-project-pdf",
    retries: 1,
    // Rendering is memory-hungry (a full document tree + embedded images + a
    // font store). Cap per tenant so a burst of export clicks cannot evict the
    // engine's real work from the same serverless pool.
    concurrency: { limit: 2, key: "event.data.tenantId + '_export'" },
  },
  { event: "export/project.requested" },
  async ({ event, step }) => {
    const { exportId } = event.data;
    // Stamped once, outside the step, so a retry re-uses the ORIGINAL time
    // rather than re-clocking the cover.
    const generatedAt = new Date().toISOString();

    return await step.run("render-project-export", async () => {
      try {
        const result = await runProjectExport({ exportId, generatedAt });
        if (!result.ok) {
          await markFailed(exportId, result.reason);
          console.warn(`[export] project export ${exportId} failed: ${result.reason}`);
        }
        return result;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Never leave the row pending — that is what the UI spins on.
        await markFailed(exportId, msg);
        console.error(`[export] project export ${exportId} threw: ${msg}`);
        return { ok: false, reason: msg.slice(0, 200) } satisfies RunProjectExportResult;
      }
    });
  },
);
