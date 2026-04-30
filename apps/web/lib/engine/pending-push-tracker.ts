// Pending-push tracker — Phase 2 / M5c.
//
// Reacts to every `agent/run.completed` (status='done') for a workspace-mode
// run, sniffs the per-ticket workspace for commits that aren't on the project's
// remote yet, and upserts a `pending_pushes` row so the sidebar badge ticks.
// The actual "Push & PR" flow lives in `apps/web/app/(app)/changes/actions.ts`
// (A7); this function only materialises the "there is something to push" fact.
//
// Why react to the event instead of inlining into run-agent? Three reasons:
//   1. Durability boundary. The run loop is already committed by the time
//      `agent/run.completed` fires; pushing the diff scan into a separate
//      Inngest function lets it retry independently without re-running any
//      LLM iterations.
//   2. Workspace-mode is a sparse signal. Tickets attached to a `projects`
//      row are the only ones that have a meaningful workspace_path; the env
//      fallback project (Phase 0 default) skips this entire path and we
//      return `{ skipped: "no project" }` early.
//   3. The tracker reads from `run_steps.payload.workspace_path` instead of
//      a dedicated column. A4 owns the runner-side payload shape, so adding
//      a denormalised column on `runs` would be churn we don't need: every
//      workspace-mode runner already writes that payload field.
//
// Idempotency: one in-flight `pending_pushes` row per (project_id, branch).
// If the user has already pushed (pushed_at is non-null) we leave that row
// alone and open a fresh one for the next commit cycle. If they haven't, we
// UPDATE in place so multiple completed runs against the same branch don't
// proliferate rows.
//
// Out of scope here:
//   - Realtime publication. The `pending_pushes` table is added to
//     `supabase_realtime` in the M5c migration (A1), so any INSERT/UPDATE
//     here fires a realtime event automatically and the badge hook
//     (`useLivePendingPushes`, A7) picks it up. The `pending_push.upserted`
//     and `pending_push.cleared` Inngest event types are added to the
//     schema for downstream listeners A6/A7 may wire up later.
//   - Registering this function in `app/api/inngest/route.ts`. A8 owns that.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import {
  getCurrentBranch,
  getFilesChanged,
  getHeadSha,
  getUnifiedDiff,
  getUnpushedCommits,
  type ChangedFile,
} from "@/lib/git/diff";
import { decidePushOwnership } from "@/lib/integration/merger-push";

type RunInfo = {
  runId: string;
  ticketId: string;
  tenantId: string;
  projectId: string;
  defaultBranch: string | null;
};

type DiffResult = {
  branch: string;
  commits: string[];
  filesChanged: ChangedFile[];
  unifiedDiff: string;
  headSha: string | null;
};

export const pendingPushTracker = inngest.createFunction(
  { id: "pending-push-tracker", retries: 1 },
  { event: "agent/run.completed" },
  async ({ event, step }) => {
    const { runId, status } = event.data;
    // Only successful runs are interesting — a failed run might have left
    // junk commits in the workspace, but the "ready to push" semantic only
    // makes sense for a converged ticket.
    if (status !== "done") {
      return { skipped: "non-done status" };
    }

    // 1. Resolve run → ticket → project. The env-fallback project (Phase 0
    //    default) returns no row, which short-circuits the function.
    const runInfo = await step.run("load-run-info", async (): Promise<RunInfo | null> => {
      const supabase = supabaseService();
      const { data: run } = await supabase
        .from("runs")
        .select("id, ticket_id, tenant_id")
        .eq("id", runId)
        .single();
      if (!run?.ticket_id) return null;
      const { data: ticket } = await supabase
        .from("tickets")
        .select("project_id")
        .eq("id", run.ticket_id)
        .single();
      if (!ticket?.project_id) return null;
      const { data: project } = await supabase
        .from("projects")
        .select("id, default_branch")
        .eq("id", ticket.project_id)
        .single();
      if (!project) return null;
      return {
        runId: run.id as string,
        ticketId: run.ticket_id as string,
        tenantId: run.tenant_id as string,
        projectId: project.id as string,
        defaultBranch: (project.default_branch as string | null) ?? null,
      };
    });
    if (!runInfo) return { skipped: "no project" };

    // 2. Find the workspace path. The runner records it on every step's
    //    payload; we walk back from the most recent step until we find one.
    //    Twenty rows is generous — the runner writes the field on the very
    //    first prep step, so anything beyond ~3 rows would already be odd.
    const workspacePath = await step.run("find-workspace", async () => {
      const supabase = supabaseService();
      const { data: steps } = await supabase
        .from("run_steps")
        .select("payload")
        .eq("run_id", runId)
        .order("idx", { ascending: false })
        .limit(20);
      for (const s of steps ?? []) {
        const p = (s.payload as { workspace_path?: string } | null)?.workspace_path;
        if (typeof p === "string" && p.length > 0) return p;
      }
      return null;
    });
    if (!workspacePath) {
      return { skipped: "no workspace_path on run_steps" };
    }

    // 3. Sniff the workspace for unpushed commits + capture the diff. All in
    //    one step.run so a transient git failure retries the whole scan
    //    atomically rather than the runner re-imaging a partial result.
    const result = await step.run("compute-diff", async (): Promise<DiffResult | null> => {
      const branch = await getCurrentBranch(workspacePath).catch(() => null);
      if (!branch) return null;
      const commits = await getUnpushedCommits(workspacePath, branch);
      if (commits.length === 0) {
        return {
          branch,
          commits: [],
          filesChanged: [],
          unifiedDiff: "",
          headSha: null,
        };
      }
      const filesChanged = await getFilesChanged(workspacePath, branch);
      const unifiedDiff = await getUnifiedDiff(workspacePath, branch, {
        maxBytes: 2 * 1024 * 1024,
      });
      const headSha = await getHeadSha(workspacePath);
      return { branch, commits, filesChanged, unifiedDiff, headSha };
    });
    if (!result || result.commits.length === 0) {
      return { skipped: "no unpushed commits" };
    }

    // 4. Upsert one row per (project_id, branch). UPDATE if there's an
    //    in-flight (pushed_at IS NULL) row; INSERT otherwise. Returns the row
    //    id so we can emit the typed Inngest event with the right pk.
    const pendingPushId = await step.run("upsert-pending-push", async () => {
      const supabase = supabaseService();
      // Tenant-scoped. This lookup decides whether we UPDATE an existing row or
      // INSERT a new one, so unscoped it was a cross-tenant WRITE with a leak
      // attached: a planted `{tenant_id: them, project_id: <our project>,
      // branch: <ours>, pushed_at: null}` row would be selected here and we
      // would write OUR unified diff into THEIR row.
      const { data: existing } = await supabase
        .from("pending_pushes")
        .select("id, ticket_id, merger_ticket_id")
        .eq("project_id", runInfo.projectId)
        .eq("tenant_id", runInfo.tenantId)
        .eq("branch", result.branch)
        .is("pushed_at", null)
        .maybeSingle();
      if (existing) {
        // A merger resolves the conflict IN THE SOURCE TICKET'S WORKSPACE, ON
        // THE SOURCE TICKET'S BRANCH, so its own run matches this row. Writing
        // `ticket_id` unconditionally re-parented the push to the merger and
        // orphaned it from the `integration_queue` row, which names the SOURCE
        // - the land then cancelled with "ticket has no branch with work to
        // land" over a branch full of commits. See `merger-push.ts`.
        const ownership = decidePushOwnership({
          existingTicketId: (existing.ticket_id as string | null) ?? null,
          existingMergerTicketId: (existing.merger_ticket_id as string | null) ?? null,
          incomingTicketId: runInfo.ticketId,
        });
        if (!ownership.reparented) {
          console.info(
            `[pending-push] keeping push ${existing.id} parented to source ` +
              `${ownership.ticketId}; merger ${runInfo.ticketId} committed onto ` +
              `branch ${result.branch}`,
          );
        }
        const { error } = await supabase
          .from("pending_pushes")
          .update({
            ticket_id: ownership.ticketId,
            run_id: runInfo.runId,
            workspace_path: workspacePath,
            unpushed_count: result.commits.length,
            files_changed: result.filesChanged,
            unified_diff: result.unifiedDiff,
            head_sha: result.headSha,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
        if (error) {
          throw new Error(`pending_pushes update failed: ${error.message}`);
        }
        return existing.id as string;
      }
      const { data: inserted, error: insertErr } = await supabase
        .from("pending_pushes")
        .insert({
          tenant_id: runInfo.tenantId,
          project_id: runInfo.projectId,
          ticket_id: runInfo.ticketId,
          run_id: runInfo.runId,
          workspace_path: workspacePath,
          branch: result.branch,
          unpushed_count: result.commits.length,
          files_changed: result.filesChanged,
          unified_diff: result.unifiedDiff,
          head_sha: result.headSha,
        })
        .select("id")
        .single();
      if (insertErr) {
        throw new Error(`pending_pushes insert failed: ${insertErr.message}`);
      }
      return inserted.id as string;
    });

    // 5. Emit the typed Inngest event. The realtime publication on the table
    //    is what drives the badge UI; this event is for downstream listeners
    //    (e.g. notification fan-out) that A6/A7 may add later.
    await step.sendEvent("emit-pending-push-upserted", {
      name: "pending_push.upserted",
      data: {
        pendingPushId,
        projectId: runInfo.projectId,
        tenantId: runInfo.tenantId,
        commits: result.commits.length,
      },
    });

    return {
      runId,
      pendingPushId,
      projectId: runInfo.projectId,
      branch: result.branch,
      commits: result.commits.length,
      files: result.filesChanged.length,
    };
  },
);
