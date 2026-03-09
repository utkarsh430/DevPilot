// PATCH /api/runners/[id]/heartbeat
//
// Worker pings every ~15s. Failure to heartbeat for N intervals → runner
// marked offline (Phase 1 sweeper job).
//
// Track 2 — the runner also includes `tmuxSession` (string | null) when it's
// wrapping the current `claude -p` step inside a named tmux pane
// (`devpilot-run-<runId-16char>`). The route stamps it onto the runner's current
// in-flight run row so the UI can render `tmux attach -t <name>`. This is a
// recovery channel — the primary path is the per-job claim endpoint, which
// stamps the same field synchronously when the pane opens. The heartbeat
// path covers the rare case where the claim POST raced or got dropped.

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";

export const dynamic = "force-dynamic";

type HeartbeatBody = {
  status?: string;
  tmuxSession?: string | null;
};

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as HeartbeatBody;
  const supabase = supabaseService();
  const { error } = await supabase
    .from("runners")
    .update({
      last_heartbeat_at: new Date().toISOString(),
      status: body.status ?? "idle",
    })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Track 2 — propagate the active tmux session name onto the runner's
  // current in-flight run row IF AND ONLY IF the row's column is still NULL
  // (i.e. claim hasn't stamped it yet). Heartbeat is the recovery channel;
  // claim is authoritative. Critical guard: under LOCAL_CC_CONCURRENCY > 1
  // the runner reports its "current" tmuxSession as the most-recently-
  // spawned pane, which is NOT a 1:1 with any specific running row. Without
  // the IS NULL guard, the heartbeat would clobber correctly-claimed rows
  // with the wrong runner-current session name (PM's row ends up pointing
  // at Tech Lead's pane → operator clicks PM Terminal → 409 or wrong pane).
  // The IS NULL guard means heartbeat can only ever HELP a missed-claim
  // race, never hurt a successful one.
  if (body.tmuxSession !== undefined && body.tmuxSession !== null && body.status === "busy") {
    try {
      // Tmux session naming convention (Track 2):
      //   devpilot-run-<runId-first-16-chars-with-dashes-stripped>
      // We can therefore reverse-engineer which run this session BELONGS TO
      // and refuse to stamp it on the wrong row. Under LOCAL_CC_CONCURRENCY
      // > 1, heartbeat is naturally lossy (one tmuxSession per heartbeat
      // payload, multiple concurrent runs), so without this check we'd
      // overwrite PM's row with DevOps's session and the operator would
      // open PM's terminal but see DevOps' pane (or a 409 if reaped).
      // Legacy compat: pre-rename runners still emit `ace-run-*` sessions, so
      // accept both prefixes during a mixed-version window.
      const m = /^(?:ace|devpilot)-run-([a-f0-9]{16})$/i.exec(body.tmuxSession);
      const targetPrefix = m?.[1]?.toLowerCase() ?? null;
      if (targetPrefix) {
        // Deliberately NOT tenant-scoped. Runners are shared, so the run this
        // runner is currently executing legitimately belongs to another tenant
        // (see CROSS_TENANT_BY_DESIGN, lib/security/tenant-scope-scan.ts).
        // Filtering on the runner's own tenant was tried and reverted: it drops
        // exactly those runs, so their operator never gets an attach command and
        // the Terminal button stays dead for the cross-tenant half of a shared
        // runner's work.
        //
        // The control here is the prefix match below, and it is TIGHTER than a
        // tenant predicate would be: the session name embeds the first 16 hex
        // chars of its own run's id, so only the row whose PRIMARY KEY begins
        // with them is stamped. A row cannot be aimed at someone else's pane —
        // that would mean choosing a colliding uuid.
        const { data: candidates } = await supabase
          .from("runs")
          .select("id, tmux_session_name")
          .eq("runner_id", id)
          .eq("status", "running")
          .is("tmux_session_name", null)
          .order("created_at", { ascending: false })
          .limit(8);
        // Match the row whose id-prefix-without-dashes matches the session.
        const target = (candidates ?? []).find((r) => {
          const idNoDashes = (r.id as string).replace(/-/g, "").toLowerCase();
          return idNoDashes.startsWith(targetPrefix);
        });
        if (target && target.id) {
          // IS NULL guard repeated in WHERE to close the SELECT→UPDATE race
          // with a concurrent claim POST.
          await supabase
            .from("runs")
            .update({ tmux_session_name: body.tmuxSession })
            .eq("id", target.id)
            .is("tmux_session_name", null);
        }
        // If no candidate matches, do nothing — this session belongs to a
        // run whose row already has a value (good) or to a row already
        // finalised (stale heartbeat). Both are no-ops, not errors.
      }
    } catch {
      // best-effort — runner heartbeat must not fail on a runs-update miss
    }
  }

  return NextResponse.json({ ok: true });
}
