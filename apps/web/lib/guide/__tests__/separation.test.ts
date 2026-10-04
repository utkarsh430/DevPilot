// `lib/guide/lower.ts` and `lib/export/markdown.ts` must remain SEPARATE.
//
// These are SOURCE SCANS, and that is deliberate. The claim being defended is
// about every FUTURE path — "no markdown link in an audit PDF is ever clickable"
// — and a runtime test can only ever show that the paths it happened to call
// were not. The specific regression this guards is attractive rather than
// malicious: the two modules look like near-duplicates, "DRY them up" is a
// reasonable-sounding review comment, and the merge would put clickable,
// agent-authored links into a compliance record.
//
// See the header of `lib/guide/lower.ts` for the full trust-domain table.

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = join(__dirname, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(WEB_ROOT, rel), "utf8");
}

/** Strip comments so prose ABOUT a rule is never mistaken for the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const EXPORT_MARKDOWN = "lib/export/markdown.ts";
const GUIDE_LOWER = "lib/guide/lower.ts";

describe("both modules still exist and are distinct files", () => {
  it("neither has been deleted in favour of the other", () => {
    expect(read(EXPORT_MARKDOWN).length).toBeGreaterThan(0);
    expect(read(GUIDE_LOWER).length).toBeGreaterThan(0);
  });
});

describe("MdInline must never gain an href", () => {
  it("the type declares no href field", () => {
    const src = code(read(EXPORT_MARKDOWN));
    const type = /export type MdInline = \{([\s\S]*?)\n\};/.exec(src);
    expect(type, "MdInline type declaration not found — was it renamed?").not.toBeNull();
    expect(type?.[1]).not.toMatch(/\bhref\b/);
  });

  it("no object literal or type member in the module carries an href key", () => {
    // Scoped to the KEY position (`{ href:` / `, href:` / a type member) rather
    // than to the bare word. `isSafeHref(href: string)` is a local parameter and
    // is fine — nothing a renderer can read. What must never appear is `href` as
    // a field on a value handed out of this module, because that is the only
    // way a URL reaches a renderer as a destination rather than as inert text.
    expect(code(read(EXPORT_MARKDOWN))).not.toMatch(/[{,]\s*href\s*[?]?\s*:/);
  });

  it("nothing reads .href off a node into the output", () => {
    expect(code(read(EXPORT_MARKDOWN))).not.toMatch(/\.href\b/);
  });

  it("the inert-annotation mechanism is still in place", () => {
    // Non-vacuity: the assertions above would also pass if the link handling had
    // been deleted outright, which would silently drop URLs from the record.
    const src = code(read(EXPORT_MARKDOWN));
    expect(src).toMatch(/linkUrl/);
    expect(src).toMatch(/isSafeHref/);
  });

  it("images are still placeholders, never fetched", () => {
    const src = code(read(EXPORT_MARKDOWN));
    expect(src).toMatch(/\[image/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});

describe("the two modules do not reference each other", () => {
  it("the guide lowering does not import the export lowering", () => {
    const src = code(read(GUIDE_LOWER));
    expect(src).not.toMatch(/from\s+["'][^"']*export\/markdown["']/);
    expect(src).not.toMatch(/\bMdInline\b|\bMdBlock\b|\bmarkdownToBlocks\b/);
  });

  it("the export lowering does not import the guide vocabulary", () => {
    const src = code(read(EXPORT_MARKDOWN));
    expect(src).not.toMatch(/from\s+["'][^"']*guide\//);
    expect(src).not.toMatch(/\bDocInline\b|\bDocBlock\b/);
  });
});

describe("the AUDIT export never draws the guide's clickable vocabulary", () => {
  // The other shape this regression could take: keep both modules, but point the
  // audit PDF's renderer at `DocBlock` because it is the richer type. Same
  // outcome — a clickable, agent-authored link in a compliance record.
  //
  // Scoped by filename rather than by directory ON PURPOSE. The guide's OWN PDF
  // document lives under `lib/export/` too (it is the only place permitted to
  // import `@react-pdf/renderer`), and it *must* import `guide/blocks` — that is
  // the whole one-source design. `guide-*` files are the guide's; everything else
  // under `lib/export/` serves the audit artifact and is in scope here.
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "__tests__" && entry !== "node_modules") walk(full, out);
      } else if (/\.tsx?$/.test(entry) && !entry.startsWith("guide-")) {
        out.push(full);
      }
    }
    return out;
  }

  it("holds across every non-guide file under lib/export", () => {
    const files = walk(join(WEB_ROOT, "lib", "export"));
    expect(files.length).toBeGreaterThan(0); // non-vacuity
    const offenders = files
      .filter((file) =>
        /from\s+["'][^"']*guide\/(lower|blocks)["']/.test(code(readFileSync(file, "utf8"))),
      )
      .map((f) => f.slice(WEB_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
