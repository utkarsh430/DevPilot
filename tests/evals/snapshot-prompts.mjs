#!/usr/bin/env node
// Phase 1 / M12 — snapshot each role's `systemPrompt` to a text file under
// `tests/evals/snapshots/`. The per-role Promptfoo yamls reference these
// snapshots via `file://...` so:
//   1. A prompt edit shows up as BOTH a TypeScript diff (the role file) AND
//      a snapshot diff (caught by CI).
//   2. Promptfoo runs against a frozen prompt body — eval results are
//      reproducible even if the TypeScript module is mid-refactor.
//
// Usage:
//   node --import tsx tests/evals/snapshot-prompts.mjs            # write
//   node --import tsx tests/evals/snapshot-prompts.mjs --check    # verify
//
// `--check` exits non-zero if any snapshot is missing or stale. Used by the
// `tests/evals/run-acceptance.mjs` acceptance script and by CI.
//
// How the role list is derived (this used to be a hand-maintained list, and
// the drift it caused is exactly why it isn't one any more)
// ─────────────────────────────────────────────────────────────────────────
// The previous version of this file carried a comment claiming it imported
// "the live ROLES map … with no risk of drift" while actually snapshotting a
// hardcoded object of 11 roles. It had drifted: 42 of the 53 roles in
// `lib/roles/index.ts` had no snapshot at all, including `backend_engineer`
// and the ~13KB `project_scaffolder` prompt that makes a project's whole
// stack decision. A prompt edit to any of them was invisible to CI.
//
// We cannot simply `import { ROLES } from ".../index.ts"`: `index.ts` imports
// every role through the `@/lib/...` tsconfig path alias, and this script runs
// under bare `node --import tsx` from the repo root, where tsx resolves no
// `apps/web` tsconfig and the alias fails to resolve.
//
// So we derive the list from `index.ts` as the source of truth *statically*:
// parse its import statements and its `ROLES` map body, then dynamically
// import each role module by a plain relative path (every role file's only
// imports are `import type`, so each is loadable standalone). Adding a role
// to `index.ts` now adds its snapshot automatically — nobody has to remember
// this file exists.
//
// Any parse failure or unresolvable entry is FATAL rather than skipped. A
// silently-shorter role list is the precise failure mode this replaced.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const SNAPSHOT_DIR = join(__dirname, "snapshots");
const ROLES_DIR = resolve(REPO_ROOT, "apps/web/lib/roles");
const INDEX_PATH = join(ROLES_DIR, "index.ts");

// Roles that are NOT in `ROLES` but still carry a snapshot + eval.
//
// `supervisor` is defined in `lib/roles/supervisor.ts` and casts its slug at
// the union boundary (`role: "supervisor" as RoleConfig["role"]`); it is not
// a member of the `Role` union and is not registered in the `ROLES` map, so
// the index parse below cannot see it. It has a committed
// `supervisor.eval.yaml`, so dropping its snapshot would break that eval.
// Keep this list empty unless a role genuinely lives outside `ROLES`.
const EXTRA_ROLES = {
  supervisor: { module: "supervisor", exportName: "supervisorRole" },
};

// A floor, not a pin: guards against a regex that silently matches nothing
// after an `index.ts` refactor. Bump it only downward-consciously.
const MIN_EXPECTED_ROLES = 50;

function fatal(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

/**
 * Parse `lib/roles/index.ts` into `{ slug: { module, exportName } }`.
 *
 * Reads two things out of the file:
 *   - `import { xRole } from "@/lib/roles/<module>";`  → exportName → module
 *   - the `ROLES` map body: `  <slug>: xRole,`         → slug → exportName
 */
function parseRoleIndex(source) {
  const importedFrom = new Map();
  for (const m of source.matchAll(
    /^import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*"@\/lib\/roles\/([A-Za-z0-9_]+)";$/gm,
  )) {
    importedFrom.set(m[1], m[2]);
  }
  if (importedFrom.size === 0) {
    fatal(`could not parse any role imports out of ${INDEX_PATH}`);
  }

  const mapBody = source.match(/export const ROLES[^{]*\{([\s\S]*?)\n\};/);
  if (!mapBody) {
    fatal(`could not locate the \`export const ROLES = { … };\` map in ${INDEX_PATH}`);
  }

  const roles = {};
  for (const m of mapBody[1].matchAll(/^\s*([a-z0-9_]+):\s*([A-Za-z0-9_]+),\s*$/gm)) {
    const [, slug, exportName] = m;
    const module = importedFrom.get(exportName);
    if (!module) {
      fatal(
        `ROLES entry "${slug}: ${exportName}" has no matching import in ${INDEX_PATH}. ` +
          `Either the import shape changed or the role is imported indirectly; this script ` +
          `must not silently skip it.`,
      );
    }
    roles[slug] = { module, exportName };
  }
  return roles;
}

const indexSource = readFileSync(INDEX_PATH, "utf8");
const ROLE_SOURCES = { ...parseRoleIndex(indexSource), ...EXTRA_ROLES };

const roleCount = Object.keys(ROLE_SOURCES).length;
if (roleCount < MIN_EXPECTED_ROLES) {
  fatal(
    `only ${roleCount} role(s) resolved from ${INDEX_PATH} (expected at least ` +
      `${MIN_EXPECTED_ROLES}). The index parse has almost certainly broken — refusing to ` +
      `rewrite snapshots against a truncated list.`,
  );
}

// Load each role module by relative path (bypassing the `@/` alias) and pull
// its named export.
const ROLES = {};
for (const [slug, { module, exportName }] of Object.entries(ROLE_SOURCES)) {
  const modPath = join(ROLES_DIR, `${module}.ts`);
  if (!existsSync(modPath)) fatal(`${slug}: role module not found at ${modPath}`);
  let mod;
  try {
    mod = await import(modPath);
  } catch (err) {
    fatal(`${slug}: failed to import ${modPath} — ${err?.message ?? err}`);
  }
  const role = mod[exportName];
  if (!role) {
    fatal(`${slug}: ${modPath} has no export named "${exportName}"`);
  }
  ROLES[slug] = role;
}

const args = new Set(process.argv.slice(2));
const checkMode = args.has("--check");

mkdirSync(SNAPSHOT_DIR, { recursive: true });

let stale = 0;
let written = 0;

/**
 * Phase 4 — three snapshots per split role, one per unsplit role.
 *
 *   <slug>.system.txt  the COMPOSED base: style + the fenced safety contract.
 *                      This is what a run actually receives and what the
 *                      Promptfoo yamls consume via `file://…`, so it is written
 *                      for every role and its bytes are unchanged for any role
 *                      with no `safetyContract` — which is what makes the no-op
 *                      case provable from the committed files alone.
 *   <slug>.style.txt   the style half, verbatim.   } written ONLY when the role
 *   <slug>.safety.txt  the safety half, verbatim.  } has been split.
 *
 * The two component files are what make a diff reviewable. `system.txt` mixes
 * both halves by construction, so on its own it cannot answer "did this PR
 * change a safety rule or just reword some guidance" — the question a reviewer
 * most needs answered. With the components committed, a style edit leaves
 * `safety.txt` untouched and a safety edit leaves `style.txt` untouched, and
 * that is visible in `git diff --stat` before anyone reads a line.
 *
 * Kept in lockstep with `applySafetyContract` in
 * `apps/web/lib/roles/safety-contract.ts` — the module is imported rather than
 * reimplemented here, so the snapshot cannot drift from what dispatch composes.
 */
const { applySafetyContract } = await import(join(ROLES_DIR, "safety-contract.ts"));

function snapshot(filePath, body) {
  if (checkMode) {
    if (!existsSync(filePath)) {
      console.error(`✗ snapshot missing: ${filePath}`);
      stale++;
      return;
    }
    if (readFileSync(filePath, "utf8") !== body) {
      console.error(
        `✗ snapshot stale: ${filePath} (run \`node --import tsx tests/evals/snapshot-prompts.mjs\`)`,
      );
      stale++;
    }
  } else {
    writeFileSync(filePath, body, "utf8");
    written++;
  }
}

for (const [slug, role] of Object.entries(ROLES)) {
  const style = role.systemPrompt;
  if (typeof style !== "string" || style.length === 0) {
    console.error(`✗ ${slug}: systemPrompt is empty or non-string`);
    process.exit(2);
  }
  const contract = role.safetyContract;
  if (contract !== undefined && (typeof contract !== "string" || contract.trim().length === 0)) {
    // An empty-string contract is the same as none, but writing one is almost
    // certainly a half-finished split rather than an intention — fail loudly
    // rather than silently snapshotting it as unsplit.
    console.error(
      `✗ ${slug}: safetyContract is present but empty. Omit the field entirely for an ` +
        `unsplit role, or give it content.`,
    );
    process.exit(2);
  }

  snapshot(join(SNAPSHOT_DIR, `${slug}.system.txt`), applySafetyContract(style, contract));
  if (contract) {
    snapshot(join(SNAPSHOT_DIR, `${slug}.style.txt`), style);
    snapshot(join(SNAPSHOT_DIR, `${slug}.safety.txt`), contract);
  }
}

if (checkMode) {
  if (stale > 0) {
    console.error(`\n${stale} snapshot(s) stale or missing.`);
    process.exit(1);
  }
  console.log(`✓ all ${Object.keys(ROLES).length} role snapshots up to date`);
} else {
  console.log(`✓ wrote ${written} snapshot(s) to ${SNAPSHOT_DIR}`);
}
