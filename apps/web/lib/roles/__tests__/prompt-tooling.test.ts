import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROLES } from "@/lib/roles";
import {
  extractToolingClaims,
  flattenPromptSource,
  isBinDeclared,
  unresolvedToolingClaims,
} from "@/lib/roles/prompt-tooling";

// Repo root, from apps/web/lib/roles/__tests__.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const MANIFESTS = [
  join(REPO_ROOT, "package.json"),
  join(REPO_ROOT, "apps", "web", "package.json"),
  join(REPO_ROOT, "apps", "runner", "package.json"),
];

/**
 * Names DIRECTLY declared by a workspace package. Deliberately not "what
 * resolves": `playwright` resolves in apps/web only because promptfoo depends
 * on it, which is exactly how the defect this guards stayed invisible.
 */
function declaredDependencies(): Set<string> {
  const declared = new Set<string>();
  for (const path of MANIFESTS) {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.dependencies ?? {})) declared.add(name);
    for (const name of Object.keys(pkg.devDependencies ?? {})) declared.add(name);
  }
  return declared;
}

/**
 * The prompt text an agent actually receives, per role - the composed catalog
 * rather than the source files. Scanning source would also read doc comments,
 * which legitimately quote broken commands when explaining why they are broken
 * (this module's own header does).
 */
function rolePromptTexts(): { role: string; text: string }[] {
  return Object.entries(ROLES).map(([role, config]) => ({
    role,
    text: [config.systemPrompt, config.safetyContract ?? ""].join("\n"),
  }));
}

describe("role prompts do not name tooling the workspace lacks", () => {
  // THE GUARD. Both roles fixed in this PR failed here before the fix, each
  // claiming `pnpm exec playwright test`. See prompt-tooling.ts for why that
  // command is worse for an agent than a clean "not installed" failure.
  it("every `pnpm exec <bin>` a role prompt names resolves to a declared dependency", () => {
    const declared = declaredDependencies();
    const offenders: string[] = [];

    for (const { role, text } of rolePromptTexts()) {
      for (const claim of unresolvedToolingClaims(extractToolingClaims(text), declared)) {
        offenders.push(
          `${role}: \`${claim.command}\` - no declared dependency provides \`${claim.bin}\``,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  // Non-vacuity. The assertion above passes trivially if the catalog scan is
  // empty or the extractor is broken, and a silently-empty scan is the failure
  // mode this shape of test is most prone to.
  it("the scan reaches real, non-empty role prompts", () => {
    const texts = rolePromptTexts();
    expect(texts.length).toBeGreaterThan(40);
    expect(texts.every(({ text }) => text.trim().length > 0)).toBe(true);
    // The catalog must include the two roles this PR fixed, or the guard would
    // not have covered them.
    const roles = texts.map(({ role }) => role);
    expect(roles).toContain("qa_automation_engineer");
    expect(roles).toContain("sdet");
  });
});

describe("extractToolingClaims", () => {
  it("finds a command written inline", () => {
    expect(extractToolingClaims("run `pnpm exec playwright test --reporter=line`")).toEqual([
      { bin: "playwright", command: "pnpm exec playwright test --reporter=line" },
    ]);
  });

  // Prompts are authored as concatenated string literals. The catalog scan sees
  // them already joined, but the extractor is also usable against source, and a
  // command split across the join must not slip through there.
  it("finds a command split across a string-concatenation boundary", () => {
    const source = '"     - `pnpm exec playwright test" +\n    " --reporter=line` if the change"';
    expect(extractToolingClaims(source).map((c) => c.bin)).toEqual(["playwright"]);
  });

  it("ignores plain scripts, which are conventional rather than tooling claims", () => {
    expect(extractToolingClaims("run `pnpm test` and `pnpm typecheck`")).toEqual([]);
  });

  it("returns nothing for prompts that name no tooling", () => {
    expect(extractToolingClaims("run `git status` then commit")).toEqual([]);
  });

  it("flattenPromptSource joins concatenated literals", () => {
    expect(flattenPromptSource('"foo" +\n    "bar"')).toBe('"foobar"');
  });
});

describe("isBinDeclared", () => {
  it("accepts a bin whose package is declared under its own name", () => {
    expect(isBinDeclared("vitest", new Set(["vitest"]))).toBe(true);
  });

  it("accepts a bin provided by a differently-named package", () => {
    expect(isBinDeclared("playwright", new Set(["@playwright/test"]))).toBe(true);
  });

  // The property that makes the check meaningful: `playwright` is reachable in
  // apps/web today via promptfoo, and must still read as absent.
  it("rejects a bin that is only transitively available", () => {
    expect(isBinDeclared("playwright", new Set(["promptfoo"]))).toBe(false);
  });
});
