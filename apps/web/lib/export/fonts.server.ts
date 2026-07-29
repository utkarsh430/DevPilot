import "server-only";

// The IO half of font registration: supplies the REAL react-pdf `Font` store and
// a real module resolver to the pure `registerExportFonts`.
//
// The font files are package ASSETS, so we need their absolute on-disk path, not
// an import of their bytes: react-pdf's `Font.register` accepts a local file
// path, a data URL or an http URL — never a Buffer. That makes a resolver call
// at runtime unavoidable.
//
// ── Why `__non_webpack_require__` and NOT `createRequire` ────────────────────
// This is the fix for a shipped bug: the first real export 500'd with
// `Cannot find module '@fontsource/bricolage-grotesque/…-700-normal.woff'`
// while that file sat on disk, correctly resolvable, the whole time.
//
// `createRequire(import.meta.url).resolve(spec)` works under Vitest and dies in
// the BUILT server. webpack's parser recognises `createRequire()` and replaces
// the returned require with one of ITS OWN — here, because the specifier is a
// variable it cannot analyse, with the "missing module" stub:
//
//     38653: a => { function b(a) { var b = Error("Cannot find module '"+a+"'");
//                                   throw b.code = "MODULE_NOT_FOUND", b }
//                   b.keys = () => [], b.resolve = b, ... }
//
// `b.resolve === b`, so `nodeRequire.resolve(x)` compiles to `c(38653).resolve(x)`
// — a function that throws MODULE_NOT_FOUND for EVERY input. Nothing is ever
// resolved; the message names our specifier only because the stub echoes back its
// own argument. The file existing on disk was never relevant.
//
// Critically, webpack does this for ANY argument: `createRequire(import.meta.url)`,
// `createRequire(<cwd path>)` and `createRequire(<__dirname path>)` all compile to
// the same stub, with the anchor expression discarded WITHOUT being evaluated
// (verified by probing all three in real build output). So "anchor it somewhere
// more stable" cannot work. Neither can `serverExternalPackages`: that governs how
// IMPORTS of a package are emitted, and nothing here imports `@fontsource/*`.
// The only fix is to stop asking webpack for a require at all.
//
// `__non_webpack_require__` is webpack's documented escape hatch — it compiles to
// the real Node `require` of the emitted chunk, resolving from
// `.next/server/chunks/` and walking up to `apps/web/node_modules`, which is
// exactly where pnpm links `@fontsource/*`. `scripts/export-fonts-accept.mjs`
// proves this against real `next build` output; do not "simplify" this back to
// `createRequire` without running it.
//
// The `createRequire` fallback covers runtimes where the identifier does not
// exist (Turbopack, plain ESM). It is unreachable under webpack, and `typeof` on
// an undeclared identifier is safe everywhere, so a non-webpack bundler degrades
// to today's behaviour instead of throwing a ReferenceError.
//
// The `.woff` assets still have to SHIP: Next's tracer follows imports, not
// runtime resolution, so `outputFileTracingIncludes` in `next.config.ts` is what
// puts them in the lambda.

import { createRequire } from "node:module";
import { registerExportFonts, type FontRegistrar } from "@/lib/export/fonts";

/** webpack replaces this identifier with the chunk's real Node `require`. */
declare const __non_webpack_require__: NodeRequire | undefined;

const nodeRequire: NodeRequire =
  typeof __non_webpack_require__ !== "undefined"
    ? __non_webpack_require__
    : createRequire(import.meta.url);

/**
 * Register the brand faces onto react-pdf's global font store. Idempotent (the
 * pure helper guards), so callers may call it on every render.
 */
export function ensureExportFonts(Font: FontRegistrar): void {
  registerExportFonts(Font, (specifier) => nodeRequire.resolve(specifier));
}
