// WI-4 — `integration_queue` IO. Every read/write of the land queue goes
// through here; the decisions themselves are pure and live in
// `land-policy.ts` / `landed.ts`.
//
// Service-role throughout: the queue denies all non-service writes at the RLS
// layer, and every caller (the transition seam, the durable land worker, the
// reaper cron) is already inside the trusted server boundary.

import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { decideLandedShaGate, LANDED_SHA_BACKFILL_SENTINEL } from "@/lib/integration/land-policy";
import { decideMergerRelease } from "@/lib/integration/land-outcome";
import { settleLandedPush } from "@/lib/integration/landed-push";
import { resolveTicketPush } from "@/lib/integration/merger-push";
import type { TicketStatus } from "@/lib/board/state";

/** Instance-wide kill switch. Set `DEVPILOT_AUTO_LAND_ENABLED=0` to stop the land
 *  worker everywhere, regardless of any project's opt-in flag. Default ON, so
 *  the per-project `auto_land_enabled` (default FALSE) is what actually decides
 *  whether anything lands. */
export function isAutoLandEnabled(): boolean {
  return process.env.DEVPILOT_AUTO_LAND_ENABLED !== "0";
}

export type IntegrationQueueStatus =
  | "pending"
  | "landing"
  | "awaiting_merge_resolution"
  | "landed"
  | "failed"
  | "cancelled";

export type IntegrationQueueRow = {
  id: string;
  tenantId: string;
  projectId: string;
  ticketId: string;
  status: IntegrationQueueStatus;
  attempts: number;
};

/** What the land worker needs to know about the ticket it claimed. */
export type LandContext = {
  ticketId: string;
  tenantId: string;
  projectId: string;
  title: string;
  status: TicketStatus | null;
  landedSha: string | null;
  priority: number;
  project: {
    id: string;
    githubOwner: string | null;
    githubRepo: string | null;
    repoUrl: string | null;
    integrationBranch: string | null;
    defaultBranch: string;
    autoLandEnabled: boolean;
    createdBy: string | null;
  } | null;
  pendingPush: {
    id: string;
    branch: string;
    workspacePath: string;
    pushedAt: string | null;
    headSha: string | null;
  } | null;
};

// ─── enqueue ───────────────────────────────────────────────────────────────

export type EnqueueResult =
  | { enqueued: true; queueId: string; projectId: string; requeued: boolean }
  | { enqueued: false; reason: string };

/**
 * Enqueue a ticket for landing — the ONE entry point, called from the two
 * places that can know a landing is owed:
 *
 *   • `transitionTicket` on `→ done` (SYNCHRONOUSLY, before dependents are
 *     considered for promotion — see below), and
 *   • the `pending_push.upserted` listener, which covers a branch pushed AFTER
 *     the ticket was already done (and the merger's fix-up push).
 *
 * WHY THE `→ done` CALL MUST BE SYNCHRONOUS. `promoteUnblockedDependents` runs
 * on the same `→ done` transition and asks "does this dependent still have open
 * blockers?". Under WI-5 the answer for a landable parent is "yes — it is
 * awaiting its landing", but that is only true once the queue row EXISTS. Emit
 * the enqueue as an event and the promotion races it: promotion reads "no queue
 * row ⇒ nothing owed ⇒ blocker closed", promotes the dependent, and the
 * dependent starts on a dev tip that does not contain its parent. Inserting the
 * row inline closes the race by construction.
 *
 * MERGER REDIRECT. An auto-spawned merger (`release_engineer` with a
 * `parent_ticket_id`) has no branch of its own — it resolves the SOURCE ticket's
 * branch, inside the source's workspace. Enqueueing the merger would land the
 * source's branch under the merger's row and stamp `landed_sha` on the wrong
 * ticket. So a merger reaching done re-enqueues its SOURCE, which is exactly the
 * merger → retry edge: without it, a ticket whose land conflicted is parked in
 * `awaiting_merge_resolution` forever — done on the board, never on dev.
 *
 * Idempotent: the partial unique index on (ticket_id) covers pending / landing /
 * awaiting_merge_resolution, so a duplicate enqueue while a land is in flight is
 * a no-op rather than a second landing.
 *
 * `force` — the explicit operator "Land now" path (`landTicketNowAction`). Its
 * ONLY effect is to see through the `landed_sha='backfill'` sentinel that the
 * migration stamped on tickets that were already `done` when auto-land shipped,
 * so an operator can land such a ticket on demand. It is deliberately scoped:
 * the auto path never sets it (so it can't resurrect a backfilled ticket on its
 * own), and it never re-lands a GENUINELY landed ticket (a real sha). See
 * `decideLandedShaGate`.
 */
export async function enqueueForLanding(args: {
  ticketId: string;
  tenantId: string;
  force?: boolean;
}): Promise<EnqueueResult> {
  if (!isAutoLandEnabled()) return { enqueued: false, reason: "auto-land kill switch is on" };

  const supabase = supabaseService();
  const { data: ticket } = await supabase
    .from("tickets")
    .select(
      "id, tenant_id, project_id, status, landed_sha, priority, requested_role, parent_ticket_id",
    )
    .eq("id", args.ticketId)
    .maybeSingle();
  if (!ticket) return { enqueued: false, reason: "ticket not found" };

  // Merger redirect — land the SOURCE, not the merger. The rule is the pure
  // `decideMergerRelease`: only a merger that reached `done` releases its
  // source, so a failed or abandoned one leaves the parked row where it is.
  const release = decideMergerRelease({
    requestedRole: (ticket.requested_role as string | null) ?? null,
    parentTicketId: (ticket.parent_ticket_id as string | null) ?? null,
    status: (ticket.status as string | null) ?? null,
  });
  if (release.action === "hold") return { enqueued: false, reason: release.reason };
  const isMerger = release.action === "release_source";
  const targetId = isMerger ? release.sourceTicketId : (ticket.id as string);

  const target = isMerger
    ? (
        await supabase
          .from("tickets")
          .select("id, tenant_id, project_id, status, landed_sha, priority")
          .eq("id", targetId)
          .maybeSingle()
      ).data
    : ticket;
  if (!target) return { enqueued: false, reason: "target ticket not found" };

  const projectId = (target.project_id as string | null) ?? null;
  if (!projectId) {
    // The Inngest concurrency key that serializes landing IS the project id.
    // A ticket with no project has no lane to be serialized on, so it is never
    // landed automatically.
    return { enqueued: false, reason: "ticket has no project" };
  }
  // `landed_sha` handling — the sentinel-bypass rule lives in the pure
  // `decideLandedShaGate`. A genuinely landed ticket short-circuits here (never
  // re-landed); a backfilled ticket short-circuits too UNLESS this is the
  // explicit operator "Land now" (`force`), in which case the sentinel is
  // cleared further down (once the ticket proves landable) so the pipeline lands
  // it for real and stamps the true sha.
  const shaGate = decideLandedShaGate({
    landedSha: (target.landed_sha as string | null) ?? null,
    force: args.force === true,
  });
  if (shaGate.action === "already_landed") {
    return { enqueued: false, reason: "already landed" };
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id, auto_land_enabled")
    .eq("id", projectId)
    .maybeSingle();
  if (!project?.auto_land_enabled) {
    return { enqueued: false, reason: "auto-land is not enabled for this project" };
  }

  // A ticket is only enqueued once it is LANDABLE — done, with a branch. Never
  // merely "non-terminal": a ticket parked to `blocked` (a WI-2 safety park, a
  // QA retry-ceiling park) has no approved work and must never be queued to land.
  if ((target.status as string) !== "done") {
    return { enqueued: false, reason: `ticket is ${target.status}, not done` };
  }
  const branch = await loadLandableBranch(targetId, target.tenant_id as string);
  if (!branch) return { enqueued: false, reason: "ticket has no branch with work to land" };

  // Explicit operator "Land now" of a backfilled ticket: the sentinel was never
  // a real landing, so clear it now that the ticket has proven landable (done +
  // a branch). Clearing it here — not up front — means a re-file that turns out
  // to have nothing to land leaves the sentinel intact. The CAS on the sentinel
  // value keeps a genuine sha (impossible to reach here) from ever being wiped.
  if (shaGate.action === "clear_sentinel_and_land") {
    await supabase
      .from("tickets")
      .update({ landed_sha: null })
      .eq("id", targetId)
      .eq("landed_sha", LANDED_SHA_BACKFILL_SENTINEL);
  }

  // A row parked on a merger is RESET rather than duplicated — the unique index
  // would reject the insert anyway, and this is the path that actually releases
  // the parked land once its merger is done.
  // Tenant-scoped, off the target ticket's own row (DB truth, not the
  // caller-supplied `args.tenantId`, which this function never verifies).
  const { data: parked } = await supabase
    .from("integration_queue")
    .select("id")
    .eq("ticket_id", targetId)
    .eq("tenant_id", target.tenant_id as string)
    .eq("status", "awaiting_merge_resolution")
    .maybeSingle();
  if (parked) {
    const { data: reset } = await supabase
      .from("integration_queue")
      .update({ status: "pending", last_error: null, heartbeat_at: null, claimed_at: null })
      .eq("id", parked.id as string)
      // CAS: only OUR observed state may be moved, so a worker that re-claimed
      // the row between the read and this write is not clobbered.
      .eq("status", "awaiting_merge_resolution")
      .select("id");
    if (reset && reset.length > 0) {
      await emitLandNeeded({ tenantId: target.tenant_id as string, projectId });
      return { enqueued: true, queueId: parked.id as string, projectId, requeued: true };
    }
  }

  const { data: inserted, error } = await supabase
    .from("integration_queue")
    .insert({
      tenant_id: target.tenant_id as string,
      project_id: projectId,
      ticket_id: targetId,
      priority: (target.priority as number | null) ?? 3,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 = the partial unique index fired: a land is already pending/in
    // flight/parked for this ticket. That is the duplicate-enqueue guard doing
    // its job, not a failure.
    if (error.code === "23505") {
      // A row already exists in pending/landing/awaiting_merge_resolution.
      //
      // PUMP ANYWAY. The row this collides with is very often a `pending` one
      // the reaper re-pended without an event ever being sent, and this call —
      // typically a merger reaching `done` — is the moment it became landable.
      // Returning silently left it sitting `pending`, unclaimed, with only the
      // 5-minute cron floor to notice; if that cron is not running the ticket is
      // done on the board and never on dev, forever. That is the stall shape the
      // stranded push exhibited. `integration/land-needed` is idempotent (the
      // worker claims at most one row and no-ops when there is nothing to
      // claim), so an extra pump costs nothing and a missing one costs a
      // landing.
      await emitLandNeeded({ tenantId: target.tenant_id as string, projectId });
      return { enqueued: false, reason: "a landing is already queued for this ticket" };
    }
    throw new Error(`enqueueForLanding: ${error.message}`);
  }
  if (!inserted) return { enqueued: false, reason: "insert returned no row" };

  await emitLandNeeded({ tenantId: target.tenant_id as string, projectId });
  return { enqueued: true, queueId: inserted.id as string, projectId, requeued: false };
}

/**
 * The newest `pending_pushes` row for the ticket that actually carries a branch.
 * This is what "has a pushed branch" means operationally: the runner commits into
 * the workspace and the tracker records the row; whether it has reached the
 * remote yet is the land worker's job, not a precondition for queueing it.
 */
async function loadLandableBranch(ticketId: string, tenantId: string): Promise<string | null> {
  const supabase = supabaseService();
  // Tenant-scoped: the branch this returns is the branch the land worker MERGES
  // into the integration branch. A planted `{tenant_id: them, ticket_id: <our
  // ticket>}` row would win the `updated_at DESC` race and name the ref we
  // merge — the sharpest read in this file.
  const { data } = await supabase
    .from("pending_pushes")
    .select("branch")
    .eq("ticket_id", ticketId)
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const branch = (data?.branch as string | null) ?? null;
  return branch && branch.trim().length > 0 ? branch : null;
}

/**
 * The queue's OWN pump. Land cadence is deliberately NOT coupled to
 * `agent/run.completed`: a cascade, a merger retry, and the last ticket in a
 * project all have no follow-on completion, so a run-completion-driven queue
 * starves precisely when it has work left. Every successful land re-emits this,
 * and a low-frequency cron backs it up as a floor.
 */
export async function emitLandNeeded(args: { tenantId: string; projectId: string }): Promise<void> {
  await sendEventBounded({
    name: "integration/land-needed",
    data: { tenantId: args.tenantId, projectId: args.projectId },
  });
}

// ─── claim ─────────────────────────────────────────────────────────────────

/**
 * Claim the next landable row for a project (FOR UPDATE SKIP LOCKED, in
 * dependency order — see the SQL function's comment for why `builds_on` gates on
 * LANDED and `blocked_by` gates on DONE).
 *
 * This is a single-ROW claim, not a per-project mutex. What guarantees that only
 * one land runs per project at a time is the `land-ticket` function's
 * `concurrency { limit: 1, key: projectId }`.
 */
export async function claimNextLand(projectId: string): Promise<IntegrationQueueRow | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase.rpc("integration_queue_claim_next", {
    p_project_id: projectId,
  });
  if (error) throw new Error(`claimNextLand: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return null;
  return {
    id: row.id as string,
    ticketId: row.ticket_id as string,
    tenantId: row.tenant_id as string,
    projectId,
    status: "landing",
    attempts: (row.attempts as number | null) ?? 1,
  };
}

/** Everything the worker needs about the claimed ticket, in one read. */
export async function loadLandContext(ticketId: string): Promise<LandContext | null> {
  const supabase = supabaseService();
  const { data: ticket } = await supabase
    .from("tickets")
    .select("id, tenant_id, project_id, title, status, landed_sha, priority")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) return null;

  const projectId = (ticket.project_id as string | null) ?? null;
  const { data: project } = projectId
    ? await supabase
        .from("projects")
        .select(
          "id, github_owner, github_repo, repo_url, integration_branch, default_branch, auto_land_enabled, created_by",
        )
        .eq("id", projectId)
        .maybeSingle()
    : { data: null };

  // Scoped to the ticket's own tenant. The ticket is the ANCHOR here — looked up
  // by primary key, which is not attacker-aimable — so its `tenant_id` is the
  // legitimate authority for reading the rows that hang off it.
  //
  // NOT a bare `ticket_id = ticketId` read: a conflict handed to a merger used
  // to re-parent this row to the merger, orphaning it from the queue row (which
  // names the SOURCE, deliberately - see `decideMergerRelease`). That produced a
  // land cancelled with "ticket has no branch with work to land" over a branch
  // that had 15 unpushed commits. See `merger-push.ts`.
  const push = await resolveTicketPush(supabase, {
    ticketId,
    tenantId: ticket.tenant_id as string,
  });
  if (push?.via === "merger") {
    console.info(
      `[land] ticket=${ticketId} push=${push.id} recovered through merger ` +
        `${push.mergerTicketId} (branch ${push.branch})`,
    );
  }

  return {
    ticketId: ticket.id as string,
    tenantId: ticket.tenant_id as string,
    projectId: projectId ?? "",
    title: (ticket.title as string | null) ?? "",
    status: (ticket.status as TicketStatus | null) ?? null,
    landedSha: (ticket.landed_sha as string | null) ?? null,
    priority: (ticket.priority as number | null) ?? 3,
    project: project
      ? {
          id: project.id as string,
          githubOwner: (project.github_owner as string | null) ?? null,
          githubRepo: (project.github_repo as string | null) ?? null,
          repoUrl: (project.repo_url as string | null) ?? null,
          integrationBranch: (project.integration_branch as string | null) ?? null,
          defaultBranch: (project.default_branch as string | null) ?? "main",
          autoLandEnabled: (project.auto_land_enabled as boolean | null) ?? false,
          createdBy: (project.created_by as string | null) ?? null,
        }
      : null,
    pendingPush: push
      ? {
          id: push.id,
          branch: push.branch,
          workspacePath: push.workspacePath,
          pushedAt: push.pushedAt,
          headSha: push.headSha,
        }
      : null,
  };
}

// ─── stamps (all CAS-guarded) ──────────────────────────────────────────────

/**
 * THE stamp. Records the landing on the ticket AND closes the queue row, and it
 * is the only function in the codebase that writes `tickets.landed_sha`.
 *
 * `sha` is non-optional by type: there is no way to call this without one, which
 * is what makes the "landed row, NULL sha" half-land unrepresentable in code as
 * well as in the schema (see the chk_integration_queue_landed_ts CHECK).
 *
 * Order matters. The ticket is stamped FIRST, then the queue row is closed. If
 * we crash between the two, the row stays `landing` with a stamped ticket — and
 * the reaper reconciles it forward to `landed` on its next pass. The reverse
 * order would leave a terminal `landed` row above an unstamped ticket, which
 * nothing revisits: the exact silent half-land that wedges every dependent.
 *
 * The ticket write is CAS-guarded on `landed_sha IS NULL`, so a concurrent
 * stamp (a reaper reconciling the same landing) cannot overwrite the first sha.
 * A ticket lands once.
 *
 * `tenantId` and `pendingPushId` are REQUIRED, and that is the point rather than
 * an inconvenience: settling the ticket's `pending_pushes` row is implied by the
 * landing, and when it lived inline at the call sites two of the four forgot it
 * (see `landed-push.ts`). A landing path that cannot be written without deciding
 * what happens to the push row cannot silently leak one. Pass
 * `pendingPushId: null` only for a genuinely branchless ticket.
 */
export async function stampLanded(args: {
  queueId: string;
  ticketId: string;
  tenantId: string;
  pendingPushId: string | null;
  sha: string;
  prNumber?: number | null;
  prUrl?: string | null;
}): Promise<{ stamped: boolean; sha: string }> {
  const supabase = supabaseService();
  const now = new Date().toISOString();

  const { error: ticketErr } = await supabase
    .from("tickets")
    .update({ landed_sha: args.sha, integrated_at: now })
    .eq("id", args.ticketId)
    .is("landed_sha", null);
  if (ticketErr) throw new Error(`stampLanded(ticket): ${ticketErr.message}`);

  // Re-read: if another worker/reaper won the CAS, THEIR sha is the truth.
  const { data: ticket } = await supabase
    .from("tickets")
    .select("landed_sha")
    .eq("id", args.ticketId)
    .maybeSingle();
  const sha = ((ticket?.landed_sha as string | null) ?? args.sha) || args.sha;

  const { data: closed, error: queueErr } = await supabase
    .from("integration_queue")
    .update({
      status: "landed",
      landed_at: now,
      merge_sha: sha,
      last_error: null,
      ...(args.prNumber !== undefined ? { pr_number: args.prNumber } : {}),
      ...(args.prUrl !== undefined ? { pr_url: args.prUrl } : {}),
    })
    .eq("id", args.queueId)
    .in("status", ["landing", "awaiting_merge_resolution"])
    .select("id");
  if (queueErr) throw new Error(`stampLanded(queue): ${queueErr.message}`);

  // The branch is on the integration branch now, so nothing is owed to the
  // remote: the push row is settled. Done LAST, after the ticket and the queue
  // row, so a crash mid-stamp leaves the row still counted (visible, recoverable
  // by the next attempt) rather than settled above an unstamped ticket.
  await settleLandedPush(supabase, {
    pendingPushId: args.pendingPushId,
    tenantId: args.tenantId,
  });

  return { stamped: (closed?.length ?? 0) > 0, sha };
}

/** CAS-guarded status move. Returns false when the row was not in `from` —
 *  which is how the reaper and a late worker are kept from double-moving it. */
export async function moveQueueRow(args: {
  queueId: string;
  from: IntegrationQueueStatus[];
  to: IntegrationQueueStatus;
  lastError?: string | null;
  heartbeat?: boolean;
}): Promise<boolean> {
  const supabase = supabaseService();
  const patch: Record<string, unknown> = { status: args.to };
  if (args.lastError !== undefined) patch.last_error = args.lastError?.slice(0, 2000) ?? null;
  if (args.to === "pending") {
    patch.claimed_at = null;
    patch.heartbeat_at = null;
  }
  if (args.heartbeat) patch.heartbeat_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("integration_queue")
    .update(patch)
    .eq("id", args.queueId)
    .in("status", args.from)
    .select("id");
  if (error) throw new Error(`moveQueueRow: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Record the PR the land is going through, BEFORE the merge is attempted.
 *
 * This is a crash-safety write, not bookkeeping. Repos commonly enable "auto-
 * delete head branches on merge", so the instant the squash lands, `devpilot/<slug>`
 * is gone. A worker that then dies before stamping leaves the reaper asking "is
 * the BRANCH contained in dev?" — which 404s, reads as "not landed", and (once
 * the workspace is reaped too) can never recover the fact that the work IS on
 * dev. The ticket stays unlanded and every dependent wedges forever.
 *
 * The PR outlives the branch. Writing its number here, before the merge, is what
 * lets the reaper ask the one question that still has a truthful answer.
 */
export async function recordLandPullRequest(args: {
  queueId: string;
  prNumber: number;
  prUrl: string;
}): Promise<void> {
  const supabase = supabaseService();
  await supabase
    .from("integration_queue")
    .update({ pr_number: args.prNumber, pr_url: args.prUrl })
    .eq("id", args.queueId);
}

/** Keep-alive while a land is in flight. The reaper reads its age to tell "a
 *  worker is mid-merge" from "a worker died mid-merge". */
export async function heartbeatQueueRow(queueId: string): Promise<void> {
  const supabase = supabaseService();
  await supabase
    .from("integration_queue")
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("id", queueId)
    .eq("status", "landing");
}
