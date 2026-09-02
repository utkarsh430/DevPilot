// Runner half of the workspace precondition guard - the copy that actually
// stands between a job and the money.
//
// The engine refuses a workspace-requiring dispatch it can see is impossible
// (no repo URL) before the job is ever enqueued. This is the second line: by
// the time a job is popped, workspace prep has either produced a directory or
// been skipped, and only the runner knows which. If the engine stamped
// `requiresWorkspace: true` and prep produced nothing, the agent has no
// repository to read and nothing to commit to - spawning `claude -p` can only
// burn subscription spend to produce a hallucinated or empty answer, which is
// exactly the incident this guard exists for:
//
//   [devpilot-runner] skipping workspace prep (ticketId=<none>, repoUrl=unset, token=absent)
//   [devpilot-runner] claude reports usd=0.925089
//
// WHY THE FLAG IS TRUSTED OVER `job.ticketId`
// ───────────────────────────────────────────
// `requiresWorkspace` is stamped by the engine as its OWN field, not re-derived
// here from `ticketId`. That is the point: a job whose stamp says "workspace
// required" but which arrives with no ticket reference is an INCONSISTENT
// payload - a ticketId lost or garbled between enqueue and claim - and it is
// refused rather than degraded into a blind run. Deriving the requirement from
// `ticketId` on this side would make the two facts fail together and the
// inconsistency undetectable.
//
// Absent/false is the legitimate ticket-less case and MUST stay permissive: the
// platform's own one-shot classifiers and rankers, plan-mode calls,
// supervisor-spawned children, and the headless `/v1` + widget surfaces all run
// on this queue with no checkout by design. A guard that broke those would be a
// worse bug than the one it fixes, so the default is "no workspace needed".
//
// Duplicated rather than imported - the runner cannot import from apps/web,
// same as `ticket-branch.ts` / `workspace-root.ts`.

export type WorkspacePreconditionJob = {
  /** Engine-stamped: does this job need a git checkout? Absent = no. */
  requiresWorkspace?: boolean;
  ticketId?: string | null;
};

// ─────────────────────────────────────────────────────────────────────────
// Workspace prep ELIGIBILITY — a different question from `requiresWorkspace`
// above.
//
// THE 2026-08-06 INCIDENT
// ────────────────────────
// `requiresWorkspace` governs REFUSAL (can this job possibly succeed without
// a checkout), and it correctly stays false for one-shot dispatch classifiers
// / ticket enrichers / suggestion rankers - none of them are ticket-bound
// code-producing dispatches. But `apps/web/lib/runners/local-cc-oneshot.server.ts`
// used to launder that correctness bug into a DIFFERENT one: to keep those
// jobs workspace-less, it hardcoded the job's `ticketId` to `null` in the
// Redis payload while the `runs` row it inserted kept the REAL ticket id -
// so a direct DB query and the job the runner actually popped disagreed
// about which ticket a run belonged to, and the runner logged
// `ticketId=<none>` for a run that had a real one. That is the exact
// inconsistency `decideJobWorkspaceRefusal` above exists to make detectable
// rather than silent - so lying about `ticketId` to control prep was never
// an acceptable fix, even though it happened to be harmless FOR workspace
// prep specifically.
//
// The correct fix keeps `ticketId` truthful and adds a SEPARATE, explicit
// signal for "should prep even be attempted" - `workspacePrepEligible`.
//
// WHY THIS CANNOT BE `requiresWorkspace`
// ───────────────────────────────────────
// A reviewer (qa/verifier) does not REQUIRE a workspace - it can render a
// verdict on a repo-less project - but it very much WANTS one when a repo is
// resolvable, so it can actually read the code it is reviewing. Gating prep
// on `requiresWorkspace` would starve every reviewer of the checkout it
// needs. Eligibility has to be its own field.
export type WorkspacePrepEligibilityJob = {
  ticketId?: string | null;
  /** Per-job repo URL the engine resolved (`ticketId`'s project), if any. */
  repoUrl?: string | null;
  /** Engine-stamped: absent/true (default) preserves today's behaviour -
   *  attempt prep whenever a ticket and a resolvable repo are both present,
   *  regardless of role. Explicit `false` is stamped ONLY by one-shot
   *  bridges that tag a job with a real `ticketId` for audit/attribution but
   *  never resolve a project repo of their own - they must never attempt
   *  prep even via a legacy `ENGINEER_REPO_URL` fallback, because doing so
   *  could race a concurrent producer's LIVE workspace for the same ticket
   *  (workspace re-entry does a hard reset + clean). */
  workspacePrepEligible?: boolean;
};

/**
 * Should the runner attempt to prepare a git workspace for this job?
 *
 * `engineerRepoUrlEnv` is the runner host's legacy single-project fallback
 * (`ENGINEER_REPO_URL`); a job with no per-job `repoUrl` can still resolve a
 * repo through it, which is exactly the path a mis-eligible one-shot job
 * could otherwise race a live producer workspace through.
 */
export function decideWorkspacePrepAttempt(
  job: WorkspacePrepEligibilityJob,
  engineerRepoUrlEnv: string | undefined,
): boolean {
  const haveTicket = Boolean(job.ticketId);
  const haveRepoUrl = Boolean(job.repoUrl) || Boolean(engineerRepoUrlEnv);
  const eligible = job.workspacePrepEligible !== false;
  return haveTicket && haveRepoUrl && eligible;
}

export type JobWorkspaceRefusal =
  | { refuse: false }
  | { refuse: true; code: "workspace_required_but_absent"; error: string };

/**
 * Decide whether to refuse this job instead of spawning `claude -p`.
 *
 * @param job           the popped job payload (only the two fields matter here)
 * @param workspacePath the path prepared for this job, or null when prep was
 *                      skipped or produced nothing
 */
export function decideJobWorkspaceRefusal(
  job: WorkspacePreconditionJob,
  workspacePath: string | null,
): JobWorkspaceRefusal {
  if (job.requiresWorkspace !== true) return { refuse: false };
  if (workspacePath) return { refuse: false };

  // Name WHICH precondition is missing, so the board can tell this apart from a
  // genuine failure of the work itself. `ticketId` absent here is the stronger
  // signal of the two - it means the payload disagreed with itself.
  const detail =
    job.ticketId == null || job.ticketId === ""
      ? "the job requires a git workspace but arrived with no ticket reference, so none could be prepared (inconsistent job payload - the ticket id was lost between enqueue and claim)"
      : `the job requires a git workspace for ticket ${job.ticketId} but none was prepared (no repo URL resolved, or prep was skipped)`;

  return {
    refuse: true,
    code: "workspace_required_but_absent",
    error: `workspace precondition failed: ${detail}. Refusing before invoking the model - the agent would have no repository to read or commit to.`,
  };
}
