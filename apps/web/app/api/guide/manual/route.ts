// GET /api/guide/manual
//
// The whole user guide as one PDF: render → stream, synchronously.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ READ THIS BEFORE "FIXING" THE CACHE HEADERS TO no-store.                 ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Every OTHER export route in this repo is `no-store, private`, and every one of
// them is right to be: they render per-tenant live data, so a shared cache entry
// would be a cross-tenant disclosure. Pattern-matching those three routes onto
// this one looks like tightening a loose screw and is in fact a pure
// pessimisation, so the argument is written down here rather than left to be
// re-derived:
//
//   • It carries NO tenant data. Not a filtered subset — none. Every byte comes
//     from static TypeScript constants (`lib/guide/manifest.ts`) and committed
//     PNGs (`public/guide/`). No database is read on this path at all.
//   • It is byte-identical for every reader. There is no session input, no
//     tenant, no user, no query parameter that changes the output.
//   • It changes only when the repo changes — which is exactly what the strong
//     `ETag` is computed over (`guideContentHash()`), so a content edit
//     invalidates every cached copy and an unrelated deploy does not.
//
// So the render is paid ONCE per content version rather than once per reader.
// That is the whole reason this is affordable as a synchronous render: it is the
// longest document this codebase produces, and without a validator every reader
// would pay several seconds of layout for identical bytes.
//
// `stale-while-revalidate` is what makes the first request after a content
// change cheap for the reader who happens to make it: they get the previous
// version immediately while the new one renders behind them. For a manual, one
// reader briefly receiving the previous revision of the documentation is an
// entirely acceptable trade for never making anyone wait on a cold render.
//
// ── Auth: this handler performs no check, and that is not the whole story ───
//
// The handler itself reads no session and no tenant — there is nothing here to
// leak (see the three bullets above), and a session check would also defeat the
// shared caching that makes the synchronous render affordable.
//
// But "the manual is reachable by anyone" would be an over-claim, and it was
// MEASURED to be false in one case: `middleware.ts` redirects EVERY path to
// `/setup` on an instance with no Supabase boot env, this route included. So on
// an unconfigured instance the manual is unreachable — which is a little
// unfortunate, since it is the document that explains how to configure one.
//
// That is left as-is rather than fixed here, deliberately. Adding a middleware
// exemption is a change to shared routing with a blast radius well beyond this
// PR, and the guide's own entry point (`app/(app)/guide`) already sits behind
// the authenticated app shell — so an exemption would only serve a reader who
// has the URL and no instance. Worth doing; worth doing on its own.
//
// ── Why Node runtime ────────────────────────────────────────────────────────
//
// react-pdf needs Node (Buffer, streams, fontkit); it cannot run on Edge.

import { NextResponse } from "next/server";
import { renderGuidePdfStream } from "@/lib/export/render.server";
import { buildContentDisposition } from "@/lib/export/filename";
import { guideContentHash } from "@/lib/guide/manual-version";

export const runtime = "nodejs";

/** One day fresh, one week servable-while-revalidating. */
const CACHE_CONTROL = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export async function GET(request: Request) {
  // A STRONG validator (no `W/` prefix): the bytes really are identical for a
  // given content hash, so a range request or a byte-for-byte comparison is
  // sound. A weak one would forbid range requests on a document readers open in
  // a PDF viewer that does exactly that.
  const etag = `"${guideContentHash()}"`;

  // `If-None-Match` may carry a list, and may carry `*`. Compare against the
  // members rather than the whole header — a naive equality check silently never
  // matches for any client that sends more than one, which turns the whole cache
  // into a slow path that still looks like it is working.
  const inm = request.headers.get("If-None-Match");
  if (inm) {
    const tags = inm.split(",").map((t) => t.trim());
    if (tags.includes("*") || tags.includes(etag)) {
      // 304 MUST carry the cache directives too, or an intermediary revalidating
      // on the reader's behalf drops them and the next request is a full render.
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": CACHE_CONTROL },
      });
    }
  }

  try {
    const stream = await renderGuidePdfStream({ generatedAt: new Date().toISOString() });

    return new Response(stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/pdf",
        // The one place a filename reaches a response header. The basename here
        // is a literal rather than derived from anything authorable, but it
        // still goes through `buildContentDisposition` — that function is the
        // single answer to "how does a filename become a header in this repo",
        // and routing around it for the easy case is how the next caller learns
        // that hand-rolling one is normal.
        "Content-Disposition": buildContentDisposition("devpilot-manual"),
        "Cache-Control": CACHE_CONTROL,
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err: unknown) {
    // A failure here is a render failure — a missing font face, a style react-pdf
    // refuses. Notably NOT a missing figure: those degrade to a visible
    // placeholder inside the document (see `guide-figures.server.ts`) rather
    // than reaching this catch, because a manual missing one screenshot is still
    // worth delivering.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[guide] manual render failed: ${msg}`);
    return NextResponse.json({ error: "manual could not be produced" }, { status: 500 });
  }
}
