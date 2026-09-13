// Truncation that cannot split a character.
//
// `s.slice(0, n)` counts UTF-16 CODE UNITS, and every non-BMP character (emoji,
// and the maths/CJK-extension planes) is a two-unit surrogate pair. Slicing at a
// fixed index therefore lands mid-pair whenever a title happens to put an emoji
// on the boundary, leaving a LONE SURROGATE — an unpaired half of a character
// that is not valid text. Ticket titles here are routinely agent-authored and
// routinely carry emoji, so this is reachable from ordinary data rather than
// from anything adversarial.
//
// Where that lands: the three fixed-index truncations in the export chrome —
// the running header (`oneLine`), the outline label (`bookmarkLabel`), and the
// ticket document's `title.slice(0, 70)`. All three feed either the text shaper
// or a PDF outline string, neither of which has a defined behaviour for a lone
// surrogate.
//
// `Array.from` iterates by CODE POINT, so a surrogate pair is one element and a
// slice can never divide it. It does not merge grapheme clusters (a flag, or an
// emoji with a skin-tone modifier, is several code points), so a truncation can
// still cut such a cluster into its parts — but every part remains a valid
// character, which is the property that matters here.

/** The ellipsis costs one character, so the kept text is `max - 1` code points. */
export function truncateChars(s: string, max: number): string {
  if (max <= 0) return "";
  const points = Array.from(s);
  if (points.length <= max) return s;
  return `${points.slice(0, max - 1).join("")}…`;
}

/**
 * Collapse to a single line and truncate.
 *
 * A title carrying a newline wraps the running header into two rows and pushes
 * it into the body text, so the flattening is not cosmetic.
 */
export function oneLineTruncated(s: string, max: number): string {
  return truncateChars(s.replace(/\s+/g, " ").trim(), max);
}
