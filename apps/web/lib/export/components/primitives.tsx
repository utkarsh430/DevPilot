// Shared react-pdf primitives + the export's stylesheet.
//
// Everything visual routes through here so the two documents cannot drift into
// two different-looking artifacts. Colors come from `theme.ts` (which is frozen
// against `app/globals.css` by a drift test) — never a literal hex in a
// component, exactly as the app forbids hardcoded colors outside tokens.
//
// react-pdf constraints worth remembering while editing this file:
//   • No CSS variables, no `hsl(var(…))`, no `calc()`, no cascade. Styles are
//     plain objects and inheritance only flows through `<Text>` nesting.
//   • No alpha compositing against a parent. Every tint here is precomputed
//     opaque via `theme.mix()`.
//   • Flexbox only (no grid). Tables are rows of flexed cells.
//   • `wrap={false}` on a block asks the layout engine to keep it on one page;
//     use it for small units (a chip row, a metric tile), never for anything
//     that could exceed a page — that silently clips.

import React from "react";
import { Page, Text, View, StyleSheet } from "@react-pdf/renderer";

/**
 * react-pdf's style type, borrowed from `View`.
 *
 * NOT from `Text`: its props are a `TextProps | SVGTextProps` union, so a style
 * derived from it widens to include SVG presentation attributes and then no
 * longer assigns back to a plain `<Text style>`. `View` is the clean source of
 * the same `Style | Style[]`.
 */
export type PdfStyle = React.ComponentProps<typeof View>["style"];
import {
  COLORS,
  mix,
  SURFACE,
  roleColor,
  roleTint,
  statusColor,
  runStatusColor,
} from "@/lib/export/theme";
import { FONT_FAMILY } from "@/lib/export/fonts";
import { TRUST_COLOR, TRUST_LABEL } from "@/lib/export/theme";
import type { Trust, Untrusted } from "@/lib/export/types";

/**
 * A PDF outline entry.
 *
 * react-pdf's published `ExpandedBookmark` is `{ title, top, left, zoom, fit,
 * expanded }` and is declared on `PageProps` only. The RUNTIME is wider on both
 * counts: it reads `bookmark` off ANY node (`'bookmark' in node.props` in
 * @react-pdf/render), and it honours two fields the type does not mention —
 * `ref` and `parent` — which are what make a 100-page export navigable.
 *
 * So the types are incomplete, not the runtime. Rather than scatter a cast at
 * every heading and page, the gap is absorbed once here: `BookmarkView` and
 * `BookmarkPage` are a `View`/`Page` that additionally accept our `PdfBookmark`.
 * If react-pdf's types catch up, delete these and use the primitives directly.
 *
 * Why `ref` is required
 * ────────────────────
 * `resolveBookmarks` (@react-pdf/layout) assigns these itself, before render:
 *
 *     const ref = refs++;
 *     const newHierarchy = { ref, parent: parent?.ref, ...bookmark };
 *
 * Two things follow. The spread puts OUR values last, so an explicit `ref` /
 * `parent` wins. And the auto-assigned ids come from a BREADTH-FIRST walk —
 * every page first, THEN their children — not from document order.
 *
 * That second point is the trap, and it shipped. The ids used to be hardcoded
 * positional indices (`{cover: 0, contents: 1, config: 2, rollups: 3,
 * tickets: 4}`), written as if the walk were depth-first. It is not. The two
 * orders agree only while the CONDITIONAL "Ticket summary" page is present,
 * i.e. only for a project OVER the detail cap. Under the cap — the common case
 * — auto-ref 4 is the Configuration section rather than the Ticket-detail page,
 * so every ticket nested under "Configuration & stack" and the "Ticket detail"
 * entry sat empty. The rendered pages are identical either way; only a viewer's
 * sidebar shows it, which is why it went unnoticed.
 *
 * Explicit ids from `BOOKMARK_REF` are immune both to the traversal order and
 * to a page appearing or vanishing. `ref` is REQUIRED on our type so a new
 * bookmark cannot quietly fall back to a positional id again.
 */
export type PdfBookmark = {
  title: string;
  /** Unique id for this entry. Required for correct nesting — see above. */
  ref: number;
  /** The `ref` of the intended parent entry. Omit for a top-level entry. */
  parent?: number;
  expanded?: boolean;
};

export const BookmarkView = View as unknown as React.ComponentType<
  React.ComponentProps<typeof View> & { bookmark?: PdfBookmark }
>;

/**
 * A `Page` whose `bookmark` is our `PdfBookmark` rather than react-pdf's
 * narrower `ExpandedBookmark`. Same gap, same absorption — a page-level entry
 * needs a `ref` for exactly the reason a view-level one does.
 */
export const BookmarkPage = Page as unknown as React.ComponentType<
  React.ComponentProps<typeof Page> & { bookmark?: PdfBookmark }
>;

export const styles = StyleSheet.create({
  page: {
    backgroundColor: COLORS.background,
    color: COLORS.foreground,
    fontFamily: FONT_FAMILY.body,
    fontSize: 9.5,
    lineHeight: 1.5,
    paddingTop: 54,
    paddingBottom: 48,
    paddingHorizontal: 48,
  },
  h1: { fontFamily: FONT_FAMILY.display, fontWeight: 700, fontSize: 22, color: COLORS.foreground },
  h2: {
    fontFamily: FONT_FAMILY.display,
    fontWeight: 700,
    fontSize: 15,
    color: COLORS.foreground,
    marginBottom: 6,
  },
  h3: {
    fontFamily: FONT_FAMILY.body,
    fontWeight: 600,
    fontSize: 11,
    color: COLORS.foreground,
    marginBottom: 4,
  },
  /** Section eyebrow — the small uppercase label above a block. */
  eyebrow: {
    fontFamily: FONT_FAMILY.body,
    fontWeight: 600,
    fontSize: 7,
    letterSpacing: 1.1,
    textTransform: "uppercase",
    color: COLORS.mutedForeground,
  },
  body: { fontSize: 9.5, color: COLORS.foreground },
  muted: { fontSize: 8.5, color: COLORS.mutedForeground },
  mono: { fontFamily: FONT_FAMILY.mono, fontSize: 8 },
  card: {
    backgroundColor: SURFACE,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderStyle: "solid",
    padding: 10,
  },
  row: { flexDirection: "row", alignItems: "center" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  rule: { height: 1, backgroundColor: COLORS.border, marginVertical: 8 },
});

/** A small pill. `tone` is the text/border color; the fill is a precomputed tint. */
export function Pill({
  label,
  tone,
  solid = false,
}: {
  label: string;
  tone: string;
  solid?: boolean;
}) {
  return (
    <View
      wrap={false}
      style={{
        backgroundColor: solid ? tone : mix(tone, SURFACE, 0.12),
        borderRadius: 3,
        paddingVertical: 1.5,
        paddingHorizontal: 5,
      }}
    >
      <Text
        style={{
          fontSize: 7,
          fontWeight: 600,
          letterSpacing: 0.3,
          color: solid ? COLORS.primaryForeground : tone,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/** Role chip, colored by the role spectrum (unknown slug → muted, never borrowed). */
export function RoleChip({ role }: { role: string | null }) {
  const label = role ?? "unassigned";
  const tone = roleColor(role);
  return (
    <View
      wrap={false}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: roleTint(role),
        borderRadius: 3,
        paddingVertical: 1.5,
        paddingHorizontal: 5,
      }}
    >
      <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: tone }} />
      <Text style={{ fontSize: 7, fontWeight: 600, color: tone }}>{label}</Text>
    </View>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <Pill label={status.replace(/_/g, " ")} tone={statusColor(status)} />;
}

export function RunStatusPill({ status }: { status: string }) {
  return <Pill label={status.replace(/_/g, " ")} tone={runStatusColor(status)} />;
}

/**
 * The provenance marker above machine-written content: the trust word, plus an
 * optional note (e.g. "command output"). PURE, so it is unit-testable.
 *
 * Deliberately quiet — a marker, not a warning banner. It used to read
 * `AGENT-WRITTEN · TREAT AS DATA`, which added noise without adding a defense:
 * the untrusted content is rendered inert by construction (react-pdf has no
 * executable channel, and `markdown.ts` allowlists the AST and drops raw HTML),
 * and provenance is ALSO carried by the colored rail (`TRUST_COLOR`) and the
 * author + timestamp line above each entry. So the label keeps only what a reader
 * actually uses: who wrote it.
 */
export function trustMarkerLabel(trust: Trust, note?: string): string {
  return `${TRUST_LABEL[trust].toUpperCase()}${note ? ` · ${note}` : ""}`;
}

/**
 * The attribution mark for machine-written content.
 *
 * Human text renders with no chrome at all — the default reading is "a person
 * wrote this". Agent and system text carry a visible label and a colored rail,
 * so the reader never has to infer authorship from tone. This is the visual half
 * of the `Untrusted` carrier: the type stops the code from forgetting, the rail
 * stops the reader from assuming.
 */
export function TrustRail({
  trust,
  children,
  note,
}: {
  trust: Trust;
  children: React.ReactNode;
  note?: string;
}) {
  if (trust === "human") return <>{children}</>;
  const tone = TRUST_COLOR[trust];
  return (
    <View
      style={{
        borderLeftWidth: 2,
        borderLeftColor: tone,
        borderLeftStyle: "solid",
        paddingLeft: 7,
        backgroundColor: mix(tone, SURFACE, 0.05),
        paddingVertical: 4,
        paddingRight: 6,
        borderRadius: 2,
      }}
    >
      <Text
        style={{ fontSize: 6.5, fontWeight: 600, letterSpacing: 0.6, color: tone, marginBottom: 2 }}
      >
        {trustMarkerLabel(trust, note)}
      </Text>
      {children}
    </View>
  );
}

/** Plain untrusted text, attributed. Use where markdown would be overkill. */
export function UntrustedText({
  value,
  style,
  note,
}: {
  value: Untrusted;
  style?: PdfStyle;
  note?: string;
}) {
  return (
    <TrustRail trust={value.trust} note={note}>
      <Text style={style ? [styles.body, style].flat() : styles.body}>{value.value}</Text>
    </TrustRail>
  );
}

/** Label/value line used throughout the metadata blocks. */
export function Field({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <View style={{ flexDirection: "row", marginBottom: 2.5 }}>
      <Text style={{ ...styles.muted, width: 96, flexShrink: 0 }}>{label}</Text>
      <Text
        style={{
          fontSize: mono ? 8 : 8.5,
          fontFamily: mono ? FONT_FAMILY.mono : FONT_FAMILY.body,
          color: tone ?? COLORS.foreground,
          flex: 1,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * Section heading that also becomes a PDF bookmark (a real outline entry).
 *
 * `bookmark` takes an object only. It used to also accept a bare string as a
 * convenience, which built `{ title }` with no `ref` — i.e. the shorthand was
 * the one shape that silently corrupts the outline (see `PdfBookmark`). A
 * shorthand that cannot express a required field is a trap, so it is gone.
 */
export function Section({
  title,
  eyebrow,
  bookmark,
  children,
}: {
  title: string;
  eyebrow?: string;
  bookmark?: PdfBookmark;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <BookmarkView bookmark={bookmark} style={{ marginBottom: 6 }}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.h2}>{title}</Text>
        <View style={{ height: 2, width: 28, backgroundColor: COLORS.primary, borderRadius: 1 }} />
      </BookmarkView>
      {children}
    </View>
  );
}

/**
 * Coerce a value to a number react-pdf can actually draw.
 *
 * pdfkit refuses any number outside `(-1e21, 1e21)`, and NaN/Infinity fail that
 * test too (every comparison against NaN is false). The vendored patch in
 * `patches/@react-pdf__pdfkit@5.1.1.patch` stops such a value from THROWING at
 * the write boundary, but that is a last-resort net that draws the element in
 * the wrong place and logs. Use this wherever we compute a number ourselves, so
 * a bad input degrades to a chosen, sensible value instead of a coerced 0.
 *
 * `Number.isFinite` is the whole check: it is false for NaN, ±Infinity and any
 * non-number, and every finite double below 1e21 is drawable.
 */
export function safeNum(n: unknown, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  if (n <= -1e21 || n >= 1e21) return fallback;
  return n;
}

/** A horizontal bar for the rollup charts. Drawn as nested Views — react-pdf has
 *  no chart primitives and an SVG dependency would buy nothing here. */
export function Bar({
  value,
  max,
  tone,
  width = 120,
}: {
  value: number;
  max: number;
  tone: string;
  width?: number;
}) {
  // `Math.max(0, Math.min(1, NaN))` is NaN, not 0 — a clamp built from Math.min
  // /Math.max does NOT sanitise its input, because every comparison against NaN
  // is false and both functions propagate it. So a single NaN cent figure used
  // to reach react-pdf as `width: NaN` and fail the whole export. Sanitise the
  // inputs first; the clamp then only has to do clamping.
  const safeValue = safeNum(value, 0);
  const safeMax = safeNum(max, 0);
  const barWidth = safeNum(width, 120);
  const pct = safeMax > 0 ? Math.max(0, Math.min(1, safeValue / safeMax)) : 0;
  return (
    <View
      style={{
        width: barWidth,
        height: 5,
        backgroundColor: COLORS.muted,
        borderRadius: 2.5,
        overflow: "hidden",
      }}
    >
      <View
        style={{ width: barWidth * pct, height: 5, backgroundColor: tone, borderRadius: 2.5 }}
      />
    </View>
  );
}

/**
 * An empty-state line. Saying "none" beats an ambiguous blank in a record.
 *
 * No `fontStyle: "italic"` here (or anywhere else in the export): react-pdf
 * resolves a style to a REGISTERED face and throws `Could not resolve font for
 * Inter, fontWeight 400, fontStyle italic` when there isn't one. We register
 * upright faces only, so emphasis is carried by color and weight. Adding italic
 * means registering the italic .woff for every family that uses it.
 */
export function Empty({ children }: { children: string }) {
  return <Text style={{ ...styles.muted, color: COLORS.mutedForeground }}>{children}</Text>;
}
