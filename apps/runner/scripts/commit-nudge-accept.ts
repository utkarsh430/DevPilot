// Acceptance check: the empty-delivery nudge WORKS AGAINST A REAL AGENT.
//
//   pnpm --filter @devpilot/runner accept:commit-nudge
//
// WHY THIS EXISTS AND WHY A UNIT TEST IS NOT ENOUGH
// ────────────────────────────────────────────────
// `empty-delivery.test.ts` proves the DECISION. That is the half that already
// worked before this change: `decideQaGate` has correctly returned
// `empty_delivery` on this exact shape since B2, and the tickets still stranded
// — because the refusal arrived after `claude -p` had exited. So the claim this
// change actually makes is not "a function returns a refusal", it is:
//
//   an agent that finished a run having committed nothing receives that
//   refusal at a point where committing is still possible, and commits.
//
// Nothing short of a real `claude -p` against a real git workspace can show
// that. This script builds the measured defect shape — a code-producing role's
// branch with modified tracked files, a NEW untracked directory, and zero
// commits — runs the REAL seam over it (the real git reads, the real decision,
// the real prompt, the real `runClaude` with the real narrowed tool set and the
// real no-servers MCP config), and asserts the branch is no longer empty.
//
// It is NOT in `pnpm test`: it spends a real `claude -p` turn on the operator's
// subscription and takes tens of seconds, not milliseconds. It needs an
// authenticated `claude` CLI and nothing else — no Supabase, no Redis, no
// engine, no network beyond the model. The four env vars below are SYNTHETIC on
// purpose: `env.ts` hard-requires them at module load, and loading the real
// `.env.local` would point a test at a live instance's registration key for no
// benefit, since this path never reaches Redis or the engine.
//
// SCENARIO B IS NOT A FORMALITY. A run that only proved "the defect shape gets
// a commit" passes for an implementation that nudges unconditionally — which
// would spend a turn on every one of the ~48 non-code roles and on every clean
// run. The control asserts the two non-nudge outcomes that bound the cost and
// the loop: nothing-to-commit, and a non-code role.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// env.ts calls process.exit(1) on any of these at module load, and it is
// imported transitively by claude.ts. Synthetic: nothing here talks to Redis or
// the engine.
process.env.UPSTASH_REDIS_REST_URL ||= "https://accept.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "accept-token";
process.env.DEVPILOT_RUNNER_REGISTRATION_KEY ||= "accept-key";
process.env.DEVPILOT_RUNNER_TENANT_ID ||= "00000000-0000-0000-0000-000000000000";

const { runClaude, COMMIT_NUDGE_TOOLS_CSV, NO_MCP_CONFIG_PATH, buildClaudeBaseArgs } =
  await import("../src/claude.js");
const { readGitCommitsAhead, readGitWorkingTreeStatus } = await import("../src/git-utils.js");
const { decideCommitNudge, renderCommitNudgePrompt, COMMIT_NUDGE_SYSTEM_PROMPT } =
  await import("../src/empty-delivery.js");

const execFileP = promisify(execFile);
const git = async (cwd: string, args: string[]) => {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout.trim();
};

const BASE_BRANCH = "main";

/**
 * Build the measured defect shape: a clone whose feature branch adds NOTHING to
 * `origin/main`, with the agent's work sitting uncommitted — three modified
 * tracked files (#27/#88) plus a brand-new untracked directory (#86, the entry
 * `git commit -a` would silently drop).
 */
async function buildDefectWorkspace(base: string): Promise<string> {
  const originDir = path.join(base, "origin.git");
  const ws = path.join(base, "workspace");
  await git(base, ["init", "--bare", "-q", "-b", BASE_BRANCH, originDir]);

  const seed = path.join(base, "seed");
  await fs.mkdir(seed, { recursive: true });
  await git(seed, ["init", "-q", "-b", BASE_BRANCH]);
  await git(seed, ["config", "user.email", "accept@devpilot.test"]);
  await git(seed, ["config", "user.name", "accept"]);
  await fs.writeFile(path.join(seed, "README.md"), "# widget service\n");
  await fs.mkdir(path.join(seed, "src"), { recursive: true });
  for (const f of ["parser.ts", "validate.ts", "index.ts"]) {
    await fs.writeFile(path.join(seed, "src", f), `export const ${path.parse(f).name} = 1;\n`);
  }
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-q", "-m", "initial"]);
  await git(seed, ["remote", "add", "origin", originDir]);
  await git(seed, ["push", "-q", "origin", BASE_BRANCH]);

  await execFileP("git", ["clone", "-q", originDir, ws]);
  await git(ws, ["config", "user.email", "engineer@devpilot.test"]);
  await git(ws, ["config", "user.name", "engineer"]);
  await git(ws, ["checkout", "-q", "-b", "devpilot/add-widget-validation"]);

  // ── the agent's work, written and NEVER committed ───────────────────────
  for (const f of ["parser.ts", "validate.ts", "index.ts"]) {
    await fs.appendFile(
      path.join(ws, "src", f),
      `\n// widget validation added by the engineer run\nexport function check_${path.parse(f).name}(x: unknown) {\n  return x != null;\n}\n`,
    );
  }
  // The #86 trap: a NEW directory. `git commit -a` stages tracked
  // modifications only and would drop this entirely.
  await fs.mkdir(path.join(ws, "tests", "fixtures"), { recursive: true });
  await fs.writeFile(
    path.join(ws, "tests", "fixtures", "widget.json"),
    JSON.stringify({ id: "w-1", valid: true }, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(ws, "tests", "fixtures", "widget.invalid.json"),
    JSON.stringify({ id: null }, null, 2) + "\n",
  );

  // The runner writes the project's secrets here and excludes them locally; the
  // blanket `git add -A` must not be able to stage this.
  await fs.appendFile(path.join(ws, ".git", "info", "exclude"), "\n.env.local\n");
  await fs.writeFile(path.join(ws, ".env.local"), "STRIPE_SECRET_KEY=sk_live_do_not_commit\n");

  return ws;
}

function banner(s: string) {
  console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
}

async function main(): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "devpilot-commit-nudge-accept-"));
  let failed = false;

  try {
    const ws = await buildDefectWorkspace(base);

    // ── BEFORE ─────────────────────────────────────────────────────────────
    banner("BEFORE — the measured defect shape (#27 / #86 / #88)");
    const commitsBefore = await readGitCommitsAhead(ws, BASE_BRANCH);
    const statusBefore = await readGitWorkingTreeStatus(ws);
    console.log(`branch:        ${await git(ws, ["rev-parse", "--abbrev-ref", "HEAD"])}`);
    console.log(`commits ahead: ${commitsBefore}`);
    console.log(`git status --porcelain:`);
    for (const l of statusBefore ?? []) console.log(`  ${l}`);

    assert.equal(commitsBefore, 0, "fixture must start with an EMPTY branch");
    assert.ok(
      (statusBefore ?? []).some((l) => l.startsWith("??") && l.includes("tests/")),
      "fixture must carry an untracked new directory",
    );
    assert.ok(
      !(statusBefore ?? []).some((l) => l.includes(".env.local")),
      "the excluded secrets file must never be offered to the agent",
    );

    // ── DETECTION ──────────────────────────────────────────────────────────
    const decision = decideCommitNudge({
      codeProducing: true, // engine-stamped isCodeProducingRole("engineer")
      workspacePath: ws,
      commitsAhead: commitsBefore,
      statusEntries: statusBefore,
      alreadyNudged: false,
    });
    assert.equal(decision.nudge, true, "the seam must fire on the defect shape");

    // ── THE MESSAGE THE AGENT ACTUALLY RECEIVES ────────────────────────────
    const nudgePrompt = renderCommitNudgePrompt(decision.nudge ? decision.statusEntries : []);
    banner("THE REFUSAL, DELIVERED WHILE THE AGENT CAN STILL ACT");
    console.log(nudgePrompt);

    // The tool set really is narrowed, on the real argv the child is spawned
    // with — not merely on the constant.
    const argv = buildClaudeBaseArgs(null, NO_MCP_CONFIG_PATH, COMMIT_NUDGE_TOOLS_CSV);
    assert.ok(!argv.join(" ").includes("mcp__"), "the nudge turn must carry no MCP tools");
    assert.ok(argv.includes(NO_MCP_CONFIG_PATH), "the nudge turn must load the no-servers config");
    const noServers = JSON.parse(await fs.readFile(NO_MCP_CONFIG_PATH, "utf8"));
    assert.deepEqual(noServers.mcpServers, {}, "the nudge config must declare no MCP servers");

    // ── THE REAL TURN ──────────────────────────────────────────────────────
    banner("RUNNING THE REAL `claude -p` NUDGE TURN (this spends subscription budget)");
    const startedAt = Date.now();
    const out = await runClaude({
      prompt: nudgePrompt,
      systemPrompt: COMMIT_NUDGE_SYSTEM_PROMPT,
      cwd: ws,
      toolsCsv: COMMIT_NUDGE_TOOLS_CSV,
      mcpConfigPath: NO_MCP_CONFIG_PATH,
      runId: null,
      model: null,
    });
    console.log(`\n--- agent reply (${Math.round((Date.now() - startedAt) / 1000)}s) ---`);
    console.log(out.text.trim().slice(0, 1200));

    // ── AFTER ──────────────────────────────────────────────────────────────
    banner("AFTER");
    const commitsAfter = await readGitCommitsAhead(ws, BASE_BRANCH);
    const statusAfter = await readGitWorkingTreeStatus(ws);
    console.log(`commits ahead: ${commitsBefore} -> ${commitsAfter}`);
    console.log(await git(ws, ["log", "--oneline", `origin/${BASE_BRANCH}..HEAD`]));
    console.log(`\nfiles now on the branch:`);
    const committed = await git(ws, ["diff", "--name-only", `origin/${BASE_BRANCH}..HEAD`]);
    for (const l of committed.split("\n").filter(Boolean)) console.log(`  ${l}`);
    console.log(`\nremaining uncommitted: ${(statusAfter ?? []).length} entr(y|ies)`);

    assert.ok(
      commitsAfter !== null && commitsAfter > 0,
      `THE CLAIM FAILED: branch still has ${commitsAfter} commits after the nudge`,
    );
    // The whole point of naming `git add -A`: the untracked fixtures must be in
    // the commit. A `git commit -a` would leave them behind and this assertion
    // is what would catch a prompt regression to that instruction.
    assert.ok(
      committed.includes("tests/fixtures/widget.json"),
      "the UNTRACKED fixtures directory must be in the commit — `git add -A`, not `git commit -a`",
    );
    assert.ok(
      committed.includes("src/parser.ts"),
      "the modified tracked files must be in the commit",
    );
    assert.ok(
      !committed.includes(".env.local"),
      "the excluded secrets file must NOT have been committed",
    );
    console.log("\n✓ SCENARIO A: the agent received the refusal in time and committed the work");

    // ── SCENARIO B: the two non-nudge outcomes that bound cost and loop ─────
    banner("CONTROL — the seam must NOT fire when there is nothing to record");
    const cleanStatus = await readGitWorkingTreeStatus(ws);
    // Post-commit, the same workspace is the "nothing further to commit" case.
    const afterCommitDecision = decideCommitNudge({
      codeProducing: true,
      workspacePath: ws,
      commitsAhead: await readGitCommitsAhead(ws, BASE_BRANCH),
      statusEntries: cleanStatus,
      alreadyNudged: false,
    });
    assert.equal(
      afterCommitDecision.nudge,
      false,
      "must not re-fire on a branch that now delivers",
    );
    console.log(
      `recovered workspace   -> no nudge (${(afterCommitDecision as { skipped: string }).skipped})`,
    );

    const emptyRun = decideCommitNudge({
      codeProducing: true,
      workspacePath: ws,
      commitsAhead: 0,
      statusEntries: [],
      alreadyNudged: false,
    });
    assert.equal((emptyRun as { skipped: string }).skipped, "nothing-to-commit");
    console.log(`genuinely produced nothing -> no nudge (nothing-to-commit; the QA gate parks it)`);

    const nonCode = decideCommitNudge({
      codeProducing: false,
      workspacePath: ws,
      commitsAhead: 0,
      statusEntries: [" M spec.md", "?? notes/"],
      alreadyNudged: false,
    });
    assert.equal((nonCode as { skipped: string }).skipped, "not-code-producing");
    console.log(`a non-code role (PM/designer/techwriter) -> no nudge (not-code-producing)`);

    banner("ACCEPTED — the empty-delivery seam reaches the agent while it can still act");
  } catch (err) {
    failed = true;
    console.error(`\n✗ ACCEPTANCE FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    if (!failed || process.env.KEEP_WORKSPACE !== "1") {
      await fs.rm(base, { recursive: true, force: true });
    } else {
      console.error(`workspace kept for inspection: ${base}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

await main();
