// GET /api/dev-servers/[sessionId]/logs/stream
//
// Server-Sent Events tail of a dev server's live terminal output. The runner
// streams chunks into the Redis Stream `devpilot:devlog:<sessionId>` (via the
// runner-auth ingest route); this route backfills recent history then polls
// XRANGE from a cursor (Upstash REST has no blocking XREAD) and emits each new
// chunk as `data: { id, c }`. Mirrors the poll-loop SSE shape already used by
// `app/v1/agents/[id]/runs/route.ts`.
//
// Auth: the calling USER (cookie session) must own the session's tenant — same
// ownership check the dev-server stop action uses (getSessionById + tenant id).

import { type NextRequest } from "next/server";
import { sseResponse } from "@/lib/api/sse";
import { redis } from "@/lib/cache/redis";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { getSessionById } from "@/lib/dev-servers/load";

export const dynamic = "force-dynamic";

const STREAM_TIMEOUT_MS = 30 * 60_000; // self-cap (matches the idle reaper window)
const POLL_MS = 250; // ~sub-second latency combined with the runner's debounce
const STATUS_POLL_EVERY = 8; // re-check the session row every ~2s for terminal

type Entry = Record<string, string>;

export async function GET(req: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  await requireUser();
  const tenantId = await getCurrentTenantId();
  const { sessionId } = await ctx.params;

  const session = await getSessionById(sessionId).catch(() => null);
  if (!tenantId || !session || session.tenantId !== tenantId) {
    return new Response("not found", { status: 404 });
  }

  const key = `devpilot:devlog:${sessionId}`;
  const since = new URL(req.url).searchParams.get("since");
  // `null` cursor → read inclusively from the start ("-"); otherwise exclusive
  // after the client's last seen id ("(<id>").
  let lastId: string | null = since && since.length > 0 ? since : null;

  return sseResponse(async (emit) => {
    const start = Date.now();
    let tick = 0;
    let sinceWrite = 0; // ticks since we last sent anything to the client
    while (Date.now() - start < STREAM_TIMEOUT_MS) {
      const startArg = lastId === null ? "-" : `(${lastId}`;
      let entries: Record<string, Entry> = {};
      try {
        entries = (await redis().xrange(key, startArg, "+", 500)) as Record<string, Entry>;
      } catch {
        // transient — try again next tick
      }
      let wrote = false;
      for (const [id, fields] of Object.entries(entries)) {
        await emit.write({ id, c: fields.c ?? "" });
        lastId = id;
        wrote = true;
      }

      // Keepalive: browsers/proxies drop SSE connections that sit idle. When the
      // dev server produces no output for a stretch, send an SSE comment every
      // ~5s so the connection stays warm and the client keeps receiving live
      // updates without a page refresh. (EventSource ignores comment lines.)
      sinceWrite = wrote ? 0 : sinceWrite + 1;
      if (!wrote && sinceWrite % 20 === 0) {
        await emit.writeRaw(`: keepalive ${Date.now()}\n\n`);
      }

      // Periodically check whether the session reached a terminal state so we
      // close the stream instead of polling a dead session for 30 minutes.
      if (++tick % STATUS_POLL_EVERY === 0) {
        const s = await getSessionById(sessionId).catch(() => null);
        const st = s?.status ?? "gone";
        if (st === "stopped" || st === "errored" || st === "gone") {
          await emit.write({ done: true, status: st });
          return;
        }
      }

      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    await emit.write({ done: true, status: "timeout" });
  });
}
