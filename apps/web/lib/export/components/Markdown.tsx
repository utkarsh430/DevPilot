// Draw `MdBlock`s (see `lib/export/markdown.ts`) with react-pdf primitives.
//
// This component is the ONLY consumer of the markdown lowering, and it is
// deliberately dumb: it has no parser, no escaping, and no idea what a URL is.
// Every decision that could be a security decision — is this HTML, may this link
// be clickable, how long may a code block be — already happened in the pure
// module. Here there is nothing left to get wrong; a block type this switch does
// not handle simply is not drawn, and there is no `<Link>` to misuse.

import React from "react";
import { Text, View } from "@react-pdf/renderer";
import { COLORS, SURFACE, mix } from "@/lib/export/theme";
import { FONT_FAMILY } from "@/lib/export/fonts";
import type { MdBlock, MdInline } from "@/lib/export/markdown";
import { styles, type PdfStyle } from "@/lib/export/components/primitives";

const HEADING_SIZE: Record<number, number> = { 1: 13, 2: 12, 3: 11, 4: 10, 5: 9.5, 6: 9.5 };

function inlineStyle(run: MdInline): PdfStyle {
  return {
    fontFamily: run.code || run.linkUrl ? FONT_FAMILY.mono : FONT_FAMILY.body,
    fontWeight: run.bold ? 600 : 400,
    // react-pdf resolves italic through a registered `fontStyle: italic` face.
    // We register upright faces only, so emphasis is carried by color rather
    // than a synthetic oblique (which react-pdf does not do and would warn on).
    color: run.italic || run.linkUrl ? COLORS.mutedForeground : COLORS.foreground,
    textDecoration: run.strike ? "line-through" : undefined,
    backgroundColor: run.code ? COLORS.muted : undefined,
    fontSize: run.code || run.linkUrl ? 8 : undefined,
  };
}

/**
 * Inline runs, ALL inert.
 *
 * There is deliberately no `<Link>` here and no `href` on `MdInline` to hang one
 * off. Every markdown string this component draws is untrusted (agent comments,
 * handoffs, ticket descriptions, model narration), and a markdown link lets its
 * author pick the visible label and the destination independently — a clickable
 * "[the QA report](https://evil.example)" inside a document an auditor trusts is
 * a phishing affordance with no upside. The pure module appends the URL as inert
 * text instead, so the reader sees where it would have gone.
 *
 * The one clickable link in this document — the Langfuse trace deep link — is
 * built directly in `TicketSection` from a system-generated URL, not from
 * markdown, which is exactly the distinction being drawn.
 */
function Runs({ runs }: { runs: readonly MdInline[] }) {
  return (
    <>
      {runs.map((run, i) => (
        <Text key={i} style={inlineStyle(run)}>
          {run.text}
        </Text>
      ))}
    </>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.type) {
    case "paragraph":
      return (
        <Text style={{ ...styles.body, marginBottom: 4 }}>
          <Runs runs={block.runs} />
        </Text>
      );
    case "heading":
      return (
        <Text
          style={{
            fontFamily: FONT_FAMILY.body,
            fontWeight: 600,
            fontSize: HEADING_SIZE[block.depth] ?? 10,
            color: COLORS.foreground,
            marginTop: 4,
            marginBottom: 3,
          }}
        >
          <Runs runs={block.runs} />
        </Text>
      );
    case "list":
      return (
        <View style={{ marginBottom: 4 }}>
          {block.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", marginBottom: 1.5 }}>
              <Text style={{ ...styles.body, width: 14, color: COLORS.mutedForeground }}>
                {block.ordered ? `${i + 1}.` : "•"}
              </Text>
              <Text style={{ ...styles.body, flex: 1 }}>
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
            borderLeftColor: COLORS.border,
            borderLeftStyle: "solid",
            padding: 6,
            marginBottom: 4,
          }}
        >
          {block.lang ? (
            <Text style={{ ...styles.eyebrow, marginBottom: 2 }}>{block.lang}</Text>
          ) : null}
          <Text style={{ fontFamily: FONT_FAMILY.mono, fontSize: 7.5, color: COLORS.foreground }}>
            {block.value}
          </Text>
        </View>
      );
    case "blockquote":
      return (
        <View
          style={{
            borderLeftWidth: 2,
            borderLeftColor: COLORS.primary,
            borderLeftStyle: "solid",
            paddingLeft: 7,
            marginBottom: 4,
          }}
        >
          <Text style={{ ...styles.body, color: COLORS.mutedForeground }}>
            <Runs runs={block.runs} />
          </Text>
        </View>
      );
    case "table":
      // GFM table as a flexed grid. Columns share width evenly: react-pdf has no
      // content-driven table layout, and guessing per-column widths from cell
      // length looks worse than an even split at this density.
      return (
        <View
          style={{
            borderWidth: 1,
            borderColor: COLORS.border,
            borderStyle: "solid",
            borderRadius: 3,
            marginBottom: 5,
            overflow: "hidden",
          }}
        >
          <View style={{ flexDirection: "row", backgroundColor: COLORS.muted }}>
            {block.header.map((cell, i) => (
              <View key={i} style={{ flex: 1, padding: 4 }}>
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
                <View key={c} style={{ flex: 1, padding: 4 }}>
                  <Text style={{ fontSize: 8, color: COLORS.foreground }}>
                    <Runs runs={cell} />
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    case "rule":
      return <View style={styles.rule} />;
    default:
      return null;
  }
}

export function Markdown({ blocks }: { blocks: readonly MdBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </>
  );
}
