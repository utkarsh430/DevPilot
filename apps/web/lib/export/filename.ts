// Content-Disposition filename derivation for the ticket export — PURE.
//
// Why this is its own module with its own tests
// ─────────────────────────────────────────────
// The filename embeds the ticket TITLE, and a title can be agent-authored (WI-14
// `devpilot_create_ticket`) or simply pasted by an operator. It therefore lands,
// unmodified, inside a RESPONSE HEADER — which is a header-injection sink: a CR
// or LF in the value can terminate the header and let the rest of the string be
// read as additional headers (or a response body). A quote can close the
// `filename="…"` token early and let the remainder be parsed as further
// Content-Disposition parameters.
//
// So we never interpolate a raw title. `buildContentDisposition` emits BOTH
// forms of the RFC 6266 header:
//
//   • `filename=` — an ASCII-only, quote-free, control-free fallback that every
//     client understands. Non-ASCII is dropped here, not transliterated.
//   • `filename*=` — RFC 5987 / RFC 8187 `UTF-8''<pct-encoded>` so a unicode
//     title survives on clients that implement it. Percent-encoding is itself
//     the escape: the encoded value cannot contain CR, LF, or a quote.
//
// Modern browsers prefer `filename*` when both are present (RFC 6266 §4.3).

/** Max slug length. Long enough to identify a ticket, short of any OS limit. */
export const FILENAME_SLUG_MAX = 60;

/**
 * Turn an arbitrary (possibly agent-authored) title into a lowercase, ASCII,
 * hyphen-separated slug. Total — never throws, always returns something usable.
 *
 * Everything outside `[a-z0-9]` collapses to a hyphen, which means CR/LF, quotes,
 * semicolons, backslashes and path separators are structurally unable to survive
 * — the allowlist is what makes this safe, not a blocklist of bad characters.
 * An empty result (a title that is entirely emoji, CJK, or whitespace) falls
 * back to `"ticket"` so we never emit a bare `DevPilot-42-.pdf`.
 */
export function slugifyTitle(title: string, max: number = FILENAME_SLUG_MAX): string {
  const slug = title
    .normalize("NFKD")
    // Strip combining marks so "é" degrades to "e" rather than to a hyphen.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "ticket";
}

/**
 * The document's base filename (no extension): `DevPilot-42-fix-the-thing`, or
 * `DevPilot-<short-id>-…` when the ticket has no number (a project-less ticket
 * has no per-project counter — see `formatTicketKey`).
 */
export function ticketExportBasename(args: {
  ticketNumber: number | null;
  ticketId: string;
  title: string;
}): string {
  const key =
    args.ticketNumber !== null && Number.isFinite(args.ticketNumber)
      ? `DevPilot-${args.ticketNumber}`
      : `DevPilot-${args.ticketId.replace(/-/g, "").slice(0, 8)}`;
  return `${key}-${slugifyTitle(args.title)}`;
}

/** Project export basename: `devpilot-project-<slug>-<YYYY-MM-DD>`. */
export function projectExportBasename(args: { name: string; generatedAt: string }): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(args.generatedAt)?.[0] ?? "export";
  return `devpilot-project-${slugifyTitle(args.name)}-${day}`;
}

/**
 * RFC 5987 / RFC 8187 `ext-value` encoding for the `filename*` parameter.
 * `encodeURIComponent` already percent-encodes every byte outside the unreserved
 * set; we additionally encode the few characters it leaves alone that are NOT in
 * RFC 8187's `attr-char` (`!`, `'`, `(`, `)`, `*`) so the token can't be
 * misparsed.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Build a complete, injection-safe `Content-Disposition` header value.
 *
 * `basename` is expected to already be slug-safe (see `ticketExportBasename`),
 * but this function does NOT trust that: it re-strips anything non-ASCII or
 * structural from the plain `filename=` token, so the header is safe even if a
 * future caller hands it raw text.
 */
export function buildContentDisposition(basename: string, extension = "pdf"): string {
  const full = `${basename}.${extension}`;
  // Defence in depth: the plain token is re-filtered to printable ASCII minus
  // the characters that carry meaning inside a quoted-string (`"` and `\`) and
  // minus every control char (CR/LF are in this range — this is the injection
  // guard).
  //
  // The emptiness check is on the STEM, not on the whole string: a fully
  // non-ASCII name (`日本語`) filters down to `.pdf`, which is non-empty and so
  // passed a naive check — and `filename=".pdf"` is a hidden dotfile, not a
  // usable download.
  const asciiStem = basename
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\;]/g, "-")
    .trim();
  const safeAscii = asciiStem.length > 0 ? `${asciiStem}.${extension}` : `export.${extension}`;
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeRfc5987(full)}`;
}
