// "Can this run possibly do its job?" - the pre-spend precondition check for a
// dispatched local-cc job that needs a git checkout.
//
// THE INCIDENT
// ────────────
// The runner treats a missing workspace as a reason to SKIP preparation and
// carry on:
//
//   [devpilot-runner] skipping workspace prep (ticketId=<none>, repoUrl=unset, token=absent)
//   [devpilot-runner] claude reports usd=0.925089
//   [devpilot-runner] claude finished - text 302 chars
//
// For work whose deliverable is committed source, that is not a degraded run -
// it is a run that cannot succeed. The agent has no repository to read, no
// `.env.local`, and nothing to commit to; the only outcomes available to it are
// hallucinating a diff or giving up. Both cost real subscription spend, and the
// second defect is worse than the first: the run was recorded `done`, which on
// the board is indistinguishable from success.
//
// THE RULE (one sentence)
// ───────────────────────
// A local-cc job requires a workspace exactly when it is a ticket-bound
// dispatch of a CODE-PRODUCING role; every other invocation on that queue -
// the platform's own one-shot classifiers/rankers, plan-mode calls,
// supervisor-spawned children, the headless `/v1` and widget surfaces, and
// every non-code role (a PM refining a description, a designer writing a spec,
// devops advising on a topology) - is a chat turn with no checkout to reason
// about and is deliberately untouched.
//
// WHY `isCodeProducingRole` AND NOT "has a ticket"
// ────────────────────────────────────────────────
// "Ticket-bound" alone is far too wide. A project with no connected repo is a
// supported configuration, and the ~48 non-code producer roles run against it
// perfectly well today. Refusing those would be a strictly worse bug than the
// one this guard fixes, so the predicate reuses `lib/roles/code-producing.ts`,
// whose curation rule already points the right way: the default is NOT
// code-producing, so getting membership wrong in the exclusive direction costs
// one missed refusal, while getting it wrong inclusively wedges a whole role.
//
// PURE ON PURPOSE. The decision has no IO so it is unit-testable, and the same
// shape is mirrored (not imported - the runner cannot import from web, same as
// `ticket-branch.ts`) in `apps/runner/src/workspace-precondition.ts`, which is
// the copy that actually stands between the job and the spend.

import { isCodeProducingRole } from "@/lib/roles/code-producing";

export type WorkspaceRefusalCode = "no_repo_url";

export type WorkspacePreconditionDecision = {
  /** Does this run need a git checkout to have any chance of succeeding? */
  requiresWorkspace: boolean;
  /** Non-null when it needs one and provably cannot get one. */
  refusal: { code: WorkspaceRefusalCode; message: string } | null;
};

export type WorkspacePreconditionInput = {
  /** The run's ticket, or null/undefined for a ticket-less invocation. */
  ticketId: string | null | undefined;
  /** The dispatched role slug, or null when the run has none. */
  role: string | null | undefined;
  /** Repo URL the engine resolved for this run (project » ENGINEER_REPO_URL). */
  repoUrl: string | null | undefined;
};

/**
 * Does this run require a git workspace?
 *
 * Deliberately narrow - see the header. Both conjuncts are load-bearing:
 * dropping the ticket check would sweep in the ticket-less platform
 * invocations, and dropping the role check would wedge every non-code role on
 * a repo-less project.
 */
export function runRequiresWorkspace(args: {
  ticketId: string | null | undefined;
  role: string | null | undefined;
}): boolean {
  return Boolean(args.ticketId) && isCodeProducingRole(args.role);
}

/**
 * Refuse a dispatch that requires a workspace but has no repository to clone.
 *
 * `repoUrl` is the ONLY precondition checked here, and that is a judgement, not
 * an oversight: without it the runner provably prepares no workspace at all. A
 * missing GitHub token is NOT a refusal - a public repo clones fine without one
 * and refusing on it would break real projects - and a token that is present
 * but unusable surfaces through the existing workspace-prep failure path, which
 * already fails the run loudly.
 */
export function decideWorkspacePrecondition(
  input: WorkspacePreconditionInput,
): WorkspacePreconditionDecision {
  const requiresWorkspace = runRequiresWorkspace(input);
  if (!requiresWorkspace) return { requiresWorkspace: false, refusal: null };

  const repoUrl = input.repoUrl?.trim() ?? "";
  if (repoUrl.length === 0) {
    return {
      requiresWorkspace: true,
      refusal: {
        code: "no_repo_url",
        message:
          `role '${input.role}' delivers committed source, but no repository URL could be ` +
          `resolved for this ticket's project - the runner would prepare no workspace and the ` +
          `agent would have nothing to read or commit to. Connect a repository to the project ` +
          `(or set ENGINEER_REPO_URL), then re-trigger this ticket.`,
      },
    };
  }

  return { requiresWorkspace: true, refusal: null };
}
