#!/usr/bin/env node
// Acceptance: the manual route works in the BUILT server, and the figure bytes
// it reads at runtime are actually present in the build's traced file set.
//
// Why this exists as an accept script and not a Vitest test
// ────────────────────────────────────────────────────────
// `lib/export/guide-figures.server.ts` reads its PNGs with `fs.readFile`. Next's
// file tracer follows IMPORTS, and a runtime `readFile` is not one — so the
// dependency is invisible to the bundler, invisible to every source-level test,
// and its failure is SILENT: the manual still renders, with a placeholder where
// each screenshot should be. It works on every developer machine and degrades on
// deploy. That is the same class as the fonts bug documented at length in
// `next.config.ts`, which shipped fatally once.
//
// What it asserts, against real `.next` output:
//   1. the route was built at all;
//   2. its traced file set carries the `@fontsource` `.woff` faces — load-bearing
//      and NOT covered by anything else (an unregistered face THROWS at render);
//   3. its traced file set carries every figure file the registry declares;
//   4. the built server serves a real PDF, with the headers this route promises;
//   5. that PDF contains ZERO figure placeholders — the actual end-to-end claim.
//
// ── An honest caveat about (3), because it was measured ────────────────────
// A clean control build with the `./public/guide/*` entries REMOVED still traced
// them: Next picks the public directory up on its own. So this assertion is not
// currently proving that the config entry works — it is proving that the files
// are traced BY SOMETHING. That is the property that matters, and it keeps its
// value if Next's defaults change or an exclude is added later. Do not upgrade
// the wording to "proves the config entry is required"; it does not.
//
// Run:
//   pnpm --filter @devpilot/web build
//   pnpm --filter @devpilot/web accept:guide

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "/api/guide/manual";
const PORT = Number(process.env.GUIDE_ACCEPT_PORT ?? 3987);

let failures = 0;
function fail(msg) {
  console.error(`\x1b[31mFAIL\x1b[0m  ${msg}`);
  failures += 1;
}
function pass(msg) {
  console.log(`\x1b[32mok\x1b[0m    ${msg}`);
}
function note(msg) {
  console.log(`\x1b[33mnote\x1b[0m  ${msg}`);
}

// ── 1. The route was built ──────────────────────────────────────────────────
const routeDir = path.join(webRoot, ".next", "server", "app", "api", "guide", "manual");
const nftPath = path.join(routeDir, "route.js.nft.json");
if (!fs.existsSync(nftPath)) {
  console.error(
    `\x1b[31mFAIL\x1b[0m  no build output at ${nftPath} — run \`pnpm --filter @devpilot/web build\` first`,
  );
  process.exit(1);
}
pass(`the route was built (${path.relative(webRoot, nftPath)})`);

const traced = JSON.parse(fs.readFileSync(nftPath, "utf8")).files ?? [];

// ── 2. Fonts ────────────────────────────────────────────────────────────────
// Genuinely load-bearing: `registerExportFonts` resolves these at runtime and an
// unresolved face makes react-pdf THROW, so a missing font is a 500, not a
// degradation. This is the assertion that most directly protects the route.
const woff = traced.filter((f) => f.endsWith(".woff"));
if (woff.length === 0) {
  fail("no @fontsource .woff faces traced — the deployed route will throw on its first render");
} else {
  pass(`${woff.length} font faces traced`);
}

// ── 3. Figures ──────────────────────────────────────────────────────────────
// The registry is read from source rather than imported: this script is plain
// node, and `lib/guide/figures.ts` is TypeScript. A regex over the `file:` fields
// is enough — every entry is a string literal written by the capture script.
const figuresSrc = fs.readFileSync(path.join(webRoot, "lib", "guide", "figures.ts"), "utf8");
const declared = [...figuresSrc.matchAll(/^\s*file:\s*"([^"]+)"/gm)].map((m) => m[1]);

if (declared.length === 0) {
  // NOT a pass. The registry being empty makes assertions 3 and 5 VACUOUS, and a
  // green run that proved nothing is precisely how a silent tracing failure
  // survives. Say so, loudly, every time, until the capture crew lands.
  note(
    "GUIDE_FIGURES is EMPTY — the figure-tracing and zero-placeholder checks below " +
      "are vacuous. This run does NOT establish that figures reach the lambda. " +
      "Re-run once captures are committed.",
  );
} else {
  const missing = declared.filter(
    (file) => !traced.some((t) => t.endsWith(`/public/guide/${file}`)),
  );
  if (missing.length > 0) {
    fail(
      `these declared figures are NOT in the route's traced files: ${missing.join(", ")} — ` +
        `the deployed manual will render placeholders for them`,
    );
  } else {
    pass(`all ${declared.length} declared figures are traced`);
  }
}

// ── 4 + 5. Serve it and read it back ────────────────────────────────────────
// Synthetic boot env: `middleware.ts` redirects EVERY path to /setup when the
// two public Supabase vars are absent, and this route reads no database at all,
// so dummy values are enough to exercise the real handler. They are deliberately
// not real credentials — nothing here should be able to reach a live project.
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: webRoot,
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://accept.invalid.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "accept-script-placeholder",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const base = `http://127.0.0.1:${PORT}`;

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}${ROUTE}`, { redirect: "manual" });
      if (res.status !== 0) return res;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

try {
  const res = await waitForServer();
  if (!res) {
    fail(`the built server never answered on ${base}${ROUTE}\n${serverLog.slice(-1500)}`);
  } else if (res.status === 307 || res.status === 302) {
    // The one failure mode worth naming rather than lumping into "not 200":
    // silently accepting a redirect here would make the whole end-to-end half of
    // this script pass without ever rendering a PDF.
    fail(
      `the route redirected to ${res.headers.get("location")} instead of serving — ` +
        `the instance looks unconfigured to middleware.ts`,
    );
  } else if (!res.ok) {
    fail(`the route returned HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  } else {
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("application/pdf")) {
      fail(`content-type was "${type}", not application/pdf`);
    } else {
      pass(`the built server served application/pdf`);
    }

    const disposition = res.headers.get("content-disposition") ?? "";
    if (!/filename\*=UTF-8''/.test(disposition)) {
      fail(`content-disposition is missing the RFC 5987 form: "${disposition}"`);
    } else {
      pass("content-disposition carries both filename forms");
    }

    const etag = res.headers.get("etag");
    if (!etag || etag.startsWith("W/")) {
      fail(`expected a strong ETag, got ${etag ?? "none"}`);
    } else {
      const revalidated = await fetch(`${base}${ROUTE}`, { headers: { "If-None-Match": etag } });
      if (revalidated.status !== 304) {
        fail(`revalidating with the returned ETag gave ${revalidated.status}, not 304`);
      } else {
        pass("a conditional request revalidates to 304");
      }
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      fail("the body is not a PDF");
    } else {
      pass(`the body is a real PDF (${(buf.byteLength / 1024).toFixed(0)} KiB)`);
    }

    // ── 5. Zero placeholders ────────────────────────────────────────────────
    // Extracted with `unpdf`, which this repo already depends on. Text
    // extraction is the right tool for "does this STRING appear" — the caveat in
    // AGENTS.md is about verifying LAYOUT by extraction, which it cannot do.
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(doc, { mergePages: true });
    const placeholders = (text.match(/Image unavailable/g) ?? []).length;
    if (declared.length === 0) {
      note(`${placeholders} placeholder(s) present — expected while GUIDE_FIGURES is empty`);
    } else if (placeholders > 0) {
      fail(
        `${placeholders} figure placeholder(s) in the served manual — ` +
          `the figures did not reach the built server`,
      );
    } else {
      pass("zero figure placeholders in the served manual");
    }
  }
} finally {
  server.kill("SIGTERM");
}

if (failures > 0) {
  console.error(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\n\x1b[32mall checks passed\x1b[0m");
