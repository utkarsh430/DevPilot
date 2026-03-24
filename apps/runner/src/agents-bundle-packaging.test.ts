// Regression coverage for the subagent-bundle packaging bug: `apps/runner`'s
// build is a plain `tsc` compile, which only emits `.ts` -> `.js` and silently
// skips every other file under `src/` — no error, no warning. `src/agents/*.md`
// (the read-only Claude Code subagent definitions `agents-bundle.ts` installs
// into a workspace's `.claude/agents/`) is exactly such a file, so `dist/agents/`
// was never produced by any build, on any machine. `installSubagentsIntoWorkspace`
// caught the resulting ENOENT and warned (non-fatal by design — a missing
// bundle must never block a step), which is precisely why nobody noticed the
// bundle had never once been installed anywhere.
//
// Fixed by `scripts/copy-static-assets.mjs`, run as the second half of the
// `build` script (see package.json). This file locks down two properties:
//
//   (1) a CLEAN build actually produces `dist/agents/` with the definitions —
//       proven by deleting `dist/` and running the real build script, not by
//       asserting a directory happens to exist from a previous run.
//   (2) once the bundle is present, `installSubagentsIntoWorkspace` actually
//       installs it into a workspace — so the packaging fix is connected to
//       the behaviour it exists to enable, not just to a directory existing.
//
// NOT a jest/vitest suite — the runner has no test runner wired up, so this
// follows the same bare-`main()` convention as workspace-reap-guard.test.ts /
// board-tools.test.ts. Run it directly:
//
//   cd apps/runner && npx tsx src/agents-bundle-packaging.test.ts
//
// Test (1) deletes and rebuilds the real `apps/runner/dist/` — that IS the
// build under test, not a side effect to avoid.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installSubagentsIntoWorkspace } from "./agents-bundle.js";

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, ".."); // apps/runner
const SRC_AGENTS_DIR = path.join(ROOT, "src", "agents");
const DIST_DIR = path.join(ROOT, "dist");
const DIST_AGENTS_DIR = path.join(DIST_DIR, "agents");

/** The real `scripts.build` command from package.json — read at runtime and
 *  run through a shell, NOT re-typed here. Hardcoding the two build steps
 *  ourselves would prove nothing: it would keep "passing" even if someone
 *  later removed the copy step from the actual build script, which is
 *  exactly the regression this test exists to catch. */
async function readBuildScript(): Promise<string> {
  const raw = await fs.readFile(path.join(ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  const build = pkg.scripts?.build;
  assert.ok(
    build && build.trim().length > 0,
    "package.json must declare a non-empty scripts.build",
  );
  return build;
}

async function readMdFiles(dir: string): Promise<Map<string, string>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = new Map<string, string>();
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    out.set(e.name, await fs.readFile(path.join(dir, e.name), "utf8"));
  }
  return out;
}

/** A clean build of `apps/runner` must produce `dist/agents/` containing the
 *  markdown definitions, byte-for-byte. */
async function testCleanBuildProducesAgentsBundle(): Promise<void> {
  // Prove this against a build that starts with no `dist/` at all — the same
  // state a fresh checkout or CI runner starts from, and the exact condition
  // under which the original bug was invisible (a caught, non-fatal ENOENT).
  await fs.rm(DIST_DIR, { recursive: true, force: true });

  // Run the ACTUAL `scripts.build` command from package.json (via a shell,
  // since it's a `tsc ... && node ...` compound command) — proving a
  // property of the real build, not of a hand-rolled substitute for it.
  //
  // `/bin/sh`, NEVER `process.env.SHELL`. A non-interactive `zsh -c` sources
  // the user's `.zshenv`, which commonly REBUILDS PATH from scratch — so the
  // build resolved `tsc` or not depending on the invoker's dotfiles. It
  // happened to work under `pnpm --filter @devpilot/runner test` (pnpm exports
  // its own PATH, and the shell had not yet clobbered it) and failed under
  // `pnpm test`, where turbo's environment differs, with a bare
  // `zsh:1: command not found: tsc` — a red gate that looks like a broken
  // build and is really a broken test harness.
  //
  // PATH is also set explicitly rather than inherited, so the binaries come
  // from this workspace regardless of how the test was invoked. Both halves
  // are needed: `sh` stops the dotfiles clobbering PATH, and the explicit
  // entry stops us depending on the caller having exported it.
  const buildScript = await readBuildScript();
  const binDirs = [
    path.join(ROOT, "node_modules", ".bin"),
    path.join(ROOT, "..", "..", "node_modules", ".bin"),
  ];
  await execFileP("/bin/sh", ["-c", buildScript], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${binDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  const distMd = await readMdFiles(DIST_AGENTS_DIR).catch((err) => {
    throw new Error(
      `expected dist/agents/ to exist and contain .md files after a build; ` +
        `readdir failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  assert.ok(
    distMd.size > 0,
    "expected dist/agents/ to contain at least one .md file after a clean build",
  );

  const srcMd = await readMdFiles(SRC_AGENTS_DIR);
  assert.ok(srcMd.size > 0, "sanity check: src/agents/ itself must hold at least one .md file");

  // Every source definition must have made it across, unmodified — not just
  // "some" file landing in the destination.
  for (const [name, source] of srcMd) {
    assert.ok(distMd.has(name), `dist/agents/${name} is missing after build`);
    assert.equal(
      distMd.get(name),
      source,
      `dist/agents/${name} must match src/agents/${name} byte-for-byte`,
    );
  }

  console.log(
    `✓ a clean build produces dist/agents/ with ${srcMd.size} definition(s): ${[...srcMd.keys()].join(", ")}`,
  );
}

/** Once the bundle is present (as it now is under `src/agents/`, which is
 *  exactly where `agents-bundle.ts` resolves `BUNDLE_DIR` to when this test
 *  runs via `tsx` — the same __dirname-relative contract the compiled build
 *  uses), `installSubagentsIntoWorkspace` must actually copy it into a
 *  workspace's `.claude/agents/`. This is the behaviour the packaging fix
 *  exists to enable — a directory existing on disk proves nothing on its
 *  own. */
async function testInstallSubagentsIntoWorkspaceCopiesTheBundle(base: string): Promise<void> {
  const srcMd = await readMdFiles(SRC_AGENTS_DIR);
  assert.ok(srcMd.size > 0, "sanity check: src/agents/ must hold at least one .md file to install");

  const workspace = path.join(base, "install-target");
  await fs.mkdir(workspace, { recursive: true });

  await installSubagentsIntoWorkspace(workspace);

  const installedDir = path.join(workspace, ".claude", "agents");
  const installedMd = await readMdFiles(installedDir).catch((err) => {
    throw new Error(
      `expected ${installedDir} to exist and contain .md files after install; ` +
        `readdir failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  for (const [name, source] of srcMd) {
    assert.ok(installedMd.has(name), `${installedDir}/${name} was not installed`);
    assert.equal(
      installedMd.get(name),
      source,
      `installed ${name} must match the bundled source byte-for-byte`,
    );
  }

  console.log(
    `✓ installSubagentsIntoWorkspace copies ${srcMd.size} definition(s) into a workspace's .claude/agents/`,
  );
}

async function main(): Promise<void> {
  await testCleanBuildProducesAgentsBundle();

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "devpilot-agents-bundle-test-"));
  try {
    await testInstallSubagentsIntoWorkspaceCopiesTheBundle(base);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }

  console.log("\nAll agents-bundle-packaging tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
