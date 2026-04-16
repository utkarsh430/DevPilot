// The per-ticket git branch namespace.
//
// NEW branches are cut as `devpilot/<slug>`. But `ace/<slug>` was the namespace
// before the rename, and those branches are still checked out in existing
// workspaces on disk and already pushed to operators' project repos. We rename
// NOTHING on any remote and NOTHING in any DB row — instead every MATCHER
// accepts both prefixes.
//
// ⚠️ `isTicketBranch` is LOAD-BEARING, not dead code. Do not "clean up" the
// `ace` half. The runner's workspace re-entry guard (apps/runner/src/workspace.ts,
// which has its own copy of this rule — the runner cannot import from the web
// app) uses it to KEEP an existing checkout on its current branch. Narrow it to
// `devpilot/` only and the runner will `git checkout -b devpilot/<slug>` inside a
// workspace already sitting on `ace/<slug>`, stranding the engineer's prior
// commits on a branch nothing points at any more. Some of those commits exist
// nowhere else — they were never pushed.
//
// The `ace` half may be dropped once no `ace/*` workspace remains on disk.
// This mirrors the same dual-match already used for the tmux session prefix at
// app/api/runners/[id]/heartbeat/route.ts.

export const TICKET_BRANCH_PREFIX = "devpilot/";

/** Matches BOTH the current and the pre-rename ticket-branch namespaces. */
export const TICKET_BRANCH_RE = /^(?:ace|devpilot)\//;

/** The branch a ticket's work lands on. */
export function ticketBranch(slug: string): string {
  return `${TICKET_BRANCH_PREFIX}${slug}`;
}

/** True for a per-ticket branch in EITHER namespace. See the warning above. */
export function isTicketBranch(branch: string | null | undefined): boolean {
  return !!branch && TICKET_BRANCH_RE.test(branch);
}
