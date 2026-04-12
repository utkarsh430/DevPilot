// WI-4 — the serialized auto-land worker.
//
// WHAT IT REPLACES. Today a finished ticket sits in /changes until an operator
// pushes it, opens a PR against `dev`, and merges it by hand. That manual step
// is the only thing that puts a ticket's work onto the integration branch — and
// WI-5 now gates every dependent on exactly that fact. So the manual step
// becomes a durable worker: rebase onto the LIVE dev tip, land as a squashed PR,
// and stamp the one truth (`tickets.landed_sha` / `integrated_at`) that says the
// work is on dev.
//
// SERIALIZATION — the load-bearing property of this file.
//
//   `concurrency: { limit: 1, key: event.data.projectId }`
//
// One land per project at a time, no exceptions. This is NOT an optimization and
// it is not achieved by the SQL claim: `integration_queue_claim_next` uses FOR
// UPDATE SKIP LOCKED, which is a single-ROW claim — two concurrent callers get
// two DIFFERENT rows and would rebase-and-merge into the same dev tip at once,
// each having verified a tip the other is about to move. The Inngest concurrency
// key is the mutex; SKIP LOCKED is defence in depth behind it.
//
// Each invocation therefore claims and FULLY lands exactly ONE row (rebase +
// merge + stamp) before returning, then re-pumps the queue for the next one.
// The key MUST resolve to a non-null projectId — an `undefined` key silently
// serializes NOTHING, which is why `integration_queue.project_id` is NOT NULL and
// why the event carries the project explicitly rather than being derived from a
// run (`agent/run.completed` carries no projectId at all).
//
// And it is deliberately NOT folded into `drainBacklogFn`: that function's own
// `concurrency { limit: 1 }` is the DRAIN COORDINATOR lock, and the drain's
// fan-out lives inside it. Sharing the lock would stall the whole sliding window
// behind every merge.

import { NonRetriableError, type GetStepTools } from "inngest";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { gitExec, safeStderr } from "@/lib/git/exec";
import { ensureCredentialFreeOrigin } from "@/lib/git/remote";
import {
  conflictedFiles,
  mergeWouldChangeNothing,
  reconcileWithRemoteBranch,
  revParse,
} from "@/lib/git/reconcile-branch";
import { ensureFreshGithubToken } from "@/lib/github/refresh";
import {
  createPullRequest,
  findOpenPullRequest,
  getBranchSha,
  getPullRequest,
  isBranchContainedIn,
  squashMergePullRequest,
  GithubApiError,
} from "@/lib/github/client";
import {
  logConflictEvent,
  spawnMerger,
  stampConflict,
  type ConflictDetail,
} from "@/lib/engine/conflict-audit";
import {
  claimNextLand,
  emitLandNeeded,
  enqueueForLanding,
  heartbeatQueueRow,
  isAutoLandEnabled,
  loadLandContext,
  moveQueueRow,
  recordLandPullRequest,
  stampLanded,
  type LandContext,
} from "@/lib/integration/queue.server";
import {
  assertSerializableLandEvent,
  decideLandable,
  decideReap,
  resolveLandedSha,
  LAND_HEARTBEAT_TIMEOUT_MS,
  LAND_SERIALIZATION,
  MAX_LAND_ATTEMPTS,
  type MergeObservation,
} from "@/lib/integration/land-policy";
import {
  buildNothingToLandComment,
  buildNothingToLandMetadata,
  decideConflictResolution,
  decideLandAttempt,
  classifyPullRequestFailure,
  type GithubFailureShape,
  NOTHING_TO_LAND_AUTHOR_ID,
  type NothingToLandOutcome,
} from "@/lib/integration/land-outcome";
import {
  loadPendingPushConflictState,
  markConflictResolved,
} from "@/lib/integration/land-outcome-write";
import { resolveMergerTicketId } from "@/lib/integration/merger-push";
import { addComment, promoteUnblockedDependents } from "@/lib/board/transitions";
import { checkWorkspaceAvailable } from "@/lib/dev-servers/workspace-availability.server";
import { resolveWorkspaceRoot } from "@/lib/workspace-root";
import type { TicketStatus } from "@/lib/board/state";

const GIT_TIMEOUT_MS = 120_000;
const WORKSPACE_ROOT = resolveWorkspaceRoot(process.env.WORKSPACE_ROOT);

// ─── the worker ────────────────────────────────────────────────────────────

export const landTicketFn = inngest.createFunction(
  {
    id: "land-ticket",
    // THE serialization. See the file header, and `LAND_SERIALIZATION` (which is
    // where it is defined, and asserted on, so it can't drift) before touching it.
    concurrency: { limit: LAND_SERIALIZATION.limit, key: LAND_SERIALIZATION.key },
    // Retries are handled in-band: a failed land must return its row to the
    // queue (or fail it at the attempt ceiling), not be blindly replayed by
    // Inngest on top of a half-finished merge.
    retries: 0,
  },
  { event: "integration/land-needed" },
  async ({ event, step }) => {
    // A land whose concurrency key resolved to `undefined` is running with NO
    // mutual exclusion. Refuse, rather than land unserialized.
    let tenantId: string;
    let projectId: string;
    try {
      ({ tenantId, projectId } = assertSerializableLandEvent(event.data));
    } catch (err) {
      throw new NonRetriableError(err instanceof Error ? err.message : String(err));
    }
    if (!isAutoLandEnabled()) return { skipped: "DEVPILOT_AUTO_LAND_ENABLED=0" };

    // 1. Claim ONE row, in dependency order. A row whose builds_on parent hasn't
    //    landed is skipped over (not halted on), so an independent ticket lands
    //    instead and one stalled chain never blocks the project's lane.
    const claimed = await step.run("claim-next", async () => claimNextLand(projectId));
    if (!claimed) return { landed: 0, reason: "nothing claimable" };

    const { id: queueId, ticketId, attempts } = claimed;

    // 2. Attempt ceiling. A land that fails deterministically (a branch that no
    //    longer exists, a repo we lost access to) must not spin the pump forever.
    if (attempts > MAX_LAND_ATTEMPTS) {
      await step.run("fail-at-ceiling", async () =>
        moveQueueRow({
          queueId,
          from: ["landing"],
          to: "failed",
          lastError: `land failed ${attempts - 1} times (ceiling ${MAX_LAND_ATTEMPTS})`,
        }),
      );
      await step.run("repump-after-ceiling", async () => emitLandNeeded({ tenantId, projectId }));
      return { landed: 0, ticketId, failed: "attempt ceiling" };
    }

    try {
      const result = await landOne({ step, queueId, ticketId, tenantId, projectId, attempts });

      // 3. The queue's OWN pump. Land cadence is never coupled to
      //    `agent/run.completed`: a cascade, a merger retry, and the last ticket
      //    in a project all have no follow-on completion, so a completion-driven
      //    queue starves exactly when it still has work. Each invocation lands
      //    one row and asks for the next.
      await step.run("repump", async () => emitLandNeeded({ tenantId, projectId }));
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Hand the row back to the queue (or fail it if this was the last attempt).
      // Either way it leaves `landing`, so the reaper isn't left to time it out.
      await step.run("release-on-error", async () => {
        const atCeiling = attempts >= MAX_LAND_ATTEMPTS;
        await moveQueueRow({
          queueId,
          from: ["landing"],
          to: atCeiling ? "failed" : "pending",
          lastError: message,
        });
      });
      await step.run("repump-after-error", async () => emitLandNeeded({ tenantId, projectId }));
      console.warn(`[land-worker] ticket=${ticketId} land failed: ${message}`);
      return { landed: 0, ticketId, error: message };
    }
  },
);

/** Inngest's own step tooling, bound to our client's event schema — so the
 *  `landOne` helper below gets the same `step.run` typing the handler has. */
type StepRunner = GetStepTools<typeof inngest>;

type LandOneArgs = {
  step: StepRunner;
  queueId: string;
  ticketId: string;
  tenantId: string;
  projectId: string;
  attempts: number;
};

async function landOne(args: LandOneArgs) {
  const { step, queueId, ticketId, tenantId, projectId } = args;

  const ctx: LandContext | null = await step.run("load-context", async () =>
    loadLandContext(ticketId),
  );

  // 4. LANDABLE predicate. Note what is NOT consulted: the dispatcher's
  //    TERMINAL_TICKET_STATES, which CONTAINS `done` and would cancel exactly
  //    the tickets we exist to land. See decideLandable().
  const decision = decideLandable({
    status: ctx?.status ?? null,
    hasBranch: Boolean(ctx?.pendingPush?.branch),
    landedSha: ctx?.landedSha ?? null,
    autoLandEnabled: Boolean(ctx?.project?.autoLandEnabled),
    hasIntegrationTarget: Boolean(
      ctx?.project?.githubOwner && ctx?.project?.githubRepo && integrationBranchOf(ctx),
    ),
  });

  if (decision.action === "cancel") {
    await step.run("cancel-row", async () =>
      moveQueueRow({
        queueId,
        from: ["landing"],
        to: "cancelled",
        lastError: decision.reason,
      }),
    );
    return { landed: 0, ticketId, cancelled: decision.reason };
  }

  if (decision.action === "already_landed") {
    // A duplicate enqueue, or a replay after a successful stamp. Close the row
    // out against the sha already on the ticket — never merge a second time.
    //
    // This path used to stamp and return WITHOUT settling the push row, so every
    // re-enqueue of an already-landed ticket left a `pushed_at IS NULL` row
    // behind claiming unpushed work that had shipped. `stampLanded` now owns the
    // settle; the push id is threaded through here for that reason.
    await step.run("close-already-landed", async () =>
      stampLanded({
        queueId,
        ticketId,
        tenantId,
        pendingPushId: ctx?.pendingPush?.id ?? null,
        sha: ctx!.landedSha!,
      }),
    );
    return { landed: 0, ticketId, alreadyLanded: true };
  }

  const c = ctx!;
  const project = c.project!;
  const push = c.pendingPush!;
  const owner = project.githubOwner!;
  const repo = project.githubRepo!;
  const base = integrationBranchOf(c)!;
  const branch = push.branch;

  // 5. The project owner's GitHub token — the same identity the manual push/PR
  //    flow uses.
  const token = await step.run("resolve-token", async () => {
    if (!project.createdBy) throw new Error("project has no owner identity for a GitHub token");
    const fresh = await ensureFreshGithubToken(project.createdBy, tenantId);
    if (!fresh) throw new Error("GitHub token not available for the project owner");
    return fresh;
  });

  // 6. Rebase onto the LIVE dev tip and push the feature branch.
  //
  //    Re-fetched HERE, at claim time, not read from any snapshot: the previous
  //    ticket in this same lane may have moved dev seconds ago, and rebasing onto
  //    a stale tip is how you land a branch that silently drops it.
  const prep = await step.run("rebase-and-push", async () =>
    rebaseAndPush({
      workspacePath: push.workspacePath,
      branch,
      base,
      pushedAt: push.pushedAt,
      token,
    }),
  );

  if (prep.kind === "conflict") {
    // 7. Conflict → park the row and hand the fix to a merger. The row is NOT
    //    failed and NOT re-pended: a merger owns it now, and re-landing it in a
    //    loop would spawn a merger per attempt. It is released back to `pending`
    //    when that merger reaches done (the merger→retry edge in
    //    enqueueForLanding) — without which the ticket would be done on the board
    //    and never on dev, forever.
    await step.run("park-on-conflict", async () => {
      await stampConflict(push.id, prep.detail);
      await logConflictEvent(push.id, "detected", { ...prep.detail, source: "auto-land" });
      const mergerTicketId = await spawnMerger({
        pendingPushId: push.id,
        sourceTicketId: ticketId,
        tenantId,
        projectId,
        integrationBranch: base,
        sourceBranch: branch,
        detail: prep.detail,
        sourceTitle: c.title || `branch ${branch}`,
      });
      await logConflictEvent(push.id, "merger_spawned", {
        merger_ticket_id: mergerTicketId,
        source: "auto-land",
      });
      await moveQueueRow({
        queueId,
        from: ["landing"],
        to: "awaiting_merge_resolution",
        lastError: `rebase onto ${base} conflicted; merger ${mergerTicketId} owns the fix`,
      });
    });
    return { landed: 0, ticketId, parked: "awaiting_merge_resolution" };
  }

  if (prep.kind === "error") throw new Error(prep.error);

  // 7b. THE MERGER LOOP CLOSES HERE. The rebase just succeeded against the LIVE
  //     integration tip, which is direct evidence that whatever conflict parked
  //     this push is gone — so, and only so, the conflict flag is cleared and
  //     the replayed sha recorded. Success is deliberately NOT taken from the
  //     merger ticket's own status: a merger can move itself to `done` having
  //     resolved nothing, and clearing on that would land a branch nobody fixed.
  //     A merger that failed or was abandoned lands us in the `conflict` branch
  //     above instead, with the flag untouched.
  await step.run("resolve-conflict-flag", async () => {
    try {
      const db = supabaseService();
      const current = await loadPendingPushConflictState(db, {
        pendingPushId: push.id,
        tenantId,
      });
      const decision = decideConflictResolution({
        conflictState: current?.conflictState ?? null,
        rebaseSucceeded: true,
        headSha: prep.headSha,
      });
      if (decision.action !== "resolve") return { resolved: false, reason: decision.reason };

      const moved = await markConflictResolved(db, {
        pendingPushId: push.id,
        tenantId,
        rebasedOntoSha: decision.rebasedOntoSha,
      });
      if (moved) {
        await logConflictEvent(push.id, "retry_pushed", {
          rebased_onto_sha: decision.rebasedOntoSha,
          base,
          source: "auto-land",
        });
      }
      return { resolved: moved };
    } catch (err) {
      // A record-keeping failure must never fail the landing it is recording.
      console.warn(
        `[land] resolve-conflict-flag failed for push=${push.id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return { resolved: false, reason: "error" };
    }
  });

  // 7c. NOTHING TO LAND. A review-only ticket finishes with a branch that is
  //     zero commits ahead of the base; opening a pull request for it returns
  //     `422 Validation Failed`, which used to be recorded on the queue row as
  //     an error. Detect it BEFORE the pull request and close the row out as the
  //     success it is. An INDETERMINATE count falls through to the PR as before.
  //
  //     The same outcome is reachable a second way — see the `createPullRequest`
  //     catch below — so the closure is a local helper both paths call rather
  //     than two copies that can drift into disagreeing about what "nothing to
  //     land" does to the ticket.
  const closeNothingToLand = async (reason: string, outcome: NothingToLandOutcome) => {
    // The branch's (empty) work is, vacuously, already contained in the base —
    // so the base tip is the truthful `landed_sha`. Stamping it is what releases
    // `builds_on` dependents, which gate on LANDED and would otherwise wedge
    // forever behind a ticket that had nothing to merge.
    const baseSha = await step.run("read-base-ref-nothing-to-land", async () =>
      getBranchSha({ token }, { owner, repo, branch: base }),
    );
    if (!baseSha) throw new Error(`could not resolve ${base} to stamp a nothing-to-land outcome`);

    // Nothing is owed to the remote, so the push is settled — `stampLanded` does
    // it, tenant-scoped and CAS-guarded. That also releases the unpushed-work
    // reap guard holding the workspace on disk.
    const stamped = await step.run("close-nothing-to-land", async () =>
      stampLanded({ queueId, ticketId, tenantId, pendingPushId: push.id, sha: baseSha }),
    );

    // The readable record of this outcome: a system comment under its own
    // author with structured `metadata.kind = 'nothing_to_land'`. Best-effort —
    // a notice must never fail the outcome it describes.
    await step.run("notice-nothing-to-land", async () => {
      try {
        await addComment({
          ticketId,
          tenantId,
          authorType: "system",
          authorId: NOTHING_TO_LAND_AUTHOR_ID,
          body: buildNothingToLandComment({ branch, base, outcome }),
          metadata: buildNothingToLandMetadata({ branch, base, outcome }),
        });
        return { posted: true };
      } catch (err) {
        console.warn(
          `[land] nothing-to-land notice failed for ticket=${ticketId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return { posted: false };
      }
    });

    // Same fan-out as a real landing, and for the same reason: everything
    // downstream keys off `landed_sha`, not off HOW the sha was reached. Omitting
    // any of these would leave a stacked child rooted on a sha nothing told it
    // about, which is the wedge this whole path exists to avoid.
    await step.run("post-land-nothing-to-land", async () => {
      await inngest.send({
        name: "branch/parent-landed",
        data: { ticketId, tenantId, integrationSha: stamped.sha, integrationBranch: base },
      });
      await promoteUnblockedDependents({ blockerTicketId: ticketId, tenantId });
      await inngest.send({ name: "ticket-drain/requested", data: { tenantId, projectId } });
    });

    return { landed: 0, ticketId, sha: stamped.sha, nothingToLand: reason, outcome };
  };

  const attempt = decideLandAttempt({ commitsAhead: prep.commitsAhead });
  if (attempt.action === "nothing_to_land") {
    // The two ways to get here are different facts and are recorded as such:
    // a branch that changed nothing, versus one whose work already shipped.
    return closeNothingToLand(
      prep.alreadyOnBase ? "every change is already on the integration branch" : attempt.reason,
      prep.alreadyOnBase ? "already_on_base" : "no_commits",
    );
  }

  await step.run("heartbeat", async () => heartbeatQueueRow(queueId));

  // 8. Land it: open (or re-find) the PR, merge it with SQUASH.
  const merge = await step.run("squash-merge", async (): Promise<MergeObservation> => {
    const existing = await findOpenPullRequest({ token }, { owner, repo, head: branch, base });
    let pr = existing;
    if (!pr) {
      try {
        pr = await createPullRequest(
          { token },
          {
            owner,
            repo,
            head: branch,
            base,
            title: c.title?.trim() || `DevPilot: ${branch}`,
            body:
              `Auto-landed by DevPilot.\n\n` +
              `Ticket: \`${ticketId}\`\nBranch: \`${branch}\` → \`${base}\``,
          },
        );
      } catch (err) {
        // THE FALLBACK for what `decideLandAttempt` could not prove locally — an
        // indeterminate commit count, or a branch emptied between the count and
        // this request. It reads the WHOLE error, not just the top-level
        // `message`: GitHub's 422 for this case says "Validation Failed" up top
        // and puts the real reason ("No commits between …") in `errors[]`, which
        // is why the old `githubMessage`-only match never once fired and
        // DevPilot-7 burned three attempts recording a cause it never named.
        const failure = classifyPullRequestFailure(toGithubFailureShape(err));
        if (failure.kind === "nothing_to_land") {
          return { kind: "nothing_to_land", reason: failure.reason };
        }
        // Every other 422 keeps the `explainPushFailure` standard: name the
        // cause GitHub buried in `errors[]` rather than surfacing the generic
        // top-level string on its own. Anything that is not a 422 is rethrown
        // untouched — the original error type and message are already the best
        // account of it, and re-wrapping would only lose the class.
        if (err instanceof GithubApiError && err.status === 422) {
          throw new Error(failure.explanation);
        }
        throw err;
      }
    }
    // Record the PR BEFORE merging. If the merge succeeds and we die before
    // stamping — and the repo auto-deletes head branches, as many do — the branch
    // is gone and "is the branch in dev?" no longer has a truthful answer. The PR
    // does. See recordLandPullRequest().
    await recordLandPullRequest({ queueId, prNumber: pr.number, prUrl: pr.html_url });

    const merged = await squashMergePullRequest(
      { token },
      {
        owner,
        repo,
        pullNumber: pr.number,
        commitTitle: `${c.title?.trim() || branch} (#${pr.number})`,
        commitMessage: `Auto-landed by DevPilot.\nTicket: ${ticketId}`,
      },
    );
    if (merged.merged) return { kind: "merged", sha: merged.sha };
    if (merged.reason === "already_merged") return { kind: "already_up_to_date" };
    throw new NotMergeableError(merged.message, pr.number, pr.html_url);
  });

  // 8b. The fallback's nothing-to-land observation converges on the SAME closure
  //     the local check uses, so both paths leave identical records: a terminal
  //     row, the base tip stamped, and the `devpilot_nothing_to_land` notice the
  //     board reads. Before this, an after-the-fact detection stamped a landing
  //     and rendered as `Landed`, quietly claiming the ticket had shipped code.
  if (merge.kind === "nothing_to_land") return closeNothingToLand(merge.reason, "no_commits");

  // 9. THE STAMP. The sha comes from reading the dev REF, never from the merge
  //    response — see resolveLandedSha() for the half-land this prevents. If the
  //    ref won't resolve we refuse to stamp at all and let the row stay claimed
  //    for the reaper, rather than recording a landing we can't name.
  const devSha = await step.run("read-dev-ref", async () =>
    getBranchSha({ token }, { owner, repo, branch: base }),
  );
  const resolved = resolveLandedSha({ observation: merge, devRefSha: devSha });
  if (!resolved.ok) throw new Error(resolved.reason);

  // The branch IS on dev now, so the pending_push is no longer pending. Settling
  // it clears the /changes badge and releases the unpushed-work reap guard, which
  // is otherwise holding the workspace on disk forever. `stampLanded` owns that
  // write — and unlike the inline version this replaces, it is tenant-scoped.
  const stamp = await step.run("stamp-landed", async () =>
    stampLanded({ queueId, ticketId, tenantId, pendingPushId: push.id, sha: resolved.sha }),
  );

  // 10. Post-land fan-out. Everything downstream keys off the landing, not off
  //     `done`, and every one of these is a no-op if the sha didn't change.
  await step.run("post-land", async () => {
    // (a) Stacked children re-rebase onto the new tip.
    await inngest.send({
      name: "branch/parent-landed",
      data: {
        ticketId,
        tenantId,
        integrationSha: stamp.sha,
        integrationBranch: base,
      },
    });
    // (b) WI-5 — THE promotion trigger. It cannot stay on `→ done`: at `done`
    //     the landing hasn't happened, so a dependent's blocker is still open,
    //     the promotion misses, and nothing ever re-fires it. Here, the landing
    //     IS the fact that unblocks the dependent.
    await promoteUnblockedDependents({ blockerTicketId: ticketId, tenantId });
    // (c) …and re-drain the project, so a dependent the drain DEFERRED while
    //     this ticket was landing gets re-evaluated now that it has landed. The
    //     drain window is also what caps the fan-out: a wide builds_on tree
    //     readies through the sliding window, not straight into dispatch.
    await inngest.send({
      name: "ticket-drain/requested",
      data: { tenantId, projectId },
    });
  });

  return { landed: 1, ticketId, sha: stamp.sha, alreadyUpToDate: resolved.alreadyUpToDate };
}

class NotMergeableError extends Error {
  constructor(
    message: string,
    readonly prNumber: number,
    readonly prUrl: string,
  ) {
    super(`GitHub refused to merge PR #${prNumber}: ${message}`);
    this.name = "NotMergeableError";
  }
}

function integrationBranchOf(ctx: LandContext | null): string | null {
  if (!ctx?.project) return null;
  return ctx.project.integrationBranch ?? ctx.project.defaultBranch ?? null;
}

// ─── rebase + push ─────────────────────────────────────────────────────────

type PrepResult =
  | {
      kind: "ok";
      rebased: boolean;
      /** HEAD after the rebase. `null` when there was no usable workspace to
       *  inspect (branch landed from the remote) — indeterminate, not proof, so
       *  `decideConflictResolution` refuses to clear a conflict on it. */
      headSha: string | null;
      /** `git rev-list --count origin/<base>..HEAD`. `null` when it could not be
       *  counted; NEVER inferred to 0 — see `decideLandAttempt`. */
      commitsAhead: number | null;
      /** Proven already on the integration branch: merging would change nothing.
       *  A SUCCESS, not an error - see `mergeWouldChangeNothing`. It rides
       *  alongside `commitsAhead: 0` rather than replacing it, so the existing
       *  nothing-to-land closure is reached unchanged and this only decides how
       *  the outcome is WORDED. */
      alreadyOnBase: boolean;
    }
  | { kind: "conflict"; detail: ConflictDetail }
  | { kind: "error"; error: string };

/**
 * Rebase the feature branch onto the live integration tip and push it.
 *
 * The integration branch is only ever a MERGE TARGET here — it is fetched, never
 * checked out, never rewritten, and never force-pushed. Only the ticket's own
 * `devpilot/<slug>` branch is force-pushed (with --force-with-lease), and only when
 * the rebase actually rewrote it.
 *
 * When the workspace is gone (reaped, or recorded on another host) but the branch
 * is already on the remote, we skip the rebase entirely and let GitHub decide
 * whether the PR is mergeable: there is nothing local to rebase, and a
 * fast-forwardable branch still lands cleanly. If it isn't mergeable, the squash
 * comes back `not_mergeable` and the normal conflict path takes over.
 */
async function rebaseAndPush(args: {
  workspacePath: string;
  branch: string;
  base: string;
  pushedAt: string | null;
  /**
   * The token resolved by the `resolve-token` step a few lines up. It used to
   * be resolved and then discarded, so every fetch and push below authenticated
   * with whatever credential was frozen into the workspace's `origin` URL when
   * it was cloned — days or weeks earlier. A reconnect, a rotation or a newly
   * granted scope reached none of them, and the rejection named the very token
   * the operator had just fixed. REQUIRED rather than optional precisely so
   * that "forgot to pass it" is not expressible.
   */
  token: string;
}): Promise<PrepResult> {
  const { workspacePath, branch, base, token } = args;

  const availability = await checkWorkspaceAvailable({
    storedPath: workspacePath,
    workspaceRoot: WORKSPACE_ROOT,
    hasSavedDiff: false,
  });
  if (!availability.available) {
    if (args.pushedAt) {
      // Already on the remote — land it from there. Both facts are
      // INDETERMINATE without a workspace: no head sha to record, and no commit
      // count. Neither is guessed — the conflict flag stays put and the pull
      // request is attempted exactly as before.
      return {
        kind: "ok",
        rebased: false,
        headSha: null,
        commitsAhead: null,
        alreadyOnBase: false,
      };
    }
    return {
      kind: "error",
      error: `workspace is unusable (${availability.code}) and the branch was never pushed: ${availability.message}`,
    };
  }

  // Drop the credential the workspace was cloned with BEFORE the first remote
  // call. Git prefers a userinfo segment in the remote URL over any credential
  // helper, so without this the fresh token below is never consulted at all.
  // Non-fatal by design — see `ensureCredentialFreeOrigin`.
  await ensureCredentialFreeOrigin(workspacePath);

  try {
    // Re-fetch the integration branch RIGHT NOW. The previous land in this lane
    // may have moved it seconds ago.
    await gitExec(workspacePath, ["fetch", "origin", base], GIT_TIMEOUT_MS, { token });

    // RECONCILE WITH THE BRANCH'S OWN REMOTE HEAD FIRST. Nothing here touched
    // `origin/<branch>` before, so a workspace whose branch was behind its own
    // remote counterpart produced a push rejected `(non-fast-forward)` - and the
    // worker then re-ran the identical push twice more and failed the row for
    // good. See `lib/git/reconcile-branch.ts` for the full argument (including
    // why this is a rebase and NEVER a force). It must run BEFORE the base
    // rebase, because that rebase rewrites the branch and leaves nothing
    // coherent to reconcile the remote head against.
    const reconcile = await reconcileWithRemoteBranch({ workspacePath, branch, token });
    if (reconcile.kind === "error") return reconcile;
    if (reconcile.kind === "conflict") {
      // Through the EXISTING conflict path - `conflict_state`, the merger spawn,
      // the parked queue row - identical in shape to a base-rebase conflict, so
      // no new failure mode is introduced. The stderr is PREFIXED with what was
      // being reconciled: the merger ticket renders that block verbatim, and
      // "conflicted against the integration branch" would be the wrong story to
      // hand a human.
      return {
        kind: "conflict",
        detail: {
          files: reconcile.files,
          stderr:
            `RECONCILE CONFLICT: \`origin/${branch}\` carries commits this workspace does ` +
            `not have, and replaying the local commits on top of it did not apply cleanly. ` +
            `This is a conflict between the branch and its OWN remote head, not against the ` +
            `integration branch \`${base}\`.\n\n${reconcile.stderr}`,
          base_sha: reconcile.remoteHead,
          branch_sha: reconcile.localHead ?? "",
        },
      };
    }

    // ALREADY ON THE INTEGRATION BRANCH? Then this is the nothing-to-land
    // SUCCESS path, and the rebase below must never be attempted. Measured on
    // `scoursh`: #69/#76/#77 held real branches with real commits whose content
    // was already on `dev`, landed earlier through pull requests - a state the
    // sweep that finds them cannot possibly detect, because it is a git fact and
    // not a database one. Replaying already-applied commits onto a base that has
    // since moved is how a shipped ticket acquires a conflict, a merger ticket
    // and a `failed` row; returning `commitsAhead: 0` instead routes it into
    // `closeNothingToLand`, which stamps `landed_sha` and heals the bookkeeping.
    // INDETERMINATE (`null`) falls through unchanged - see the helper.
    if ((await mergeWouldChangeNothing(workspacePath, base)) === true) {
      return {
        kind: "ok",
        rebased: false,
        headSha: await revParse(workspacePath, "HEAD"),
        commitsAhead: 0,
        alreadyOnBase: true,
      };
    }

    // Read HEAD **after** the reconcile, so `rebased` below means "the base
    // rebase rewrote the branch" - which is exactly the condition under which
    // the push cannot fast-forward. A reconcile that only fast-forwarded us onto
    // the remote head leaves HEAD a descendant of `origin/<branch>` and still
    // pushes plainly.
    const headBefore = (
      await gitExec(workspacePath, ["rev-parse", "--verify", "HEAD"], 15_000)
    ).stdout.trim();
    const baseSha = (
      await gitExec(workspacePath, ["rev-parse", `origin/${base}`], 15_000)
    ).stdout.trim();

    let rebased = false;
    try {
      await gitExec(workspacePath, ["rebase", `origin/${base}`], GIT_TIMEOUT_MS);
      const headAfter = (
        await gitExec(workspacePath, ["rev-parse", "--verify", "HEAD"], 15_000)
      ).stdout.trim();
      rebased = headAfter !== headBefore;
    } catch (err) {
      // Collect the conflicted files, then leave the workspace on a clean branch.
      // The merger runs in THIS workspace, so it must not be left mid-rebase.
      const files = await conflictedFiles(workspacePath);
      await gitExec(workspacePath, ["rebase", "--abort"], 30_000).catch(() => undefined);

      const detail: ConflictDetail = {
        files,
        stderr: safeStderr((err as Error).message ?? "", token).slice(0, 4000),
        base_sha: baseSha,
        branch_sha: headBefore,
      };
      if (files.length === 0) {
        // Not a real 3-way conflict — a merger would have nothing to resolve
        // (usually: the workspace has uncommitted changes blocking the rebase).
        // Surface it as an error instead of spawning a dead merger ticket.
        return {
          kind: "error",
          error: `rebase onto ${base} failed with no conflicting files: ${detail.stderr.slice(0, 500)}`,
        };
      }
      return { kind: "conflict", detail };
    }

    const pushArgs = rebased
      ? ["push", "--force-with-lease", "--set-upstream", "origin", branch]
      : ["push", "--set-upstream", "origin", branch];
    await gitExec(workspacePath, pushArgs, GIT_TIMEOUT_MS, { token });

    const headSha = (
      await gitExec(workspacePath, ["rev-parse", "--verify", "HEAD"], 15_000)
    ).stdout.trim();

    // How much of this branch is not yet on the base? Counted AFTER the rebase,
    // so it is the exact set a pull request would carry. Zero means the ticket
    // changed nothing — a correct outcome the pull-request call reports as a
    // 422. A git failure here is left INDETERMINATE (null), never 0.
    const commitsAhead = await countCommitsAhead(workspacePath, base);

    return {
      kind: "ok",
      rebased,
      headSha: headSha.length > 0 ? headSha : null,
      commitsAhead,
      alreadyOnBase: false,
    };
  } catch (err) {
    return {
      kind: "error",
      // Scrubbed a second time with the token as an explicit needle: `gitExec`
      // already does this for its own rejections, but this catch also sees
      // errors from elsewhere, and `last_error` on the queue row is read by
      // humans and rendered on the board.
      error: explainPushFailure(safeStderr((err as Error).message ?? String(err), token)),
    };
  }
}

/**
 * Adapt a thrown value into the pure classifier's input shape.
 *
 * The classifier is pure so it can be tested; this is the one place that knows
 * about `GithubApiError`. A non-GitHub throw still gets a shape (status null,
 * no `errors[]`) so the classifier has one input type and no null path.
 */
function toGithubFailureShape(err: unknown): GithubFailureShape {
  if (err instanceof GithubApiError) {
    return {
      status: err.status,
      githubMessage: err.githubMessage ?? null,
      githubErrors: err.githubErrors ?? null,
      fallbackMessage: err.message,
    };
  }
  return {
    status: null,
    githubMessage: null,
    githubErrors: null,
    fallbackMessage: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Make one specific, otherwise-baffling push rejection legible.
 *
 * GitHub refuses a push that touches `.github/workflows/**` when the OAuth app's
 * grant lacks the `workflow` scope. The raw stderr is accurate but reads as a
 * generic push failure, and no amount of retrying gets past it. Naming it saves
 * the next person the investigation. Every other message is passed through
 * verbatim.
 *
 * DevPilot now REQUESTS `workflow` (see `lib/github/scopes.ts`), so a grant that
 * still lacks it is one authorised before that change — GitHub does not add
 * scopes to an already-issued token. The fix is therefore a specific, available
 * action rather than an open-ended decision, and the message says where it is.
 */
function explainPushFailure(stderr: string): string {
  if (/without\s+`?workflow`?\s+scope/i.test(stderr) || /\bworkflow\b.*\bscope\b/i.test(stderr)) {
    return (
      `push rejected: this branch changes a GitHub Actions workflow file, and the ` +
      `connected GitHub OAuth grant does not carry the \`workflow\` scope. An existing ` +
      `token does not gain new scopes on its own - reconnect GitHub at ` +
      `Settings → GitHub integration to re-authorise, then retry the land.\n\n${stderr}`
    );
  }
  // A non-fast-forward should now be UNREACHABLE on the ordinary path - the
  // branch is reconciled with its own remote head before the push (see
  // `reconcileWithRemoteBranch`). Reaching it means the remote moved between
  // that fetch and this push, i.e. a genuine race, and the next attempt will
  // reconcile against the newer head. Say that, rather than leaving the bare
  // stderr that three identical failed attempts were recorded under.
  if (/\bnon-fast-forward\b/i.test(stderr) || /\bfetch first\b/i.test(stderr)) {
    return (
      `push rejected: the remote branch carries commits this workspace does not have. ` +
      `DevPilot reconciles the branch with its own remote head before pushing, so this ` +
      `means the remote moved during the land - the next attempt reconciles against the ` +
      `newer head. Nothing was force-pushed and no commit was discarded.\n\n${stderr}`
    );
  }
  return stderr;
}

/**
 * `git rev-list --count origin/<base>..HEAD`.
 *
 * Returns `null` on any failure or unparseable output. That distinction is
 * load-bearing: `0` skips the pull request, so a git error must never be able to
 * masquerade as "nothing to land" and silently drop a real landing.
 */
async function countCommitsAhead(workspacePath: string, base: string): Promise<number | null> {
  try {
    const out = await gitExec(
      workspacePath,
      ["rev-list", "--count", `origin/${base}..HEAD`],
      15_000,
    );
    const n = Number.parseInt(out.stdout.trim(), 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

// ─── reaper + cron floor ───────────────────────────────────────────────────

type ReapRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  ticket_id: string;
  status: "landing" | "awaiting_merge_resolution";
  attempts: number;
  pr_number: number | null;
  heartbeat_at: string | null;
  claimed_at: string | null;
  enqueued_at: string;
};

/**
 * The integration-queue reaper + the queue's cron floor, in one 5-minute tick.
 *
 * SCOPE — rows that are IN FLIGHT (`landing` / `awaiting_merge_resolution`).
 * A `pending` row is NOT this function's business: it has no worker to have
 * died and nothing to reconcile, and its failure mode (an
 * `integration/land-needed` event that was lost, so the land never started at
 * all) needs a grace, a backoff and a give-up rather than a reconcile. That is
 * `landRescueReaper` (`lib/engine/land-rescue-reaper.ts`), which used to live
 * here as a blind project-level "some row is pending, emit a pump" floor with
 * none of those three. The two status sets are disjoint, so the two 5-minute
 * crons can never both act on one row.
 *
 * REAPER. A worker that dies mid-land leaves its row in `landing` forever — the
 * event that would have re-pumped it was never sent, and nothing else looks at
 * the row. But it is NOT safe to simply re-land it: a worker that merged and
 * then died looks identical to one that died before merging, and re-running the
 * land on the first would try to merge a branch GitHub has already merged. So
 * the reaper's first question is always "is this branch already on dev?" — and
 * if it is, it reconciles FORWARD (stamps the sha, closes the row `landed`)
 * rather than re-landing. Every move is CAS-guarded on the status we observed, so
 * the reaper and a late-waking worker can never double-move the same row.
 *
 * The re-pended rows this function produces are picked up by the queue's own
 * pump (it emits `integration/land-needed` on every requeue) and, if that event
 * is lost too, by `landRescueReaper`.
 */
export const integrationQueueReaper = inngest.createFunction(
  { id: "integration-queue-reaper", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    if (!isAutoLandEnabled()) return { skipped: "DEVPILOT_AUTO_LAND_ENABLED=0" };

    const rows = await step.run("scan-inflight", async () => {
      const supabase = supabaseService();
      const { data, error } = await supabase
        .from("integration_queue")
        .select(
          "id, tenant_id, project_id, ticket_id, status, attempts, pr_number, heartbeat_at, claimed_at, enqueued_at",
        )
        .in("status", ["landing", "awaiting_merge_resolution"])
        .limit(50);
      if (error) throw new Error(`scan-inflight failed: ${error.message}`);
      return (data ?? []) as ReapRow[];
    });

    let reconciled = 0;
    for (const row of rows) {
      const outcome = await step.run(`reap-${row.id}`, async () => reapRow(row));
      if (outcome !== "leave") reconciled++;
    }

    return { scanned: rows.length, reconciled };
  },
);

async function reapRow(row: ReapRow): Promise<string> {
  const supabase = supabaseService();

  // Is the branch already on dev? Ask GitHub — the remote ref is the truth, and
  // the reaper has no workspace to read a local one from.
  const ctx = await loadLandContext(row.ticket_id);
  let landedOnDev = false;
  let devSha: string | null = null;
  const project = ctx?.project;
  const base = project?.integrationBranch ?? project?.defaultBranch ?? null;

  if (ctx?.landedSha) {
    // Already stamped; only the queue row is behind.
    landedOnDev = true;
    devSha = ctx.landedSha;
  } else if (project?.githubOwner && project?.githubRepo && base) {
    try {
      const token = project.createdBy
        ? await ensureFreshGithubToken(project.createdBy, row.tenant_id)
        : null;
      if (token) {
        const gh = { owner: project.githubOwner, repo: project.githubRepo };

        // (a) THE branch-deletion-proof signal. If the worker got as far as
        //     opening a PR, ask whether that PR merged. Many repos auto-delete
        //     the head branch on merge, so by the time we look, `devpilot/<slug>` may
        //     not exist — and the branch-containment check below would then read
        //     a landed ticket as unlanded and wedge every dependent of it.
        if (row.pr_number) {
          const pr = await getPullRequest({ token }, { ...gh, pullNumber: row.pr_number });
          if (pr?.merged) landedOnDev = true;
        }

        // (b) Fallback: the branch is still around and reachable from dev (a
        //     worker that merged some other way, or a human who did it by hand).
        if (!landedOnDev && ctx?.pendingPush?.branch) {
          landedOnDev = await isBranchContainedIn(
            { token },
            {
              ...gh,
              base,
              head: ctx.pendingPush.branch,
            },
          );
        }

        if (landedOnDev) {
          devSha = await getBranchSha({ token }, { ...gh, branch: base });
        }
      }
    } catch (err) {
      // A GitHub hiccup must never be read as "not landed" — that would re-land a
      // branch that is already in. Leave the row for the next tick.
      console.warn(
        `[integration-reaper] reconcile against ${base} failed for row ${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "leave";
    }
  }

  // A parked row is released by its MERGER's state, not by a timeout: it is
  // legitimately parked for as long as the merger takes, and timing it out would
  // spawn a second merger on top of a live one.
  let mergerStatus: TicketStatus | null = null;
  if (row.status === "awaiting_merge_resolution") {
    // Tenant-scoped: the merger id this resolves decides whether a parked land
    // is released. A planted row would name a merger we never spawned.
    //
    // Goes through `resolveMergerTicketId` rather than a bare `ticket_id` read
    // for the same reason `loadLandContext` does: once a merger had re-parented
    // the push, this lookup found no row, resolved no merger, and a parked land
    // was never released - the orphan blinded the release path as well as the
    // land. That helper keeps THIS query as its first step, so the non-orphaned
    // path is unchanged.
    const mergerId = await resolveMergerTicketId(supabase, {
      ticketId: row.ticket_id,
      tenantId: row.tenant_id,
    });
    if (mergerId) {
      const { data: merger } = await supabase
        .from("tickets")
        .select("status")
        .eq("id", mergerId)
        .maybeSingle();
      mergerStatus = (merger?.status as TicketStatus | null) ?? null;
    }
  }

  const anchor = row.heartbeat_at ?? row.claimed_at ?? row.enqueued_at;
  const decision = decideReap({
    status: row.status,
    heartbeatAgeMs: Date.now() - new Date(anchor).getTime(),
    attempts: row.attempts,
    landedOnDev,
    mergerStatus,
    timeoutMs: LAND_HEARTBEAT_TIMEOUT_MS,
  });

  switch (decision.action) {
    case "stamp_landed": {
      if (!devSha) {
        // Landed but we can't name the sha — refuse to stamp (the whole point of
        // the crash-safe stamp). Next tick will try again.
        return "leave";
      }
      // Threading the push id is what stops this path leaking a stale row. The
      // reaper does the FULL post-land fan-out below, so before this every
      // downstream consumer was told the ticket had landed while its push row
      // stayed `pushed_at IS NULL` forever.
      await stampLanded({
        queueId: row.id,
        ticketId: row.ticket_id,
        tenantId: row.tenant_id,
        pendingPushId: ctx?.pendingPush?.id ?? null,
        sha: devSha,
      });
      await inngest.send({
        name: "branch/parent-landed",
        data: {
          ticketId: row.ticket_id,
          tenantId: row.tenant_id,
          integrationSha: devSha,
          integrationBranch: base,
        },
      });
      await promoteUnblockedDependents({
        blockerTicketId: row.ticket_id,
        tenantId: row.tenant_id,
      });
      await inngest.send({
        name: "ticket-drain/requested",
        data: { tenantId: row.tenant_id, projectId: row.project_id },
      });
      return "stamp_landed";
    }
    case "requeue":
      await moveQueueRow({
        queueId: row.id,
        from: [row.status],
        to: "pending",
        lastError: decision.reason,
      });
      await emitLandNeeded({ tenantId: row.tenant_id, projectId: row.project_id });
      return "requeue";
    case "fail":
      await moveQueueRow({
        queueId: row.id,
        from: [row.status],
        to: "failed",
        lastError: decision.reason,
      });
      return "fail";
    default:
      return "leave";
  }
}

// ─── enqueue on a late push ────────────────────────────────────────────────

/**
 * `pending_push.upserted` is the OTHER enqueue trigger (the primary one is the
 * `→ done` transition seam, which enqueues inline — see enqueueForLanding).
 *
 * It exists because a branch can appear AFTER the ticket is already done: the
 * merger's fix-up push is exactly that, and so is any late commit on a completed
 * ticket. It is keyed off this event rather than `agent/run.completed` because
 * that event carries NO projectId — and projectId is the concurrency key that
 * serializes landing, so keying off it would resolve `undefined` and serialize
 * nothing at all. `pending_push.upserted` carries both tenantId and projectId.
 *
 * `enqueueForLanding` re-checks landability itself, so a push from a ticket that
 * is still in progress is simply ignored.
 */
export const enqueueLandOnPush = inngest.createFunction(
  {
    id: "enqueue-land-on-push",
    retries: 2,
    concurrency: { limit: 4, key: "event.data.tenantId" },
  },
  { event: "pending_push.upserted" },
  async ({ event, step }) => {
    if (!isAutoLandEnabled()) return { skipped: "DEVPILOT_AUTO_LAND_ENABLED=0" };
    const { tenantId } = event.data;

    const pendingPushId = event.data.pendingPushId;
    const ticketId = await step.run("resolve-ticket", async () => {
      const { data } = await supabaseService()
        .from("pending_pushes")
        .select("ticket_id")
        .eq("id", pendingPushId)
        .maybeSingle();
      return (data?.ticket_id as string | null) ?? null;
    });
    if (!ticketId) return { enqueued: false, reason: "pending push has no ticket" };

    return step.run("enqueue", async () => {
      const res = await enqueueForLanding({ ticketId, tenantId });
      return res.enqueued
        ? { enqueued: true as const, queueId: res.queueId }
        : { enqueued: false as const, reason: res.reason };
    });
  },
);
