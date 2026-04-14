#!/usr/bin/env node
// Phase 1 / M12 — CI driver: run every per-role Promptfoo eval and compare
// the resulting pass-rate against the committed `tests/evals/baseline.json`.
//
// Behavior
// ─────────
//   • For each role yaml in `tests/evals/<role>.eval.yaml`, run
//     `promptfoo eval -c <yaml> -o .tmp/<role>.results.json`.
//   • Parse the JSON; compute pass-rate = successes / (successes + failures
//     + errors).
//   • Compare against `baseline.json.roles[<role>].pass_rate`.
//   • If the committed baseline is `null` for a role, RECORD the live
//     pass-rate to the artifacts and DO NOT BLOCK the PR — the harness is
//     bootstrapping.
//   • Otherwise, fail the job if `(baseline - live) * 100 > 5` pp.
//   • Always print a one-row-per-role summary table.
//
// Exit codes:
//   0 — all roles passed (or were bootstrapping)
//   1 — at least one role regressed past the threshold
//   2 — driver error (yaml missing, promptfoo binary missing, etc.)

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const EVAL_DIR = dirname(__filename);
const REPO_ROOT = resolve(EVAL_DIR, "..", "..");
const TMP_DIR = join(EVAL_DIR, ".tmp");

function findBin(name, dirs) {
  for (const d of dirs) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const promptfooBin = findBin("promptfoo", [
  join(REPO_ROOT, "apps/web/node_modules/.bin"),
  join(REPO_ROOT, "node_modules/.bin"),
]);
if (!promptfooBin) {
  console.error("error: promptfoo binary not found in node_modules.");
  process.exit(2);
}

const baselinePath = join(EVAL_DIR, "baseline.json");
if (!existsSync(baselinePath)) {
  console.error(`error: ${baselinePath} missing`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const thresholdPp = baseline.regression_threshold_pp ?? 5;

const yamlFiles = readdirSync(EVAL_DIR)
  .filter((f) => f.endsWith(".eval.yaml"))
  .sort();

// The per-role yamls pin the Anthropic provider, so every eval needs a live
// key. Without one, promptfoo aborts before writing any results file and there
// is nothing to compare — the suite simply cannot run. Rather than misreport
// that as a driver-error regression, skip cleanly (exit 0). The gate still
// bites the moment ANTHROPIC_API_KEY is present, matching the harness's
// bootstrapping/non-blocking design (see .github/workflows/evals.yml).
if (!(process.env.ANTHROPIC_API_KEY ?? "").trim()) {
  console.log(
    `note: ANTHROPIC_API_KEY is not set — skipping ${yamlFiles.length} role eval(s). ` +
      `The regression gate runs only when the key is available; nothing to compare, not blocking.`,
  );
  process.exit(0);
}

mkdirSync(TMP_DIR, { recursive: true });

const summary = [];
let regressed = false;
let bootstrapping = 0;

for (const yaml of yamlFiles) {
  const role = yaml.replace(/\.eval\.yaml$/, "");
  const outputJson = join(TMP_DIR, `${role}.results.json`);
  const res = spawnSync(
    promptfooBin,
    [
      "eval",
      "-c",
      join(EVAL_DIR, yaml),
      "-o",
      outputJson,
      "--no-cache",
      "--no-progress-bar",
      "--no-table",
      "--no-write",
    ],
    {
      cwd: EVAL_DIR,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PROMPTFOO_DISABLE_TELEMETRY: "1" },
    },
  );
  if (!existsSync(outputJson)) {
    console.error(
      `error: promptfoo did not produce ${outputJson} for ${role} (exit ${res.status})`,
    );
    summary.push({ role, status: "driver-error", passRate: null, baseline: null, dropPp: null });
    regressed = true;
    continue;
  }
  const payload = JSON.parse(readFileSync(outputJson, "utf8"));
  const results = payload.results ?? payload;
  const stats = results.stats ?? payload.stats ?? { successes: 0, failures: 0, errors: 0 };
  const total = (stats.successes ?? 0) + (stats.failures ?? 0) + (stats.errors ?? 0);
  const passRate = total > 0 ? stats.successes / total : 0;
  const baselineRate = baseline.roles?.[role]?.pass_rate ?? null;
  let status;
  let dropPp = null;
  if (baselineRate == null) {
    status = "bootstrap";
    bootstrapping++;
  } else {
    dropPp = (baselineRate - passRate) * 100;
    if (dropPp > thresholdPp) {
      status = "REGRESS";
      regressed = true;
    } else {
      status = "ok";
    }
  }
  summary.push({ role, status, passRate, baseline: baselineRate, dropPp, total });
}

// Pretty-print the summary table.
console.log("\n=== evals summary ===");
console.log(["role", "status", "pass-rate", "baseline", "drop (pp)", "total"].join("\t"));
for (const row of summary) {
  console.log(
    [
      row.role,
      row.status,
      row.passRate != null ? (row.passRate * 100).toFixed(1) + "%" : "—",
      row.baseline != null ? (row.baseline * 100).toFixed(1) + "%" : "—",
      row.dropPp != null ? row.dropPp.toFixed(1) : "—",
      row.total ?? "—",
    ].join("\t"),
  );
}

writeFileSync(join(TMP_DIR, "summary.json"), JSON.stringify(summary, null, 2));

if (bootstrapping > 0) {
  console.log(
    `\nnote: ${bootstrapping} role(s) are bootstrapping (no baseline yet). CI is not blocking on those — promote them by setting their pass_rate in tests/evals/baseline.json.`,
  );
}

if (regressed) {
  console.error(`\n❌ at least one role regressed past the ${thresholdPp} pp threshold.`);
  process.exit(1);
}
console.log("\n✅ all evals within tolerance.");
