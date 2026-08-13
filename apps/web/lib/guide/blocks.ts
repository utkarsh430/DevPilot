// The guide's block vocabulary — the ONE typed shape that both the web renderer
// and the react-pdf renderer draw. PURE: no imports at all, so a React client
// component, a react-pdf document, a node script and Vitest can all load it.
//
// ── Why this file exists ────────────────────────────────────────────────────
//
// The guide ships on two surfaces (an in-app reader and a downloadable manual)
// and the binding requirement is that they must not drift. Drift is not
// prevented by discipline; it is prevented by there being only one thing. So the
// markdown is parsed ONCE (`lower.ts`) into `DocBlock[]`, and each surface is a
// dumb `switch` over that array.
//
// The `switch` in each renderer is exhaustive with a `never` check. That is the
// structural guarantee this design rests on: adding a member to `DocBlock` is a
// COMPILE ERROR in whichever renderer forgot it, rather than a block type that
// silently renders on one surface and vanishes on the other. Keep every member a
// discriminated union arm on `type`, and never add an open-ended escape hatch
// (`{ type: "raw"; html: string }` or similar) — that would reintroduce exactly
// the per-surface interpretation this file removes.
//
// ── Two load-bearing properties ─────────────────────────────────────────────
//
// 1. `heading.depth` is narrowed to `2 | 3`. The page title is the h1 and comes
//    from the manifest, so a body cannot introduce a second page title. A
//    depth-1 heading in a body is a LOWERING ERROR, not a silent demotion.
//    (`components/plan/MessageMarkdown.tsx` demotes h1 → h2 at 13px uppercase.
//    That is right for a chat bubble and wrong here, and it must not be reused:
//    a demotion is a decision one renderer makes and the other might not.)
//
// 2. `anchor` is computed ONCE, during lowering, by one `slugifyAnchor`. Five
//    consumers read that exact string: the web `id=`, the in-page TOC, the
//    sidebar sub-nav, the PDF sub-bookmark and the PDF TOC row. Deriving it a
//    second time anywhere is how a TOC entry starts pointing at nothing.
//
// ── Trust domain ────────────────────────────────────────────────────────────
//
// Guide content is FIRST-PARTY and PR-reviewed, which is why `DocInline` carries
// an `href` and links here are genuinely clickable. That is the opposite of
// `lib/export/markdown.ts`, which serves untrusted agent-authored text and whose
// `MdInline` deliberately has no `href` at all. See the header of `lower.ts` for
// the full table; the short version is that one module cannot serve both trust
// domains, and merging them would put clickable agent-authored links into an
// audit PDF a compliance reader trusts.

/**
 * An inline run: text plus the marks that apply to it.
 *
 * `href` is present ONLY because this vocabulary serves first-party content. A
 * renderer that makes it clickable must still treat an external destination as
 * external (`rel="noopener noreferrer"`); an internal `/guide/*` destination is
 * validated against the manifest by a test, so a renamed slug is a red build
 * rather than a dead link nobody notices.
 */
export type DocInline = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
};

/** The tone of a callout. Closed set — a renderer switches exhaustively on it. */
export type CalloutTone = "note" | "warning" | "tip";

export type DocBlock =
  | { type: "paragraph"; runs: DocInline[] }
  | { type: "heading"; depth: 2 | 3; anchor: string; runs: DocInline[] }
  | { type: "list"; ordered: boolean; items: DocInline[][] }
  | { type: "code"; lang: string | null; value: string }
  | { type: "callout"; tone: CalloutTone; runs: DocInline[] }
  | { type: "table"; header: DocInline[][]; rows: DocInline[][][] }
  | { type: "figure"; figureId: string }
  | { type: "rule" };

/** Every `DocBlock["type"]`, for the exhaustiveness tests both renderers carry. */
export const DOC_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "list",
  "code",
  "callout",
  "table",
  "figure",
  "rule",
] as const satisfies readonly DocBlock["type"][];

/**
 * An acknowledgement that a figure may be out of date, pinned to the EXACT live
 * fingerprint it excuses.
 *
 * Pinning is the whole design. A boolean `stale: true` would excuse the drift
 * that exists today AND every future drift on the same files, silently, forever.
 * Because this names one fingerprint, the next edit to a watched file produces a
 * different one and the gate goes red again.
 *
 * The cost of the escape hatch is paid IN THE PRODUCT, not in CI: both surfaces
 * render a visible "may be out of date" badge carrying `note` and `since`. And
 * because it lives in the manifest — a static typed constant — the PDF renderer,
 * which has no repo source to hash, can render the badge too.
 */
export type StaleAcknowledgement = {
  /** The live fingerprint at the moment of acknowledgement. Not a wildcard. */
  fingerprint: string;
  /** Why it is acceptable, in the operator's own words. Shown to the reader. */
  note: string;
  /** ISO date (YYYY-MM-DD). Shown to the reader. */
  since: string;
};

/**
 * A captured screenshot and everything both surfaces need to draw it honestly.
 *
 * OWNERSHIP: the capture crew (Phase B) owns the DATA — it fills the registry in
 * `figures.ts`, and `scripts/guide-capture.mjs` is the SOLE writer of every
 * provenance field (`capturedAt`, `theme`, `build`, `fingerprint`). A
 * hand-authored entry is not forbidden by the type system and is not detectable
 * by the freshness check — see `GUIDE_PROVENANCE_UNPROVEN_EXAMPLE`, which is
 * asserted to PASS precisely so that limit is stated rather than assumed.
 *
 * The TYPE is frozen here so the capture crew can fill it without renegotiating
 * with the two renderer crews.
 */
export type GuideFigure = {
  /** Stable id. Referenced from markdown as `![](figure:<id>)`. */
  id: string;
  /** Path under `apps/web/public/guide/`, e.g. `board-overview.png`. */
  file: string;
  /**
   * Alt text — what the image MEANS, for a screen reader and for the fallback
   * when the bytes cannot be loaded. Must not equal `caption` (a test asserts
   * it): a caption that duplicates the alt text tells a sighted reader nothing
   * and tells a screen-reader user the same sentence twice.
   */
  alt: string;
  /** Caption drawn under the frame, on both surfaces. */
  caption: string;
  /** Intrinsic pixel size. Explicit on the web `<img>` to reserve layout. */
  width: number;
  height: number;
  /** The route depicted, drawn in the figure's chrome bar. */
  route: string;
  /**
   * The 2–4 repo files that actually compose this screen. NOT a directory tree:
   * a broad glob goes red on every unrelated edit, and a gate people resent gets
   * deleted. Paths are repo-relative.
   */
  watch: readonly string[];
  /** sha256 over the sorted watched files — see `freshness.ts`. */
  fingerprint: string;
  /** ISO instant the capture script ran. Written by the script, never by hand. */
  capturedAt: string;
  /** Theme at capture. Light only — see the plan; the PDF is light-only too. */
  theme: string;
  /** Short git sha of the tree the capture ran against. */
  build: string;
  /** Present only when drift has been deliberately accepted. */
  staleAcknowledged?: StaleAcknowledgement;
};

/** Plain-text projection of inline runs — TOC entries, anchors, summaries. */
export function docRunsToPlainText(runs: readonly DocInline[]): string {
  return runs.map((r) => r.text).join("");
}
