"use server";

// Phase 2.5+ / Slice IB — Integration-branch + promotion server actions.
//
// Two actions live here:
//
//   • setIntegrationBranchAction({ projectId, branchName | null })
//       Updates `projects.integration_branch`. NULL clears it (back to legacy
//       "branches cut from default_branch" mode). The runner picks up the
//       new value on the next ticket dispatch — existing in-flight tickets
//       keep their current `devpilot/<slug>` branch and base.
//
//   • promoteIntegrationAction({ projectId, strategy })
//       Promotes the integration branch into the default (production) branch.
//       Two strategies:
//         - 'pr'     : opens a GitHub PR; operator merges on github.com
//                      (respects branch protection / CODEOWNERS / required
//                      reviews — the safe default).
//         - 'direct' : POST /repos/:owner/:repo/merges via the GitHub API
//                      (bypasses branch protection; faster; operator's token
//                      must have permission to merge directly).
//       Either way, a `branch_promotions` ledger row is inserted up-front
//       in status='pending' and stamped with the result on success/failure.
//
// Both actions live behind requireUser + requireTenantId and verify the
// project's tenant matches the calling user's tenant before touching state.

import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { isTicketBranch } from "@/lib/git/ticket-branch";
import { supabaseService } from "@/lib/db/server";
import { loadProjectById } from "@/lib/projects/load";
import { ensureFreshGithubToken } from "@/lib/github/refresh";
import { createPullRequest, mergeBranches, GithubApiError } from "@/lib/github/client";
import { enqueueForLanding } from "@/lib/integration/queue.server";
import { transitionTicket } from "@/lib/board/transitions";
import { decideRestartFromDev, decideDiscardAndRestart } from "@/lib/board/reopen-policy";
import { loadPendingPushesForTicket } from "@/lib/workspace/unpushed-work.server";
import { requestWorkspaceReset } from "@/lib/workspace/reset.server";
import { withSendTimeout } from "@/lib/engine/send-bounded";
import {
  runDiscardAndRestart,
  type DiscardAndRestartResult,
  type WorkspaceResetOutcome,
} from "@/lib/board/discard-restart";
import type { TicketStatus } from "@/lib/board/state";

// Branch names are constrained the same way git does — no spaces, no
// shell-special chars, ASCII only. Empty/whitespace-only inputs clear the
// setting (back to legacy default_branch routing).
const BRANCH_NAME_RE = /^[a-zA-Z0-9._/-]{1,200}$/;

export type SetIntegrationBranchInput = {
  projectId: string;
  /** New integration branch name. Empty / whitespace / null clears the
   *  setting and returns the project to legacy "cut from default_branch"
   *  behavior. */
  branchName: string | null;
};

export type SetIntegrationBranchResult =
  | { ok: true; integrationBranch: string | null }
  | { ok: false; error: string };

export async function setIntegrationBranchAction(
  input: SetIntegrationBranchInput,
): Promise<SetIntegrationBranchResult> {
  await requireUser();
  const callerTenantId = await requireTenantId();

  const project = await loadProjectById(input.projectId);
  if (!project) {
    return { ok: false, error: "Project not found." };
  }
  if (project.tenantId !== callerTenantId) {
    return { ok: false, error: "Project does not belong to your tenant." };
  }

  const trimmed = input.branchName?.trim() ?? "";
  const nextValue: string | null = trimmed.length === 0 ? null : trimmed;

  if (nextValue !== null && !BRANCH_NAME_RE.test(nextValue)) {
    return {
      ok: false,
      error: "Branch name must be ASCII letters/digits/`.`/`_`/`/`/`-` (max 200 chars).",
    };
  }
  if (nextValue !== null && nextValue === project.defaultBranch) {
    return {
      ok: false,
      error: "Integration branch can't equal the production branch. Clear it instead.",
    };
  }
  // 2026-06-08 hotfix — `devpilot/<slug>` is the per-ticket branch namespace
  // owned by the runner. Routing every push through one ticket's branch would
  // create a per-ticket stack root (which is what Phase C's `builds_on`
  // relation is actually for) and confuse the rebase pipeline. Reject
  // per-ticket values with a clear message so the operator picks a
  // stable branch like `dev` / `develop` / `staging`. The matcher covers the
  // pre-rename `ace/` prefix too — see lib/git/ticket-branch.ts.
  if (nextValue !== null && isTicketBranch(nextValue)) {
    return {
      ok: false,
      error:
        "Integration branch can't be a `devpilot/<slug>` branch — those are " +
        "per-ticket. Use a stable branch like `dev`, `develop`, or `staging`. " +
        "If you want to stack on top of another ticket's work, use the " +
        '"Builds on" picker when creating the child ticket.',
    };
  }

  const supabase = supabaseService();
  const { error } = await supabase
    .from("projects")
    .update({ integration_branch: nextValue })
    .eq("id", project.id);
  if (error) {
    return { ok: false, error: `Update failed: ${error.message}` };
  }
  return { ok: true, integrationBranch: nextValue };
}

export type PromoteIntegrationStrategy = "pr" | "direct";

export type PromoteIntegrationInput = {
  projectId: string;
  strategy: PromoteIntegrationStrategy;
  /** Optional commit/PR message override. Defaults to a templated string
   *  with the from/to branches and a timestamp. */
  message?: string;
};

export type PromoteIntegrationResult =
  | {
      ok: true;
      promotionId: string;
      strategy: PromoteIntegrationStrategy;
      prUrl?: string;
      prNumber?: number;
      mergeSha?: string;
      alreadyUpToDate?: boolean;
    }
  | { ok: false; error: string; promotionId?: string };

export async function promoteIntegrationAction(
  input: PromoteIntegrationInput,
): Promise<PromoteIntegrationResult> {
  const user = await requireUser();
  const callerTenantId = await requireTenantId();

  const project = await loadProjectById(input.projectId);
  if (!project) {
    return { ok: false, error: "Project not found." };
  }
  if (project.tenantId !== callerTenantId) {
    return { ok: false, error: "Project does not belong to your tenant." };
  }
  if (!project.integrationBranch) {
    return {
      ok: false,
      error: "Project has no integration branch configured. Set one first.",
    };
  }
  if (!project.githubOwner || !project.githubRepo) {
    return {
      ok: false,
      error: "Project isn't connected to a GitHub repo. Connect via Settings → GitHub first.",
    };
  }
  if (!project.createdBy) {
    return {
      ok: false,
      error: "Project has no owner identity for the GitHub token.",
    };
  }

  // Insert the ledger row up-front so failures still leave an audit trace.
  const supabase = supabaseService();
  const fromBranch = project.integrationBranch;
  const toBranch = project.defaultBranch;
  const { data: inserted, error: insertErr } = await supabase
    .from("branch_promotions")
    .insert({
      tenant_id: project.tenantId,
      project_id: project.id,
      from_branch: fromBranch,
      to_branch: toBranch,
      strategy: input.strategy,
      status: "pending",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return {
      ok: false,
      error: `Ledger insert failed: ${insertErr?.message ?? "no row"}`,
    };
  }
  const promotionId = inserted.id as string;

  // Resolve the project owner's GitHub token. The token is refreshed in-place
  // if needed; both flows accept a Bearer token.
  let token: string;
  try {
    // Pass the project's tenant so the OAuth App credentials resolve from the
    // tenant's platform-secrets scope (override » instance » env).
    const fresh = await ensureFreshGithubToken(project.createdBy, project.tenantId);
    if (!fresh) {
      await stampFailure(promotionId, "GitHub token not available for project owner.");
      return {
        ok: false,
        error: "GitHub token not available for project owner.",
        promotionId,
      };
    }
    token = fresh;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await stampFailure(promotionId, `Token refresh failed: ${message}`);
    return { ok: false, error: `Token refresh failed: ${message}`, promotionId };
  }

  const defaultMessage = `Promote ${fromBranch} → ${toBranch}`;
  const message = input.message?.trim().length ? input.message.trim() : defaultMessage;

  if (input.strategy === "pr") {
    try {
      const pr = await createPullRequest(
        { token },
        {
          owner: project.githubOwner,
          repo: project.githubRepo,
          head: fromBranch,
          base: toBranch,
          title: message,
          body:
            `Promotes \`${fromBranch}\` into \`${toBranch}\` via DevPilot.\n\n` +
            `Review the diff on GitHub and merge when ready. ` +
            `This PR was opened by the operator from the DevPilot project page.`,
        },
      );
      await stampOpened(promotionId, pr.html_url, pr.number);
      return {
        ok: true,
        promotionId,
        strategy: "pr",
        prUrl: pr.html_url,
        prNumber: pr.number,
      };
    } catch (err) {
      const message =
        err instanceof GithubApiError
          ? (err.githubMessage ?? err.message)
          : err instanceof Error
            ? err.message
            : String(err);
      await stampFailure(promotionId, message);
      return { ok: false, error: message, promotionId };
    }
  }

  // strategy === "direct"
  try {
    const result = await mergeBranches(
      { token },
      {
        owner: project.githubOwner,
        repo: project.githubRepo,
        base: toBranch,
        head: fromBranch,
        commit_message: message,
      },
    );
    if (result.merged) {
      await stampMerged(promotionId, result.sha);
      return {
        ok: true,
        promotionId,
        strategy: "direct",
        mergeSha: result.sha,
      };
    }
    // 204 No Content — head already up-to-date with base. Mark as merged
    // (the desired terminal state) with a null sha so the UI can label it
    // appropriately.
    await stampMerged(promotionId, null);
    return {
      ok: true,
      promotionId,
      strategy: "direct",
      alreadyUpToDate: true,
    };
  } catch (err) {
    const message =
      err instanceof GithubApiError
        ? (err.githubMessage ?? err.message)
        : err instanceof Error
          ? err.message
          : String(err);
    await stampFailure(promotionId, message);
    return { ok: false, error: message, promotionId };
  }
}

/**
 * WI-4 — the per-project auto-land opt-in.
 *
 * OFF by default, and only an operator can turn it on: the flag decides whether
 * a done ticket's branch is squash-merged onto the integration branch by the
 * land worker with no human in the loop, which is a real change in what the
 * platform is allowed to do to a repo. No agent, MCP tool, or engine path writes
 * this column — same shape as the safety-critical flag.
 *
 * Requires an integration branch: there is nowhere to land otherwise. The
 * instance-wide kill switch (`DEVPILOT_AUTO_LAND_ENABLED=0`) overrides this flag and
 * stops the worker everywhere regardless.
 *
 * Human review does NOT move: it stays at integration → production
 * (`promoteIntegrationAction`, unchanged). What auto-land removes is the manual
 * push/PR/merge of each ticket INTO the integration branch — and the per-ticket
 * automated gates (QA verdict, the L1 QA hand-off gate, the SME safety gate) all
 * still have to pass before a ticket can reach `done` and be enqueued at all.
 */
export type SetAutoLandInput = { projectId: string; enabled: boolean };
export type SetAutoLandResult = { ok: true; enabled: boolean } | { ok: false; error: string };

export async function setAutoLandEnabledAction(
  input: SetAutoLandInput,
): Promise<SetAutoLandResult> {
  await requireUser();
  const callerTenantId = await requireTenantId();

  const project = await loadProjectById(input.projectId);
  if (!project) return { ok: false, error: "Project not found." };
  if (project.tenantId !== callerTenantId) {
    return { ok: false, error: "Project does not belong to your tenant." };
  }
  if (input.enabled && !project.integrationBranch) {
    return {
      ok: false,
      error: "Set an integration branch first — auto-land needs somewhere to land into.",
    };
  }
  if (input.enabled && !(project.githubOwner && project.githubRepo)) {
    return {
      ok: false,
      error: "Connect the project to a GitHub repo before enabling auto-land.",
    };
  }

  const supabase = supabaseService();
  const { error } = await supabase
    .from("projects")
    .update({ auto_land_enabled: input.enabled })
    .eq("id", project.id);
  if (error) return { ok: false, error: `Failed to save: ${error.message}` };

  revalidatePath(`/projects/${project.id}`);
  return { ok: true, enabled: input.enabled };
}

// ─── ledger stampers ──────────────────────────────────────────────────────

async function stampOpened(id: string, prUrl: string, prNumber: number) {
  const supabase = supabaseService();
  await supabase
    .from("branch_promotions")
    .update({ status: "opened", pr_url: prUrl, pr_number: prNumber })
    .eq("id", id);
}

async function stampMerged(id: string, mergeSha: string | null) {
  const supabase = supabaseService();
  await supabase
    .from("branch_promotions")
    .update({ status: "merged", merge_sha: mergeSha })
    .eq("id", id);
}

async function stampFailure(id: string, reason: string) {
  const supabase = supabaseService();
  await supabase
    .from("branch_promotions")
    .update({ status: "failed", failure_reason: reason.slice(0, 1000) })
    .eq("id", id);
}

// ─── ticket recovery: Land now + Restart from dev ──────────────────────────
//
// Two operator-only affordances that live next to the auto-land toggle. Both
// reuse the existing land / cleanup machinery — neither reimplements branch
// merging or workspace deletion.

/** Load a ticket's recovery-relevant fields, tenant-checked. Service-role read
 *  (RLS is enforced by the explicit tenant comparison the callers make). */
async function loadRecoveryTicket(
  ticketId: string,
  callerTenantId: string,
): Promise<
  | {
      ok: true;
      ticket: { id: string; tenantId: string; projectId: string | null; status: TicketStatus };
    }
  | { ok: false; error: string }
> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("id, tenant_id, project_id, status")
    .eq("id", ticketId)
    .maybeSingle();
  if (error) return { ok: false, error: `Ticket lookup failed: ${error.message}` };
  if (!data) return { ok: false, error: "Ticket not found." };
  if ((data.tenant_id as string) !== callerTenantId) {
    return { ok: false, error: "Ticket does not belong to your tenant." };
  }
  return {
    ok: true,
    ticket: {
      id: data.id as string,
      tenantId: data.tenant_id as string,
      projectId: (data.project_id as string | null) ?? null,
      status: data.status as TicketStatus,
    },
  };
}

export type LandTicketNowResult =
  | { ok: true; enqueued: boolean; reason?: string; integrationBranch: string }
  | { ok: false; error: string };

/**
 * "Land now" — land a `done` ticket's committed-but-unlanded branch into the
 * project's integration branch ON DEMAND, driving the SAME durable pipeline the
 * auto path uses (`enqueueForLanding` → `integration/land-needed` →
 * `landTicketFn`). It does NOT reimplement the merge.
 *
 * WHY THIS EXISTS. Auto-land enqueues only on the `→ done` transition, so a
 * ticket that reached `done` before auto-land was armed never landed, and
 * arming the flag is not retroactive. This is the operator's one-click way to
 * land such a ticket after the fact.
 *
 * TWO GATES DELIBERATELY KEPT (not bypassed):
 *   • `auto_land_enabled` — the pipeline (`decideLandable`) is gated on it, so
 *     we require it and give an actionable error rather than threading a second
 *     "force" through the serialization-critical land worker. Arming auto-land
 *     is step 3 of the recommended recovery sequence anyway, so this nudges the
 *     operator to the right end state. This is the documented decision.
 *   • the instance kill switch (`DEVPILOT_AUTO_LAND_ENABLED`) — an operator can't
 *     override an instance-wide safety switch.
 *
 * THE ONE BYPASS: the `landed_sha='backfill'` sentinel. `enqueueForLanding` is
 * called with `force: true`, which — and only which — lets it see through that
 * sentinel so a backfilled `done` ticket becomes enqueueable. The auto path
 * never passes `force`, so it can never do this; a genuinely landed ticket (real
 * sha) is still never re-landed. See `decideLandedShaGate`.
 */
export async function landTicketNowAction(input: {
  ticketId: string;
}): Promise<LandTicketNowResult> {
  await requireUser();
  const callerTenantId = await requireTenantId();

  const loaded = await loadRecoveryTicket(input.ticketId, callerTenantId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const ticket = loaded.ticket;

  if (!ticket.projectId) {
    return { ok: false, error: "Ticket has no project, so it has nowhere to land." };
  }
  const project = await loadProjectById(ticket.projectId);
  if (!project) return { ok: false, error: "Project not found." };
  if (project.tenantId !== callerTenantId) {
    return { ok: false, error: "Project does not belong to your tenant." };
  }
  if (!project.integrationBranch) {
    return { ok: false, error: "Set an integration branch first — there is nowhere to land into." };
  }
  if (!(project.githubOwner && project.githubRepo)) {
    return { ok: false, error: "Connect the project to a GitHub repo before landing." };
  }
  if (!project.autoLandEnabled) {
    return {
      ok: false,
      error:
        "Enable auto-land for this project first (Branch routing) — the land pipeline is gated on it. " +
        "It won't retroactively land this ticket, but it lets you land it now and auto-lands future ones.",
    };
  }
  if (ticket.status !== "done") {
    return {
      ok: false,
      error: `Only a done ticket can be landed (this one is ${ticket.status}).`,
    };
  }

  const result = await enqueueForLanding({
    ticketId: ticket.id,
    tenantId: ticket.tenantId,
    // The whole point of the operator path: see through the backfill sentinel.
    force: true,
  });

  revalidatePath("/board");
  revalidatePath(`/projects/${ticket.projectId}`);
  if (result.enqueued) {
    return { ok: true, enqueued: true, integrationBranch: project.integrationBranch };
  }
  return {
    ok: true,
    enqueued: false,
    reason: result.reason,
    integrationBranch: project.integrationBranch,
  };
}

export type ReopenFromDevResult =
  | { ok: true; reopened: true; workspaceReset: WorkspaceResetOutcome }
  | {
      ok: false;
      error: string;
      /** Present when the refusal is because the workspace holds unpushed work.
       *  The UI lists the branches and points the operator at Land / Review. */
      unpushed?: { branch: string; count: number }[];
    };

/**
 * "Restart from dev" — reopen a `done` (or `paused`) ticket back to the backlog
 * and force its next run to fresh-clone the current integration branch, so it
 * rebuilds on top of the accumulated `dev` content.
 *
 * HUMAN-GATED. This is a server action behind `requireUser`, and it moves the
 * ticket through `transitionTicket` as `actor: "human"` — the only actor the
 * reopen gate (`decideReopenGate`) lets out of `done`. Agents can never reach
 * this.
 *
 * THE DATA-LOSS GUARD IS SACRED. A `done` ticket often has commits that live
 * ONLY in its workspace (auto-land off ⇒ never pushed). Fresh-cloning would
 * destroy them. So before doing anything we check `pending_pushes` via the pure
 * `decideRestartFromDev`, which composes the same `decideWorkspaceReap` guard the
 * reaper uses: if any unpushed work exists we REFUSE and hand back the branches,
 * telling the operator to Land / push / discard first. We NEVER silently wipe.
 * (The runner-side reap guard is the independent second line of defence: even if
 * this check were somehow skipped, `cleanupWorkspace` refuses in front of the
 * `rm`.)
 *
 * MECHANISM. When it is safe, we emit the existing `workspace/cleanup-requested`
 * event (`requestWorkspaceReset`) so the runner removes the redundant workspace,
 * then reopen the ticket to `backlog` WITHOUT dispatching. Backlog is a resting
 * state — the operator moves it to Ready when ready — and that human step is the
 * window in which the async cleanup completes, so the subsequent dispatch finds
 * no workspace and fresh-clones `integration_branch ?? default_branch`. We also
 * clear `landed_sha` so re-completed work can land again.
 */
export async function reopenFromDevAction(input: {
  ticketId: string;
}): Promise<ReopenFromDevResult> {
  await requireUser();
  const callerTenantId = await requireTenantId();

  const loaded = await loadRecoveryTicket(input.ticketId, callerTenantId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const ticket = loaded.ticket;

  const pendingPushes = await loadPendingPushesForTicket(ticket.id, callerTenantId);
  const decision = decideRestartFromDev({ status: ticket.status, pendingPushes });

  if (decision.action === "reject_status") {
    return { ok: false, error: capitalize(decision.reason) + "." };
  }
  if (decision.action === "refuse_unpushed") {
    return {
      ok: false,
      error:
        "This ticket has unpushed commits that exist only in its workspace. " +
        'Land them into dev ("Land now") or push / discard them via "Review changes" before ' +
        "restarting — otherwise restarting would abandon them.",
      unpushed: decision.holding.map((r) => ({
        branch: r.branch,
        count: r.unpushed_count ?? 0,
      })),
    };
  }

  // Safe to reopen. Emit the workspace reset FIRST so the runner is already
  // draining the cleanup while the ticket sits in backlog awaiting the
  // operator's move to Ready.
  //
  // BEST-EFFORT AND BOUNDED. An unresponsive Inngest makes an emit HANG rather
  // than throw, and a hang walks straight past this `catch`, stranding the
  // operator with the reopen never performed. The bound makes expiry an ordinary
  // error so the stated intent ("a failed cleanup emit must not block the
  // reopen") actually holds. It wraps the whole call because the whole call is
  // what the operator waits on - a DB read plus the send; `requestWorkspaceReset`
  // separately bounds the send itself, which is what covers a future caller.
  // Worst case the next run re-enters the stale workspace (no data loss); the
  // operator can restart again.
  let workspaceReset: WorkspaceResetOutcome;
  try {
    const reset = await withSendTimeout(
      () =>
        requestWorkspaceReset({
          ticketId: ticket.id,
          tenantId: ticket.tenantId,
          reason: "operator-restart-from-dev",
        }),
      { label: "workspace/cleanup-requested" },
    );
    workspaceReset = reset.emitted ? "queued" : "not_needed";
  } catch (err) {
    workspaceReset = "failed";
    console.warn(
      `[reopenFromDevAction] workspace reset emit failed for ${ticket.id}: ${String(err)}`,
    );
  }

  // Reopen to backlog as a human. `emitDispatch: false` keeps the ticket at rest
  // — nothing dispatches from backlog anyway, and suppressing the event avoids a
  // spurious run against the about-to-be-cleaned workspace.
  try {
    await transitionTicket({
      ticketId: ticket.id,
      tenantId: ticket.tenantId,
      to: "backlog",
      actor: "human",
      emitDispatch: false,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Reopen failed." };
  }

  // Clear the landing stamp so re-completed work can land again. Done AFTER the
  // reopen so a genuinely-landed ticket that fails to reopen keeps its stamp.
  try {
    await supabaseService()
      .from("tickets")
      .update({ landed_sha: null, integrated_at: null })
      .eq("id", ticket.id);
  } catch (err) {
    console.warn(
      `[reopenFromDevAction] clearing landed_sha failed for ${ticket.id}: ${String(err)}`,
    );
  }

  revalidatePath("/board");
  return { ok: true, reopened: true, workspaceReset };
}

export type { DiscardAndRestartResult, WorkspaceResetOutcome } from "@/lib/board/discard-restart";

/**
 * "Discard & restart from dev" — the DELIBERATE, human-confirmed sibling of the
 * safe "Restart from dev". For a NON-done, partially-completed ticket
 * (`in_progress`, `paused`, `blocked`, `input_required`), it INTENTIONALLY
 * discards the ticket's uncommitted + unpushed work and sends it back to the
 * backlog to re-run fresh off the current integration branch.
 *
 * HUMAN-GATED & BYPASS-PROOF. This is a server action behind `requireUser`, and
 * it moves the ticket through `transitionTicket` as `actor: "human"` — the only
 * actor the reset gate (`decideReopenGate`) lets reset a non-done ticket to
 * `backlog`. Agents / the engine can never reach this.
 *
 * AN EXPLICIT OVERRIDE OF THE DATA-LOSS GUARD, NOT A WEAKENING OF IT. The AGENTS
 * contract is "never SILENTLY delete the only copy of a commit"; a confirmed
 * operator discard is the sanctioned release. So this action, and ONLY this
 * action, threads `force: true` into the cleanup pipeline
 * (`requestWorkspaceReset` → the `workspace/cleanup-requested` event → the Redis
 * job → the runner's `cleanupWorkspace`), where the reap guard is bypassed for
 * this one confirmed discard. The automatic reaper and the safe restart never set
 * `force`, so their refuse-on-unpushed guard is fully intact.
 *
 * MECHANISM.
 *   1. Discard the ticket's `pending_pushes` rows — the same soft-discard
 *      `Review changes → Discard` uses (drop the row). This both clears the
 *      /changes entry and stops it dangling at a workspace we are about to wipe.
 *   2. Emit the workspace reset WITH `force: true` so the runner wipes even the
 *      unpushed commits.
 *   3. Reset the ticket to `backlog` (a resting state; the operator moves it to
 *      Ready when they want it to run) WITHOUT dispatching, so the async cleanup
 *      completes before the next run — which then fresh-clones `dev`.
 *   4. Clear `landed_sha` so re-completed work can land again.
 *
 * The caller is responsible for collecting the operator's explicit,
 * hard-to-mis-trigger confirmation before invoking this (see the type-to-confirm
 * dialog in TicketDrawer).
 */
export async function discardAndRestartFromDevAction(input: {
  ticketId: string;
}): Promise<DiscardAndRestartResult> {
  await requireUser();
  const callerTenantId = await requireTenantId();

  const loaded = await loadRecoveryTicket(input.ticketId, callerTenantId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const ticket = loaded.ticket;

  const decision = decideDiscardAndRestart({ status: ticket.status });
  if (decision.action === "reject_status") {
    return { ok: false, error: capitalize(decision.reason) + "." };
  }

  const supabase = supabaseService();

  // The four-step sequence lives in `lib/board/discard-restart.ts` so it can be
  // driven under Vitest - this file is `"use server"` and reaches `next/headers`
  // through `@/lib/auth`, which is precisely the gap the "hangs forever on an
  // unresponsive Inngest" defect lived in. Everything above (auth, tenant proof,
  // FSM decision) is the security envelope and stays here; only the effects are
  // supplied.
  const result = await runDiscardAndRestart(
    {
      // 1. Soft-discard every unpushed `pending_pushes` row for this ticket — the
      //    same machinery `discardPendingChangesAction` uses (drop the row).
      //    Scoped to unpushed rows so a genuinely-pushed-and-still-tracked row
      //    (if any) is left alone; the whole point is to throw away only
      //    local-only work.
      discardPendingPushes: async () => {
        // Tenant-scoped (`callerTenantId` is proved against this ticket by
        // `loadRecoveryTicket` above). This is a DELETE, so unscoped it was a
        // cross-tenant destroy: `pending_pushes`' member write policy pins only
        // the row's own `tenant_id`, so a hostile tenant could aim a row at our
        // ticket and have our discard drop THEIR record of unpushed work.
        const { data: dropped, error: delErr } = await supabase
          .from("pending_pushes")
          .delete()
          .eq("ticket_id", ticket.id)
          .eq("tenant_id", callerTenantId)
          .is("pushed_at", null)
          .select("id");
        if (delErr) return { ok: false as const, error: delErr.message };
        return { ok: true as const, count: dropped?.length ?? 0 };
      },
      // 2. `force: true` is what makes the reap guard step aside for this
      //    confirmed discard — set on NO other path, and named nowhere but here.
      requestWorkspaceReset: () =>
        requestWorkspaceReset({
          ticketId: ticket.id,
          tenantId: ticket.tenantId,
          reason: "operator-discard-and-restart",
          force: true,
        }),
      // 3. `emitDispatch: false` keeps the ticket at rest — nothing dispatches
      //    from backlog anyway, and suppressing the event avoids a spurious run
      //    against the about-to-be-wiped workspace.
      resetToBacklog: async () => {
        await transitionTicket({
          ticketId: ticket.id,
          tenantId: ticket.tenantId,
          to: "backlog",
          actor: "human",
          emitDispatch: false,
        });
      },
      // 4. Clear the landing stamp so re-completed work can land again.
      clearLandingStamp: async () => {
        await supabaseService()
          .from("tickets")
          .update({ landed_sha: null, integrated_at: null })
          .eq("id", ticket.id);
      },
    },
    { ticketId: ticket.id },
  );

  // Only on success, as before - a refusal changed nothing worth revalidating.
  if (result.ok) revalidatePath("/board");
  return result;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}
