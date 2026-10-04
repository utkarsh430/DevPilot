#!/usr/bin/env node
// Acceptance for PR 2: what does Vercel ACTUALLY say about each project?
//
// Why this exists
// ───────────────
// PR 2's whole claim is that DevPilot reports the truth about what is armed:
// which branch each Vercel project deploys production from, and whether git
// pushes deploy to production at all. Both of those are read from Vercel's
// `GET /v9/projects/{id}` response, and two of the fields involved are things a
// unit test cannot settle:
//
//   • `link.productionBranch` — we assert it is READ-ONLY (verified against the
//     official OpenAPI document: it appears only in response schemas). This
//     script shows what it actually is per project, which is the value the
//     operator has to change by hand in the dashboard.
//
//   • `deploymentPolicy` — present in Vercel's OpenAPI spec but UNDOCUMENTED in
//     prose, and PR 2 was written without a Vercel account to test against. If
//     it turns out not to be supported on the operator's plan, this script is
//     where that shows up: the state prints as `unknown` rather than `gated`,
//     which is exactly what the UI will say too.
//
// It is READ-ONLY. It creates nothing, links nothing, deploys nothing and
// changes nothing. Every call is a GET. Not in CI and never will be — it needs a
// real credential and makes real network calls. Same posture as
// `vercel-accept.mjs` and `export-fonts-accept.mjs`.
//
// Run:
//   VERCEL_TOKEN=… node apps/web/scripts/vercel-projects-accept.mjs
//   VERCEL_TOKEN=… VERCEL_TEAM_ID=team_… node apps/web/scripts/vercel-projects-accept.mjs
//
// The token is read from the environment ONLY — never a flag (argv is visible in
// `ps` to every user on the host) and never a file in the repo.

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
      "        VERCEL_TOKEN=… node apps/web/scripts/vercel-projects-accept.mjs",
  );
}

// Run the REAL modules through tsx rather than reimplementing the client here —
// a second implementation would prove nothing about the one that ships.
const runner = `
import { listVercelProjects, getVercelProject } from "@/lib/vercel/api";
import { interpretProductionAutoDeploy } from "@/lib/vercel/deploy-policy";

const opts = {
  credential: {
    token: process.env.VERCEL_TOKEN ?? "",
    teamId: (process.env.VERCEL_TEAM_ID ?? "").trim() || null,
  },
  fetchImpl: (url, init) => fetch(url, init),
};

const listed = await listVercelProjects(opts, { limit: 100 });
const rows = [];
for (const p of listed) {
  // Re-read each project individually: the LIST response is not guaranteed to
  // carry deploymentPolicy, and the card reads the single-project shape.
  let full = null;
  try {
    full = await getVercelProject(p.id, opts);
  } catch {
    full = null;
  }
  rows.push({
    id: p.id,
    name: p.name,
    repo: p.link?.org && p.link?.repo ? p.link.org + "/" + p.link.repo : null,
    productionBranch: (full ?? p).link?.productionBranch ?? null,
    state: full ? interpretProductionAutoDeploy(full.raw) : "unknown",
    policyFieldPresent: full
      ? Object.prototype.hasOwnProperty.call(full.raw ?? {}, "deploymentPolicy")
      : false,
  });
}
process.stdout.write("<<<ROWS>>>" + JSON.stringify(rows) + "<<<END>>>");
`;

const res = spawnSync("node", ["--import", "tsx", "--input-type=module", "-e", runner], {
  cwd: webRoot,
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "inherit"],
});

if (res.status !== 0) fail(`the runner exited ${res.status}. See the error above.`);

const match = /<<<ROWS>>>([\s\S]*?)<<<END>>>/.exec(res.stdout ?? "");
if (!match) fail("no project data was produced.");

/** @type {Array<{id:string,name:string|null,repo:string|null,productionBranch:string|null,state:string,policyFieldPresent:boolean}>} */
const rows = JSON.parse(match[1]);

// The same security assertion `vercel-accept.mjs` makes, for the same reason: a
// REAL Vercel response, echoing whatever context Vercel chooses to echo, must
// still come back with no credential in it.
if (JSON.stringify(rows).includes(token)) {
  fail("THE TOKEN APPEARS IN THE OUTPUT. Do not share this. Fix the scrubber.");
}
console.log(`${GREEN}ok${RESET}    the token does not appear anywhere in the output\n`);

if (rows.length === 0) {
  console.log(`${DIM}This Vercel account has no projects yet.${RESET}`);
  process.exit(0);
}

const STATE_ICON = {
  gated: `${GREEN}gated${RESET}`,
  armed: `${YELLOW}ARMED${RESET}`,
  unknown: `${DIM}unknown${RESET}`,
};

for (const r of rows) {
  console.log(`${r.name ?? r.id}  ${DIM}${r.id}${RESET}`);
  console.log(`  repo               ${r.repo ?? `${DIM}none (sourceless)${RESET}`}`);
  console.log(`  production branch  ${r.productionBranch ?? `${DIM}none reported${RESET}`}`);
  console.log(`  git → production   ${STATE_ICON[r.state] ?? r.state}`);
  console.log("");
}

// The finding that matters most, called out rather than left to be inferred from
// the table: if `deploymentPolicy` is absent from EVERY project, the gate this
// PR relies on is not supported here and the UI will correctly say so — but the
// operator should know that up front rather than discover it as a permanent
// "could not confirm" banner.
const anyPolicy = rows.some((r) => r.policyFieldPresent);
if (!anyPolicy) {
  console.log(
    `${YELLOW}NOTE${RESET}  No project returned a \`deploymentPolicy\` field.\n` +
      `      DevPilot's "stop git pushes deploying to production" control will report\n` +
      `      "could not confirm" for every project on this account, and the card will\n` +
      `      tell you to treat production as armed. That is the honest outcome, not a\n` +
      `      bug — but it means the gate is not available here, and the production\n` +
      `      branch is the only lever. Set it in the Vercel dashboard: Settings → Git.`,
  );
} else {
  console.log(
    `${GREEN}ok${RESET}    \`deploymentPolicy\` is present — the DevPilot gate is readable here`,
  );
}

console.log(
  `\n${DIM}Reminder: Vercel's REST API exposes link.productionBranch as READ-ONLY, so\n` +
    `DevPilot cannot change the production branch. Compare the values above against\n` +
    `what each DevPilot project expects; fix mismatches in Settings → Git.${RESET}`,
);
process.exit(0);
