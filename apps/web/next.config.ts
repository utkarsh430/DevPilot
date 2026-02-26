import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // node-pty is a native addon (ships a `.node` binding). Webpack must NOT
  // bundle it server-side — let Next resolve it from node_modules at runtime
  // so the binding actually loads. Track 3's /api/runs/[id]/attach SSE route
  // depends on this; without the externalisation the GET 500s silently
  // (the `import("node-pty")` resolves to a webpack chunk that can't find
  // the `.node` binding).
  // node-pty (above) plus the document-seed text extractors: `mammoth` (docx)
  // and `unpdf` (pdf — bundles pdf.js). Both are server-only, heavy, and node-
  // oriented; let Next resolve them from node_modules at runtime rather than
  // pulling pdf.js / mammoth's deps into the server bundle. They are reached
  // only from `lib/projects/doc-extract.server.ts` (dynamic import).
  //
  // `@react-pdf/renderer` joins them for the same reason: it is the audit-export
  // PDF runtime (pdfkit + fontkit + a layout engine), server-only, and reached
  // exclusively through a dynamic import in `lib/export/render.server.ts`.
  serverExternalPackages: ["node-pty", "mammoth", "unpdf", "@react-pdf/renderer"],

  // NOTE — there used to be an `ignoreWarnings` entry here silencing webpack's
  // `Critical dependency: the request of a dependency is an expression` for
  // `lib/export/fonts.server.ts`. That warning was NOT inert, and suppressing it
  // is how a fatally broken export shipped: it was webpack announcing that it had
  // taken the module's `createRequire()` over and, being unable to analyse the
  // specifier, wired it to a stub that throws MODULE_NOT_FOUND for every input.
  // `fonts.server.ts` now resolves through `__non_webpack_require__` (see the long
  // comment there), which creates no webpack dependency and so emits no warning —
  // meaning the suppression is unnecessary AND, if this warning ever returns, it
  // is once again a real signal that must be read rather than silenced.

  // The export registers its brand faces by resolving `@fontsource/*` `.woff`
  // files at RUNTIME (`__non_webpack_require__.resolve` in lib/export/fonts.server.ts).
  // Next's file tracer follows imports, not runtime resolution, so without this
  // the font assets are absent from the deployed lambda and the route throws on
  // its first render. Trace them in explicitly, for both route flavours that can
  // reach the renderer (the synchronous ticket download and the Inngest worker
  // that renders the project scope).
  //
  // The glob is relative to `apps/web`, so it matches through pnpm's symlinked
  // `apps/web/node_modules/@fontsource/*` into the store (verified in the emitted
  // `.nft.json`). This part was never broken.
  // The guide manual reads its committed screenshots with `fs.readFile` from
  // `public/guide/` (`lib/export/guide-figures.server.ts`) — a RUNTIME
  // resolution, which is the same class as the fonts bug above. It needs the
  // `.woff` glob for exactly the reason the two routes above do.
  //
  // ── What was MEASURED about the `public/guide/*` entries ───────────────────
  // They are DEFENCE IN DEPTH, not the mechanism. A clean control build (`.next`
  // removed, these three lines deleted) still traced `public/guide/*.png` into
  // this route's `.nft.json` — Next picks the public directory up on its own. So
  // do not describe them as the thing that makes figures reach the lambda; that
  // would be a confident claim contradicted by the build output. They are kept
  // because they cost nothing and they state the dependency explicitly, so a
  // future `outputFileTracingExcludes` or a change in Next's defaults cannot
  // silently drop the figures.
  //
  // ── What is NOT settled, and cannot be from here ──────────────────────────
  // Whether a Vercel lambda's filesystem actually contains `public/` at runtime
  // (those files are also served as CDN static assets) is only answerable by a
  // real deploy. If figures come back as "could not be read" in production while
  // being fine locally, that is the question to ask first — and the fix is to
  // move the bytes to an imported module rather than to add more globs here.
  // The failure is SILENT (a degraded placeholder, not a crash), so nothing
  // source-level can see it; `pnpm --filter @devpilot/web accept:guide` is what
  // checks it against a real build.
  outputFileTracingIncludes: {
    "/api/board/tickets/[id]/export": ["./node_modules/@fontsource/**/files/*.woff"],
    "/api/inngest": ["./node_modules/@fontsource/**/files/*.woff"],
    "/api/guide/manual": [
      "./node_modules/@fontsource/**/files/*.woff",
      "./public/guide/*.png",
      "./public/guide/*.jpg",
      "./public/guide/*.jpeg",
    ],
  },
};

export default nextConfig;
