// One embedded image, or one honest placeholder — the single contract for
// "there should be a picture here" across every document this repo renders.
//
// ── Why this is extracted rather than written twice ─────────────────────────
//
// The pair (draw the data URI / draw a dashed box saying why not) started life
// inline in `TicketSection`'s attachment block, and the manual needs exactly the
// same pair for its figures. Two copies would be two placeholder contracts, and
// they drift in the direction that hurts: the interesting half is the FAILURE
// half, which is by definition the half nobody looks at while working. A second
// copy that quietly omits the reason — or omits the box entirely — turns a
// visible "this could not be loaded" into an invisible gap, which is the one
// outcome both documents are written to avoid.
//
// ── The failure posture, stated once ────────────────────────────────────────
//
// A missing image is DEGRADED, never fatal, and the artifact SAYS SO. Silently
// omitting it is worse than either alternative: a reader who sees a caption but
// no picture, with nothing explaining the absence, has no way to know anything
// was dropped. This is deliberately the opposite of the audit export's
// land-state and verification reads, which fail loud — a missing picture
// misleads nobody, a missing QA verdict does.
//
// ── PNG and JPEG only, and the caller must have checked ─────────────────────
//
// react-pdf's decoder handles PNG, JPEG and SVG. Hand it `data:image/webp` and —
// verified on 4.5.1 — it does NOT throw: it logs `Base64 image invalid format:
// webp` and renders the page with the image SILENTLY MISSING. So the format
// decision belongs upstream, where a rejection can be turned into an
// `unavailableReason` this component will draw. `images.server.ts`
// (EMBEDDABLE_MIMES) and `guide-figures.server.ts` (magic-byte sniff) each do
// that before building a data URI; this component only draws what it is given.

import React from "react";
import { Text, View } from "@react-pdf/renderer";
import { Image } from "@react-pdf/renderer";
import { COLORS } from "@/lib/export/theme";
import { styles } from "@/lib/export/components/primitives";

/**
 * react-pdf's `Image` style type, borrowed from the component itself.
 *
 * Deliberately NOT `PdfStyle` (which is derived from `View`): `Image` accepts a
 * narrower set, and a widened literal — `borderStyle` inferred as `string`
 * rather than `BorderStyleValue` — fails to assign. Borrowing from the actual
 * consumer keeps the caller's object literal narrow enough to pass.
 */
type ImageStyle = React.ComponentProps<typeof Image>["style"];

/** `ImageStyle` admits `undefined`; react-pdf's array form does not. */
function isStyle(s: ImageStyle): s is NonNullable<ImageStyle> {
  return s !== undefined;
}

const FRAME: ImageStyle = {
  objectFit: "contain",
  borderWidth: 1,
  borderColor: COLORS.border,
  borderStyle: "solid",
  borderRadius: 4,
};

export function EmbeddedImage({
  dataUri,
  unavailableReason,
  imageStyle,
  placeholderHeight = 16,
}: {
  /** A `data:image/(png|jpeg);base64,…` URI, or null when it could not be built. */
  dataUri: string | null;
  /** Why there is no image. Drawn to the reader; keep it a cause, not a code. */
  unavailableReason?: string | null;
  /** Extra style for the drawn image (sizing, mostly). Border/radius come free. */
  imageStyle?: ImageStyle;
  /** Vertical padding of the dashed placeholder box. */
  placeholderHeight?: number;
}) {
  if (dataUri) {
    return (
      /* react-pdf's <Image> is a PDF drawing primitive, not an HTML <img>: it
         has no `alt` prop at all (passing one is a type error), and a PDF has no
         accessibility tree for it to land in. The caption each caller draws
         beneath carries the meaning a reader needs. */
      // eslint-disable-next-line jsx-a11y/alt-text
      <Image src={dataUri} style={[FRAME, imageStyle].filter(isStyle).flat()} />
    );
  }

  return (
    <View
      style={{
        ...styles.card,
        borderStyle: "dashed",
        alignItems: "center",
        paddingVertical: placeholderHeight,
      }}
    >
      <Text style={styles.muted}>
        {`Image unavailable — ${unavailableReason ?? "unknown reason"}.`}
      </Text>
    </View>
  );
}
