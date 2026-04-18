// WI-10 — one seam for "put this workspace on that branch without losing work".
//
// Three surfaces need it:
//   • the dev-server START path (`run-actions.ts#startDevServerForProjectAction`)
//     now that the operator can pick a branch before Run on a ticket /
//     pending-push scope, whose workspace is checked out on a FEATURE branch;
//   • the dev-server branch SWITCH path (`switchDevServerBranchAction`), which
//     grew this sequence first and is now backed by the same helper;
//   • the push path (`changes/actions.ts`), which must put HEAD back on the
//     change's own branch before it rebases — every git step there operates on
//     HEAD, so running it from a previewed `dev` checkout would rewrite the
//     wrong ref.
//
// DATA-LOSS INVARIANT (the reap-guard invariant in AGENTS.md, one level up):
// a ticket / pending-push workspace is the ONLY home of any commit on a branch
// that was never pushed. So this helper is deliberately non-destructive:
//
//   • uncommitted edits (tracked + untracked) are STASHED before the checkout
//     and popped after it — never discarded;
//   • the checkout is a plain `git checkout <branch>`: git itself refuses to
//     clobber uncommitted work, and it leaves the previous branch's commits on
//     their local ref, reachable and pushable afterwards;
//   • there is NO `reset --hard`, NO `checkout -f`, NO `clean` and NO branch
//     deletion anywhere in this file. Adding one would make a preview of `dev`
//     able to eat an unpushed feature commit. Don't.
//
// A failed checkout is reported, not forced: the caller surfaces the error and
// the workspace stays exactly as it was.

import { gitExec } from "@/lib/git/exec";

// Branch names — match GitHub's allowed set (ASCII letters/digits + `.`/`_`/`/`/`-`),
// max 200 chars. Conservative — rejects spaces and shell-special characters.
// The single validator for every operator-supplied branch name; callers import
// it rather than defining their own.
export const BRANCH_NAME_RE = /^[a-zA-Z0-9._/-]{1,200}$/;

export type ResolveRunBranchResult = { ok: true; branch: string } | { ok: false; error: string };

/**
 * Resolve which branch a dev-server run should serve: the operator's explicit
 * pick when there is one, else the scope's own pinned branch (the project's
 * integration branch, the pending push's feature branch, the ticket's
 * `devpilot/<slug>`). Whitespace-only is "no pick".
 *
 * Pure — the branch-picker semantics for every scope live here and are unit
 * tested; the server action only supplies the fallback.
 */
export function resolveRunBranch(input: {
  requested?: string | null;
  fallback: string;
}): ResolveRunBranchResult {
  const requested = input.requested?.trim();
  if (requested && !BRANCH_NAME_RE.test(requested)) {
    return { ok: false, error: "Invalid branch name." };
  }
  return {
    ok: true,
    branch: requested && requested.length > 0 ? requested : input.fallback,
  };
}

export type SwitchWorkspaceBranchResult =
  | { ok: true; switched: boolean; stashed: boolean }
  | { ok: false; error: string };

/**
 * The branch currently checked out in `workspacePath`, or null when the
 * workspace has no branch (detached HEAD, no repo, unreadable).
 */
export async function currentWorkspaceBranch(workspacePath: string): Promise<string | null> {
  try {
    const res = await gitExec(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"], 15_000);
    const name = res.stdout.trim();
    return name.length > 0 && name !== "HEAD" ? name : null;
  } catch {
    return null;
  }
}

/**
 * Check `targetBranch` out in `workspacePath`, preserving every commit and every
 * uncommitted edit already there (see the data-loss invariant at the top).
 *
 * No-ops (returns `switched: false`) when the workspace is already on the branch,
 * so callers can invoke it unconditionally on their happy path.
 *
 * `fetch` and `pull --ff-only` are best-effort: a never-pushed feature branch has
 * no `origin/<branch>` to fetch, and a diverged local branch must not be
 * fast-forwarded away. Only the checkout itself is fatal.
 */
export async function switchWorkspaceToBranch(
  workspacePath: string,
  targetBranch: string,
  opts?: { stashLabel?: string; token?: string | null },
): Promise<SwitchWorkspaceBranchResult> {
  if (!BRANCH_NAME_RE.test(targetBranch)) {
    return {
      ok: false,
      error: "Branch name must be ASCII letters/digits/`.`/`_`/`/`/`-` (max 200 chars).",
    };
  }

  const current = await currentWorkspaceBranch(workspacePath);
  if (current === targetBranch) {
    return { ok: true, switched: false, stashed: false };
  }

  // 1. Stash uncommitted edits (including untracked files) so the checkout
  //    can't be blocked by them and nothing is dropped on the floor.
  let stashed = false;
  const stashLabel = opts?.stashLabel ?? `devpilot-branch-switch-${targetBranch}`;
  try {
    const status = await gitExec(workspacePath, ["status", "--porcelain"], 15_000);
    if (status.stdout.trim().length > 0) {
      await gitExec(
        workspacePath,
        ["stash", "push", "--include-untracked", "-m", stashLabel],
        30_000,
      );
      stashed = true;
      console.log(`[branch-checkout] auto-stashed before checkout: ${stashLabel}`);
    }
  } catch (err) {
    // Non-fatal: a plain checkout still refuses to overwrite local edits, so
    // the worst case is the checkout below failing loudly with the tree intact.
    console.warn(
      "[branch-checkout] pre-checkout stash failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // 2. Best-effort fetch so a remote-only branch resolves; a local-only branch
  //    (the never-pushed `devpilot/<slug>` case) has nothing to fetch and that's fine.
  // Authenticated with the CALLER'S freshly resolved token, never with a
  // credential frozen into the workspace's remote URL — see `lib/git/credentials.ts`.
  // A caller with no token (a public repo) passes none and nothing changes.
  await gitExec(workspacePath, ["fetch", "origin", targetBranch], 60_000, {
    token: opts?.token,
  }).catch((err) => {
    console.warn(
      `[branch-checkout] fetch origin ${targetBranch} failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  });

  // 3. The checkout itself — the only fatal step.
  try {
    await gitExec(workspacePath, ["checkout", targetBranch], 30_000);
  } catch (err) {
    if (stashed) {
      await gitExec(workspacePath, ["stash", "pop"], 30_000).catch(() => undefined);
    }
    return {
      ok: false,
      error: `Couldn't check out ${targetBranch}: ${(err as Error).message}`,
    };
  }

  // 4. Match the remote tip when we can fast-forward. A diverged local branch
  //    is left alone — the push flow has the real reconciliation pipeline.
  await gitExec(workspacePath, ["pull", "origin", targetBranch, "--ff-only"], 60_000, {
    token: opts?.token,
  }).catch((err) => {
    console.warn(
      `[branch-checkout] pull --ff-only ${targetBranch} failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  });

  // 5. Restore the stash on top of the new branch. A conflicting pop leaves the
  //    stash in place (`git stash list` still has it) rather than forcing it.
  if (stashed) {
    await gitExec(workspacePath, ["stash", "pop"], 30_000).catch((err) => {
      console.warn(
        `[branch-checkout] stash pop after checkout failed; stash retained (name=${stashLabel}):`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  return { ok: true, switched: true, stashed };
}
