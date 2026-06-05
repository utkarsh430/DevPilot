// Phase 2 / M5e — Workspace tree builder + capped file reader.
//
// The Live tab on /changes/[id] needs a "what does the runner's working tree
// look like RIGHT NOW" view. We deliberately drive this from `git` (not raw
// filesystem `readdir`) so:
//
//   • The tree honours .gitignore (no `node_modules/`, no `.next/`, no log
//     spam) without re-implementing ignore parsing.
//   • Status per file (modified / added / deleted / unchanged) falls out of
//     three git commands instead of a stat-diff against HEAD that we'd have
//     to write ourselves.
//   • The "added" set covers BOTH untracked files (`ls-files --others`) AND
//     newly-staged-but-not-committed adds, which is what the operator
//     intuitively means by "files the agent just wrote".
//
// All git invocations go through `node:child_process.spawn` with `shell:false`
// — same pattern as `apps/web/lib/git/diff.ts` so we share the threat model
// (no command injection even if a future caller forgets to validate cwd).
//
// File reads are path-traversal-guarded via `path.resolve` + a prefix check
// so a malicious `relPath` (`../../etc/passwd`) can't escape the workspace
// root even if the calling action skipped the zod refine.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type TreeNode = {
  /** Path relative to the workspace root, no leading slash. "" = root. */
  path: string;
  name: string;
  /** "dir" | "file" */
  kind: "dir" | "file";
  /** Status of THIS node (worst status if dir). */
  status: "unchanged" | "modified" | "added" | "deleted";
  /** Direct children, only present on dirs. Files have undefined. */
  children?: TreeNode[];
  /** Count of changed (modified/added/deleted) descendants, present on dirs only. */
  changedDescendants?: number;
};

/** 5 MB ceiling per git stdout — enough for a 100k-file monorepo's name list. */
const GIT_STDOUT_MAX_BYTES = 5 * 1024 * 1024;

/** Default per-file read ceiling for the preview pane. 256 KB matches the
 * react-diff-viewer-continued comfort zone; anything bigger usually means
 * the file is generated and not interesting to look at in a browser. */
const DEFAULT_FILE_MAX_BYTES = 256 * 1024;

/** Internal: spawn `git` with the given args inside `cwd`, capture stdout
 * (capped at GIT_STDOUT_MAX_BYTES) + stderr + exit code. Never throws for
 * non-zero exits — the caller decides whether the failure is recoverable
 * (e.g. unborn HEAD is recoverable by falling back to `git ls-files`). */
function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = GIT_STDOUT_MAX_BYTES - stdoutBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrChunks.reduce((n, b) => n + b.length, 0) < 64 * 1024) {
        stderrChunks.push(chunk);
      }
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? -1,
      });
    });
  });
}

/** Split git stdout into trimmed non-empty lines. */
function lines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

type FlatEntry = {
  path: string;
  status: "unchanged" | "modified" | "added" | "deleted";
};

/**
 * Build the workspace tree for a runner-host workspace path.
 *
 * Steps:
 *   1. `git ls-tree -r HEAD --name-only` → tracked file list. If HEAD doesn't
 *      exist (unborn branch — typical right after `git init`), fall back to
 *      `git ls-files` which lists the index instead.
 *   2. `git diff --name-status HEAD` → map of `path → 'M'|'D'|...` for files
 *      that differ from HEAD (modifications + working-tree deletions).
 *   3. `git ls-files --others --exclude-standard` → untracked-but-not-ignored
 *      files (the "added" set the operator means when they say "files the
 *      agent just wrote").
 *
 * Then fold into a flat list with one row per path + its status, fold that
 * into a tree, and compute per-dir aggregates.
 *
 * All git output is capped at 5 MB per command. A misbehaving repo (e.g. a
 * giant `node_modules` mistakenly tracked) won't OOM the page.
 */
export async function getWorkspaceTree(
  workspacePath: string,
): Promise<{ root: TreeNode; totalFiles: number; changedFiles: number }> {
  // Step 1: tracked file list.
  let trackedPaths: string[] = [];
  const lsTree = await runGit(workspacePath, ["ls-tree", "-r", "HEAD", "--name-only"]);
  if (lsTree.exitCode === 0) {
    trackedPaths = lines(lsTree.stdout);
  } else {
    // Unborn HEAD (`fatal: not a valid object name HEAD`). Fall back to
    // `git ls-files` which lists the index — covers the "just `git init`,
    // staged some files, no commit yet" case.
    const lsFiles = await runGit(workspacePath, ["ls-files"]);
    if (lsFiles.exitCode === 0) {
      trackedPaths = lines(lsFiles.stdout);
    }
  }

  // Step 2: modified vs HEAD. Tolerate failure (unborn HEAD again) — in that
  // case `git diff --name-status` exits non-zero and we just treat the index
  // as the source of truth.
  const modifiedStatus = new Map<string, string>();
  const diffStatus = await runGit(workspacePath, ["diff", "--name-status", "HEAD"]);
  if (diffStatus.exitCode === 0) {
    for (const line of diffStatus.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const letter = (parts[0] ?? "").charAt(0).toUpperCase();
      // R/C have an extra path; we care about the new path.
      const pathName =
        (letter === "R" || letter === "C") && parts.length >= 3 ? parts[2]! : parts[1]!;
      modifiedStatus.set(pathName, letter);
    }
  }

  // Step 3: untracked. Tolerate failure (returns empty).
  let untrackedPaths: string[] = [];
  const lsOthers = await runGit(workspacePath, ["ls-files", "--others", "--exclude-standard"]);
  if (lsOthers.exitCode === 0) {
    untrackedPaths = lines(lsOthers.stdout);
  }

  // Build the flat entry list. Order matters for the tree fold:
  //   • tracked paths first (with status from modified map),
  //   • untracked paths appended as "added",
  //   • deleted-from-modified-map paths kept as "deleted" (they're in
  //     trackedPaths so already covered, but we ensure the status maps).
  const entries = new Map<string, FlatEntry>();
  for (const p of trackedPaths) {
    const letter = modifiedStatus.get(p);
    let status: FlatEntry["status"] = "unchanged";
    if (letter === "D") status = "deleted";
    else if (letter === "A") status = "added";
    else if (letter) status = "modified"; // M/R/C/T/U treated as modified
    entries.set(p, { path: p, status });
  }
  for (const p of untrackedPaths) {
    // Untracked beats unchanged but defer to an existing "deleted" if any
    // weird race produces both (shouldn't happen — git wouldn't list a
    // deleted file in --others).
    if (!entries.has(p)) {
      entries.set(p, { path: p, status: "added" });
    }
  }
  // Catch the edge case where a path appears in `git diff --name-status` as
  // deleted but isn't in `ls-tree` (e.g. unborn HEAD fallback): make sure
  // it surfaces.
  for (const [p, letter] of modifiedStatus) {
    if (!entries.has(p) && letter === "D") {
      entries.set(p, { path: p, status: "deleted" });
    }
  }

  const flat = Array.from(entries.values());

  // Fold into tree.
  const root: TreeNode = {
    path: "",
    name: "",
    kind: "dir",
    status: "unchanged",
    children: [],
    changedDescendants: 0,
  };

  // Each dir we touch gets ensured/created. We keep an index from path → node
  // so we don't re-walk the parent chain on every file.
  const dirIndex = new Map<string, TreeNode>();
  dirIndex.set("", root);

  function ensureDir(dirPath: string): TreeNode {
    if (dirIndex.has(dirPath)) return dirIndex.get(dirPath)!;
    const slashIdx = dirPath.lastIndexOf("/");
    const parentPath = slashIdx === -1 ? "" : dirPath.slice(0, slashIdx);
    const name = slashIdx === -1 ? dirPath : dirPath.slice(slashIdx + 1);
    const parent = ensureDir(parentPath);
    const node: TreeNode = {
      path: dirPath,
      name,
      kind: "dir",
      status: "unchanged",
      children: [],
      changedDescendants: 0,
    };
    parent.children!.push(node);
    dirIndex.set(dirPath, node);
    return node;
  }

  let totalFiles = 0;
  let changedFiles = 0;

  for (const entry of flat) {
    const slashIdx = entry.path.lastIndexOf("/");
    const parentPath = slashIdx === -1 ? "" : entry.path.slice(0, slashIdx);
    const name = slashIdx === -1 ? entry.path : entry.path.slice(slashIdx + 1);
    const parent = ensureDir(parentPath);
    const fileNode: TreeNode = {
      path: entry.path,
      name,
      kind: "file",
      status: entry.status,
    };
    parent.children!.push(fileNode);
    totalFiles += 1;
    if (entry.status !== "unchanged") changedFiles += 1;
  }

  // Compute per-dir aggregates: changedDescendants count + status = worst of
  // descendants. We use a severity ranking: deleted > added > modified >
  // unchanged. Two diverging children (one added, one deleted) → worst is
  // deleted, which is the most attention-grabbing case for the UI.
  const severity: Record<TreeNode["status"], number> = {
    unchanged: 0,
    modified: 1,
    added: 2,
    deleted: 3,
  };
  function aggregate(node: TreeNode): { worst: number; changed: number } {
    if (node.kind === "file") {
      return {
        worst: severity[node.status],
        changed: node.status === "unchanged" ? 0 : 1,
      };
    }
    let worst = 0;
    let changed = 0;
    // Sort children: dirs first, then files, both alphabetical. Matches
    // every file-tree UI the operator is used to (VS Code, GitHub).
    node.children!.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children!) {
      const r = aggregate(c);
      if (r.worst > worst) worst = r.worst;
      changed += r.changed;
    }
    const byRank = (Object.keys(severity) as Array<TreeNode["status"]>).find(
      (k) => severity[k] === worst,
    );
    node.status = byRank ?? "unchanged";
    node.changedDescendants = changed;
    return { worst, changed };
  }
  aggregate(root);

  return { root, totalFiles, changedFiles };
}

/**
 * Read a single workspace file with hard caps and path-traversal protection.
 *
 *   • absPath = path.resolve(workspacePath, relPath). The traversal guard
 *     compares the resolved abs path to the workspace root with a trailing
 *     separator — so a workspace at `/tmp/ws` will reject `/tmp/wsx/foo`
 *     (prefix match without separator) but accept `/tmp/ws/foo`.
 *   • If size > maxBytes (default 256 KB), return truncated=true and skip
 *     the read entirely. We don't try to render a partial file — the diff
 *     viewer chokes on truncated UTF-8.
 *   • Binary detection: read first 512 bytes, look for a NUL byte. The
 *     heuristic is the same one `git` uses internally; it's not perfect
 *     (UTF-16 text with BOM can look binary) but matches operator
 *     expectations: binary = "don't show me this".
 *   • Returns the full file as utf8 otherwise. Mojibake on non-utf8 text
 *     is acceptable — the operator's recourse is to open it in their
 *     editor, not in the browser preview.
 */
export async function readWorkspaceFile(
  workspacePath: string,
  relPath: string,
  opts: { maxBytes?: number } = {},
): Promise<{
  content: string | null;
  bytes: number;
  binary: boolean;
  truncated: boolean;
}> {
  const maxBytes = opts.maxBytes ?? DEFAULT_FILE_MAX_BYTES;

  // Normalize workspace path so the prefix check is comparable.
  const rootAbs = path.resolve(workspacePath);
  const candidateAbs = path.resolve(rootAbs, relPath);

  // Reject any candidate that escapes the workspace root. Path comparison
  // includes a separator so `/tmp/wsx` doesn't satisfy a `/tmp/ws` prefix.
  const rootWithSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (candidateAbs !== rootAbs && !candidateAbs.startsWith(rootWithSep)) {
    throw new Error("Path escapes workspace root");
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(candidateAbs);
  } catch (err) {
    throw new Error(`Cannot stat file: ${(err as Error).message}`);
  }
  if (!stat.isFile()) {
    throw new Error("Path is not a regular file");
  }
  const bytes = stat.size;
  if (bytes > maxBytes) {
    return { content: null, bytes, binary: false, truncated: true };
  }

  // Binary sniff: open + read first 512 bytes, check for NUL. We use a
  // filehandle rather than re-reading the whole file via fs.readFile, so
  // huge-but-under-cap binary files don't pay the read cost twice.
  const handle = await fs.open(candidateAbs, "r");
  try {
    const probeSize = Math.min(512, bytes);
    const probe = Buffer.alloc(probeSize);
    if (probeSize > 0) {
      await handle.read(probe, 0, probeSize, 0);
      for (let i = 0; i < probeSize; i += 1) {
        if (probe[i] === 0) {
          return { content: null, bytes, binary: true, truncated: false };
        }
      }
    }
    // Not binary — read the full file. We can re-read from disk rather than
    // try to stitch the probe + tail because we already know the file is
    // <= 256 KB; the extra read cost is negligible.
    const buf = Buffer.alloc(bytes);
    if (bytes > 0) {
      await handle.read(buf, 0, bytes, 0);
    }
    return {
      content: buf.toString("utf8"),
      bytes,
      binary: false,
      truncated: false,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Overwrite a file in the workspace with `content`. Counterpart to
 * `readWorkspaceFile`; same path-traversal guard so a crafted `relPath`
 * (".." escapes, absolute paths) can't write outside the workspace root.
 *
 * Constraints:
 *   • Workspace root must exist (no auto-create — refusing here protects
 *     a stale `workspace_path` from silently recreating a long-deleted
 *     workspace dir).
 *   • Parent dir of the target may not exist yet (the operator might
 *     create a new file in a nested path) — we mkdir -p it.
 *   • Content size capped at 1 MB by default. Larger files belong in
 *     VS Code, not an inline textarea.
 */
export async function writeWorkspaceFile(
  workspacePath: string,
  relPath: string,
  content: string,
  opts: { maxBytes?: number } = {},
): Promise<{ bytes: number }> {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;

  if (typeof content !== "string") {
    throw new Error("Content must be a string");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `Content exceeds the inline-edit cap (${bytes} > ${maxBytes} bytes). Use VS Code for larger files.`,
    );
  }

  // Same prefix check as the read path. Compute resolved root + candidate
  // and require the candidate to sit inside the root.
  const rootAbs = path.resolve(workspacePath);
  const candidateAbs = path.resolve(rootAbs, relPath);
  const rootWithSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (candidateAbs !== rootAbs && !candidateAbs.startsWith(rootWithSep)) {
    throw new Error("Path escapes workspace root");
  }

  // Workspace root must exist. We bail rather than create it to avoid
  // resurrecting a long-cleaned-up workspace silently.
  try {
    const rootStat = await fs.stat(rootAbs);
    if (!rootStat.isDirectory()) {
      throw new Error("Workspace path is not a directory");
    }
  } catch (err) {
    throw new Error(`Workspace dir missing — cannot write: ${(err as Error).message}`);
  }

  // Parent of the target file may not exist yet (new file in a fresh subdir).
  await fs.mkdir(path.dirname(candidateAbs), { recursive: true });
  await fs.writeFile(candidateAbs, content, "utf8");
  return { bytes };
}
