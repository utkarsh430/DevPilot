// The brand bitmaps for the PDF chrome, read from `public/brand/` at render time.
//
// Same resolution rule as the guide figures (`guide-figures.server.ts`):
// `process.cwd()` is `apps/web` in dev and the traced app root in a Next lambda,
// which is where `public/` lives in both. `next.config.ts` lists
// `./public/brand/*.png` under `outputFileTracingIncludes` for every route that
// renders a PDF, so the files travel with the lambda.
//
// TOTAL, never throws: a missing or unreadable file yields `null`, and the
// chrome falls back to a text wordmark. An export that fails to render because
// the logo could not be read would be a worse product than one with a plain
// wordmark in the corner.
//
// No `server-only` marker on purpose: the PDF documents are rendered under
// Vitest (`lib/export/__tests__/*render*.test.ts`), and a marker would make the
// chrome unloadable there — which is exactly the gap this repo's export bugs
// have lived in.

import { readFileSync } from "node:fs";
import path from "node:path";

const FILES = {
  /** Square chevron-and-arrow mark, 512×512. */
  mark: { file: "devpilot-mark.png", width: 512, height: 512 },
  /** Mark + wordmark lockup, 1400×358. */
  logo: { file: "devpilot-logo.png", width: 1400, height: 358 },
} as const;

export type BrandAssetKind = keyof typeof FILES;

/** react-pdf's inline image source shape. */
export type BrandAssetSource = { data: Buffer; format: "png" };

const cache = new Map<BrandAssetKind, BrandAssetSource | null>();

function brandDir(): string {
  return path.join(process.cwd(), "public", "brand");
}

/** Bytes for one brand asset, cached for the process; `null` if unreadable. */
export function brandAsset(kind: BrandAssetKind): BrandAssetSource | null {
  if (cache.has(kind)) return cache.get(kind) ?? null;
  let source: BrandAssetSource | null = null;
  try {
    source = { data: readFileSync(path.join(brandDir(), FILES[kind].file)), format: "png" };
  } catch {
    source = null;
  }
  cache.set(kind, source);
  return source;
}

/** Width/height of an asset box at a given height, preserving its aspect. */
export function brandAssetBox(
  kind: BrandAssetKind,
  height: number,
): { width: number; height: number } {
  const { width, height: h } = FILES[kind];
  return { width: (height * width) / h, height };
}
