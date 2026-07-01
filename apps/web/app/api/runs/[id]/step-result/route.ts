// POST /api/runs/[id]/step-result
//
// Worker has finished running `claude -p` for one agent step. Forward the
// result to Inngest as a `runner/step-result` event — the durable runAgent
// function is waiting on this event (via step.waitForEvent matching jobId)
// and will resume on receipt.

import { NextResponse } from "next/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { redis } from "@/lib/cache/redis";

export const dynamic = "force-dynamic";

// Result-cache TTL for the side-channel the classifier-bridge polls. The
// bridge can't use Inngest's `waitForEvent` because it's called from inside
// `step.run` (Inngest forbids nested step ops). Caching the result text in
// Redis with a short TTL lets a pure polling loop consume it without any
// other side effects on the existing runAgent path.
const RESULT_CACHE_TTL_SECONDS = 300; // 5 min — well above any classifier timeout

type Body = {
  jobId: string;
  ok: boolean;
  result?: {
    text: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason?: string;
    modelId?: string;
  };
  error?: string;
  /**
   * Phase 1 / M0 — Engineer git workspace. Absolute path on the runner host
   * where this step ran. `null` when no workspace was prepared. Forwarded
   * verbatim into the Inngest event payload; consumed by `runAgent` for
   * `run_steps.payload.workspace_path`.
   */
  workspacePath?: string | null;
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id: runId } = await params;
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  await sendEventBounded({
    name: "runner/step-result",
    data: {
      jobId: body.jobId,
      runId,
      ok: body.ok,
      result: body.result,
      error: body.error,
      workspacePath: body.workspacePath ?? null,
    },
  });

  // Side-channel: cache the outcome in Redis so synthetic runs (the one-shot
  // local-cc bridge in lib/runners/local-cc-oneshot.server.ts, used by the
  // dispatch classifiers and the auth-mode-routed features) can pick it up
  // via polling. runAgent itself doesn't read this key — it waits on the
  // `runner/step-result` event above — so there's no behavioural impact on
  // the existing path. Best-effort: if Redis is unavailable, the poll-loop
  // just times out and the caller falls back.
  try {
    // @upstash/redis auto-JSON-parses values on read whenever the stored
    // text starts with `{` / `[` / a digit / etc. Claude's classifier
    // replies ARE JSON, so a plain `set(text)` round-trips as an object
    // and the bridge then crashes on `text.match(...)`. We wrap in an
    // envelope — `{text: <raw>}` on success, `{error: <reason>}` on runner
    // failure — so the auto-parse hands back an object with a known string
    // field regardless of payload shape. The error envelope lets pollers
    // fail fast instead of burning their full timeout.
    if (body.ok && body.result?.text) {
      await redis().set(
        `devpilot:run-result:${runId}`,
        JSON.stringify({ text: body.result.text }),
        {
          ex: RESULT_CACHE_TTL_SECONDS,
        },
      );
    } else if (!body.ok) {
      await redis().set(
        `devpilot:run-result:${runId}`,
        JSON.stringify({ error: body.error ?? "runner reported failure" }),
        { ex: RESULT_CACHE_TTL_SECONDS },
      );
    }
  } catch (err) {
    console.warn(
      `[step-result] result-cache write failed for run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return NextResponse.json({ ok: true });
}
