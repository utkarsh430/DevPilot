// Pure policy: "does this ticket still hold work that exists ONLY on disk?"
//
// Why this exists
// ────────────────
// The workspace reaper (`lib/engine/workspace-reaper.ts`) deletes a ticket's
// on-disk workspace once the ticket has been terminal (`done`/`failed`) for
// the grace window. Until 2026-07-11 it did so unconditionally - including
// when that workspace was the ONLY place a branch's commits existed. The
// branch had never been pushed, the commits lived nowhere else, and the
// `rm -rf` destroyed them. The `pending_pushes` row survived, still pointing
// at a directory that no longer existed, so the Changes page's push flow
// `spawn`ed git with a missing `cwd` and reported `spawn git ENOENT`.
//
// The correlation observed in production was perfect: every workspace still on
// disk had `pushed_at != null` and its branch was on the remote; every missing
// one had `pushed_at = null` and no remote branch. Silent work loss, and the
// ticket was marked `done` regardless.
//
// The predicate
// ─────────────
// A `pending_pushes` row is written ONLY when the tracker finds at least one
// unpushed commit (`pending-push-tracker.ts` bails on `commits.length === 0`),
// and `pushed_at` is stamped only after a successful `git push`. So
// `pushed_at === null` on a live row means, precisely: "commits exist here that
// are on no remote". That is the hold signal - we deliberately do NOT also
// require `unpushed_count > 0`, because a stale/zero count on a live row would
// otherwise re-open the exact data-loss hole this module closes. Holding a
// workspace costs disk; reaping one costs the work.
//
// Releasing the hold is the operator's call, and both exits already exist:
// push the change (stamps `pushed_at` - the commits are on the remote, the
// workspace is now redundant) or discard it (drops the row). Either way the
// next reaper pass sweeps the workspace normally.
//
// Deliberately pure: no DB, no fs, no env, no Next imports. The loaders live in
// the callers (the reaper, the `→ done` notice), so this stays unit-testable.

/** The `pending_pushes` columns this policy reads. */
export type PendingPushLike = {
  id: string;
  branch: string;
  workspace_path: string;
  /** Stamped only after a successful push. `null` = the commits are local-only. */
  pushed_at: string | null;
  unpushed_count: number | null;
};

/**
 * Does this row represent commits that exist only in the workspace?
 *
 * `pushed_at === null` is the whole test - see the module header for why the
 * commit count is deliberately not part of it.
 */
export function holdsUnpushedWork(row: PendingPushLike): boolean {
  return row.pushed_at === null;
}

export type ReapDecision =
  | { reap: true }
  | {
      reap: false;
      /** Human-readable, safe to log and to put in a system comment. */
      reason: string;
      /** The rows that caused the hold, so callers can surface specifics. */
      holding: PendingPushLike[];
    };

/**
 * Decide whether a terminal ticket's workspace may be reaped, given every
 * `pending_pushes` row for that ticket.
 *
 * Fail-closed by construction: the only branch that returns `reap: true` is the
 * one where NO row holds unpushed work.
 */
export function decideWorkspaceReap(pendingPushes: PendingPushLike[]): ReapDecision {
  const holding = pendingPushes.filter(holdsUnpushedWork);
  if (holding.length === 0) return { reap: true };
  const branches = holding.map((r) => r.branch).join(", ");
  return {
    reap: false,
    reason:
      `workspace holds unpushed work on ${holding.length} branch${holding.length === 1 ? "" : "es"} ` +
      `(${branches}); reaping it would destroy commits that exist nowhere else`,
    holding,
  };
}

/**
 * Body of the system comment posted when a ticket reaches `done` while its
 * branch is still unpushed. This is the "don't let it be silent" half of the
 * fix: the reap guard keeps the commits alive on disk, and this makes the fact
 * that they were never pushed visible on the ticket instead of only in a
 * sidebar badge the operator may never open.
 */
export function formatUnpushedWorkNotice(holding: PendingPushLike[]): string {
  const lines = holding.map(
    (r) =>
      `- \`${r.branch}\` - ${r.unpushed_count ?? 0} unpushed commit${(r.unpushed_count ?? 0) === 1 ? "" : "s"} ([review & push](/changes/${r.id}))`,
  );
  return [
    "**This ticket completed with work that was never pushed.**",
    "",
    ...lines,
    "",
    "The commits exist only in this ticket's workspace on the runner host. The workspace is",
    "held back from cleanup until you either push the change or discard it, so the work is not",
    "at risk - but nothing is on the remote yet, and no PR exists.",
  ].join("\n");
}
