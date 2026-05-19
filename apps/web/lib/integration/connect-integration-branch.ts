// WI-4 (connect-existing) — decide which branch a CONNECTED (pre-existing) repo
// should use as its integration branch: the shared branch every ticket cuts from
// and squash-merges back into. The decision is pure; the caller performs the
// GitHub branch create (idempotent) and the `projects` row write.
//
// The one constraint that makes this non-trivial: an existing repo may already
// have a `dev` branch that means something to the operator. We must NOT
// repurpose the operator's own branch as our integration lane.
//
// Rule:
//   • No `dev` branch on the repo → adopt `dev` (created off the default
//     branch). `dev` is the conventional integration-branch name and, when it
//     doesn't exist yet, carries no prior meaning, so adopting it is safe and
//     matches what the create-new-repo flow seeds.
//   • `dev` already exists → it's the operator's own branch; leave it alone and
//     use a devpilot-namespaced branch instead, created off the default branch.
//
// Why the dash form `devpilot-integration` and NOT `devpilot/integration`: the
// `devpilot/` (and pre-rename `ace/`) slash prefix is the per-ticket branch
// namespace matched by `isTicketBranch` (lib/git/ticket-branch.ts). A
// slash-namespaced integration branch would be (a) refused by
// `setIntegrationBranchAction`'s own `isTicketBranch` guard and
// `sanitizeDefaultBranch`, and (b) at risk of being mistaken for a ticket branch
// by any matcher that keys on that prefix. `devpilot-integration` has no slash
// after `devpilot`, so it does not match `/^(?:ace|devpilot)\//` — clearly ours,
// without polluting the per-ticket namespace.

/** The integration branch used when the connected repo already has its own `dev`. */
export const DEVPILOT_INTEGRATION_BRANCH = "devpilot-integration";

/** The conventional integration branch name, adopted when the repo has no `dev`. */
export const DEFAULT_INTEGRATION_BRANCH = "dev";

export type ConnectIntegrationBranchPlan = {
  /** The branch to store in `projects.integration_branch`. */
  branch: string;
  /** The branch to create `branch` from — always the repo's default branch. */
  sourceBranch: string;
};

/**
 * Pure resolution of the integration branch for a connect-existing project.
 * IO (does `dev` exist? create the branch) lives in the caller; this only maps
 * the observed state to a decision so it can be unit-tested without GitHub.
 */
export function resolveConnectIntegrationBranch(opts: {
  /** True when the repo already has a `dev` branch (the operator's own). */
  devExists: boolean;
  /** The repo's default branch — the source the integration branch is cut from. */
  defaultBranch: string;
}): ConnectIntegrationBranchPlan {
  const branch = opts.devExists ? DEVPILOT_INTEGRATION_BRANCH : DEFAULT_INTEGRATION_BRANCH;
  return { branch, sourceBranch: opts.defaultBranch };
}
