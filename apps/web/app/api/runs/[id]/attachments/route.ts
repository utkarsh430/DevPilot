// GET /api/runs/[id]/attachments
//
// Runner → engine. Phase 3 of the ticket-screenshot feature. When a local-cc
// job's payload says the run's ticket has image attachments, the runner calls
// this endpoint to get FRESH short-lived signed download URLs, downloads each
// image into a per-run temp dir (outside any git workspace), and adds a fenced
// "Read these" section to the agent's prompt so `claude -p`'s Read tool can see
// them. See apps/runner/src/attachments.ts.
//
// Why a run-scoped endpoint instead of URLs baked into the Redis job payload:
// a queued local-cc job can wait behind stacked steps that each run up to the
// 1h step timeout at concurrency 1-3, so the enqueue→download gap is effectively
// unbounded — a fixed signed-URL TTL in the payload risks expiring in the queue.
// Minting the URL here, at download time, keeps its lifetime a few minutes and
// decoupled from queue delay. (An input_required resume is a FRESH dispatch —
// new run, new job — so no single URL ever has to survive a human pause.)
//
// Security (AGENTS.md — tenant isolation is the boundary): the runner supplies
// ONLY `runId` in the path and the shared registration key (same gate as every
// other runner→engine route). Ticket + tenant are derived SERVER-SIDE from the
// run row; the runner never names a ticket, tenant, or storage key. Rows are
// loaded by the run's own ticket id, and `selectDeliverableAttachments` drops
// any key not scoped to the run's tenant — so a request can only ever reach its
// own run's ticket's images, in its own tenant. The images are UNTRUSTED
// (principle 6); the untrusted fence is applied on the runner side.

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { ATTACHMENT_BUCKET } from "@/lib/board/attachments";
import { selectDeliverableAttachments, type AttachmentRow } from "@/lib/board/attachment-delivery";

export const dynamic = "force-dynamic";

// Signed-URL lifetime. Short on purpose — the runner downloads immediately after
// this call, so the URL never needs to outlive that download, and a leaked link
// expires fast. Generous enough to absorb a slow multi-file download.
const SIGNED_URL_TTL_SECONDS = 300;

export type RunAttachmentDTO = {
  id: string;
  mime: string;
  bytes: number;
  filename: string;
  url: string;
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = checkRunnerAuth(_request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id: runId } = await params;
  const supabase = supabaseService();

  // Derive ticket + tenant from the RUN row — never from the caller.
  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("ticket_id, tenant_id")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) {
    console.error(`[run-attachments] run load failed for ${runId}: ${runErr.message}`);
    return NextResponse.json({ error: "load failed" }, { status: 500 });
  }
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const ticketId = (run.ticket_id as string | null) ?? null;
  const tenantId = (run.tenant_id as string | null) ?? null;
  // A ticket-less run (supervisor child, ad-hoc smoke test) has no ticket to
  // pull attachments from — return an empty set, not an error.
  if (!ticketId || !tenantId) {
    return NextResponse.json({ attachments: [] });
  }

  // Scoped to the tenant DERIVED FROM THE RUN ROW above (never from the
  // caller). The route's whole security envelope is "this runner can only reach
  // ITS OWN run's ticket's images, in its own tenant" — and until now the
  // second half was asserted in the comment but not in the query:
  // `ticket_attachments` carries its own `tenant_id`, so a hostile tenant could
  // aim a row at our ticket and have it delivered into our agent's context as a
  // file it is told to Read.
  const { data: rows, error: attErr } = await supabase
    .from("ticket_attachments")
    .select("id, storage_key, mime, bytes")
    .eq("ticket_id", ticketId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (attErr) {
    // Don't swallow — a silent [] would read as "no attachments".
    console.error(
      `[run-attachments] load failed for run ${runId} ticket ${ticketId}: ${attErr.message}`,
    );
    return NextResponse.json({ error: "load failed" }, { status: 500 });
  }

  const deliverable = selectDeliverableAttachments({
    tenantId,
    rows: (rows ?? []).map(
      (r): AttachmentRow => ({
        id: r.id as string,
        storageKey: r.storage_key as string,
        mime: r.mime as string,
        bytes: r.bytes as number,
      }),
    ),
  });

  // Sign each vetted row. A row's storage key is re-fetched here (never taken
  // from the caller) so a signed URL always points at exactly the object the
  // vetted row named.
  const byId = new Map<string, string>(
    (rows ?? []).map((r) => [r.id as string, r.storage_key as string]),
  );
  const attachments: RunAttachmentDTO[] = [];
  for (const d of deliverable) {
    const storageKey = byId.get(d.id);
    if (!storageKey) continue;
    const { data: signed, error: signErr } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrl(storageKey, SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      console.warn(
        `[run-attachments] sign failed for run ${runId} attachment ${d.id}: ${signErr?.message ?? "no url"}`,
      );
      continue;
    }
    attachments.push({
      id: d.id,
      mime: d.mime,
      bytes: d.bytes,
      filename: d.filename,
      url: signed.signedUrl,
    });
  }

  return NextResponse.json({ attachments });
}
