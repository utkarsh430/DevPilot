#!/usr/bin/env node
// Acceptance: the Vercel preflight against a REAL token.
//
// Why this exists as a manual script and not a Vitest test
// ───────────────────────────────────────────────────────
// The whole point of the preflight is to detect a browser-only grant — whether
// the Vercel for GitHub App is installed on the operator's GitHub account, and
// with what repository scope. Nothing in a unit test can observe that. The
// suite in `lib/vercel/__tests__/` drives an injected fetch against recorded
// wire shapes, which proves the client and the rules are correct; it cannot
// prove that a particular Vercel account is set up. That is this script's job.
//
// It is NOT in CI and never will be: it needs a real credential and makes real
// network calls. Same posture as `export-fonts-accept.mjs`.
//
// It is READ-ONLY. It creates nothing, deploys nothing, and changes nothing on
// the Vercel account. Every call it makes is a GET.
//
// Run:
//   VERCEL_TOKEN=… node apps/web/scripts/vercel-accept.mjs
//   VERCEL_TOKEN=… VERCEL_TEAM_ID=team_… VERCEL_GIT_NAMESPACE=acme \
//     node apps/web/scripts/vercel-accept.mjs
//
// The token is read from the environment ONLY — never a flag (argv is visible
// in `ps` to every user on the host) and never a file in the repo.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function fail(msg) {
  console.error(`${RED}FAIL${RESET}  ${msg}`);
  process.exit(1);
}

const token = (process.env.VERCEL_TOKEN ?? "").trim();
if (!token) {
  fail(
    "VERCEL_TOKEN is not set.\n" +
      "      Mint one at https://vercel.com/account/tokens and run:\n" +
      "        VERCEL_TOKEN=… node apps/web/scripts/vercel-accept.mjs",
  );
}

// The client lives in TypeScript. Rather than duplicating it here — which would
// make this script test a SECOND implementation and prove nothing about the one
// that ships — run the real modules through tsx.
const runner = `
import { runVercelPreflight } from "@/lib/vercel/api";

const report = await runVercelPreflight({
  config: {
    token: process.env.VERCEL_TOKEN ?? null,
    teamId: process.env.VERCEL_TEAM_ID ?? null,
    gitNamespace: process.env.VERCEL_GIT_NAMESPACE ?? null,
  },
  fetchImpl: (url, init) => fetch(url, init),
});

// The report is safe to print: every message in it has already been through the
// scrubber, and api.test.ts asserts the token never appears in one. Printing the
// raw report is itself part of what this script verifies.
process.stdout.write("<<<REPORT>>>" + JSON.stringify(report) + "<<<END>>>");
`;

const res = spawnSync("node", ["--import", "tsx", "--input-type=module", "-e", runner], {
  cwd: webRoot,
  encoding: "utf8",
  env: process.env,
  // Inherit stderr so a module-resolution failure is visible rather than
  // being swallowed into a confusing "no report" message.
  stdio: ["ignore", "pipe", "inherit"],
});

if (res.status !== 0) {
  fail(`the preflight runner exited ${res.status}. See the error above.`);
}

const match = /<<<REPORT>>>([\s\S]*?)<<<END>>>/.exec(res.stdout ?? "");
if (!match) fail("the preflight produced no report.");

/** @type {{ready: boolean, scope: any, checks: Array<any>, namespaceSlugs: string[]}} */
const report = JSON.parse(match[1]);

// ── Assertion 1: the token never appears in what we render ─────────────────
// This is the one security property this script can prove that a unit test
// cannot fully: a REAL Vercel error body, echoing whatever context Vercel
// chooses to echo, still comes back scrubbed.
if (JSON.stringify(report).includes(token)) {
  fail("THE TOKEN APPEARS IN THE RENDERED REPORT. Do not share this output. Fix the scrubber.");
}
console.log(`${GREEN}ok${RESET}    the token does not appear anywhere in the report`);

// ── Report ─────────────────────────────────────────────────────────────────
const ICON = {
  ok: `${GREEN}✓${RESET}`,
  warn: `${YELLOW}!${RESET}`,
  error: `${RED}✗${RESET}`,
  unknown: `${DIM}?${RESET}`,
};

console.log("");
console.log(`Scope: ${JSON.stringify(report.scope)}`);
console.log("");
for (const check of report.checks) {
  console.log(`${ICON[check.level] ?? "?"} ${check.label}`);
  console.log(`  ${check.detail}`);
  if (check.remedy) console.log(`  ${DIM}→ ${check.remedy}${RESET}`);
  if (check.remedyHref) console.log(`  ${DIM}  ${check.remedyHref}${RESET}`);
}
console.log("");

// ── Assertion 2: the shape is complete ─────────────────────────────────────
// Guards against a rules change that silently drops a check — the operator
// would read a shorter list as "fewer problems" rather than "less checked".
for (const required of ["token", "scope", "github_app"]) {
  if (!report.checks.some((c) => c.id === required)) {
    fail(`the report is missing the "${required}" check`);
  }
}
console.log(`${GREEN}ok${RESET}    all mandatory checks are present`);

// ── Verdict ────────────────────────────────────────────────────────────────
if (report.ready) {
  console.log(`\n${GREEN}READY${RESET} — this Vercel account is set up for DevPilot deploys.`);
  if (report.checks.some((c) => c.level === "warn")) {
    console.log(
      `${YELLOW}      Note the warnings above: they work, but carry a recurring cost.${RESET}`,
    );
  }
  process.exit(0);
}

console.log(`\n${YELLOW}NOT READY${RESET} — resolve the errors above, then re-run.`);
console.log(
  `${DIM}This is a legitimate outcome, not a script failure: reporting an incomplete\n` +
    `setup specifically and actionably is exactly what the preflight is for.${RESET}`,
);
process.exit(0);
