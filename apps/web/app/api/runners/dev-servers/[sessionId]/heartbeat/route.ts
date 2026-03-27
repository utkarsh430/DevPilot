// Phase 2 / M5e — Runner → engine heartbeat for dev-server sessions.
//
// POST /api/runners/dev-servers/[sessionId]/heartbeat
//
// The runner-side dev-server loop (B2) calls this ~every 3s while a child
// process is alive. The endpoint:
//
//   1. Validates the `x-devpilot-runner-key` header against
//      `DEVPILOT_RUNNER_REGISTRATION_KEY` (the same gate as `/api/runners/register`).
//   2. Loads the existing session row by id (service-role).
//   3. UPDATEs status / status_reason / port / url / pid / last_log_tail /
//      last_heartbeat_at; sets stopped_at = now() if the status terminates.
//   4. If the status transitioned (e.g. starting→running), emits
//      `dev_server.status_changed` so downstream listeners (toast fan-out,
//      ops dashboards) can react.
//
// Failure modes:
//   • Bad runner key            → 401
//   • Body fails Zod parse      → 400 (the runner is supposed to be careful;
//                                 a 400 here points to a runner-side bug)
//   • Session not found          → 404 (runner held onto a sessionId after
//                                  the engine deleted the row)
//   • DB error / Inngest error   → 500
//
// We always return JSON ({ ok: true } on success) so the runner can branch on
// the shape without parsing HTML error pages.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { getSessionById } from "@/lib/dev-servers/load";

export const dynamic = "force-dynamic";

const Body = z.object({
  status: z.enum([
    "starting",
    "running",
    "stopped",
    "errored",
    // `building` — running a build step before serving; `needs_env` — parked
    // waiting on required env vars the runner detected as missing.
    "building",
    "needs_env",
  ]),
  // Which runner owns this session. Stamped so the dev-server reaper and the
  // runner-watchdog can fail-forward a session whose owning runner died (the
  // "owned by a dead runner" self-heal path). Optional for wire-compat with
  // older runners that don't send it — those sessions self-heal via the
  // heartbeat-timeout signal instead.
  runnerId: z.string().uuid().nullable().optional(),
  statusReason: z.string().nullable().optional(),
  port: z.number().int().nullable().optional(),
  url: z.string().nullable().optional(),
  pid: z.number().int().nullable().optional(),
  logTail: z.string().nullable().optional(),
  // Required env var keys the runner detected as missing (only on needs_env).
  missingEnvKeys: z.array(z.string()).nullable().optional(),
  // Slice C — file-watcher signal from the runner. Both nullable for
  // sessions whose workspace path was missing (older runner builds, or
  // a sample that failed for any reason).
  workspaceHeadSha: z.string().nullable().optional(),
  workspaceDirtyFileCount: z.number().int().nullable().optional(),
});

function isTerminal(status: z.infer<typeof Body>["status"]): boolean {
  return status === "stopped" || status === "errored";
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  // ── 1. Auth ────────────────────────────────────────────────────────────
  const auth = checkRunnerAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401 });
  }

  // ── 2. Params + body ──────────────────────────────────────────────────
  const { sessionId } = await ctx.params;
  const rawBody = (await req.json().catch(() => null)) as unknown;
  const parsed = Body.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // ── 3. Load existing row ──────────────────────────────────────────────
  // Needed for transition detection and to surface a 404 on a stale runner
  // sessionId. We always read the latest state before UPDATEing so a stop
  // request that landed during the heartbeat round-trip doesn't get clobbered.
  const existing = await getSessionById(sessionId).catch(() => null);
  if (!existing) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  // Terminal states are durable — never resurrected by a late heartbeat.
  //   • `stopped`: the Stop click eagerly flips the row so the UI doesn't wait
  //     for the runner round-trip; a trailing `running`/`starting` heartbeat
  //     must not undo it.
  //   • `errored`: the dev-server reaper / runner-watchdog fail-forwarded a
  //     stranded session; a late or continuing heartbeat (e.g. a runner whose
  //     registration heartbeat blipped) must not resurrect it into an
  //     errored↔running flip-flop, and must not override an operator's Restart.
  // A genuine restart creates a NEW session row via the insert path, so
  // skipping the UPDATE here loses nothing legitimate.
  if (existing.status === "stopped" || existing.status === "errored") {
    return NextResponse.json({ ok: true, skipped: `already-${existing.status}` });
  }

  // ── 4. Build the patch ────────────────────────────────────────────────
  const now = new Date().toISOString();
  // Only stamp stopped_at the FIRST time we go terminal. Subsequent heartbeats
  // (which the runner shouldn't really send after stopped, but we're defensive)
  // mustn't overwrite the original stop timestamp.
  const stoppedAt = isTerminal(body.status) && !existing.stoppedAt ? now : existing.stoppedAt;

  // We send all keys (rather than diffing) so a heartbeat that clears port
  // or url (e.g. server crashed and the runner reports port=null) actually
  // wipes the row's port. The Zod schema's `.nullable()` for those fields is
  // the gate that lets a runner do that on purpose.
  const patch = {
    status: body.status,
    status_reason: body.statusReason ?? null,
    // Stamp ownership on every heartbeat so a session claimed mid-flight is
    // attributable to its runner. Only overwrite when the runner actually
    // reports an id — never null out a previously-recorded owner from an older
    // runner's payload.
    ...(body.runnerId ? { runner_id: body.runnerId } : {}),
    port: body.port ?? null,
    url: body.url ?? null,
    pid: body.pid ?? null,
    last_log_tail: body.logTail ?? null,
    missing_env_keys: body.missingEnvKeys ?? null,
    last_heartbeat_at: now,
    stopped_at: stoppedAt,
    // Slice C — workspace state. Stamp regardless of status; the file
    // watcher reports even during 'starting' so the operator sees their
    // local edits the moment the spawn lands. workspace_dirty_at gets a
    // fresh timestamp whenever the SHA or count actually moves so the
    // UI's RefreshPill can drive off that field instead of polling.
    workspace_head_sha: body.workspaceHeadSha ?? null,
    workspace_dirty_file_count: body.workspaceDirtyFileCount ?? null,
    workspace_dirty_at:
      body.workspaceHeadSha != null || body.workspaceDirtyFileCount != null ? now : null,
  };

  const supabase = supabaseService();
  // Compare-and-set on the CURRENT status, not just the row read above: the
  // reaper / runner-watchdog may fail-forward this row to `errored` in the
  // window between our read (line 95) and this write. Without the guard, a
  // late `running`/`starting` heartbeat would overwrite `errored` back to a
  // non-terminal state (and fire a spurious status_changed) — resurrecting a
  // session the self-heal path deliberately terminalized. Guarding on the
  // non-terminal set matches the eager read-gate above but closes the race,
  // while still letting a legitimate non-terminal→terminal heartbeat (a
  // runner's onExit reporting `stopped`/`errored`) land. A 0-row result means
  // the row went terminal underneath us — a harmless no-op.
  const { data: updatedRows, error: updErr } = await supabase
    .from("dev_server_sessions")
    .update(patch)
    .eq("id", sessionId)
    .not("status", "in", "(stopped,errored)")
    .select("id");
  if (updErr) {
    return NextResponse.json({ error: `update failed: ${updErr.message}` }, { status: 500 });
  }
  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json({ ok: true, skipped: "concurrently-terminal" });
  }

  // ── 5. Status-changed event ───────────────────────────────────────────
  // We only fire when the status actually changed; routine same-status
  // heartbeats don't deserve event traffic. The URL is included even when
  // unchanged because downstream listeners (toast "Your dev server is up at
  // X") want to know it on the running transition specifically.
  if (existing.status !== body.status) {
    try {
      await sendEventBounded({
        name: "dev_server.status_changed",
        data: {
          sessionId,
          tenantId: existing.tenantId,
          projectId: existing.projectId,
          status: body.status,
          url: body.url ?? existing.url ?? undefined,
        },
      });
    } catch (err) {
      // Non-fatal: the DB update already succeeded. We log so an ops
      // dashboard can spot Inngest delivery failures without lying to the
      // runner about the heartbeat itself.
      console.warn(
        `[runners/dev-servers/heartbeat] status_changed emit failed for ${sessionId}: ${(err as Error).message}`,
      );
    }
  }

  return NextResponse.json({ ok: true });
}
