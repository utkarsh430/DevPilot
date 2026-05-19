#!/usr/bin/env node
// Acceptance: the audit-PDF export's font registration works in the BUILT server.
//
// Why this exists as an accept script and not a Vitest test
// ────────────────────────────────────────────────────────
// The bug this guards against is a BUNDLER transform, so it exists only in
// `next build` output and is invisible to every test that imports source.
// `lib/export/__tests__/fonts.test.ts` builds its own
// `createRequire(import.meta.url)` resolver and hands it to the pure
// `registerExportFonts` — so it exercises a resolver that is correct by
// construction and never touches `fonts.server.ts`, the module that was broken.
// It passed green through the entire lifetime of the bug.
//
// What it actually asserts, against real `.next/server` output:
//   1. the compiled `ensureExportFonts` resolves every declared `@fontsource`
//      `.woff` to a real file on disk (the regression: it used to throw
//      `Cannot find module '…-700-normal.woff'` for every specifier), and
//   2. `@react-pdf/renderer` then draws a non-empty PDF whose bytes carry our
//      embedded faces — i.e. the resolved paths are genuinely loadable, not just
//      strings that happen to exist.
//
// Run:  pnpm --filter @devpilot/web build && node apps/web/scripts/export-fonts-accept.mjs
// (from the repo root, or anywhere — paths are derived from this file.)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import React from "react";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chunkDir = path.join(webRoot, ".next", "server", "chunks");
const require = createRequire(import.meta.url);

function fail(msg) {
  console.error(`\x1b[31mFAIL\x1b[0m  ${msg}`);
  process.exit(1);
}
function pass(msg) {
  console.log(`\x1b[32mok\x1b[0m    ${msg}`);
}

if (!fs.existsSync(chunkDir)) {
  fail(`no build output at ${chunkDir} — run \`pnpm --filter @devpilot/web build\` first`);
}

// ── 1. Find the compiled fonts.server.ts module in the emitted chunks ────────
// Module ids are generated, so locate the module by the thing only this module
// does: call `registerExportFonts` with a resolver. `FONT_SENTINEL` is the first
// declared specifier, which webpack keeps as a string literal in the chunk that
// carries the pure `fonts.ts`; the server wrapper is the module that references
// the registrar. We find the wrapper by scanning for a module whose body calls a
// `.resolve(` on a variable, in a chunk that also carries the sentinel.
const FONT_SENTINEL =
  "@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff";

/** Node builtins are emitted as `<id>: a => { a.exports = require("node:x") }` in route bundles. */
function collectExternals() {
  const out = {};
  const appDir = path.join(webRoot, ".next", "server", "app");
  const stack = [appDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".js")) {
        const src = fs.readFileSync(p, "utf8");
        for (const m of src.matchAll(
          /(\d+):\s*\w\s*=>\s*\{\s*\w\.exports\s*=\s*require\("([^"]+)"\)\s*\}/g,
        )) {
          out[m[1]] ??= m[2];
        }
      }
    }
  }
  return out;
}

const externals = collectExternals();

/** Load one emitted chunk and run `moduleId` through a minimal webpack runtime. */
function loadChunkModule(chunkFile, moduleId) {
  const chunk = require(chunkFile);
  const cache = {};
  const req = (id) => {
    if (cache[id]) return cache[id].exports;
    const m = (cache[id] = { exports: {} });
    if (chunk.modules?.[id]) chunk.modules[id](m, m.exports, req);
    else if (externals[id]) m.exports = require(externals[id]);
    else throw new Error(`module ${id} not in ${path.basename(chunkFile)} and not an external`);
    return m.exports;
  };
  req.d = (e, defs) => {
    for (const k in defs) {
      if (!Object.prototype.hasOwnProperty.call(e, k)) {
        Object.defineProperty(e, k, { enumerable: true, get: defs[k] });
      }
    }
  };
  req.r = (e) => Object.defineProperty(e, "__esModule", { value: true });
  req.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  req.n = (m) => {
    const g = m && m.__esModule ? () => m.default : () => m;
    req.d(g, { a: g });
    return g;
  };
  return req(moduleId);
}

/**
 * Every (chunk, moduleId) that looks like the compiled fonts.server.ts.
 *
 * Matched by SHAPE, not by name: minification renames everything, so we look for
 * a module that calls some imported function with `(registrar, x => <r>.resolve(x))`
 * — which is `registerExportFonts(Font, specifier => nodeRequire.resolve(specifier))`
 * and nothing else in the tree.
 */
// The resolver expression must be allowed to contain parens: the BROKEN build
// emitted `a=>c(38653).resolve(a)` (webpack's throwing stub), the fixed one emits
// `a=>e.resolve(a)`. This script has to match BOTH — its whole job is to load the
// broken shape and report the real error, not to shrug and say "shape changed".
const RESOLVER_CALL_RE = /\(0,\w+\.\w+\)\(\w+,\w+=>[\w.()]{0,40}\.resolve\(\w+\)\)/;

function findFontServerModules() {
  const hits = [];
  for (const file of fs.readdirSync(chunkDir).filter((f) => f.endsWith(".js"))) {
    const full = path.join(chunkDir, file);
    const src = fs.readFileSync(full, "utf8");
    if (!src.includes(FONT_SENTINEL)) continue;
    // Bound each module's body at the NEXT module's start rather than by a fixed
    // window. A fixed window bleeds: adjacent small modules let one module's
    // slice reach into its neighbour's body and match the neighbour's resolver
    // call, so the script picks an innocent module and then reports the
    // shipped-bug signature for it. That is a false alarm on the one script
    // whose whole job is to tell a real font break from a shape change — and it
    // fires only when module sizes shift, i.e. when an unrelated file is added.
    const starts = [...src.matchAll(/(\d+):\((\w+),(\w+),(\w+)\)=>\{/g)];
    for (const [i, m] of starts.entries()) {
      const end = starts[i + 1]?.index ?? src.length;
      if (RESOLVER_CALL_RE.test(src.slice(m.index, end))) hits.push({ file: full, id: m[1] });
    }
  }
  return hits;
}

const candidates = findFontServerModules();
if (candidates.length === 0) {
  fail(
    "could not find the compiled fonts.server.ts in .next/server/chunks — " +
      "the emitted shape changed; update this script rather than deleting it",
  );
}

// ── 2. Tie the candidates to the two REAL export entry points ────────────────
// webpack emits a copy of the module per chunk group, so "some copy works" is not
// the claim we want — the claim is that the copy each export route actually loads
// works. Both entry points are checked: the synchronous ticket download and the
// Inngest worker that renders the project scope.
const ENTRY_ROUTES = {
  "ticket export (GET /api/board/tickets/[id]/export)": "app/api/board/tickets/[id]/export",
  "project export (Inngest render job, /api/inngest)": "app/api/inngest",
};

/** Chunk files listed in a route's file-trace manifest. */
function tracedChunks(routeDir) {
  const nft = path.join(webRoot, ".next", "server", routeDir, "route.js.nft.json");
  if (!fs.existsSync(nft)) fail(`no trace manifest for ${routeDir} — did the build change?`);
  const base = path.dirname(nft);
  return new Set(
    JSON.parse(fs.readFileSync(nft, "utf8"))
      .files.map((f) => path.resolve(base, f))
      .filter((f) => f.startsWith(chunkDir) && f.endsWith(".js")),
  );
}

// Both entry points may share one compiled copy (they do today: chunk 2341).
// Exercise each copy ONCE, but remember every route that loads it, so the output
// reports real coverage instead of whichever route happened to be checked last.
const toExercise = new Map(); // chunkFile|id -> { file, id, labels: string[] }
for (const [label, routeDir] of Object.entries(ENTRY_ROUTES)) {
  const chunks = tracedChunks(routeDir);
  const mine = candidates.filter((c) => chunks.has(c.file));
  if (mine.length === 0) {
    fail(
      `${label} does not load any compiled fonts.server.ts chunk.\n      ` +
        "Either the route no longer reaches the PDF renderer, or chunking changed.",
    );
  }
  for (const c of mine) {
    const key = `${c.file}|${c.id}`;
    const entry = toExercise.get(key) ?? { ...c, labels: [] };
    entry.labels.push(label);
    toExercise.set(key, entry);
  }
}

// ── 3. Run each compiled ensureExportFonts and capture what it registered ────
let registered = null;
for (const c of toExercise.values()) {
  let captured = [];
  try {
    const mod = loadChunkModule(c.file, c.id);
    const ensure = Object.values(mod).find((v) => typeof v === "function" && v.length === 1);
    if (typeof ensure !== "function")
      throw new Error("no ensureExportFonts export found in module");
    ensure({ register: (args) => captured.push(args), registerHyphenationCallback: () => {} });
  } catch (e) {
    fail(
      `${c.labels.join(" + ")}: compiled ensureExportFonts THREW.\n      ` +
        `${path.basename(c.file)} module ${c.id}: ${e.code ?? ""} ${e.message}\n\n` +
        "      This is the shipped-bug signature. `Cannot find module '@fontsource/…woff'`\n" +
        "      means webpack replaced the module's resolver with its throwing\n" +
        "      missing-module stub — see the comment in lib/export/fonts.server.ts.",
    );
  }
  if (captured.length === 0) {
    fail(`${c.labels.join(" + ")}: compiled ensureExportFonts registered no font`);
  }
  pass(
    `${path.basename(c.file)} module ${c.id} registered ${captured.length} families\n      ` +
      `loaded by: ${c.labels.join("\n                 ")}`,
  );
  registered = captured;
}

// ── 3. Every resolved src must be a real, non-empty .woff on disk ────────────
const srcs = registered.flatMap((r) => r.fonts.map((f) => f.src));
if (srcs.length < 8) fail(`expected 8 registered faces, got ${srcs.length}`);
for (const src of srcs) {
  if (!path.isAbsolute(src)) fail(`registered src is not an absolute path: ${src}`);
  if (!src.endsWith(".woff"))
    fail(`registered src is not a .woff (woff2 is broken in react-pdf): ${src}`);
  if (!fs.existsSync(src)) fail(`registered src does not exist on disk: ${src}`);
  if (fs.statSync(src).size === 0) fail(`registered src is empty: ${src}`);
}
pass(`all ${srcs.length} faces resolved to real .woff files on disk`);

// ── 4. Actually draw a PDF with them ─────────────────────────────────────────
// Resolution succeeding is necessary but not sufficient: the paths must be
// loadable by fontkit and embeddable by pdfkit. Draw text in each family.
// Named exports, exactly as `lib/export/render.server.ts` consumes them.
const pdfMod = await import(
  pathToFileURL(require.resolve("@react-pdf/renderer", { paths: [webRoot] })).href
);
const { Document, Font, Page, Text, renderToBuffer } = pdfMod;

for (const r of registered) Font.register(r);
Font.registerHyphenationCallback((w) => [w]);

const families = [...new Set(registered.map((r) => r.family))];
const buf = await renderToBuffer(
  React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A4" },
      ...families.flatMap((family) => [
        React.createElement(
          Text,
          { key: `${family}-a`, style: { fontFamily: family, fontSize: 11 } },
          `${family} — DevPilot audit export https://github.com/utkarsh430/DevPilot`,
        ),
        React.createElement(
          Text,
          { key: `${family}-b`, style: { fontFamily: family, fontSize: 11, fontWeight: 700 } },
          `${family} bold — const x = () => 1; pnpm test -- --coverage`,
        ),
      ]),
    ),
  ),
);

if (!Buffer.isBuffer(buf) || buf.length < 1000)
  fail(`rendered PDF is empty or absurdly small (${buf?.length} bytes)`);
if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") fail("rendered bytes are not a PDF");

// The embedded font names appear in the PDF's font descriptors. If registration
// had silently fallen back to Helvetica, none of these would be present.
const asText = buf.toString("latin1");
for (const family of families) {
  if (!asText.includes(family.replace(/\s/g, ""))) {
    fail(`family ${family} is not embedded in the rendered PDF (silent Helvetica fallback?)`);
  }
}
pass(
  `rendered a ${buf.length}-byte PDF with ${families.length} embedded families: ${families.join(", ")}`,
);

console.log("\n\x1b[32mexport fonts accept: PASS\x1b[0m");
