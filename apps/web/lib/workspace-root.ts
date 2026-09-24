import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the WORKSPACE_ROOT env value into a usable absolute path.
 *
 * Duplicated from apps/runner/src/workspace-root.ts — same rules, kept
 * in lockstep because the two packages don't share a tsconfig at
 * runtime. Any change here must be mirrored there.
 *
 * Rules:
 *   • Empty/unset → defaults to `~/.devpilot/workspaces`.
 *   • Absolute path → used as-is.
 *   • Relative path → resolved against the monorepo root (the nearest
 *     ancestor with `pnpm-workspace.yaml`), NOT `process.cwd()`. This
 *     means `.devpilot/workspaces` resolves to the same on-disk location
 *     whether the reader is the web app (cwd=apps/web) or the runner
 *     (cwd=apps/runner).
 *   • Any path segment equal to `...`, `..`, or empty (other than the
 *     leading slash) throws.
 */
export function resolveWorkspaceRoot(raw: string | undefined): string {
  const value = raw && raw.length > 0 ? raw : path.join(os.homedir(), ".devpilot", "workspaces");

  const segments = value.split(path.sep);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "..." || seg === "..") {
      throw new Error(
        `WORKSPACE_ROOT contains an invalid path segment "${seg}" in "${value}". ` +
          `"..." is almost always a UI ellipsis copy-pasted into config; ".." ` +
          `escapes the intended root. Use an absolute path (e.g. ` +
          `/Users/you/.devpilot/workspaces) or a clean relative path (e.g. ` +
          `.devpilot/workspaces) resolved against the repo root.`,
      );
    }
    if (seg === "" && i !== 0) {
      throw new Error(
        `WORKSPACE_ROOT "${value}" has an empty path segment — collapsed slashes ` +
          `are not allowed.`,
      );
    }
  }

  if (path.isAbsolute(value)) return value;

  const root = findMonorepoRoot();
  if (!root) {
    throw new Error(
      `WORKSPACE_ROOT="${value}" is a relative path but no pnpm-workspace.yaml ` +
        `was found in any parent of ${process.cwd()}. Set WORKSPACE_ROOT to an ` +
        `absolute path or run from inside the repo.`,
    );
  }
  return path.resolve(root, value);
}

function findMonorepoRoot(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
