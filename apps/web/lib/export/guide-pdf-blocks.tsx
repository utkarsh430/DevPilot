// Draw `DocBlock`s (see `lib/guide/blocks.ts`) with react-pdf primitives — the
// PDF half of the guide's one-source design.
//
// ── The exhaustiveness pair IS the no-drift guarantee ───────────────────────
//
// The guide ships on two surfaces and must not diverge. That is not enforced by
// discipline; it is enforced by there being ONE `DocBlock[]` and two dumb
// `switch`es over it, each exhaustive with a `never` check. Adding a member to
// `DocBlock` is therefore a COMPILE ERROR in whichever renderer forgot it,
// rather than a block type that silently renders on the web and vanishes from
// the manual (or the reverse — a reader downloads the PDF precisely because they
// want the whole thing offline, so a block that only exists on the web is the
// worse direction).
//
// Do not add a `default:` that returns null. `lib/export/components/Markdown.tsx`
// has one, correctly: its input is UNTRUSTED agent-authored markdown and a node
// type it does not understand must be dropped rather than drawn. This input is
// first-party, PR-reviewed, and typed — a block type here can only be one this
// module was compiled against, so the `never` arm is unreachable at runtime and
// its whole value is at build time.
//
// ── This module is `guide-*`-prefixed on purpose ────────────────────────────
//
// `lib/guide/__tests__/separation.test.ts` fails any file under `lib/export/`
// that imports `guide/blocks` or `guide/lower` UNLESS its basename starts with
// `guide-`. The audit export serves untrusted agent text and its `MdInline` has
// no `href` at all; the guide's `DocInline` has one because its content is
// first-party. One module cannot serve both trust domains, and the filename
// scoping is what keeps a well-meaning "DRY these up" from putting clickable
// agent-authored links into a compliance record. Keep the prefix.
//
// ── No italics anywhere in this document ───────────────────────────────────
//
// react-pdf resolves `fontStyle: "italic"` to a REGISTERED italic face and
// throws `Could not resolve font for Inter, fontWeight 400, fontStyle italic`
// when there is not one. The export registers upright faces only (see
// `fonts.ts`), so `DocInline.italic` is carried by COLOUR and WEIGHT instead —
// the same trade `Markdown.tsx` makes, and the reason `Empty` carries a comment
// about it. Rendering emphasis at all matters: dropping the mark silently would
// make the manual disagree with the web page about which words are stressed.

import React from "react";
import { Link, Text, View } from "@react-pdf/renderer";
import { COLORS, SURFACE, mix } from "@/lib/export/theme";
import { FONT_FAMILY } from "@/lib/export/fonts";
import { styles, type PdfStyle } from "@/lib/export/components/primitives";
import { EmbeddedImage } from "@/lib/export/components/EmbeddedImage";
import { BookmarkView } from "@/lib/export/components/primitives";
import type { CalloutTone, DocBlock, DocInline } from "@/lib/guide/blocks";
import type { ResolvedGuideFigure } from "@/lib/export/guide-figures";

/**
 * Everything the figure arm needs, injected.
 *
 * The renderer does NO disk IO and knows nothing about `public/guide/`: bytes
 * are resolved once, ahead of the render, by `guide-figures.server.ts`. That is
 * what lets the whole renderer run under Vitest — including the missing-figure
 * path, which is the one that must never throw and so is the one most worth
 * being able to test.
 */
export type GuideFigureLookup = ReadonlyMap<string, ResolvedGuideFigure>;

/**
 * A heading's outline ref, supplied by the document.
 *
 * Refs are POSITIONAL across the whole manual (`guideSubsectionBookmarkRef`
 * takes a section index), so this module cannot derive them — it sees one
 * section's blocks and does not know which section it is. Passing a resolver
 * keeps the ref namespace in one place rather than half here and half there.
 * A heading with no ref simply is not bookmarked, which is the right degradation
 * for a depth-3 heading (the outline lists depth-2 only).
 */
export type HeadingBookmark = (
  anchor: string,
) => { title: string; ref: number; parent: number } | undefined;

const CALLOUT_TONE_COLOR: Record<CalloutTone, string> = {
  note: COLORS.mutedForeground,
  warning: COLORS.warning,
  tip: COLORS.primary,
};

const CALLOUT_TONE_LABEL: Record<CalloutTone, string> = {
  note: "Note",
  warning: "Warning",
  tip: "Tip",
};

/**
 * Inline marks, resolved to styles.
 *
 * `italic` becomes a colour shift plus a weight bump rather than an oblique —
 * see the module header. It is deliberately NOT the same treatment as `bold`
 * (600 vs 500 and a different colour) so that a paragraph mixing both still
 * reads as two distinct kinds of emphasis rather than one.
 */
function inlineStyle(run: DocInline): PdfStyle {
  const mono = Boolean(run.code);
  return {
    fontFamily: mono ? FONT_FAMILY.mono : FONT_FAMILY.body,
    fontWeight: run.bold ? 700 : run.italic ? 500 : 400,
    color: run.href
      ? COLORS.primary
      : run.italic && !run.bold
        ? COLORS.mutedForeground
        : COLORS.foreground,
    backgroundColor: mono ? COLORS.muted : undefined,
    fontSize: mono ? 8 : undefined,
  };
}

/**
 * Inline runs. Links ARE clickable here, and that is the one substantive
 * difference from the audit export's `Runs`.
 *
 * It is safe for the reason stated in `blocks.ts`: guide content is first-party
 * and PR-reviewed, so nobody can choose a label and a destination independently
 * to phish a reader. `lib/guide/__tests__/manifest.test.ts` additionally
 * resolves every internal `/guide/*` link against the manifest, so a renamed
 * slug is a red build rather than a dead link in a downloaded manual — which is
 * the failure mode that would otherwise be discovered by a stranger, offline,
 * with no way to report it.
 */
function Runs({ runs }: { runs: readonly DocInline[] }) {
  return (
    <>
      {runs.map((run, i) =>
        run.href ? (
          <Link key={i} src={run.href} style={inlineStyle(run)}>
            {run.text}
          </Link>
        ) : (
          <Text key={i} style={inlineStyle(run)}>
            {run.text}
          </Text>
        ),
      )}
    </>
  );
}

function Figure({ figureId, figures }: { figureId: string; figures: GuideFigureLookup }) {
  const resolved = figures.get(figureId);

  // An id with no registry entry at all. This is a SUPPORTED state, not a bug:
  // the capture crew fills `GUIDE_FIGURES` independently, so a body may
  // reference a figure whose capture has not landed. It draws the same visible
  // placeholder as a failed read rather than throwing or — much worse — quietly
  // rendering nothing where a picture was promised.
  if (!resolved) {
    return (
      <View style={{ marginBottom: 10 }} wrap={false}>
        <EmbeddedImage
          dataUri={null}
          unavailableReason={`no capture is registered for figure "${figureId}" yet`}
        />
      </View>
    );
  }

  const { figure, dataUri, unavailableReason } = resolved;
  const stale = figure.staleAcknowledged;

  return (
    <View style={{ marginBottom: 12 }} wrap={false}>
      {/* Chrome bar naming the depicted route. A framed picture reads as *a
          picture of the app*; an unframed screenshot dropped into prose reads as
          *the app, apparently broken*. The web surface frames it identically. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          backgroundColor: mix(COLORS.foreground, SURFACE, 0.05),
          borderTopLeftRadius: 4,
          borderTopRightRadius: 4,
          borderWidth: 1,
          borderColor: COLORS.border,
          borderStyle: "solid",
          paddingVertical: 3,
          paddingHorizontal: 6,
        }}
      >
        <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: COLORS.border }} />
        <Text style={{ ...styles.mono, fontSize: 6.5, color: COLORS.mutedForeground }}>
          {figure.route}
        </Text>
      </View>

      <EmbeddedImage
        dataUri={dataUri}
        unavailableReason={unavailableReason}
        imageStyle={{
          maxHeight: 300,
          width: "100%",
          borderTopLeftRadius: 0,
          borderTopRightRadius: 0,
        }}
      />

      <Text style={{ ...styles.muted, fontSize: 7.5, marginTop: 3 }}>{figure.caption}</Text>

      {/* Provenance on the face of every figure, both surfaces. A screenshot with
          no capture date is a claim about the product with no expiry on it. */}
      <Text style={{ ...styles.muted, fontSize: 6.5, marginTop: 1 }}>
        {`Captured ${figure.capturedAt.slice(0, 10)} · DevPilot ${figure.theme} · build ${figure.build}`}
      </Text>

      {/* The escape hatch's cost, paid IN THE PRODUCT rather than in CI. Read off
          the static manifest, NOT recomputed: `freshness.ts` needs `node:crypto`
          and the repo source to hash, and the lambda rendering this has neither.
          That is exactly why the acknowledgement is a typed constant. */}
      {stale ? (
        <View
          style={{
            marginTop: 4,
            borderLeftWidth: 2,
            borderLeftColor: COLORS.warning,
            borderLeftStyle: "solid",
            backgroundColor: mix(COLORS.warning, SURFACE, 0.07),
            paddingVertical: 3,
            paddingHorizontal: 6,
            borderRadius: 2,
          }}
        >
          <Text style={{ fontSize: 6.5, fontWeight: 600, color: COLORS.warning }}>
            {`MAY BE OUT OF DATE · since ${stale.since}`}
          </Text>
          <Text style={{ ...styles.muted, fontSize: 6.5, marginTop: 1 }}>{stale.note}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Block({
  block,
  figures,
  headingBookmark,
}: {
  block: DocBlock;
  figures: GuideFigureLookup;
  headingBookmark?: HeadingBookmark;
}) {
  switch (block.type) {
    case "paragraph":
      return (
        <Text style={{ ...styles.body, marginBottom: 6, lineHeight: 1.55 }}>
          <Runs runs={block.runs} />
        </Text>
      );

    case "heading": {
      // Only depth-2 headings become outline entries — they are what
      // `guideSubsections()` derives and what the sidebar and TOC list, so a
      // depth-3 entry would make the manual's outline richer than every other
      // surface's navigation and stop the two agreeing.
      const bookmark = block.depth === 2 ? headingBookmark?.(block.anchor) : undefined;
      return (
        <BookmarkView bookmark={bookmark} style={{ marginTop: block.depth === 2 ? 12 : 8 }}>
          <Text
            style={
              block.depth === 2
                ? { ...styles.h2, fontSize: 13, marginBottom: 4 }
                : { ...styles.h3, fontSize: 10.5, marginBottom: 3 }
            }
          >
            <Runs runs={block.runs} />
          </Text>
          {block.depth === 2 ? (
            <View
              style={{
                height: 2,
                width: 20,
                backgroundColor: COLORS.primary,
                borderRadius: 1,
                marginBottom: 6,
              }}
            />
          ) : null}
        </BookmarkView>
      );
    }

    case "list":
      return (
        <View style={{ marginBottom: 6 }}>
          {block.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", marginBottom: 2 }}>
              <Text style={{ ...styles.body, width: 14, color: COLORS.mutedForeground }}>
                {block.ordered ? `${i + 1}.` : "•"}
              </Text>
              <Text style={{ ...styles.body, flex: 1, lineHeight: 1.5 }}>
                <Runs runs={item} />
              </Text>
            </View>
          ))}
        </View>
      );

    case "code":
      return (
        <View
          style={{
            backgroundColor: mix(COLORS.foreground, SURFACE, 0.05),
            borderRadius: 3,
            borderLeftWidth: 2,
            borderLeftColor: COLORS.primary,
            borderLeftStyle: "solid",
            padding: 7,
            marginBottom: 7,
          }}
        >
          {block.lang ? (
            <Text style={{ ...styles.eyebrow, marginBottom: 2 }}>{block.lang}</Text>
          ) : null}
          <Text
            style={{
              fontFamily: FONT_FAMILY.mono,
              fontSize: 7.5,
              color: COLORS.foreground,
              lineHeight: 1.45,
            }}
          >
            {block.value}
          </Text>
        </View>
      );

    case "callout": {
      const tone = CALLOUT_TONE_COLOR[block.tone];
      return (
        <View
          style={{
            borderLeftWidth: 2,
            borderLeftColor: tone,
            borderLeftStyle: "solid",
            backgroundColor: mix(tone, SURFACE, 0.06),
            paddingVertical: 5,
            paddingHorizontal: 8,
            borderRadius: 2,
            marginBottom: 7,
          }}
        >
          <Text
            style={{
              fontSize: 6.5,
              fontWeight: 600,
              letterSpacing: 0.6,
              color: tone,
              marginBottom: 2,
            }}
          >
            {CALLOUT_TONE_LABEL[block.tone].toUpperCase()}
          </Text>
          <Text style={{ ...styles.body, lineHeight: 1.5 }}>
            <Runs runs={block.runs} />
          </Text>
        </View>
      );
    }

    case "table":
      // Columns share width evenly: react-pdf has no content-driven table
      // layout, and guessing per-column widths from cell length looks worse than
      // an even split at this density. Same call as the audit export's tables.
      return (
        <View
          style={{
            borderWidth: 1,
            borderColor: COLORS.border,
            borderStyle: "solid",
            borderRadius: 3,
            marginBottom: 8,
            overflow: "hidden",
          }}
        >
          <View style={{ flexDirection: "row", backgroundColor: COLORS.muted }}>
            {block.header.map((cell, i) => (
              <View key={i} style={{ flex: 1, padding: 5 }}>
                <Text style={{ fontSize: 8, fontWeight: 600, color: COLORS.foreground }}>
                  <Runs runs={cell} />
                </Text>
              </View>
            ))}
          </View>
          {block.rows.map((row, r) => (
            <View
              key={r}
              style={{
                flexDirection: "row",
                borderTopWidth: 1,
                borderTopColor: COLORS.border,
                borderTopStyle: "solid",
              }}
            >
              {row.map((cell, c) => (
                <View key={c} style={{ flex: 1, padding: 5 }}>
                  <Text style={{ fontSize: 8, color: COLORS.foreground }}>
                    <Runs runs={cell} />
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );

    case "figure":
      return <Figure figureId={block.figureId} figures={figures} />;

    case "rule":
      return <View style={styles.rule} />;

    default: {
      // Exhaustiveness. If this stops compiling, a `DocBlock` member was added
      // and this renderer has not decided how to draw it — which is the entire
      // point of the check. Decide here; do not widen the type to silence it.
      const never: never = block;
      return never;
    }
  }
}

export function GuideBlocks({
  blocks,
  figures,
  headingBookmark,
}: {
  blocks: readonly DocBlock[];
  figures: GuideFigureLookup;
  headingBookmark?: HeadingBookmark;
}) {
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} figures={figures} headingBookmark={headingBookmark} />
      ))}
    </>
  );
}
