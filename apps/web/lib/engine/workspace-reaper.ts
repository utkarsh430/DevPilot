// Workspace reaper — engine-side cron that announces which per-ticket
// workspaces should be cleaned by runners.
//
// Phase 1 / M0 Wave 3 scope (this commit):
//   • Scheduled function runs nightly.
//   • Scans tickets that have been in a terminal state (done | failed) for at
//     least REAPER_GRACE_HOURS (default 24h). The grace lets operators
//     inspect a recently-failed workspace before it disappears.
//   • For each ticket, gathers distinct `workspace_path` values from its
//     `run_steps.payload` and emits ONE `workspace/cleanup-requested` event
//     per ticket carrying those paths.
//   • Records a `workspace_reaped_at` timestamp on the ticket via a
//     dedicated column? — NO. To avoid a schema bump for what's a Phase-1
//     foundation, idempotency relies on the runner refusing to re-clean a
//     path that's already gone. The reaper is safe to re-fire.
//
// 2026-07-11 - UNPUSHED-WORK HOLD (data-loss fix):
//   A workspace is the ONLY copy of any commit whose branch was never pushed.
//   The reaper used to emit cleanup for every terminal ticket unconditionally,
//   so a ticket that reached `done` with an unpushed branch had its commits
//   `rm -rf`'d out of existence while the `pending_pushes` row survived,
//   pointing at a directory that no longer existed (the Changes page then died
//   with `spawn git ENOENT`). We now consult `pending_pushes` per ticket and
//   SKIP the emit while any row still holds unpushed work - see
//   `lib/workspace/unpushed-work.ts` for the predicate and for how an operator
//   releases the hold (push or discard). The runner enforces the same rule
//   independently against git itself (`apps/runner/src/workspace-reap-guard.ts`),
//   so a stale queued job or a future caller of `cleanupWorkspace` can't
//   bypass this.
//
// Out of scope here (operator-side / runner-side):
//   • Runner subscription to `workspace/cleanup-requested` and the actual
//     `rm -rf` against `~/.devpilot/workspaces/<ticketId>/`. The runner already
//     knows its workspace root from `apps/runner/src/workspace.ts`; wiring
//     the subscriber is the operator-side next step once ENGINEER_REPO_URL
//     is in use.
//   • Cross-host safety (the eventual fleet runner): a workspace path is
//     host-local, so the runner that owns the host must be the one cleaning.
//     The event payload doesn't bind to a runner id — runners filter by
//     their own owned-paths set.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { decideWorkspaceReap } from "@/lib/workspace/unpushed-work";
import { loadPendingPushesForTicket } from "@/lib/workspace/unpushed-work.server";
import { loadTicketWorkspacePaths } from "@/lib/workspace/reset.server";

const REAPER_GRACE_HOURS = Number(process.env.DEVPILOT_WORKSPACE_REAPER_GRACE_HOURS ?? "24");
const REAPER_BATCH_LIMIT = Number(process.env.DEVPILOT_WORKSPACE_REAPER_BATCH ?? "100");

// Set DEVPILOT_WORKSPACE_REAPER=0 to disable in environments where the runner
// isn't yet subscribed to cleanup events (avoids cluttering the event log).
const REAPER_ENABLED = (process.env.DEVPILOT_WORKSPACE_REAPER ?? "1") !== "0";

export const workspaceReaper = inngest.createFunction(
  { id: "workspace-reaper", retries: 1 },
  // Daily at 03:00 UTC. Aligns with low-activity windows in most TZs and
  // avoids overlapping with peak dispatcher load.
  { cron: "0 3 * * *" },
  async ({ step }) => {
    if (!REAPER_ENABLED) {
      return { skipped: "DEVPILOT_WORKSPACE_REAPER=0" };
    }

    const cutoffIso = await step.run("compute-cutoff", async () => {
      const d = new Date(Date.now() - REAPER_GRACE_HOURS * 3_600_000);
      return d.toISOString();
    });

    const tickets = await step.run("scan-terminal-tickets", async () => {
      const supabase = supabaseService();
      const { data, error } = await supabase
        .from("tickets")
        .select("id, tenant_id, status, updated_at")
        .in("status", ["done", "failed"])
        .lte("updated_at", cutoffIso)
        .order("updated_at", { ascending: true })
        .limit(REAPER_BATCH_LIMIT);
      if (error) throw new Error(`scan failed: ${error.message}`);
      return data ?? [];
    });

    if (tickets.length === 0) {
      return { cutoffIso, candidates: 0, emitted: 0, heldForUnpushedWork: 0 };
    }

    // Per-ticket: gather distinct workspace paths from run_steps.payload.
    // We do this in step.run so each ticket's I/O is checkpointed and a
    // mid-batch failure resumes cleanly.
    let emitted = 0;
    let heldForUnpushedWork = 0;
    for (const t of tickets) {
      // Unpushed-work hold - checked BEFORE we bother gathering paths, so a
      // held ticket costs one cheap indexed read and nothing else. A query
      // failure throws and Inngest retries the step: on this path, "we don't
      // know" must never resolve to "delete it".
      const hold = await step.run(`unpushed-hold-${t.id}`, async () => {
        const decision = decideWorkspaceReap(
          await loadPendingPushesForTicket(t.id as string, t.tenant_id as string),
        );
        if (decision.reap) return null;
        return decision.reason;
      });
      if (hold) {
        console.warn(`[workspace-reaper] holding workspace for ticket=${t.id}: ${hold}`);
        heldForUnpushedWork += 1;
        continue;
      }

      // Shared with the operator "Restart from dev" path (`reset.server.ts`) so
      // both gather workspace paths the same way.
      const paths = await step.run(`paths-${t.id}`, async () =>
        loadTicketWorkspacePaths(t.id as string, t.tenant_id as string),
      );

      if (paths.length === 0) continue;

      await step.sendEvent(`emit-${t.id}`, {
        name: "workspace/cleanup-requested",
        data: {
          tenantId: t.tenant_id as string,
          ticketId: t.id as string,
          paths,
          reason: `ticket-${t.status}-for-${REAPER_GRACE_HOURS}h`,
        },
      });
      emitted += 1;
    }

    return { cutoffIso, candidates: tickets.length, emitted, heldForUnpushedWork };
  },
);
