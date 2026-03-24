// Bundled Claude Code subagent definitions for the Local CC Runner.
//
// These let the parent `claude -p` step fan out READ-ONLY work in parallel
// (Task tool) without violating DevPilot's hard ceilings: every bundled agent's
// `tools:` frontmatter lists only Read/Grep/Glob, so a runaway subagent can
// at worst waste tokens — it structurally cannot edit files, run shell, or
// reach the devpilot_* MCP tools that mutate board state.
//
// Cross-role/cross-run handoffs (PM→Eng→QA, supervisor→child) still go
// through the durable engine via `devpilot_spawn_agent`, where MAX_DEPTH /
// MAX_FAN_OUT / budget checks apply. Subagents are for intra-step
// parallelism only.
//
// Install path: `<workspace>/.claude/agents/*.md`. We also append
// `.claude/agents/` to `.git/info/exclude` so the operator's repo never
// accidentally commits the bundle.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLE_DIR = path.resolve(__dirname, "agents");

/**
 * Copy every `*.md` agent definition into `<workspacePath>/.claude/agents/`,
 * overwriting any existing files (the bundle is the source of truth each
 * step). Adds `.claude/agents/` to `.git/info/exclude` so a stray `git add .`
 * inside the workspace can't commit them.
 *
 * No-op + warn when the workspace doesn't look like a git working tree
 * (still installs the agents — the gitignore step just skips). Errors here
 * are non-fatal: a missing subagent bundle should never block the step.
 */
export async function installSubagentsIntoWorkspace(workspacePath: string): Promise<void> {
  try {
    const entries = await fs.readdir(BUNDLE_DIR, { withFileTypes: true });
    const mds = entries.filter((e) => e.isFile() && e.name.endsWith(".md"));
    if (mds.length === 0) return;

    const targetDir = path.join(workspacePath, ".claude", "agents");
    await fs.mkdir(targetDir, { recursive: true });
    for (const e of mds) {
      const src = path.join(BUNDLE_DIR, e.name);
      const dst = path.join(targetDir, e.name);
      const body = await fs.readFile(src, "utf8");
      await fs.writeFile(dst, body, "utf8");
    }

    // Best-effort gitignore. If `.git/info/exclude` doesn't exist (cwd
    // isn't a git tree), skip silently — non-engineer steps (PM, QA)
    // sometimes run with a non-repo cwd.
    const excludePath = path.join(workspacePath, ".git", "info", "exclude");
    try {
      let existing = "";
      try {
        existing = await fs.readFile(excludePath, "utf8");
      } catch {
        // file may not exist yet; we'll create it below if .git/info does
      }
      const pattern = ".claude/agents/";
      const lines = existing.split(/\r?\n/);
      if (!lines.includes(pattern)) {
        await fs.mkdir(path.dirname(excludePath), { recursive: true });
        const updated =
          existing.length === 0 || existing.endsWith("\n")
            ? `${existing}${pattern}\n`
            : `${existing}\n${pattern}\n`;
        await fs.writeFile(excludePath, updated, "utf8");
      }
    } catch {
      // Non-git cwd — fine, just skip the exclude.
    }
  } catch (err) {
    console.warn(
      `[devpilot-runner] installSubagentsIntoWorkspace failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
