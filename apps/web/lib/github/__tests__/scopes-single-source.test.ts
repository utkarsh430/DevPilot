// Structural proof that the GitHub OAuth scope set has exactly ONE home.
//
// WHY A SOURCE SCAN. Before this, the scope string was written out four times:
// `lib/github/oauth.ts`, `lib/auth/browser.ts`, the settings client component,
// and once more by hand as JSX `<Badge>`s listing the scopes to the user. Three
// of those are separate OAuth entry points. Adding `workflow` to some but not
// all of them is a silent half-fix with a nasty shape: the operator clicks
// "Reconnect", GitHub shows a consent screen, he approves - and the flow he
// happened to use asked for the old set, so nothing changes and the next CI
// push is rejected exactly as before.
//
// `scopes.test.ts` proves the constant is right. Only a scan can prove nobody
// re-declared it, because a duplicate literal is valid TypeScript that
// typechecks, renders, and passes every other test.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The one file allowed to spell the scopes out. */
const SOURCE_OF_TRUTH = path.join("lib", "github", "scopes.ts");

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".turbo", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(webRoot).map((f) => ({
  rel: path.relative(webRoot, f),
  text: readFileSync(f, "utf8"),
}));

describe("GitHub OAuth scopes have a single source", () => {
  it("finds the tree (guards against a scan that vacuously passes on zero files)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.rel === SOURCE_OF_TRUTH)).toBe(true);
  });

  it("no file outside lib/github/scopes.ts declares a GitHub scope literal", () => {
    // Matches an assignment of a string that looks like a GitHub OAuth scope
    // set - i.e. containing `repo` alongside another scope token. Deliberately
    // catches the pre-existing "repo read:user user:email" shape AND any
    // reordered or re-spelled variant someone writes next.
    const SCOPE_LITERAL = /=\s*"[^"]*\brepo\b[^"]*\b(?:workflow|read:user|user:email)\b[^"]*"/;
    const offenders = files
      .filter((f) => f.rel !== SOURCE_OF_TRUTH && SCOPE_LITERAL.test(f.text))
      .map((f) => f.rel);
    expect(
      offenders,
      `Declare scopes only in ${SOURCE_OF_TRUTH} and import GITHUB_OAUTH_SCOPES from there.`,
    ).toEqual([]);
  });

  it("every signInWithOAuth github call passes the shared constant", () => {
    // The literal check above can be dodged by inlining the string straight
    // into the options object. This closes that: any GitHub handshake must
    // reference the shared identifier by name.
    const callers = files.filter(
      (f) => f.text.includes('provider: "github"') && f.text.includes("signInWithOAuth"),
    );
    expect(callers.length, "expected at least one GitHub OAuth caller").toBeGreaterThan(0);
    for (const f of callers) {
      expect(f.text, `${f.rel} must use GITHUB_OAUTH_SCOPES from ${SOURCE_OF_TRUTH}`).toContain(
        "GITHUB_OAUTH_SCOPES",
      );
    }
  });
});
