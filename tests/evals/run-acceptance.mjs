#!/usr/bin/env node
// Phase 1 / M12 acceptance — deliberate regression detection via Promptfoo.
//
// Per DEVPILOT_PHASE1_PLAN.md §M12:
//   > Introduce a deliberate regression (loosen QA's REJECT criteria); CI
//   > catches it.
//
// What this script proves
// ────────────────────────
//   1. Snapshots are in sync with the live role files (snapshot-prompts
//      --check). A drift here is a code-review-time failure on its own.
//   2. With the CURRENT QA prompt, the QA gold set's pass-rate is captured
//      as the baseline.
//   3. We hot-swap the QA snapshot file with a "loosened" variant that
//      strips the FIRST-PASS-REJECT policy. The per-role yaml's
//      `file://snapshots/qa.system.txt` reference picks up the loosened
//      body without any other change.
//   4. We re-run Promptfoo against the loosened prompt and capture the new
//      pass-rate.
//   5. We assert that the regression is detected: new pass-rate must be at
//      least 5 percentage points below the baseline (the same threshold CI
//      uses against tests/evals/baseline.json).
//   6. ALWAYS restore the original snapshot in a `finally`, even on test
//      failure — a left-behind loosened prompt would silently corrupt the
//      next run.
//
// Prompt-override mechanism — why a snapshot swap instead of an env var?
// ────────────────────────────────────────────────────────────────────────
// Promptfoo supports `var` injection but we deliberately use the
// file-swap approach because:
//   (a) It exercises the SAME loading path as CI — `file://snapshots/...`
//       in the yaml — so the test is closer to the production path.
//   (b) A future contributor adding a new role doesn't have to remember to
//       wire the override variable into their yaml.
//   (c) The diff between the original and loosened snapshots is the exact
//       artifact we'd want CI to surface in a PR comment.
//
// Run
// ────
//   pnpm --filter @devpilot/web exec node tests/evals/run-acceptance.mjs
//
// Requires ANTHROPIC_API_KEY in env (Promptfoo's Anthropic provider).
//
// Baseline recording (separate mode, does NOT run the regression swap)
// ─────────────────────────────────────────────────────────────────────
//   node tests/evals/run-acceptance.mjs --record-baseline [--allow-dirty]
//
// Runs every `*.eval.yaml` once and writes the pass-rates, the ISO
// timestamp, and the HEAD commit into `tests/evals/baseline.json`. Until a
// role has a non-null `pass_rate` there, `ci-compare.mjs` treats it as
// bootstrapping and does not block a PR — so this is the step that actually
// arms the regression gate.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const EVAL_DIR = dirname(__filename);
const REPO_ROOT = resolve(EVAL_DIR, "..", "..");
const SNAPSHOTS_DIR = join(EVAL_DIR, "snapshots");
const QA_SNAPSHOT = join(SNAPSHOTS_DIR, "qa.system.txt");
const QA_BACKUP = join(SNAPSHOTS_DIR, ".qa.system.txt.bak");
const TMP_DIR = join(EVAL_DIR, ".tmp");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const recordBaseline = args.has("--record-baseline");
const allowDirty = args.has("--allow-dirty");
const regressionThresholdPct = 5; // CI fails on > 5 pp drop.
const BASELINE_PATH = join(EVAL_DIR, "baseline.json");

function log(msg) {
  console.log(`[m12-accept] ${msg}`);
}

function fatal(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

function findPromptfooBin() {
  // Look in apps/web/node_modules (where the dev-dep lives) and the root
  // pnpm store.
  const candidates = [
    join(REPO_ROOT, "apps/web/node_modules/.bin/promptfoo"),
    join(REPO_ROOT, "node_modules/.bin/promptfoo"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function ensureSnapshotsFresh() {
  log("checking snapshots are in sync with role source files…");
  const tsxBin = findTsxBin();
  if (!tsxBin) {
    fatal("tsx not found in node_modules. Run `pnpm install` first.");
  }
  const res = spawnSync(tsxBin, [join(EVAL_DIR, "snapshot-prompts.mjs"), "--check"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    fatal(
      "snapshots stale or missing. Run `node --import tsx tests/evals/snapshot-prompts.mjs` to refresh.",
    );
  }
}

function findTsxBin() {
  const candidates = [
    join(REPO_ROOT, "node_modules/.bin/tsx"),
    join(REPO_ROOT, "apps/web/node_modules/.bin/tsx"),
    join(REPO_ROOT, "apps/runner/node_modules/.bin/tsx"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function runPromptfoo(roleYaml, label) {
  const bin = findPromptfooBin();
  if (!bin) {
    fatal(
      "promptfoo binary not found in node_modules. Run `pnpm --filter @devpilot/web add -D promptfoo` (or `pnpm install` if it's already in package.json).",
    );
  }
  mkdirSync(TMP_DIR, { recursive: true });
  const outputJson = join(TMP_DIR, `${label}.results.json`);
  log(`running promptfoo eval for ${label} (${roleYaml})…`);
  const args = [
    "eval",
    "-c",
    roleYaml,
    "-o",
    outputJson,
    "--no-cache",
    "--no-progress-bar",
    "--no-table",
    "--no-write",
  ];
  const res = spawnSync(bin, args, {
    cwd: EVAL_DIR,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PROMPTFOO_DISABLE_TELEMETRY: "1" },
  });
  // Promptfoo exits non-zero when assertions fail (exit code 100); that's
  // expected on the loosened run. We rely on the JSON for the truth value.
  if (!existsSync(outputJson)) {
    fatal(
      `promptfoo did not produce results JSON at ${outputJson}. stderr in inherited stream above. exit code ${res.status}.`,
    );
  }
  const payload = JSON.parse(readFileSync(outputJson, "utf8"));
  const results = payload.results ?? payload;
  const stats = results.stats ?? payload.stats ?? null;
  if (!stats) {
    fatal(`promptfoo results JSON has no stats block: ${outputJson}`);
  }
  const total = (stats.successes ?? 0) + (stats.failures ?? 0) + (stats.errors ?? 0);
  if (total === 0) {
    fatal(`promptfoo reported 0 tests for ${label}`);
  }
  const passRate = stats.successes / total;
  return { passRate, stats, outputJson, total };
}

function loosenedQaPrompt(original) {
  // The deliberate-regression target per DEVPILOT_PHASE1_PLAN.md §M12:
  // strip the "FIRST-PASS-REJECT" policy block so QA approves
  // first-pass proposals it would normally reject.
  //
  // We replace the whole FIRST-PASS RULE paragraph with a permissive
  // alternative. The substring is stable across small prompt edits because
  // it starts with a distinctive header.
  const firstPassRuleStart = "FIRST-PASS RULE:";
  const secondPassRuleStart = "SECOND-PASS RULE:";
  const startIdx = original.indexOf(firstPassRuleStart);
  const endIdx = original.indexOf(secondPassRuleStart);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    fatal(
      `could not locate FIRST-PASS-REJECT policy block in qa.system.txt. The snapshot may have drifted from the expected shape; M12 acceptance script needs updating.`,
    );
  }
  const loosened =
    original.slice(0, startIdx) +
    "FIRST-PASS RULE: If the engineer's proposal looks reasonable on first read, " +
    "APPROVE it. There is no review-then-revise requirement. Only reject if you " +
    "see a clear, blocking, fact-based issue.\n\n" +
    original.slice(endIdx);
  if (loosened === original) {
    fatal("loosened prompt is identical to original — substitution failed.");
  }
  return loosened;
}

// ── `--record-baseline` ───────────────────────────────────────────────
// Documented in the README since M12 as the way to promote real baselines,
// but never actually implemented — which is why every `pass_rate` in
// baseline.json was still `null`, and why `ci-compare.mjs` treated every
// role as "bootstrapping" and did NOT block on a regression. Recording real
// numbers is what arms that gate.
//
// Two refusals, both deliberate:
//   • No ANTHROPIC_API_KEY → refuse. Recording zeros from a suite that
//     never ran would arm the gate against a fiction, which is strictly
//     worse than leaving it disarmed.
//   • Dirty working tree → refuse (override with --allow-dirty). The
//     recorded_commit is the claim "these numbers describe these prompts";
//     stamping a SHA that does not contain the prompts actually measured
//     makes the baseline unreproducible.
function recordBaselines() {
  log("=== recording eval baselines ===\n");

  if (!(process.env.ANTHROPIC_API_KEY ?? "").trim()) {
    fatal(
      "ANTHROPIC_API_KEY is not set. Recording a baseline requires a live run of every " +
        "role eval — there is nothing to record without one, and writing zeros would arm " +
        "the CI regression gate against numbers that were never measured.",
    );
  }

  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (status && !allowDirty) {
    fatal(
      "working tree is dirty. `recorded_commit` is the claim that these pass-rates describe " +
        "the prompts at that commit; recording from a dirty tree breaks that. Commit first, " +
        "or pass --allow-dirty if you know what you are doing.",
    );
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

  ensureSnapshotsFresh();

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const yamlFiles = readdirSync(EVAL_DIR)
    .filter((f) => f.endsWith(".eval.yaml"))
    .sort();
  if (yamlFiles.length === 0) fatal(`no *.eval.yaml files found in ${EVAL_DIR}`);

  const roles = {};
  for (const yaml of yamlFiles) {
    const role = yaml.replace(/\.eval\.yaml$/, "");
    const { passRate, total } = runPromptfoo(join(EVAL_DIR, yaml), `record-${role}`);
    roles[role] = { pass_rate: Number(passRate.toFixed(4)), total };
    log(`  ${role}: ${(passRate * 100).toFixed(1)}% (${total} tests)`);
  }

  const next = {
    ...baseline,
    _comment:
      "Baseline snapshot of per-role pass-rates. Recorded by " +
      "`node tests/evals/run-acceptance.mjs --record-baseline`. ci-compare.mjs fails a PR " +
      "if any role drops more than regression_threshold_pp below its pass_rate here. A " +
      "role whose pass_rate is null is still bootstrapping and does NOT block.",
    recorded_at: new Date().toISOString(),
    recorded_commit: commit,
    roles,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");

  log(`\n✅ recorded ${Object.keys(roles).length} role baseline(s) at ${commit}`);
  log(`   → ${BASELINE_PATH}`);
  log(`   The CI regression gate now BLOCKS on a >${next.regression_threshold_pp ?? 5} pp drop.`);
}

async function main() {
  if (recordBaseline) {
    recordBaselines();
    return;
  }

  log("=== Phase 1 / M12 acceptance — eval regression detection ===\n");

  ensureSnapshotsFresh();

  const qaYaml = join(EVAL_DIR, "qa.eval.yaml");
  if (!existsSync(qaYaml)) fatal(`qa.eval.yaml missing at ${qaYaml}`);

  const originalQa = readFileSync(QA_SNAPSHOT, "utf8");
  // Belt-and-braces: also keep a backup file so even an aborted run can be
  // restored by hand.
  writeFileSync(QA_BACKUP, originalQa, "utf8");

  let baseline;
  let loosenedResult;
  let restored = false;

  try {
    log("\n--- Step 1: baseline run (current QA prompt) ---");
    if (dryRun) {
      baseline = { passRate: 1.0, total: 4, stats: { successes: 4, failures: 0, errors: 0 } };
      log(`  [dry-run] baseline pass-rate=100% (synthetic)`);
    } else {
      baseline = runPromptfoo(qaYaml, "qa-baseline");
      log(
        `  baseline: ${baseline.stats.successes}/${baseline.total} pass = ${(baseline.passRate * 100).toFixed(1)}%`,
      );
    }

    log("\n--- Step 2: deliberate regression — loosen QA's REJECT policy ---");
    const loosened = loosenedQaPrompt(originalQa);
    writeFileSync(QA_SNAPSHOT, loosened, "utf8");
    log(
      `  wrote loosened QA snapshot (${loosened.length} bytes; original was ${originalQa.length})`,
    );

    log("\n--- Step 3: re-run with loosened prompt ---");
    if (dryRun) {
      loosenedResult = {
        passRate: 0.25,
        total: 4,
        stats: { successes: 1, failures: 3, errors: 0 },
      };
      log(`  [dry-run] loosened pass-rate=25% (synthetic)`);
    } else {
      loosenedResult = runPromptfoo(qaYaml, "qa-loosened");
      log(
        `  loosened: ${loosenedResult.stats.successes}/${loosenedResult.total} pass = ${(loosenedResult.passRate * 100).toFixed(1)}%`,
      );
    }

    log("\n--- Step 4: regression-detection assertion ---");
    const drop = baseline.passRate - loosenedResult.passRate;
    const dropPct = drop * 100;
    log(
      `  baseline ${(baseline.passRate * 100).toFixed(1)}% → loosened ${(loosenedResult.passRate * 100).toFixed(1)}% (drop ${dropPct.toFixed(1)} pp; CI threshold > ${regressionThresholdPct} pp)`,
    );

    if (dropPct > regressionThresholdPct) {
      log(
        `  ✅ regression detected (drop ${dropPct.toFixed(1)} pp > ${regressionThresholdPct} pp)`,
      );
    } else {
      // restore before throwing
      writeFileSync(QA_SNAPSHOT, originalQa, "utf8");
      restored = true;
      fatal(
        `regression NOT detected. The loosened QA prompt should have caused at least one first-pass test to flip from PASS to FAIL. Either the gold set isn't sensitive enough or the prompt swap didn't take effect.`,
      );
    }
  } finally {
    if (!restored) {
      writeFileSync(QA_SNAPSHOT, originalQa, "utf8");
      log("\n--- Step 5: restored original QA snapshot ---");
    }
    if (existsSync(QA_BACKUP)) rmSync(QA_BACKUP);
  }

  log("\n=== M12 ACCEPTANCE PASS ===");
  log(`Summary:`);
  log(`  • baseline pass-rate: ${(baseline.passRate * 100).toFixed(1)}%`);
  log(`  • loosened pass-rate: ${(loosenedResult.passRate * 100).toFixed(1)}%`);
  log(
    `  • drop:               ${((baseline.passRate - loosenedResult.passRate) * 100).toFixed(1)} pp`,
  );
  log(`  • CI threshold:       > ${regressionThresholdPct} pp`);
}

main().catch((err) => {
  fatal(err?.message ?? String(err));
});
