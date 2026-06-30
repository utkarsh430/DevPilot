// The per-ticket git branch namespace (runner copy).
//
// Twin of `apps/web/lib/git/ticket-branch.ts` — duplicated because the runner is
// a separate package that cannot import from the web app (same reason
// `workspace-root.ts` is duplicated). Keep the two in sync.
//
// NEW branches are cut as `devpilot/<slug>`. `ace/<slug>` was the namespace
// before the rename and is still checked out in existing workspaces on disk. We
// rename NO branch, anywhere — the matcher accepts both prefixes instead.
//
// ⚠️ `isTicketBranch` is LOAD-BEARING, not dead code. Do not "clean up" the
// `ace` half. It is what makes the re-entry guard in workspace.ts KEEP an
// existing workspace on its current branch. Narrow it to `devpilot/` only and the
// runner will `git checkout -b devpilot/<slug>` inside a workspace already on
// `ace/<slug>`, stranding the engineer's prior commits on a branch nothing
// points at any more — and some of those commits were never pushed, so that
// workspace is their only copy.
//
// The `ace` half may be dropped once no `ace/*` workspace remains on disk.

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
