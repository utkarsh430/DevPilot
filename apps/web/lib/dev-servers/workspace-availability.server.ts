// Server-side companion to the pure `classifyWorkspaceAvailability`
// (`workspace-path.ts`): does the `stat`, hands the answer to the classifier.
//
// Split for the same reason as `qa-gate` / `qa-gate.server`: the decision stays
// pure and unit-testable, the I/O lives here.

import fs from "node:fs/promises";
import {
  classifyWorkspaceAvailability,
  type WorkspaceAvailability,
} from "@/lib/dev-servers/workspace-path";

/**
 * Can we run git in this stored `workspace_path` on THIS host, right now?
 *
 * Call this before any flow that `spawn`s git with `cwd = pending.workspace_path`.
 * A missing `cwd` surfaces from Node as a bare `spawn git ENOENT`, which is a
 * dead end for the operator; this turns it into a message that names the cause
 * and points at the recovery.
 */
export async function checkWorkspaceAvailable(args: {
  storedPath: string;
  workspaceRoot: string;
  hasSavedDiff: boolean;
}): Promise<WorkspaceAvailability> {
  const exists = await fs
    .stat(args.storedPath)
    .then((s) => s.isDirectory())
    .catch(() => false);
  return classifyWorkspaceAvailability({
    stored: args.storedPath,
    workspaceRoot: args.workspaceRoot,
    exists,
    hasSavedDiff: args.hasSavedDiff,
  });
}
