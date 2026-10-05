// Cover, running header, footer — the artifact's brand chrome.
//
// The logo is the same bitmap the web app serves from `public/brand/`, read at
// render time by `lib/export/brand-assets.ts` and embedded with react-pdf's
// `<Image>`. One source for both surfaces, so the PDF can never show a stale
// mark. The PDF always draws the LIGHT variant: every surface here is the paper
// colour (`SURFACE`), never a dark chrome.
//
// When the file cannot be read (a lambda whose tracer dropped `public/`, a
// broken checkout) the chrome degrades to a text wordmark rather than failing
// the export — same posture as the guide figures.

import React from "react";
import { Image, Text, View } from "@react-pdf/renderer";
import { COLORS, SURFACE, mix } from "@/lib/export/theme";
import { FONT_FAMILY } from "@/lib/export/fonts";
import { brandAsset, brandAssetBox } from "@/lib/export/brand-assets";
import { styles } from "@/lib/export/components/primitives";
import { oneLineTruncated } from "@/lib/export/truncate";

/** The square DevPilot mark, `size` points on a side. */
export function DevPilotMarkPdf({
  size = 24,
  tone = COLORS.foreground,
}: {
  size?: number;
  /** Used only by the text fallback; the bitmap carries its own colours. */
  tone?: string;
}) {
  const src = brandAsset("mark");
  if (!src) return <WordmarkFallback size={size} tone={tone} />;
  // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image, not a DOM <img>; PDFs carry no alt
  return <Image src={src} style={{ width: size, height: size }} />;
}

/** The full lockup (mark + wordmark), `size` points tall. */
export function DevPilotLogoPdf({
  tone = COLORS.foreground,
  size = 20,
}: {
  /** Used only by the text fallback; the bitmap carries its own colours. */
  tone?: string;
  size?: number;
}) {
  const src = brandAsset("logo");
  if (!src) return <WordmarkFallback size={size} tone={tone} />;
  const box = brandAssetBox("logo", size);
  // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image, not a DOM <img>; PDFs carry no alt
  return <Image src={src} style={{ width: box.width, height: box.height }} />;
}

function WordmarkFallback({ size, tone }: { size: number; tone: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Text
        style={{
          fontFamily: FONT_FAMILY.display,
          fontWeight: 700,
          fontSize: size * 0.8,
          color: tone,
        }}
      >
        devpilot
      </Text>
    </View>
  );
}

/**
 * A4 page height in PostScript points. Every document in this export is `<Page
 * size="A4">`, so this is a constant, and `TOP`-anchoring the footer against it
 * is exact — see `Footer` for why the footer must be top-anchored, not
 * bottom-anchored.
 */
export const A4_HEIGHT_PT = 841.89;

/** Rule (1) + its 6pt margin + the ~9pt text line: the footer's drawn height. */
const FOOTER_HEIGHT_PT = 16;

/**
 * Running footer: page `X of Y` plus a provenance line.
 *
 * `fixed` puts it on every page, and react-pdf resolves `pageNumber`/
 * `totalPages` at layout time (this is precisely what a pure-JS renderer buys
 * over an HTML-to-PDF print, where "page N of M" needs a second pass or a
 * paged-media polyfill).
 *
 * ── Why the footer is TOP-anchored, not `bottom: 22` (this was a real bug) ────
 * A `fixed` element is re-laid-out on every page. On a long document, react-pdf
 * paginates by repeatedly relaying-out the continuation, and the continuation
 * page is built with its `height` OMITTED (`@react-pdf/layout` `splitPage`:
 * `nextBox = omit('height', page.box)`). A `bottom`-anchored box resolves its
 * top from the page height — which is now absent — so on deep continuation pages
 * its computed `top` diverges to a huge magnitude (the exact `-2.996…e21` seen in
 * the pdfkit clamp logs). The clamp coerces that to `0`, and the footer then
 * renders at the TOP of the page, on top of the running header — the visible
 * defect. A `top`-anchored box never consults the (absent) page height, so it is
 * stable on every page; the `top: 24` running header proves it. We therefore
 * anchor the footer by `top`, computed once from the fixed A4 height.
 *
 * Three pieces, each closing one way the diverged frame surfaced a bad coordinate:
 *  • The provenance line + rule live in a `top`-anchored `fixed` View. The rule is
 *    a filled View (`height: 1`), NOT a CSS `borderTopWidth` — a CSS border runs
 *    `clipBorderTop`'s corner/join math on the box geometry, which was one of the
 *    places the diverged coordinate got written.
 *  • The page-number is its OWN `top`-anchored, absolutely-positioned `fixed`
 *    `Text`, not a child of the row above. A `render` callback makes react-pdf
 *    re-resolve that node per page (`resolveDynamicPage` → `relayoutPage`); inside
 *    the flow row that re-layout still diverged, but with an explicit `top`/`right`
 *    it has nothing to recompute and stays put. This is the piece that took the
 *    residual clamp count to zero.
 *
 * The whole reason this matters: once the footer stops diverging, the page frame
 * stays sane, so a run card (or any bordered box) that splits across a page break
 * renders cleanly too — the run-card border was a symptom of this, never a cause.
 */
export function Footer({ label }: { label: string }) {
  return (
    <>
      <View
        fixed
        style={{
          position: "absolute",
          // 22pt clearance from the page bottom, matching the old `bottom: 22`.
          top: A4_HEIGHT_PT - 22 - FOOTER_HEIGHT_PT,
          left: 48,
          right: 48,
        }}
      >
        <View style={{ height: 1, backgroundColor: COLORS.border, marginBottom: 6 }} />
        <Text style={{ fontSize: 6.5, color: COLORS.mutedForeground }}>{label}</Text>
      </View>
      {/* Aligned with the provenance line: the rule (1) + its 6pt margin puts the
          text 7pt below the container top. */}
      <Text
        fixed
        style={{
          position: "absolute",
          top: A4_HEIGHT_PT - 22 - FOOTER_HEIGHT_PT + 7,
          right: 48,
          fontSize: 6.5,
          color: COLORS.mutedForeground,
        }}
        render={({ pageNumber, totalPages }) => `${pageNumber} of ${totalPages}`}
      />
    </>
  );
}

/**
 * Running header. Mount it on content pages only — the cover simply does not
 * render one, which is why there is no page-number check here.
 *
 * Two react-pdf constraints are baked into this shape, both learned the hard way:
 *
 *  • `position: absolute` goes on the OUTER `fixed` view. A `fixed` view is
 *    still a flow participant, so nesting a separately-absolute box inside one
 *    compounds the offsets — the header landed ~50pt down the page and collided
 *    with the first section heading.
 *
 *  • NO `render` callback. Its return value is not laid out like an ordinary
 *    subtree: an `<Svg>` inside it is dropped SILENTLY (the wordmark vanished
 *    while the title beside it still drew — verified by diffing the output size
 *    with and without the callback). `render` is for simple per-page text like
 *    the footer's `X of Y`; anything structural must be a direct child.
 */
export function RunningHeader({ title }: { title: string }) {
  return (
    <View
      fixed
      style={{
        position: "absolute",
        top: 24,
        left: 48,
        right: 48,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <DevPilotLogoPdf size={9} tone={COLORS.mutedForeground} />
      <Text style={{ fontSize: 6.5, color: COLORS.mutedForeground }}>
        {oneLineTruncated(title, 80)}
      </Text>
    </View>
  );
}

export type CoverMeta = { label: string; value: string };

/**
 * The cover page. Ink field, signal rule, display face, and a metadata block —
 * the "dispatch board" identity applied to a printed record.
 */
export function Cover({
  eyebrow,
  title,
  subtitle,
  meta,
  notice,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  meta: CoverMeta[];
  notice?: string;
}) {
  return (
    <View style={{ flexGrow: 1, justifyContent: "space-between" }}>
      <View>
        <DevPilotLogoPdf size={22} />
        <View
          style={{
            height: 3,
            width: 44,
            backgroundColor: COLORS.primary,
            borderRadius: 1.5,
            marginTop: 28,
          }}
        />
        <Text style={{ ...styles.eyebrow, marginTop: 18 }}>{eyebrow}</Text>
        <Text style={{ ...styles.h1, fontSize: 30, marginTop: 6, lineHeight: 1.2 }}>{title}</Text>
        {subtitle ? (
          <Text style={{ fontSize: 11, color: COLORS.mutedForeground, marginTop: 8 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      <View style={{ ...styles.card, backgroundColor: mix(COLORS.foreground, SURFACE, 0.03) }}>
        {meta.map((m) => (
          <View key={m.label} style={{ flexDirection: "row", marginBottom: 3 }}>
            <Text style={{ ...styles.muted, width: 110, flexShrink: 0 }}>{m.label}</Text>
            <Text style={{ fontSize: 8.5, color: COLORS.foreground, flex: 1 }}>{m.value}</Text>
          </View>
        ))}
      </View>

      {notice ? (
        <View
          style={{
            borderLeftWidth: 2,
            borderLeftColor: COLORS.primary,
            borderLeftStyle: "solid",
            paddingLeft: 8,
            marginTop: 14,
          }}
        >
          <Text style={{ fontSize: 7.5, color: COLORS.mutedForeground, lineHeight: 1.5 }}>
            {notice}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The provenance + scope notice printed on every cover.
 *
 * An audit reader needs to know two things this document cannot show them
 * implicitly: that a lot of the text inside was written by a machine, and that
 * the record stops where Postgres stops. Both are stated plainly — but without a
 * "read this as data" instruction, which was noise: the untrusted content is
 * rendered inert by construction (react-pdf has no executable channel, and
 * `markdown.ts` allowlists the AST and drops raw HTML), so the label defended
 * nothing. What remains is real disclosure, not a warning banner.
 */
export const TRUST_NOTICE =
  "This export is generated from DevPilot's own database. Much of its content — agent narration, " +
  "comments, and command output — was produced by automated agents or by the engine, so it records " +
  "what was said, not a verified claim. Per-run tool-by-tool spans are not included here; each run " +
  "links to its full trace. Model prompts are omitted by design.";
