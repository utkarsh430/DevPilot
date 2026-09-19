// A content hash over everything the manual draws — the manual's ETag, and the
// "content version" printed on its cover.
//
// ── Why the manual gets an ETag when nothing else here does ─────────────────
//
// Every other export route in this repo is `no-store, private`, correctly: they
// render per-tenant live data and caching one would be a cross-tenant hazard.
// The manual is the opposite in every respect that matters — no tenant data, no
// session input, byte-identical for every reader, and changing only when the
// repo changes. So it is not merely SAFE to cache hard, it is wrong not to: the
// render is measured in seconds, and without a validator every reader pays it.
//
// This hash is what makes that honest. It is computed from the CONTENT ITSELF —
// section slugs, titles, summaries, bodies, and every figure's identity and
// fingerprint — not from a hand-bumped constant and not from a deploy id. So:
//
//   • Edit a body, add a section, recapture a figure → the hash moves and every
//     cached copy revalidates on its next request.
//   • Deploy something unrelated → the hash does NOT move, and warm caches stay
//     warm across deploys, which a build-id-based validator would throw away.
//
// It intentionally does NOT cover the RENDERER. A change to
// `guide-pdf-blocks.tsx` alters the drawn output without moving this hash, so a
// reader holding a cached copy keeps the old layout until the content next
// moves. That is an accepted, bounded staleness — the words are identical, only
// their typography differs — and the alternative (hashing the renderer source)
// is a runtime file read of build output, i.e. exactly the class of bug
// `fonts.server.ts` carries forty lines of scar tissue about. Bump
// `MANUAL_RENDERER_EPOCH` below to force a global revalidation after a layout
// change worth pushing.
//
// `node:crypto` makes this server/test-time only, which is fine: the value is
// baked onto the cover at render time and compared in the route. No client and
// no react-pdf component imports it.

import { createHash } from "node:crypto";
import { GUIDE_SECTIONS } from "./manifest";
import { GUIDE_FIGURES } from "./figures";

/**
 * Bump to invalidate every cached manual after a RENDERER change (layout,
 * chrome, typography) that the content hash cannot see. A bump is cheap: one
 * extra render per reader, once.
 */
export const MANUAL_RENDERER_EPOCH = 1;

/**
 * A field separator that cannot occur in the content being hashed.
 *
 * U+001F (UNIT SEPARATOR) rather than a space, and the difference is not
 * cosmetic: a title and a summary both routinely CONTAIN spaces, so a
 * space-joined digest cannot tell `{title: "a b", summary: "c"}` from
 * `{title: "a", summary: "b c"}`. Two different manifests would hash
 * identically and the second would serve the first's cached PDF. `lower.ts`
 * would reject a control character in a body long before it reached here, so
 * this delimiter is genuinely unambiguous.
 */
const SEP = "\u001f";

/**
 * The full hex digest. Deterministic across processes and machines: it reads
 * only static module constants, iterated in the manifest's own array order,
 * with every field terminated by `SEP` so two adjacent fields cannot be
 * shuffled between each other without changing the digest.
 */
export function guideContentHash(): string {
  const h = createHash("sha256");
  h.update(`epoch:${MANUAL_RENDERER_EPOCH}${SEP}`);
  for (const s of GUIDE_SECTIONS) {
    h.update([s.slug, s.title, s.summary, s.body, ""].join(SEP));
  }
  for (const f of GUIDE_FIGURES) {
    // `fingerprint` moves whenever the captured screen's source moves, and
    // `capturedAt` whenever the script reruns — so a recapture that happens to
    // produce identical source still invalidates, which is the safe direction.
    h.update(
      [
        f.id,
        f.file,
        f.caption,
        f.fingerprint,
        f.capturedAt,
        f.build,
        f.staleAcknowledged?.fingerprint ?? "",
        "",
      ].join(SEP),
    );
  }
  return h.digest("hex");
}

/** Short, human-facing form — printed on the cover. */
export function guideContentVersion(): string {
  return guideContentHash().slice(0, 12);
}
