// POST /api/runs/[id]/artifacts
//
// Runner → engine. The OUTBOUND half of the run/image path: an agent captured a
// screenshot through the browser (@playwright/mcp) during one `claude -p` step,
// and the runner ships those bytes here so the operator can look at them in the
// run inspector. The inbound sibling (`GET /api/runs/[id]/attachments`) carries
// operator-supplied images the other way; they are separate routes because the
// trust direction is opposite.
//
// One file per request, deliberately — not a batch. A partial failure then names
// the exact image that failed and leaves the others stored, which is the same
// reasoning as the Vercel env push (one call per variable). A batch that fails
// halfway is indistinguishable from a batch that never ran.
//
// Security (AGENTS.md — tenant isolation is the boundary)
// ──────────────────────────────────────────────────────
// The runner supplies ONLY `runId` in the path plus the shared registration key
// (the same gate every runner→engine route uses). Tenant is derived SERVER-SIDE
// from the run row; the runner never names a tenant, and there is no tenant or
// storage-key field in the request at all, so a compromised runner cannot aim an
// image at another workspace's run inspector. The storage key is derived from
// validated ids and re-checked against the bucket's own boundary predicate.
//
// The BYTES are agent-produced and end up rendered in an operator's browser, so
// the declared type is not believed: the body's magic bytes are sniffed and must
// agree with an allowlisted image type. A mismatch is a refusal, never a
// silent correction.
//
// Never blocks a run: the runner calls this AFTER it has already reported the
// step result, and treats every response — including a 500 — as advisory. A
// refusal here degrades a run to "no evidence for that step", never to a failure.

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { ARTIFACT_MAX_BYTES, extensionForArtifactMime, sniffImageMime } from "@/lib/runs/artifacts";
import { storeRunArtifact } from "@/lib/runs/artifacts-store";

export const dynamic = "force-dynamic";

function intField(form: FormData, name: string): number | null {
  const raw = form.get(name);
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id: runId } = await params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  // Reject on the DECLARED size before reading the body into memory, so an
  // oversized upload costs no allocation. The real check is on the read bytes
  // below — a declared size can lie.
  if (file.size > ARTIFACT_MAX_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }

  const stepIdx = intField(form, "stepIdx");
  const sequence = intField(form, "sequence");
  const capturedTotal = intField(form, "capturedTotal");
  const capturedAt = form.get("capturedAt");
  if (stepIdx === null || stepIdx < 0) {
    return NextResponse.json({ error: "missing or invalid stepIdx" }, { status: 400 });
  }
  if (sequence === null || sequence < 0) {
    return NextResponse.json({ error: "missing or invalid sequence" }, { status: 400 });
  }
  if (capturedTotal === null || capturedTotal <= 0) {
    return NextResponse.json({ error: "missing or invalid capturedTotal" }, { status: 400 });
  }
  if (typeof capturedAt !== "string" || Number.isNaN(new Date(capturedAt).getTime())) {
    return NextResponse.json({ error: "missing or invalid capturedAt" }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }
  if (bytes.byteLength > ARTIFACT_MAX_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }

  // Identify by CONTENT. `filename` is advisory (it is logged, never used to
  // build a path); when it carries an extension it must agree with the sniffed
  // type, so a mismatch surfaces as a refusal rather than being papered over.
  const mime = sniffImageMime(bytes);
  if (!mime) {
    return NextResponse.json({ error: "not a PNG or JPEG" }, { status: 415 });
  }
  const filename = typeof form.get("filename") === "string" ? String(form.get("filename")) : "";
  const claimedExt = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : null;
  if (claimedExt && claimedExt !== extensionForArtifactMime(mime)) {
    // jpg/jpeg are the same type under two spellings — everything else is a
    // genuine disagreement between the name and the bytes.
    const jpegAliases = claimedExt === "jpeg" && mime === "image/jpeg";
    if (!jpegAliases) {
      return NextResponse.json(
        { error: `filename extension .${claimedExt} disagrees with content (${mime})` },
        { status: 415 },
      );
    }
  }

  const supabase = supabaseService();

  // Derive tenant from the RUN row — never from the caller.
  const { data: run, error: runErr } = await supabase
    .from("runs")
    .select("tenant_id")
    .eq("id", runId)
    .maybeSingle();
  if (runErr) {
    console.error(`[run-artifacts] run load failed for ${runId}: ${runErr.message}`);
    return NextResponse.json({ error: "load failed" }, { status: 500 });
  }
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  const tenantId = (run.tenant_id as string | null) ?? null;
  if (!tenantId) return NextResponse.json({ error: "run has no tenant" }, { status: 409 });

  const stored = await storeRunArtifact(supabase, {
    tenantId,
    runId,
    stepIdx,
    mime,
    bytes,
    sequence,
    capturedTotal,
    capturedAt,
  });

  if (!stored.ok) {
    // The per-run cap is a normal, expected outcome — not an error. Reporting it
    // as one would make a healthy capped run look broken in the runner log.
    if (stored.code === "run_cap") {
      console.log(`[run-artifacts] run ${runId} at cap — dropping image: ${stored.reason}`);
      return NextResponse.json({ stored: false, reason: "run_cap" }, { status: 200 });
    }
    console.warn(`[run-artifacts] store failed for run ${runId}: ${stored.reason}`);
    const status = stored.code === "invalid" ? 400 : 500;
    return NextResponse.json({ error: stored.reason }, { status });
  }

  return NextResponse.json({ stored: true, id: stored.id });
}
