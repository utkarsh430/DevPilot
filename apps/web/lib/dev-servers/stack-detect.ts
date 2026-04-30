// Phase 2 / M5e — Workspace stack detection.
// WI-11 — platform-steered (`projects.project_type`).
//
// Two exports:
//   • `inferDevCommand(workspacePath, projectType)` — reads the workspace and
//     returns the canonical single-line dev command, e.g. `pnpm dev`.
//   • `fallbackDevCommand(projectType)` — the same answer for a workspace that
//     is NOT on disk yet (nothing to read). Callers that start a session before
//     the clone lands use this instead of hardcoding `pnpm dev`.
//
// The decision itself is the PURE `decideDevCommand(snapshot, projectType)`;
// `inferDevCommand` is just `readSnapshot` + that call. Keeping the policy pure
// is what lets the interesting cases (a web repo mislabeled `mobile`, an
// unscaffolded workspace, a broken package.json) be unit-tested with no fs.
//
// ── How the platform steers ────────────────────────────────────────────────
//
// The operator's platform label is a COARSE steer, never an override. Order:
//
//   1. Platform refinement — only fires on real EVIDENCE on disk for that
//      platform (an `expo` dependency, a `Package.swift`, an `electron`
//      dependency, …). No evidence ⇒ no platform command.
//   2. Generic disk detection — the pre-WI-11 chain, unchanged:
//      package.json → pyproject.toml → Cargo.toml → go.mod.
//   3. Platform fallback — nothing on disk at all; the label is the only signal
//      we have, so it picks the placeholder.
//
// Step 1 gating on evidence (rather than the label alone) is the whole safety
// property: **a mislabeled project degrades to the old behaviour instead of
// breaking Run.** A Next.js app tagged `mobile` finds no expo/react-native on
// disk, falls through to step 2, and still gets `pnpm dev` — where blindly
// trusting the label would have emitted `pnpm expo start` and hard-failed the
// spawn. Bad guesses stay non-fatal, exactly as the original contract said, and
// the operator's `commandOverride` (RunPanel command box) still short-circuits
// this function entirely at the call site.
//
// Explicit `scripts` beat inferred platform commands: a script the developer
// actually wrote is stronger evidence than a label someone clicked once. So the
// refiners prefer `pnpm start` / `pnpm dev` when the matching script exists and
// only synthesise a bare runner command (`pnpm expo start`) when it doesn't.
//
// ── Whitespace constraint (do not break this) ──────────────────────────────
//
// The runner-side launcher splits this string by whitespace and does NOT honour
// shell metacharacters. Every command emitted here must therefore survive a
// naive split into argv — no quotes, no `&&`, no shell expansion. That is why
// iOS gets a bare `xcodebuild` rather than
// `xcodebuild -destination 'platform=iOS Simulator,name=iPhone 15'`: the quoted
// argument would shred into four broken argv entries.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_PROJECT_TYPE, type ProjectType } from "@/lib/projects/project-type";

const FALLBACK = "pnpm dev";

/**
 * Everything `decideDevCommand` is allowed to know about the workspace. Read
 * once by `readWorkspaceSnapshot`; the decision is a pure function of it.
 */
export type WorkspaceSnapshot = {
  packageJson: string | null;
  pyproject: string | null;
  cargoToml: string | null;
  goMod: string | null;
  /** Flutter. */
  pubspecYaml: string | null;
  /** Swift Package Manager. */
  packageSwift: string | null;
  /** A `*.xcodeproj` or `*.xcworkspace` exists at the workspace root. */
  hasXcodeProject: boolean;
  /** A `src-tauri/` directory exists at the workspace root. */
  hasTauriDir: boolean;
};

export const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  packageJson: null,
  pyproject: null,
  cargoToml: null,
  goMod: null,
  pubspecYaml: null,
  packageSwift: null,
  hasXcodeProject: false,
  hasTauriDir: false,
};

// ─── package.json helpers ──────────────────────────────────────────────────

type Pkg = {
  scripts: Record<string, string>;
  deps: Record<string, string>;
};

/** Best-effort parse. Invalid JSON reads as "no package.json" — a half-broken
 *  workspace must not deadlock the Run button. */
function parsePackageJson(raw: string | null): Pkg | null {
  if (raw === null) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== "object") return null;
  const obj = pkg as Record<string, unknown>;
  const pick = (key: string): Record<string, string> => {
    const v = obj[key];
    if (!v || typeof v !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  };
  return {
    scripts: pick("scripts"),
    deps: { ...pick("dependencies"), ...pick("devDependencies") },
  };
}

function hasScript(pkg: Pkg | null, name: string): boolean {
  const s = pkg?.scripts[name];
  return typeof s === "string" && s.trim().length > 0;
}

function hasDep(pkg: Pkg | null, name: string): boolean {
  return pkg != null && Object.prototype.hasOwnProperty.call(pkg.deps, name);
}

// ─── step 2: generic disk detection (the pre-WI-11 chain, unchanged) ───────

function inferFromPackageJson(pkg: Pkg | null): string | null {
  if (hasScript(pkg, "dev")) return "pnpm dev";
  if (hasScript(pkg, "start")) return "pnpm start";
  return null;
}

// Minimal TOML scraping. We don't want a full TOML parser dependency just for
// this; the two things we need (a `[project.scripts]` table header + the
// presence of fastapi/uvicorn in a dependencies array) are easy to grep for.
function inferFromPyproject(raw: string): string {
  // 1. `[project.scripts]` block — take the first `name = ...` line below it.
  //    Stops at the next `[section]` header to avoid eating unrelated tables.
  const scriptsMatch = raw.match(/\[project\.scripts\]\s*\n([\s\S]*?)(\n\[|$)/);
  if (scriptsMatch && scriptsMatch[1]) {
    const body = scriptsMatch[1];
    const firstKey = body.match(/^\s*([a-zA-Z0-9_-]+)\s*=/m);
    if (firstKey && firstKey[1]) {
      return firstKey[1];
    }
  }
  // 2. FastAPI / uvicorn fingerprint — these are the most common Python web
  //    dev setups today. We don't try to be exhaustive (no Django, Flask
  //    detection in v1) because the operator can override.
  const haystack = raw.toLowerCase();
  if (haystack.includes("fastapi") || haystack.includes("uvicorn")) {
    return "uv run uvicorn main:app --reload";
  }
  // 3. Generic Python fallback.
  return "python main.py";
}

function inferGeneric(snap: WorkspaceSnapshot, pkg: Pkg | null): string | null {
  // Node-ish first — this is by far the most common scaffolded stack today
  // (the project scaffolder defaults to Next.js).
  const fromPkg = inferFromPackageJson(pkg);
  if (fromPkg) return fromPkg;
  if (snap.pyproject !== null) return inferFromPyproject(snap.pyproject);
  if (snap.cargoToml !== null) return "cargo run";
  if (snap.goMod !== null) return "go run .";
  return null;
}

// ─── step 1: platform refiners (evidence-gated) ────────────────────────────
//
// Each returns null when the workspace shows no evidence of that platform —
// which is what makes a mislabel harmless: we simply fall through to the
// generic chain.

function refineMobile(snap: WorkspaceSnapshot, pkg: Pkg | null): string | null {
  if (hasDep(pkg, "expo")) {
    // Expo's own scaffold ships `"start": "expo start"`, so honour it when
    // present rather than second-guessing the package manager wiring.
    return hasScript(pkg, "start") ? "pnpm start" : "pnpm expo start";
  }
  if (hasDep(pkg, "react-native")) {
    return hasScript(pkg, "start") ? "pnpm start" : "pnpm react-native start";
  }
  if (snap.pubspecYaml !== null) return "flutter run";
  return null;
}

function refineIos(snap: WorkspaceSnapshot, pkg: Pkg | null): string | null {
  // An RN/Expo app targeting iOS keeps the JS toolchain — `ios` is the
  // conventional script name (`expo run:ios` / `react-native run-ios`).
  if (hasScript(pkg, "ios")) return "pnpm ios";
  if (snap.packageSwift !== null) return "swift run";
  // Bare `xcodebuild` builds the sole project/workspace in cwd. iOS has no
  // long-running "dev server" in the web sense, so this is a build, and the
  // operator will often override it with a scheme-specific command. See the
  // whitespace constraint in the header — we cannot emit a quoted -destination.
  if (snap.hasXcodeProject) return "xcodebuild";
  return null;
}

function refineDesktop(snap: WorkspaceSnapshot, pkg: Pkg | null): string | null {
  if (snap.hasTauriDir || hasDep(pkg, "@tauri-apps/cli") || hasDep(pkg, "@tauri-apps/api")) {
    return "pnpm tauri dev";
  }
  if (hasDep(pkg, "electron")) {
    if (hasScript(pkg, "dev")) return "pnpm dev";
    if (hasScript(pkg, "start")) return "pnpm start";
    return "pnpm electron .";
  }
  return null;
}

function refineForPlatform(
  projectType: ProjectType,
  snap: WorkspaceSnapshot,
  pkg: Pkg | null,
): string | null {
  switch (projectType) {
    case "mobile":
      return refineMobile(snap, pkg);
    case "ios":
      return refineIos(snap, pkg);
    case "desktop":
      return refineDesktop(snap, pkg);
    case "web":
    case "other":
      // The generic chain already IS the web chain; `other` asserts nothing.
      return null;
  }
}

// ─── step 3: platform fallback (nothing on disk) ───────────────────────────

/**
 * The command to use when the workspace has nothing we can read — an empty or
 * not-yet-cloned repo. The label is the only signal available, so here (and
 * ONLY here) it decides alone. Exported for callers that start a session before
 * the clone lands, so they don't have to hardcode `pnpm dev`.
 */
export function fallbackDevCommand(projectType: ProjectType = DEFAULT_PROJECT_TYPE): string {
  switch (projectType) {
    case "mobile":
      // Expo/RN scaffolds converge on `start`.
      return "pnpm start";
    case "ios":
      return "pnpm ios";
    case "web":
    case "desktop":
    case "other":
      return FALLBACK;
  }
}

// ─── the pure decision ─────────────────────────────────────────────────────

export function decideDevCommand(
  snap: WorkspaceSnapshot,
  projectType: ProjectType = DEFAULT_PROJECT_TYPE,
): string {
  const pkg = parsePackageJson(snap.packageJson);
  return (
    refineForPlatform(projectType, snap, pkg) ??
    inferGeneric(snap, pkg) ??
    fallbackDevCommand(projectType)
  );
}

// ─── IO ────────────────────────────────────────────────────────────────────

async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function existsSafe(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Any `*.xcodeproj` / `*.xcworkspace` at the workspace root. */
async function hasXcodeProject(workspacePath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(workspacePath);
    return entries.some((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"));
  } catch {
    return false;
  }
}

export async function readWorkspaceSnapshot(workspacePath: string): Promise<WorkspaceSnapshot> {
  const at = (name: string) => path.join(workspacePath, name);
  const [packageJson, pyproject, cargoToml, goMod, pubspecYaml, packageSwift, xcode, tauri] =
    await Promise.all([
      readFileSafe(at("package.json")),
      readFileSafe(at("pyproject.toml")),
      readFileSafe(at("Cargo.toml")),
      readFileSafe(at("go.mod")),
      readFileSafe(at("pubspec.yaml")),
      readFileSafe(at("Package.swift")),
      hasXcodeProject(workspacePath),
      existsSafe(at("src-tauri")),
    ]);
  return {
    packageJson,
    pyproject,
    cargoToml,
    goMod,
    pubspecYaml,
    packageSwift,
    hasXcodeProject: xcode,
    hasTauriDir: tauri,
  };
}

/**
 * Canonical dev command for a workspace on disk. `projectType` coarsely steers
 * the guess; it never overrides real evidence, and a mislabel degrades to the
 * generic disk guess rather than breaking Run (see the header).
 */
export async function inferDevCommand(
  workspacePath: string,
  projectType: ProjectType = DEFAULT_PROJECT_TYPE,
): Promise<string> {
  const snap = await readWorkspaceSnapshot(workspacePath);
  return decideDevCommand(snap, projectType);
}
