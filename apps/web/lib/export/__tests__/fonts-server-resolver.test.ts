// Source guard on `fonts.server.ts`'s module resolver.
//
// ── Why this test is a SOURCE SCAN and not a render ─────────────────────────
// The bug it guards against does not exist in source. It is created by webpack
// at build time: the parser recognises `createRequire()`, takes the resulting
// require over, and — because the specifier is a variable it cannot analyse —
// wires it to its "missing module" stub, whose `.resolve` throws
// MODULE_NOT_FOUND for EVERY input. The `.woff` files were on disk and
// resolvable the entire time the export was 500-ing.
//
// So NO test that imports source can catch it. `fonts.test.ts` sits right next
// to this file, builds its own `createRequire(import.meta.url)` resolver, hands
// it to the pure `registerExportFonts`, renders a real PDF — and stayed green
// through the whole lifetime of the bug, because a resolver constructed in the
// Vitest process is correct by construction and `fonts.server.ts` is never
// loaded (it is `server-only`, so it cannot even be imported here).
//
// The real proof is `scripts/export-fonts-accept.mjs`, which runs the COMPILED
// module out of `.next/server` and fails red on the pre-fix build. That needs a
// `next build` and so cannot run in `pnpm test`.
//
// This test is the cheap half: it pins the one source property that decides
// whether the compiled output is correct — that font resolution does NOT go
// through a `createRequire` webpack will intercept. It cannot prove the build is
// good; it can stop the specific regression (someone "tidying" the escape hatch
// back into `createRequire`) from landing unnoticed, which matters because no CI
// workflow currently runs `build` + the accept script.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SERVER_SRC = path.join(process.cwd(), "lib/export/fonts.server.ts");
const source = fs.readFileSync(SERVER_SRC, "utf8");

/** Strip comments — this file's own prose names the very things we assert about. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("fonts.server.ts resolver", () => {
  const body = code(source);

  it("resolves through webpack's escape hatch, not a bundler-intercepted require", () => {
    // `__non_webpack_require__` compiles to the emitted chunk's REAL Node require.
    // Without it, webpack substitutes a stub whose `.resolve()` throws
    // `Cannot find module '@fontsource/…woff'` for every specifier — the shipped bug.
    expect(
      body,
      "font resolution must go through __non_webpack_require__; see the comment in fonts.server.ts",
    ).toContain("__non_webpack_require__");
  });

  it("never passes a bare createRequire() result to registerExportFonts", () => {
    // `createRequire` may still appear as the documented non-webpack fallback, but
    // it must not be the value the registrar resolves through on its own. Assert on
    // the resolver binding: whatever `registerExportFonts` is handed must be chosen
    // via the `__non_webpack_require__` guard.
    const resolverDecl = body.match(/const\s+nodeRequire[\s\S]*?;/)?.[0] ?? "";
    expect(resolverDecl, "expected a `const nodeRequire` declaration to inspect").not.toBe("");
    expect(
      resolverDecl.includes("__non_webpack_require__"),
      "nodeRequire must be selected through the __non_webpack_require__ guard, " +
        "not assigned straight from createRequire(...)",
    ).toBe(true);
  });

  it("keeps the resolver wired into ensureExportFonts", () => {
    // Guards the other direction: the escape hatch existing but going unused.
    expect(body).toMatch(
      /registerExportFonts\(\s*Font\s*,\s*\(specifier\)\s*=>\s*nodeRequire\.resolve/,
    );
  });
});
