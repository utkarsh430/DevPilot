// L1 (ticket-speed audit) — install dependencies before the verification
// command runs, so the QA gate's pass/fail decision reflects the ticket's
// code, not whether `node_modules` happened to already be on disk.
//
// THE DEFECT (measured 2026-08-06, olympussai board)
// ────────────────────────────────────────────────────
// DevPilot-8 and DevPilot-9 both parked asking a human to adjudicate a
// `pnpm test` failure. Re-running the EXACT gate command in each workspace
// passed clean:
//
//   DevPilot-8:  Test Files 16 passed (16)   Tests 311 passed (311)
//   DevPilot-9:  Test Files 16 passed (16)   Tests 311 passed (311)
//
// The runner log for both runs records the gate command failing —
// `verification run=… step=qa command="pnpm test" exit=1 pushed=false
// commitsAhead=2` — and contains ZERO `pnpm install` invocations anywhere in
// its history. `ENGINEER_QA_COMMAND` (env.ts) defaults to `pnpm test`, and
// nothing on the verification path (verification-hook.ts) ever installed
// dependencies first. Two agents were sent to ask a human whether their own
// passing code was broken, because the gate ran `pnpm test` against whatever
// `node_modules` happened to already exist in the workspace — which, on a
// fresh/refreshed checkout, is nothing.
//
// WHY THIS IS A SEPARATE MODULE FROM THE DEV-SERVER'S AUTO-INSTALL
// ──────────────────────────────────────────────────────────────────
// `dev-server.ts` already has an `ensureNodeDepsInstalled`/`pickInstallCommand`
// pair, but it exists to boot a live preview server (best-effort convenience:
// falls back to a *non-frozen* pnpm install when no lockfile is present at
// all, because a preview server should come up even against a half-configured
// repo) and it drags in that file's session/spawn-tracking machinery (the
// `TRACKED` map, ring-buffer log streaming, `onStage` callbacks for the
// dev-server heartbeat). A verification gate wants the OPPOSITE default: a
// deterministic, exactly-what-CI-would-install command that FAILS LOUDLY
// (`--frozen-lockfile` / `npm ci`) when the lockfile and manifest disagree,
// because that disagreement is itself a real defect (see below). So this is a
// small, independent, side-effect-free module the two features are free to
// evolve separately — not an import of dev-server.ts's helpers.
//
// THE `--frozen-lockfile` / `npm ci` DECISION, ARGUED
// ─────────────────────────────────────────────────────
// Every command here uses the package manager's frozen/CI-equivalent install
// (`pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`,
// `npm ci`, `bun install --frozen-lockfile`) whenever a lockfile is present,
// rather than a plain install that would silently regenerate it. Two reasons:
//
//   1. A plain install MUTATES the lockfile on disk to match package.json
//      whenever they've drifted, as a silent side effect of a step whose job
//      is only to VERIFY the ticket's own commits. That mutation is
//      uncommitted, invisible to `commits_ahead` (which only measures
//      commits), and would sit in the working tree for a later step's empty-
//      delivery/nudge machinery to trip over for a reason that has nothing to
//      do with the agent's actual work.
//   2. If an agent added a dependency to package.json but never ran an
//      install (so the lockfile is stale), `--frozen-lockfile`/`npm ci` FAILS
//      LOUDLY and immediately, with an unambiguous package-manager error
//      ("Cannot install with frozen-lockfile because pnpm-lock.yaml is not up
//      to date with package.json") — which is a real, actionable defect: the
//      agent must run the install and commit the updated lockfile before its
//      work is genuinely reproducible. Silently accepting the drift would hide
//      that from the ticket entirely.
//
// This failure is exactly as strict as a genuine test failure — see
// verification-hook.ts for how it stays DISTINGUISHABLE from one. When
// package.json exists but no lockfile does at all, there is nothing to freeze
// against, so a plain `pnpm install` runs (DevPilot's scaffolder is a pnpm
// shop — same fallback dev-server.ts uses).
//
// KEEPING INSTALL OFF THE CRITICAL PATH
// ───────────────────────────────────────
// A workspace that already has current dependencies must not pay a full
// install on every producer step (a run can iterate ~20 times reusing one
// working tree). `isInstallNeeded` mirrors dev-server.ts's staleness check:
// reinstall when `node_modules` is absent OR the manifest/lockfile is newer
// than the package manager's own "last install" marker (an agent added a
// dependency mid-run and the stale tree is missing it) — otherwise skip.

import fs from "node:fs/promises";
import path from "node:path";

export type LockfilePresence = {
  pnpm: boolean;
  yarn: boolean;
  npm: boolean;
  bun: boolean;
};

export type InstallPlan = { argv0: string; argv: string[] };

/**
 * Which install command applies, from lockfile presence alone. Pure — no fs.
 *
 * Priority pnpm > yarn > npm > bun when more than one lockfile is present
 * (mirrors dev-server.ts's `pickInstallCommand`). Returns `null` ONLY when
 * there is no `package.json` at all: not a Node project, so there is nothing
 * to install and the caller must skip cleanly rather than guess a command for
 * a stack that was never asked for (a lone stray lockfile with no manifest —
 * e.g. a leftover from a prior scaffold attempt — does not make this a Node
 * project either).
 */
export function pickInstallPlan(
  hasPackageJson: boolean,
  lockfiles: LockfilePresence,
): InstallPlan | null {
  if (!hasPackageJson) return null;
  if (lockfiles.pnpm) return { argv0: "pnpm", argv: ["install", "--frozen-lockfile"] };
  if (lockfiles.yarn) return { argv0: "yarn", argv: ["install", "--frozen-lockfile"] };
  if (lockfiles.npm) return { argv0: "npm", argv: ["ci"] };
  if (lockfiles.bun) return { argv0: "bun", argv: ["install", "--frozen-lockfile"] };
  // package.json with no recognized lockfile: nothing to freeze against.
  return { argv0: "pnpm", argv: ["install"] };
}

/** Render a plan the same way `VerificationCommand.command` (a plain string,
 *  re-tokenized by producer-verification.ts's `parseCommandString`) expects.
 *  Every argv piece here is a bare flag/word with no spaces or quoting needs. */
export function formatInstallCommand(plan: InstallPlan): string {
  return [plan.argv0, ...plan.argv].join(" ");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Decide whether an existing `node_modules` is stale relative to the
 * manifest/lockfile. Deliberately the same mtime-comparison shape as
 * dev-server.ts's `depsAreStale` (see the module header for why this is a
 * separate, small copy rather than a shared import): a git checkout / branch
 * switch / `git pull` only bumps the mtime of files that actually changed, so
 * "manifest newer than the install marker" is a precise deps-changed signal
 * without hashing file contents. A 1s skew tolerance absorbs a fresh clone
 * that stamps every file in the same second.
 */
async function depsAreStale(cwd: string): Promise<boolean> {
  const mtimeMs = async (rel: string): Promise<number | null> => {
    try {
      return (await fs.stat(path.join(cwd, rel))).mtimeMs;
    } catch {
      return null;
    }
  };
  const newest = (xs: Array<number | null>): number =>
    xs.reduce<number>((m, t) => (t !== null && t > m ? t : m), 0);

  const manifest = newest(
    await Promise.all([
      mtimeMs("package.json"),
      mtimeMs("pnpm-lock.yaml"),
      mtimeMs("package-lock.json"),
      mtimeMs("yarn.lock"),
      mtimeMs("bun.lockb"),
    ]),
  );
  if (manifest === 0) return false; // no manifest to compare against

  const marker = newest(
    await Promise.all([
      mtimeMs("node_modules/.modules.yaml"), // pnpm
      mtimeMs("node_modules/.package-lock.json"), // npm
      mtimeMs("node_modules/.yarn-state.yml"), // yarn (node-modules linker)
      mtimeMs("node_modules"),
    ]),
  );
  if (marker === 0) return true; // node_modules present but no marker → reinstall

  return manifest > marker + 1000;
}

/**
 * True when dependencies need (re)installing: no `node_modules` at all, or a
 * stale one. False means the workspace already has current dependencies and
 * an install would be needless work on the critical path.
 */
export async function isInstallNeeded(cwd: string): Promise<boolean> {
  const hasNodeModules = await dirExists(path.join(cwd, "node_modules"));
  if (!hasNodeModules) return true;
  return depsAreStale(cwd);
}

/**
 * The full decision for a workspace at `cwd`: what install command (if any)
 * should run before the QA/build check.
 *
 * Empty string means "nothing to install" — either this isn't a Node project
 * (no `package.json`, e.g. a non-Node repo like `scoursh`) or dependencies are
 * already installed and current. The caller (verification-hook.ts) treats an
 * empty string exactly like any other blank `VerificationCommand`: skipped,
 * never a failure. An install step that cannot apply is a no-op, not a defect.
 */
export async function resolveInstallCommand(cwd: string): Promise<string> {
  const hasPackageJson = await fileExists(path.join(cwd, "package.json"));
  if (!hasPackageJson) return "";

  const lockfiles: LockfilePresence = {
    pnpm: await fileExists(path.join(cwd, "pnpm-lock.yaml")),
    yarn: await fileExists(path.join(cwd, "yarn.lock")),
    npm: await fileExists(path.join(cwd, "package-lock.json")),
    bun: await fileExists(path.join(cwd, "bun.lockb")),
  };
  const plan = pickInstallPlan(hasPackageJson, lockfiles);
  if (!plan) return ""; // unreachable given hasPackageJson === true, kept for type honesty

  if (!(await isInstallNeeded(cwd))) return "";
  return formatInstallCommand(plan);
}
