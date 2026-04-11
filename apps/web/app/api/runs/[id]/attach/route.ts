// GET  /api/runs/[id]/attach          — SSE bridge: tmux pane → browser
// POST /api/runs/[id]/attach          — control: { kind: "input"|"resize"|"close", ... }
//
// Track 3 — "Open terminal" in the RunInspector. Every local-cc agent run now
// spawns inside a named tmux session (Track 2: devpilot-run-<runId-16char>), so we
// can `tmux attach -t <name>` from the web server and pipe the pty's stdout/
// stdin into an xterm.js panel via SSE (server → client) + POST (client →
// server).
//
// Why SSE + POST and not WebSocket
// ────────────────────────────────
// Next.js App Router has no first-class WebSocket support in route handlers
// (requires a custom server / `runtime: 'nodejs'` + manual upgrade plumbing
// that doesn't compose with `pnpm dev`). SSE + POST is wire-compatible with
// xterm.js, works in Next dev mode out of the box, and matches the shape of
// the dev-server log tail already in this codebase. The trade-off is
// minimal: stdin path adds one HTTP round-trip vs a WS frame (~5ms locally).
// See openQuestions for the WS migration path.
//
// Auth
// ────
// Same gate as every other run-scoped route: requireUser → getCurrentTenantId
// → verify run.tenant_id matches. The pty is bound to runs.tmux_session_name
// which Track 2 stamps onto the runs row when the runner opens the pane, so
// a viewer that can read the run can attach to its pane and no other.
//
// Hard guards:
//   • runner_kind must be 'local-cc' (API runs have no terminal to surface)
//   • runs.tmux_session_name must be present (otherwise no session to attach)
//   • run must be active OR recently active (no attach to ancient done runs)

import { type NextRequest, NextResponse } from "next/server";
import { requireUser, getCurrentTenantId } from "@/lib/auth";
import { ATTACH_DEV_BYPASS_HEADER, readRunnerHeader } from "@/lib/runners/headers";
import { supabaseServer, supabaseService } from "@/lib/db/server";
import {
  closeAttach,
  ensurePtyAvailable,
  openAttach,
  resizeAttach,
  subscribe,
  writeToAttach,
} from "@/lib/runs/attach-registry";

export const dynamic = "force-dynamic";
// We need Node.js runtime: node-pty is a native addon, and SSE works best
// with Node streams. Explicitly opt-in so an accidental Edge migration
// doesn't silently break this route.
export const runtime = "nodejs";

const STREAM_TIMEOUT_MS = 30 * 60_000; // self-cap matches dev-server log tail
const KEEPALIVE_EVERY_MS = 15_000;

type SessionGateResult =
  | { ok: true; sessionName: string }
  | { ok: false; status: number; body: { error: string; code?: string } };

// How long the gate will wait for `runs.tmux_session_name` to populate after
// a NULL read, polling every POLL_INTERVAL_MS. The runner sends TWO claim
// POSTs per job: the first immediately on pickup (no tmuxSession yet — the
// pane hasn't spawned), and a second one AFTER the tmux pane opens (carries
// the name). Under LOCAL_CC_CONCURRENCY > 1 the second claim can lag the
// first by several seconds because parallel pane-opens serialise through the
// tmux server. Default 12s gives that comfortable headroom; override via
// DEVPILOT_ATTACH_GATE_POLL_MS for slow/fast hosts. The polling is per-request,
// so a long window only costs us a single open HTTP connection — no
// resource amplification.
const POLL_TIMEOUT_MS = Number(process.env.DEVPILOT_ATTACH_GATE_POLL_MS ?? "12000");
const POLL_INTERVAL_MS = 250;

async function gateAndResolveSession(
  runId: string,
  opts: { poll?: boolean; skipAuth?: boolean } = { poll: true },
): Promise<SessionGateResult> {
  // Dev-only auth bypass for local end-to-end testing of the SSE bridge from
  // a script (no browser session needed). Active only when NODE_ENV !==
  // 'production' AND the magic header is present.
  if (opts.skipAuth) {
    const supabase = supabaseService();
    const { data: run } = await supabase
      .from("runs")
      .select("id, tenant_id, status, runner_kind, tmux_session_name")
      .eq("id", runId)
      .maybeSingle();
    if (!run) return { ok: false, status: 404, body: { error: "not found" } };
    if (run.runner_kind !== "local-cc") {
      return { ok: false, status: 400, body: { error: "not local-cc" } };
    }
    const name = (run.tmux_session_name as string | null) ?? null;
    if (!name) return { ok: false, status: 409, body: { error: "no session", code: "no-session" } };
    return { ok: true, sessionName: name };
  }
  await requireUser();
  const tenantId = await getCurrentTenantId();
  if (!tenantId) {
    return { ok: false, status: 401, body: { error: "no tenant" } };
  }
  const supabase = await supabaseServer();
  // Initial read so the tenant + runner_kind checks can short-circuit any
  // polling for runs that wouldn't qualify anyway.
  const { data: run } = await supabase
    .from("runs")
    .select("id, tenant_id, status, runner_kind, tmux_session_name")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.tenant_id !== tenantId) {
    return { ok: false, status: 404, body: { error: "not found" } };
  }
  if (run.runner_kind !== "local-cc") {
    return {
      ok: false,
      status: 400,
      body: {
        error: "in-browser terminal is only available for local Claude Code runs",
        code: "not-local-runner",
      },
    };
  }
  let sessionName = (run.tmux_session_name as string | null) ?? null;
  // Only poll for active runs — a `done`/`failed` run with a null column
  // means the pane was reaped before the column ever got stamped; waiting
  // is pointless. `running` and `awaiting_human` both warrant a wait.
  // POST callers (input/resize/close) skip polling because they're either
  // posting to an existing in-memory registry entry (input/resize) or
  // cleaning up regardless (close) — the long wait would just block the
  // browser tab on every keystroke if the run rolled over.
  const isActive = run.status === "running" || run.status === "awaiting_human";
  if (!sessionName && isActive && opts.poll !== false) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const { data: latest } = await supabase
        .from("runs")
        .select("tmux_session_name, status")
        .eq("id", runId)
        .maybeSingle();
      const name = (latest?.tmux_session_name as string | null) ?? null;
      if (name) {
        sessionName = name;
        break;
      }
      // Bail early if the run transitioned to a terminal status mid-poll —
      // no point waiting another 2.5s for a column that won't come.
      if (latest && latest.status !== "running" && latest.status !== "awaiting_human") {
        break;
      }
    }
  }
  if (!sessionName) {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          "no tmux session recorded for this run after polling — the runner may not have claimed it yet, or the pane was already reaped (done/failed run)",
        code: "no-session",
      },
    };
  }
  return { ok: true, sessionName };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: runId } = await ctx.params;
  const isDevBypass =
    process.env.NODE_ENV !== "production" &&
    readRunnerHeader(req, ATTACH_DEV_BYPASS_HEADER) === "1";
  const gate = await gateAndResolveSession(runId, { skipAuth: isDevBypass });
  if (!gate.ok) {
    return NextResponse.json(gate.body, { status: gate.status });
  }

  const pty = await ensurePtyAvailable();
  if (!pty.ok) {
    return NextResponse.json(
      {
        error: pty.reason,
        code: "no-pty",
        hint: "Install/build node-pty on the web host. The takeover flow (Take the wheel) still works as a fallback — it opens a native terminal on the runner.",
      },
      { status: 503 },
    );
  }

  // Honor initial geometry from query string so the first paint isn't garbled
  // before the client's first resize POST lands.
  const url = new URL(req.url);
  const cols = Number(url.searchParams.get("cols") ?? "120");
  const rows = Number(url.searchParams.get("rows") ?? "32");

  const entry = await openAttach(runId, gate.sessionName, {
    cols: Number.isFinite(cols) ? cols : 120,
    rows: Number.isFinite(rows) ? rows : 32,
  });
  if ("error" in entry) {
    // Log loudly — the silent 500 made this very hard to debug the first
    // time (node-pty not in serverExternalPackages → bundling failure).
    console.error(
      `[attach] openAttach failed for runId=${runId} session=${gate.sessionName}: ${entry.error}`,
    );
    return NextResponse.json({ error: entry.error, code: "spawn-failed" }, { status: 500 });
  }

  // Build the SSE response. We emit two event types:
  //   • `data: <json string of {c: "..."}>` for each chunk (default event)
  //   • `event: meta\ndata: {...}\n\n` for connection metadata (open/exit)
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const writeRaw = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      const writeChunk = (chunk: string) => {
        // Bracket each chunk as a JSON-encoded string so newlines don't
        // break the SSE framing. xterm.js writes the resulting string raw.
        writeRaw(`data: ${JSON.stringify({ c: chunk })}\n\n`);
      };
      const writeMeta = (m: unknown) => {
        writeRaw(`event: meta\ndata: ${JSON.stringify(m)}\n\n`);
      };

      // First write: a ≥2KB SSE comment line to push past Next.js dev mode's
      // response buffer threshold so the browser actually receives the
      // headers + initial events immediately. Without this, EventSource sits
      // on the headers until enough downstream data accumulates — the panel
      // shows "connecting…" indefinitely even though the route is healthy.
      // SSE comment lines start with ":" and are silently ignored by the
      // EventSource client (no event fires; no scrollback corrupted).
      writeRaw(`: devpilot-attach-flush ${" ".repeat(2048)}\n\n`);

      let chunkBytes = 0;
      let chunkCount = 0;
      // Replay scrollback so the operator sees recent context immediately.
      if (entry.buffer.length > 0) {
        writeChunk(entry.buffer);
        chunkBytes += entry.buffer.length;
        chunkCount++;
      }
      writeMeta({ kind: "open", sessionName: gate.sessionName });
      console.log(
        `[attach] OPEN run=${runId.slice(0, 8)} session=${gate.sessionName} replay=${entry.buffer.length}B`,
      );

      const unsubscribe = subscribe(runId, (chunk) => {
        writeChunk(chunk);
        chunkBytes += chunk.length;
        chunkCount++;
        if (chunkCount <= 3 || chunkCount % 10 === 0) {
          console.log(
            `[attach] chunk run=${runId.slice(0, 8)} count=${chunkCount} +${chunk.length}B totalSent=${chunkBytes}B`,
          );
        }
      });

      const keepalive = setInterval(() => {
        if (closed) return;
        writeRaw(`: keepalive ${Date.now()}\n\n`);
      }, KEEPALIVE_EVERY_MS);

      const timeoutTimer = setTimeout(() => {
        writeMeta({ kind: "timeout" });
        cleanup();
      }, STREAM_TIMEOUT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        try {
          unsubscribe();
        } catch {
          // ignore
        }
        clearInterval(keepalive);
        clearTimeout(timeoutTimer);
        try {
          controller.close();
        } catch {
          // ignore — already closed
        }
      };

      // Client disconnects (browser tab close) — Next signals via the abort
      // signal on the request. Without this we'd leak listeners on every
      // refresh.
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

type ControlBody =
  | { kind: "input"; data: string }
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "close" };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: runId } = await ctx.params;
  // POSTs short-circuit the session-wait poll — they target the in-memory
  // pty registry, which only exists after the GET established the attach.
  // A POST that arrives before its sibling GET should fail fast (the client
  // will retry), not block the browser tab on every keystroke for 12s.
  const gate = await gateAndResolveSession(runId, { poll: false });
  if (!gate.ok) {
    return NextResponse.json(gate.body, { status: gate.status });
  }

  const body = (await req.json().catch(() => null)) as ControlBody | null;
  if (!body || typeof body !== "object" || !("kind" in body)) {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  switch (body.kind) {
    case "input": {
      if (typeof body.data !== "string") {
        return NextResponse.json({ error: "input.data must be a string" }, { status: 400 });
      }
      // Cap a single input POST at 64KB so a runaway paste can't OOM the
      // pty buffer. Larger pastes the client splits into multiple POSTs.
      if (body.data.length > 64 * 1024) {
        return NextResponse.json(
          { error: "input too large; split into chunks ≤ 64KB" },
          { status: 413 },
        );
      }
      const ok = writeToAttach(runId, body.data);
      if (!ok) {
        return NextResponse.json(
          { error: "no live attach; reopen the terminal", code: "no-attach" },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true });
    }
    case "resize": {
      const cols = Number(body.cols);
      const rows = Number(body.rows);
      const ok = resizeAttach(runId, cols, rows);
      if (!ok) {
        return NextResponse.json(
          {
            error: "invalid resize or no live attach",
            code: "resize-failed",
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true });
    }
    case "close": {
      closeAttach(runId, "client requested");
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  }
}
