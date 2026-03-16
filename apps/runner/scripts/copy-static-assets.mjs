#!/usr/bin/env node
// Copies build-time assets that `tsc` does not emit into `dist/`.
//
// `apps/runner`'s build is a plain `tsc -p tsconfig.json` compile. `tsc` only
// emits `.ts`/`.tsx` -> `.js` (plus `.js.map`); any other file under `src/` is
// silently skipped — not copied, and no error or warning either. That makes
// every non-TS asset under `src/` invisible to the build unless something
// else copies it, and until this script existed nothing did.
//
// `src/agents/*.md` is exactly such a file: the bundled, read-only Claude
// Code subagent definitions (`explorer.md`, `researcher.md`) that
// `agents-bundle.ts` installs into a workspace's `.claude/agents/` so a
// `claude -p` step can fan out parallel read-only work. `agents-bundle.ts`
// resolves them at RUNTIME as `path.resolve(__dirname, "agents")` — which,
// in the compiled build, is `dist/agents/`. Every `pnpm build` therefore
// shipped a runner whose `dist/agents/` never existed; `installSubagentsIntoWorkspace`
// caught the resulting ENOENT and warned (non-fatal by design, so a missing
// bundle never blocks a step) — which is exactly why nobody noticed the
// bundle was never installed anywhere, ever.
//
// This script is the fix: it runs AFTER `tsc` (see the `build` script in
// package.json) and copies each source asset directory into its matching
// `dist/` location, so the runtime contract `agents-bundle.ts` already
// relies on (resolve relative to the compiled module's own directory — the
// same contract `claude.ts`'s `MCP_SERVER_SOURCE` uses, which already works
// in both dev and prod) is actually satisfied by the build.
//
// Node built-ins only (`fs.cpSync`, available since Node 16.7) — no new
// dependency for a file copy, and no shell `cp` (its `-R` flag differs
// subtly between BSD/macOS and GNU/Linux around trailing slashes).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/** Directories under `src/` that hold non-TS runtime assets and must be
 *  mirrored into `dist/` after every build. Add an entry here — and a
 *  regression test — the moment a new one shows up. */
const ASSET_DIRS = [
  { src: path.join(ROOT, "src", "agents"), dest: path.join(ROOT, "dist", "agents") },
];

for (const { src, dest } of ASSET_DIRS) {
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[copy-static-assets] ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dest)}`);
}
