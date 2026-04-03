// POST /api/runners/dev-servers/[sessionId]/logs
//
// Live dev-server log ingestion. The runner-side dev-server loop streams the
// spawned command's stdout/stderr here in small debounced batches (~250ms),
// in parallel with the 3s heartbeat that owns `last_log_tail`. We append each
// chunk to a capped Redis Stream `devpilot:devlog:<sessionId>`; the browser-facing
// SSE route (`/api/dev-servers/[sessionId]/logs/stream`) tails that stream.
//
// Why a Redis Stream (not pub/sub): Upstash REST has no blocking subscribe, so
// the SSE route polls XRANGE from a cursor. A Stream gives ordered ids + a
// cursor for free, and inline MAXLEN trimming caps memory per session.
//
// Auth: `x-devpilot-runner-key` — same gate as the heartbeat route.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { redis } from "@/lib/cache/redis";

export const dynamic = "force-dynamic";

// ~2000 entries is plenty of scrollback for a live tail; `~` = approximate
// (cheaper) trim. 1h TTL is a backstop so an abandoned stream self-cleans even
// if the stop/GC path is missed.
const STREAM_MAXLEN = 2000;
const STREAM_TTL_SECONDS = 3600;

const Body = z.object({ chunk: z.string() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  const auth = checkRunnerAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401 });
  }

  const { sessionId } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (parsed.data.chunk.length === 0) {
    return NextResponse.json({ ok: true, skipped: "empty" });
  }

  const key = `devpilot:devlog:${sessionId}`;
  try {
    await redis().xadd(
      key,
      "*",
      { c: parsed.data.chunk },
      { trim: { type: "MAXLEN", threshold: STREAM_MAXLEN, comparison: "~" } },
    );
    await redis().expire(key, STREAM_TTL_SECONDS);
  } catch (err) {
    // Non-fatal: losing a live chunk is cosmetic (the 3s heartbeat still owns
    // last_log_tail). Log and 200 so the runner doesn't treat it as a hard error.
    console.warn(`[dev-servers/logs] xadd failed for ${sessionId}: ${(err as Error).message}`);
  }

  return NextResponse.json({ ok: true });
}
