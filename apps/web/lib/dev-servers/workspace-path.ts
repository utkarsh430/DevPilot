// Pure guard: never trust a persisted absolute `workspace_path` from another
// host.
//
// Why this exists
// ────────────────
// `pending_pushes.workspace_path` and `dev_server_sessions.workspace_path`
// are absolute paths stamped by whichever runner host wrote the row. That's
// fine on a single-machine deployment, but the moment a Postgres instance is
// shared, restored, or the runner moves host, a stored path can point at a
// directory that only ever existed on a DIFFERENT machine (e.g.
// `/Users/ethan-hunt/…/.devpilot/workspaces/<ticketId>` read back on
// `/Users/utkarsh430/…`). Trusting it verbatim sends the runner `mkdir`-ing
// into someone else's home directory (EACCES) or `git`-ing into a path that
// simply doesn't exist here.
//
// The workspace layout is deterministic — `<WORKSPACE_ROOT>/<ticketId>` or
// `<WORKSPACE_ROOT>/project-<projectId>` — so a foreign path can always be
// re-derived for THIS host instead of trusted as-is. This module is the one
// shared choke point every consumer of a persisted `workspace_path` routes
// through; see `apps/web/AGENTS.md`/root `AGENTS.md` for the list of call
// sites.
//
// Deliberately pure: no env reads, no DB, no Next imports. Callers resolve
// `WORKSPACE_ROOT` themselves (via `resolveWorkspaceRoot`) and pass it in, so
// this module stays trivially unit-testable.

import * as path from "node:path";

/** Is `p` inside `workspaceRoot`? Used to decide whether a stored path is
 *  trustworthy as-is, or needs to be re-derived for this host. */
export function isUnderWorkspaceRoot(p: string, workspaceRoot: string): boolean {
  const rel = path.relative(workspaceRoot, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Return a `workspace_path` that's safe to use on THIS host.
 *
 * - If `stored` already lives under `workspaceRoot`, it's returned unchanged
 *   (the common case — this host wrote it).
 * - Otherwise it was written by a different host (or a since-changed
 *   `WORKSPACE_ROOT`). It's re-derived deterministically: `ticketId` when
 *   present, else the project-scoped path. A warning is logged so a foreign
 *   path silently swapped out is still visible in server logs.
 */
export function hostWorkspacePath(
  stored: string,
  ticketId: string | null,
  projectId: string,
  workspaceRoot: string,
): string {
  if (isUnderWorkspaceRoot(stored, workspaceRoot)) return stored;
  const rederived = ticketId
    ? path.join(workspaceRoot, ticketId)
    : path.join(workspaceRoot, `project-${projectId}`);
  console.warn(
    `[workspace-path] workspace_path "${stored}" is outside this host's WORKSPACE_ROOT ` +
      `(${workspaceRoot}); re-deriving as "${rederived}".`,
  );
  return rederived;
}

// ---------------------------------------------------------------------------
// Availability - "can I actually run git in this directory right now?"
//
// The foreign-host case above is one way a stored `workspace_path` can be
// unusable. The other is that the directory is simply GONE: until 2026-07-11
// the workspace reaper deleted a terminal ticket's workspace even when its
// branch had never been pushed, leaving a live `pending_pushes` row pointing at
// a path that no longer existed. Node reports a missing `cwd` as `spawn git
// ENOENT`, so the Changes page's push flow failed with "Failed to update
// workspace remote: spawn git ENOENT" - which tells the operator nothing about
// what happened or what to do.
//
// Both cases are the same question ("is this stored path usable here?") and both
// have the same answer for the operator ("not from this directory - but the
// saved diff can rebuild it"), so they share this one classifier rather than
// growing a parallel check. Kept pure: the caller does the `stat` and passes
// `exists`, so the decision stays trivially unit-testable.
// ---------------------------------------------------------------------------

export type WorkspaceUnavailableCode = "foreign_host" | "missing";

export type WorkspaceAvailability =
  | { available: true }
  | {
      available: false;
      code: WorkspaceUnavailableCode;
      /** Operator-facing. Says what happened AND what can still be done. */
      message: string;
    };

export function classifyWorkspaceAvailability(args: {
  stored: string;
  workspaceRoot: string;
  /** Does `stored` exist on this host, as a directory? */
  exists: boolean;
  /** Is a `unified_diff` still stored on the row? Decides which recovery we offer. */
  hasSavedDiff: boolean;
}): WorkspaceAvailability {
  const recovery = args.hasSavedDiff
    ? "The saved diff for this change is still intact, so the branch can be reconstructed: " +
      'use "Rebuild from saved diff" to replay it onto a fresh clone and push it.'
    : "No diff was saved for this change, so it cannot be reconstructed automatically.";

  if (!isUnderWorkspaceRoot(args.stored, args.workspaceRoot)) {
    return {
      available: false,
      code: "foreign_host",
      message:
        `This change was recorded on another host, at a path that does not exist here (${args.stored}). ` +
        `Its commits are not on this machine. ${recovery}`,
    };
  }
  if (!args.exists) {
    return {
      available: false,
      code: "missing",
      message:
        `The workspace for this change no longer exists on disk (${args.stored}) - it was cleaned up ` +
        `before the branch was pushed. ${recovery}`,
    };
  }
  return { available: true };
}
