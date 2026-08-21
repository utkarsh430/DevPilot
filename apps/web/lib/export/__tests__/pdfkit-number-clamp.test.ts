// The vendored pdfkit clamp: an out-of-range number must DEGRADE, not throw.
//
// This is the guard for the crash the whole change exists to fix. pdfkit's
// `PDFObject.number` throws `unsupported number: <n>` for anything outside
// (-1e21, 1e21) — NaN and ±Infinity fail that range test too — and that throw
// aborted the entire export, for both scopes.
//
// Why the fix is in the library and not in our components
// ──────────────────────────────────────────────────────
// The value that took prod down, -2.996737976248788e+21, is float32-EXACT. Our
// code is float64 throughout; react-pdf's layout engine (Yoga) stores boxes in
// float32. So the number came back OUT of layout — it is not a number any of
// our components computed, and every numeric our components do pass to react-pdf
// is a literal or already clamped. No caller-side validation can catch it. The
// only place that covers a number the LIBRARY computes is the library's own last
// mile, hence `patches/@react-pdf__pdfkit@5.1.1.patch`.
//
// Why this test drives pdfkit directly rather than rendering a document
// ────────────────────────────────────────────────────────────────────
// It was first written as "render a <View style={{width: <bad>}}> and assert a
// PDF still comes out". That version passed — and was VACUOUS. Yoga sanitises
// every style value it is handed (a NaN width becomes `auto`, an out-of-range
// one is absorbed in the float32 store), so the bad number never reached pdfkit
// and the clamp never ran. The test would have passed identically with the patch
// deleted, which is the worst kind of green.
//
// `doc.ref({...}).end()` is the honest path: a PDF dictionary value goes through
// `PDFObject.convert` → `PDFObject.number` with nothing in between. Unpatched,
// the `ref.end()` below throws `unsupported number`. That also means this test
// fails if the patch is dropped, if `patchedDependencies` is removed from
// package.json, or if a version bump silently resolves an unpatched copy — each
// of which would look fine until a real export died.

import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Resolve the SAME `@react-pdf/pdfkit` the renderer actually loads.
 *
 * It is a transitive dependency, so under pnpm's strict layout it is not
 * resolvable from `apps/web` — asking for it from here is a MODULE_NOT_FOUND.
 * Walking the real consumer chain (renderer → render → pdfkit) is also the only
 * way to be sure we are asserting against the copy that renders our exports,
 * rather than some other hoisted instance that happens to be reachable.
 */
function resolvePdfkit(): string {
  const req = createRequire(import.meta.url);
  const renderer = req.resolve("@react-pdf/renderer");
  const render = createRequire(renderer).resolve("@react-pdf/render");
  return createRequire(render).resolve("@react-pdf/pdfkit");
}

/** Values pdfkit refuses: each fails `n > -1e21 && n < 1e21`. */
const UNDRAWABLE: ReadonlyArray<readonly [string, number]> = [
  ["the exact prod value", -2.996737976248788e21],
  ["positive overflow", 1e30],
  ["negative overflow", -3e21],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["NaN", NaN],
];

type PdfDoc = { pipe: (s: PassThrough) => void; ref: (d: object) => { end: () => void } };

async function newDoc(): Promise<PdfDoc> {
  const mod = (await import(resolvePdfkit())) as { default: new (o: object) => PdfDoc };
  const doc = new mod.default({ compress: false });
  doc.pipe(new PassThrough());
  return doc;
}

/** Write `n` as a dictionary value — the shortest real path to PDFObject.number. */
async function writeNumber(n: number): Promise<void> {
  const doc = await newDoc();
  doc.ref({ DevPilotProbe: n }).end();
}

describe("pdfkit number clamp (vendored patch)", () => {
  beforeEach(() => {
    // The patch logs every coercion on purpose — a silent clamp would hide the
    // upstream bug that produced the value. Silence it so the suite output stays
    // readable, but assert below that it fires: that log is the diagnostic that
    // pins the Yoga origin from a real render.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the patched copy that the renderer itself uses", () => {
    // pnpm encodes the patch in the store path, so this is a direct check that
    // `patchedDependencies` is wired and applied — not merely that a patch file
    // exists on disk.
    expect(resolvePdfkit()).toContain("patch_hash=");
  });

  for (const [label, value] of UNDRAWABLE) {
    it(`writes ${label} (${value}) without throwing`, async () => {
      // Unpatched this rejects with `unsupported number: <value>`.
      await expect(writeNumber(value)).resolves.toBeUndefined();
    }, 20_000);
  }

  it("reports each coercion rather than swallowing it", async () => {
    await writeNumber(-2.996737976248788e21);
    const calls = vi.mocked(console.error).mock.calls;
    expect(calls.some((args) => String(args[0]).includes("out-of-range number coerced to 0"))).toBe(
      true,
    );
  }, 20_000);

  it("leaves a drawable number completely alone", async () => {
    // The clamp must be inert for every value that always worked.
    await expect(writeNumber(120.5)).resolves.toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  }, 20_000);
});
