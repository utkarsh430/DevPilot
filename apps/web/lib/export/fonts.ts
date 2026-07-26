// Brand font registration for the PDF export.
//
// Typography mirrors the app (AGENTS.md — brand identity): Bricolage Grotesque
// for display and Inter for UI/body. The mono face is the ONE deliberate
// deviation — see "Why Roboto Mono and not JetBrains Mono" below.
//
// ── Why .woff, and not .woff2 or .ttf ───────────────────────────────────────
// The `@fontsource/*` packages ship `.woff` and `.woff2` ONLY — there is no
// `.ttf` in the published tarballs, so the obvious "register the static TTF"
// plan is not available. Of the two that do ship:
//
//   • `.woff`  — works. Embeds correctly and the glyphs subset cleanly.
//   • `.woff2` — BROKEN. react-pdf 4.5.1 → @react-pdf/pdfkit → fontkit 2.0.4
//     reconstructs the `glyf` table from woff2's transformed form, and that
//     decoder throws `RangeError: Offset is outside the bounds of the DataView`
//     inside `_addGlyph` for realistic text. It "works" for a handful of glyphs
//     and blows up once the subset grows, which is the worst possible failure
//     shape: green in a smoke test, 500 on a real ticket.
//
// So: `.woff`, deliberately, and `FONT_FILES` names each file explicitly rather
// than templating the extension — a future "let's use woff2, it's smaller" edit
// should have to read this comment first.
//
// ── Why Roboto Mono and not JetBrains Mono ──────────────────────────────────
// The app's mono face is JetBrains Mono (AGENTS.md — brand identity), and this
// document deliberately does NOT use it. JetBrains Mono ships programming
// LIGATURES via the `calt` GSUB feature, and fontkit 2.0.4 throws
// `RangeError: Offset is outside the bounds of the DataView` while decoding the
// resulting composite ligature glyphs in `@fontsource/jetbrains-mono`'s latin
// subset. It fails inside `font.layout()` — before subsetting, before any
// react-pdf code — for every one of:
//
//     "://"  "//"  "->"  "=>"  "!="  "--"  "..."
//
// which is to say: every repo URL, every `--flag`, every `=>` in a code block,
// every "…" — exactly what an audit document made of shas, commands, ids and
// agent code narration is full of. This is not an edge case here; it is most
// real exports. react-pdf hardcodes `features: undefined` into its
// `font.layout()` call (@react-pdf/textkit), so `calt` cannot be disabled from
// our side, and JetBrains Mono NL (the official no-ligature variant) is not
// published on npm.
//
// Roboto Mono was chosen because it declares NO GSUB features at all, so the
// failure mode is unreachable by construction rather than avoided by luck. (IBM
// Plex Mono was also evaluated and still fails on real code — it carries
// frac/numr/dnom.) `__tests__/fonts.test.ts` lays out the strings above through
// the registered mono face, so restoring JetBrains Mono "for brand consistency"
// fails a test instead of 500-ing a customer's export.
//
// ── The DI split ────────────────────────────────────────────────────────────
// `registerExportFonts` takes the react-pdf `Font` object as an argument instead
// of importing it. That keeps this module free of both `server-only` and the PDF
// runtime, so the render smoke test can register fonts and draw a real document
// under Vitest. `fonts.server.ts` is the thin server wrapper that supplies the
// real `Font`. Same pure/`.server` shape as `lib/projects/doc-extract.ts`.
//
// ── Known gap: non-Latin + emoji ────────────────────────────────────────────
// We register the `latin` subsets only. A ticket titled in CJK, Cyrillic, Hebrew,
// Arabic, or carrying emoji renders those runs as tofu (□). react-pdf resolves a
// font per family, not per glyph, so fixing this means registering a broad
// fallback (Noto Sans + Noto Color Emoji) and paying its size on every render.
// Accepted for v1 and recorded here rather than discovered later.

export const FONT_FAMILY = {
  display: "BricolageGrotesque",
  body: "Inter",
  /** Roboto Mono, NOT JetBrains Mono — see the header. */
  mono: "RobotoMono",
} as const;

/**
 * Strings that exercise the ligature bug this module's mono choice exists to
 * avoid. Exported so the font test can assert the registered mono face lays
 * every one of them out without throwing.
 */
export const LIGATURE_BAIT = [
  "://",
  "//",
  "->",
  "=>",
  "!=",
  "--",
  "...",
  "https://github.com/utkarsh430/DevPilot",
  "const x = () => 1;",
  "pnpm test -- --coverage",
] as const;

/**
 * The exact package-relative file for each (family, weight) we draw with.
 * Resolved through the caller's module resolution, so pnpm's strict layout
 * applies and a missing dependency is a loud resolve error, not a silent
 * Helvetica fallback.
 */
export const FONT_FILES: ReadonlyArray<{
  family: string;
  weight: 400 | 500 | 600 | 700;
  specifier: string;
}> = [
  // Display — only the weights the cover + section headings actually use.
  {
    family: FONT_FAMILY.display,
    weight: 700,
    specifier: "@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff",
  },
  {
    family: FONT_FAMILY.display,
    weight: 600,
    specifier: "@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-600-normal.woff",
  },
  // Body.
  {
    family: FONT_FAMILY.body,
    weight: 400,
    specifier: "@fontsource/inter/files/inter-latin-400-normal.woff",
  },
  {
    family: FONT_FAMILY.body,
    weight: 500,
    specifier: "@fontsource/inter/files/inter-latin-500-normal.woff",
  },
  {
    family: FONT_FAMILY.body,
    weight: 600,
    specifier: "@fontsource/inter/files/inter-latin-600-normal.woff",
  },
  {
    family: FONT_FAMILY.body,
    weight: 700,
    specifier: "@fontsource/inter/files/inter-latin-700-normal.woff",
  },
  // Data / ids. Roboto Mono — no GSUB features, so no ligature glyphs exist to
  // trip fontkit. See the header before changing this to anything else.
  {
    family: FONT_FAMILY.mono,
    weight: 400,
    specifier: "@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff",
  },
  {
    family: FONT_FAMILY.mono,
    weight: 600,
    specifier: "@fontsource/roboto-mono/files/roboto-mono-latin-600-normal.woff",
  },
];

/** The bits of react-pdf's `Font` we use. Structural, so the test can pass the real one. */
export type FontRegistrar = {
  register: (args: { family: string; fonts: Array<{ src: string; fontWeight?: number }> }) => void;
  registerHyphenationCallback: (cb: (word: string) => string[]) => void;
};

/** Resolves a package specifier to an absolute path (`require.resolve`). */
export type SpecifierResolver = (specifier: string) => string;

let registered = false;

/**
 * Register every brand face. IDEMPOTENT — react-pdf's font store is module-level
 * global, and a serverless instance renders many documents; re-registering on
 * each request would re-read and re-parse ~8 font files per PDF for nothing.
 *
 * Also disables react-pdf's default hyphenation. Its built-in callback splits
 * words on inferred syllable boundaries, which mangles the two things this
 * document is mostly made of: identifiers (`devpilot_move_ticket`) and shas.
 * A wrapped-but-whole word is strictly better than a hyphenated identifier in a
 * record someone will copy values out of.
 */
export function registerExportFonts(
  Font: FontRegistrar,
  resolve: SpecifierResolver,
  { force = false }: { force?: boolean } = {},
): void {
  if (registered && !force) return;

  const byFamily = new Map<string, Array<{ src: string; fontWeight: number }>>();
  for (const f of FONT_FILES) {
    const list = byFamily.get(f.family) ?? [];
    list.push({ src: resolve(f.specifier), fontWeight: f.weight });
    byFamily.set(f.family, list);
  }
  for (const [family, fonts] of byFamily) {
    Font.register({ family, fonts });
  }
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

/** Test seam: forget that registration happened. */
export function resetExportFontsForTest(): void {
  registered = false;
}
