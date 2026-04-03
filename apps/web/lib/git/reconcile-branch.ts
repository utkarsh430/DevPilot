// Bring a workspace's branch up to date with ITS OWN remote counterpart.
//
// ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
// The land worker's `rebaseAndPush` fetched the INTEGRATION branch and nothing
// else, so the workspace's `origin/<branch>` was whatever the last clone or push
// happened to leave behind. When the remote branch had moved on - a push from
// another workspace or host, a re-clone, a merger's fix-up push landing while
// this workspace sat stale - the local branch was BEHIND its own remote and
// `git push` was refused:
//
//     ! [rejected]  devpilot/<slug> -> devpilot/<slug> (non-fast-forward)
//
// The queue row was re-pended, re-claimed, and the IDENTICAL push was run twice
// more before `MAX_LAND_ATTEMPTS` failed it permanently. Two of the six stranded
// tickets measured on project `scoursh` (2026-08-03) ended exactly there, with
// that stderr recorded verbatim on `last_error` three times over. Three attempts,
// zero chance any of them could succeed.
//
// ── WHY A REBASE AND EMPHATICALLY NOT A FORCE ─────────────────────────────
// `--force` or `--force-with-lease` would also make the push succeed, by
// DISCARDING the remote's commits. That remote branch is the sole home of any
// commit not yet on the integration branch, and this repo's data-loss invariant
// (the unpushed-work reap guard) is that we never destroy the only copy of a
// commit. Forcing here would throw away exactly the work the landing exists to
// preserve. Rebasing onto the remote head INCORPORATES those commits instead:
// `origin/<branch>..HEAD` is replayed on top of them, so both sides survive.
//
// A knock-on worth stating: this is also what makes the land worker's EXISTING
// `--force-with-lease` (used only when the base rebase rewrote the branch) safe
// rather than merely lucky. The lease compares `refs/remotes/origin/<branch>`
// against the remote, and before this that ref was never fetched - so the lease
// was checking a stale ref, and its only two outcomes were a "stale info"
// rejection or a comparison against a fiction. Now the ref is fresh AND its
// commits are already in our history, so the force rewrites only history we
// already contain.
//
// ── ORDERING ──────────────────────────────────────────────────────────────
// This MUST run before the rebase onto the integration branch. That rebase
// rewrites the branch, after which there is nothing coherent left to reconcile
// the remote head against.
//
// ── WHY IT LIVES IN `lib/git/` ────────────────────────────────────────────
// Every claim below is a claim about GIT, not about our code shape, so it is
// tested against a REAL git binary in a temp repo with a real bare remote - the
// rule `lib/git/credentials.ts` established. `lib/engine/land-worker.ts` reaches
// `server-only` and cannot load under Vitest at all, which is precisely the gap
// this defect lived in: the push argv was right there in the source and nothing
// could execute it.
//
// It deliberately imports no engine type. The caller maps `files` / `stderr` /
// `remoteHead` / `localHead` onto its own `ConflictDetail`.

import { gitExec, safeStderr } from "./exec";

const FETCH_TIMEOUT_MS = 120_000;
const REBASE_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 15_000;
const ABORT_TIMEOUT_MS = 30_000;

export type ReconcileBranchResult =
  /** Nothing to do, or the remote's commits are now in our history. */
  | { kind: "ok"; reconciled: boolean; reason: string }
  /**
   * The replay did not apply cleanly: two people genuinely changed the same
   * lines. The workspace has been left on a CLEAN branch (`rebase --abort`), so
   * the caller can hand it to a merger.
   */
  | {
      kind: "conflict";
      files: string[];
      stderr: string;
      remoteHead: string;
      localHead: string | null;
    }
  /** Something went wrong that a merger could not resolve. */
  | { kind: "error"; error: string };

/**
 * Fetch `origin/<branch>` and, when it carries commits this workspace does not
 * have, rebase the local branch onto it.
 *
 * The healthy path costs one fetch and one `merge-base --is-ancestor`: when the
 * remote head is already reachable from HEAD nothing is rewritten and no git
 * object moves.
 */
export async function reconcileWithRemoteBranch(args: {
  workspacePath: string;
  branch: string;
  /** A freshly resolved GitHub token for the fetch. */
  token: string;
}): Promise<ReconcileBranchResult> {
  const { workspacePath, branch, token } = args;
  const remoteRef = `refs/remotes/origin/${branch}`;

  // An EXPLICIT refspec, so the remote-tracking ref is definitely written rather
  // than relying on git's opportunistic update of it. The `+` forces only the
  // REMOTE-TRACKING ref, which is a mirror of the remote and never holds work of
  // ours - it is not a force push and cannot lose a commit.
  try {
    await gitExec(
      workspacePath,
      ["fetch", "origin", `+refs/heads/${branch}:${remoteRef}`],
      FETCH_TIMEOUT_MS,
      { token },
    );
  } catch {
    // The branch is not on the remote yet - the ordinary first-land case - or
    // the fetch failed. Either way there is nothing to reconcile against, and a
    // genuine network/auth failure surfaces on the caller's push with its own
    // message rather than being reported here as a phantom conflict.
    return { kind: "ok", reconciled: false, reason: "no remote branch to reconcile with" };
  }

  const remoteHead = await revParse(workspacePath, remoteRef);
  if (!remoteHead) {
    return { kind: "ok", reconciled: false, reason: "remote head did not resolve" };
  }
  const localHead = await revParse(workspacePath, "HEAD");

  // Already have everything the remote has? Then the push is a fast-forward and
  // there is nothing to reconcile. This is the path every healthy land takes.
  if (await isAncestor(workspacePath, remoteHead, "HEAD")) {
    return { kind: "ok", reconciled: false, reason: "remote head already in this branch" };
  }

  try {
    await gitExec(workspacePath, ["rebase", remoteRef], REBASE_TIMEOUT_MS);
  } catch (err) {
    const files = await conflictedFiles(workspacePath);
    // Leave the workspace on a clean branch: a merger runs in THIS workspace and
    // must not inherit a half-finished rebase.
    await gitExec(workspacePath, ["rebase", "--abort"], ABORT_TIMEOUT_MS).catch(() => undefined);

    const stderr = safeStderr((err as Error).message ?? "", token).slice(0, 4000);
    if (files.length === 0) {
      // Not a 3-way conflict - a merger would have nothing to resolve (usually
      // uncommitted changes blocking the rebase). Surface it as an error rather
      // than spawning a dead merger ticket.
      return {
        kind: "error",
        error: `rebase onto origin/${branch} failed with no conflicting files: ${stderr.slice(0, 500)}`,
      };
    }
    return { kind: "conflict", files, stderr, remoteHead, localHead };
  }

  return {
    kind: "ok",
    reconciled: true,
    reason: `incorporated origin/${branch} at ${remoteHead.slice(0, 7)}`,
  };
}

/**
 * Would merging this branch into `base` change `base` at all?
 *
 * ── WHY THIS EXISTS, and why the obvious checks all fail ──────────────────
 * Measured on `scoursh`: #69/#76/#77 held branches, held commits, had
 * `landed_sha IS NULL` and no queue row - and their content was ALREADY on
 * `dev`, landed earlier through pull requests #39/#42/#44. Handing those to the
 * land worker as ordinary work is how a healthy, already-shipped ticket turns
 * into a conflict, a merger ticket and a `failed` row. **Already-on-base is the
 * nothing-to-land SUCCESS path** - stamp the landing, heal the bookkeeping -
 * never an error.
 *
 * Detecting it is not as easy as it looks, and every cheaper signal is WRONG
 * here because those PRs were SQUASH-merged:
 *
 *   • ancestry (`merge-base --is-ancestor branch base`) - false: a squash
 *     rewrites the commits, so none of the branch's commits is in `base`.
 *   • patch-id (`git cherry`) - false: one squashed commit has a different
 *     patch-id from each of the N commits it replaced.
 *   • a plain tree comparison of `base` vs `HEAD` - false in the other
 *     direction: `base` legitimately carries every OTHER ticket's work too.
 *
 * The only question that answers it is the one actually being asked - "if this
 * landed, would anything change?" - so we perform the merge in memory and
 * compare the result with `base`'s current tree. Equal means every byte of this
 * branch is already on `base`.
 *
 * `null` means INDETERMINATE and is never inferred to either answer: git older
 * than 2.38 has no `--write-tree`, and a conflicting merge exits non-zero. Both
 * fall through to today's rebase-and-push path unchanged, so the only behaviour
 * that changes is the case we can prove - the same posture as
 * `decideLandAttempt`'s `commitsAhead === null`.
 *
 * Nothing is written: `--write-tree` writes a tree OBJECT into the object
 * database and moves no ref, so this cannot alter the branch, `base`, or the
 * working tree.
 */
export async function mergeWouldChangeNothing(
  workspacePath: string,
  base: string,
): Promise<boolean | null> {
  const baseRef = `origin/${base}`;
  const baseTree = await revParse(workspacePath, `${baseRef}^{tree}`);
  if (!baseTree) return null;
  try {
    const out = await gitExec(
      workspacePath,
      ["merge-tree", "--write-tree", baseRef, "HEAD"],
      REBASE_TIMEOUT_MS,
    );
    const mergedTree = out.stdout.split(/\r?\n/)[0]?.trim() ?? "";
    if (!/^[0-9a-f]{40,64}$/.test(mergedTree)) return null;
    return mergedTree === baseTree;
  } catch {
    // Exit 1 = the merge conflicts, so it would certainly change `base`;
    // anything else (an old git with no `--write-tree`) is unknown. Neither is
    // safe to report as "already landed", and both are correctly handled by the
    // ordinary path, so both answer `null`.
    return null;
  }
}

/** `git rev-parse --verify <ref>`, or `null` when it does not resolve. */
export async function revParse(workspacePath: string, ref: string): Promise<string | null> {
  try {
    const out = await gitExec(workspacePath, ["rev-parse", "--verify", ref], QUICK_TIMEOUT_MS);
    const sha = out.stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Is `ancestor` reachable from `descendant`?
 *
 * `git merge-base --is-ancestor` exits 1 for "no" and non-zero-non-1 for a real
 * error, and `gitExec` throws on both. Both are answered `false`, which errs
 * toward ATTEMPTING the reconcile: a rebase onto a ref that is already an
 * ancestor is a no-op, whereas skipping a reconcile we needed is the defect.
 */
export async function isAncestor(
  workspacePath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await gitExec(
      workspacePath,
      ["merge-base", "--is-ancestor", ancestor, descendant],
      QUICK_TIMEOUT_MS,
    );
    return true;
  } catch {
    return false;
  }
}

/** Files left with conflict markers after a failed rebase. */
export async function conflictedFiles(workspacePath: string): Promise<string[]> {
  try {
    const ls = await gitExec(
      workspacePath,
      ["diff", "--name-only", "--diff-filter=U"],
      QUICK_TIMEOUT_MS,
    );
    return ls.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}
