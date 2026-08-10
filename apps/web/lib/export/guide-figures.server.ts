import "server-only";

// Read the guide's committed PNGs off disk, once per render.
//
// ── Why disk and not a bucket ───────────────────────────────────────────────
//
// One copy, two readers: the web `<img>` serves `public/guide/*` as a static
// asset and the manual reads the same bytes. A Supabase bucket was rejected —
// every bucket here keys RLS on a tenant-id first path segment and a guide image
// has no tenant, and it would give the manual a network dependency, which
// `images.server.ts` opens by rejecting: "an audit artifact that reaches back to
// a 5-minute signed URL at view time is not a record — it is a viewer that stops
// working." A manual is even more clearly that.
//
// ── THE DEPLOY TRAP, and it is not hypothetical ─────────────────────────────
//
// `readFile` is a RUNTIME resolution. Next's file tracer follows IMPORTS, so
// nothing about this module tells it these PNGs are needed, and the deployed
// lambda ships without them — working perfectly on every developer machine and
// producing a manual full of placeholders on the first deploy. That is the exact
// class of bug documented at length in `next.config.ts` (the fonts one, which
// shipped fatally), which is why `outputFileTracingIncludes["/api/guide/manual"]`
// lists `./public/guide/*` alongside the font glob, and why the ONLY check that
// can see this is `scripts/guide-manual-accept.mjs` running against a real
// build. No source-level test can catch it.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GuideFigure } from "@/lib/guide/blocks";
import {
  isSafeFigureFilename,
  resolveFigureBytes,
  unavailable,
  type ResolvedGuideFigure,
} from "@/lib/export/guide-figures";

/**
 * Where the committed captures live, relative to the app root.
 *
 * `process.cwd()` is `apps/web` in dev and the traced app root in a Next lambda,
 * which is the same place `public/` is served from in both — the property that
 * makes one path work in both environments.
 */
function figureDir(): string {
  return path.join(process.cwd(), "public", "guide");
}

/**
 * Resolve every figure to bytes, concurrently.
 *
 * TOTAL: one entry per input figure, always. A read that fails for any reason —
 * the file was never captured, the tracer dropped it, the disk is unhappy —
 * becomes a placeholder carrying the reason, never a rejected promise. A manual
 * that fails to render because one screenshot is missing would be a worse
 * product than one that says which screenshot is missing.
 */
export async function resolveGuideFigures(
  figures: readonly GuideFigure[],
): Promise<Map<string, ResolvedGuideFigure>> {
  const entries = await Promise.all(
    figures.map(async (figure): Promise<[string, ResolvedGuideFigure]> => {
      if (!isSafeFigureFilename(figure.file)) {
        return [figure.id, unavailable(figure, `"${figure.file}" is not a valid figure filename`)];
      }
      try {
        const bytes = await readFile(path.join(figureDir(), figure.file));
        return [figure.id, resolveFigureBytes(figure, bytes)];
      } catch {
        // Deliberately not distinguishing ENOENT from anything else in the
        // reader-facing text: to a reader "the file is not there" and "the file
        // could not be read" are the same fact, and naming an errno tells them
        // nothing they can use. The tracing case is the one that matters and it
        // is caught by the accept script, not by a reader.
        return [
          figure.id,
          unavailable(figure, `${figure.file} could not be read from the guide asset directory`),
        ];
      }
    }),
  );
  return new Map(entries);
}
