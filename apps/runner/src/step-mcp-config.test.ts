// The per-step MCP config — the mechanism that makes a captured screenshot
// attributable to the step that produced it.
//
// A @playwright/mcp stdio server is a CHILD of the `claude -p` process that
// loads it, and the engine records exactly one `run_steps` row per such
// invocation. So if each invocation is handed an `--output-dir` unique to its
// (runId, stepIdx), a file in that directory can only have been written during
// that step — attribution by construction, with no timestamp guesswork.
//
// That property lives in exactly two places, and both are asserted here:
//   (1) `writeStepMcpConfig` must actually put the step's own directory into
//       the playwright server's `--output-dir`. Writing the config but leaving
//       the shared directory in it would give every step the same pile of
//       images and quietly mis-file all of them.
//   (2) `buildClaudeBaseArgs` must pass the per-step config through to
//       `--mcp-config`. A config nobody loads is the same as no config, and
//       the failure is invisible: the step runs fine and captures nothing.
//
// It also pins the two non-regressions: the shared config still works for the
// callers that have no step (ad-hoc runs, the interactive takeover), and the
// devpilot-board relay is present and unchanged in the per-step config — an
// agent must not lose devpilot_move_ticket because we changed where screenshots
// go.
//
// Run: tsx src/step-mcp-config.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// claude.ts imports env.ts, which `process.exit(1)`s on missing required vars.
// Populate dummies BEFORE the dynamic import (the board-tools.test.ts pattern).
for (const [k, v] of Object.entries({
  UPSTASH_REDIS_REST_URL: "http://127.0.0.1:0",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
  DEVPILOT_RUNNER_REGISTRATION_KEY: "test-registration-key",
  DEVPILOT_RUNNER_TENANT_ID: "00000000-0000-0000-0000-000000000000",
})) {
  if (!process.env[k]) process.env[k] = v;
}

type McpConfig = {
  mcpServers: Record<string, { command: string; args?: string[] }>;
};

function outputDirOf(cfg: McpConfig): string {
  const args = cfg.mcpServers.playwright?.args ?? [];
  const i = args.indexOf("--output-dir");
  assert.ok(i >= 0, "playwright server must be given an --output-dir");
  const dir = args[i + 1];
  assert.ok(typeof dir === "string" && dir.length > 0, "--output-dir must have a value");
  return dir;
}

async function main(): Promise<void> {
  const { MCP_CONFIG_PATH, buildClaudeBaseArgs, writeStepMcpConfig, removeStepMcpConfig } =
    await import("./claude.js");
  const { browserArtifactDirForStep } = await import("./browser-artifacts.js");

  const RUN = "11111111-1111-4111-8111-111111111111";
  const OTHER_RUN = "22222222-2222-4222-8222-222222222222";

  const written: string[] = [];
  const configFor = (runId: string, stepIdx: number): McpConfig => {
    const p = writeStepMcpConfig({
      runId,
      stepIdx,
      outputDir: browserArtifactDirForStep(runId, stepIdx),
    });
    assert.ok(p, "writeStepMcpConfig should produce a path");
    written.push(p!);
    return JSON.parse(fs.readFileSync(p!, "utf8")) as McpConfig;
  };

  try {
    // (1) The step's own directory reaches the playwright server.
    const step0 = configFor(RUN, 0);
    assert.equal(outputDirOf(step0), browserArtifactDirForStep(RUN, 0));

    // Two steps of one run are isolated from each other...
    const step1 = configFor(RUN, 1);
    assert.notEqual(outputDirOf(step0), outputDirOf(step1));

    // ...and so are two runs at the same step index, which is the case that
    // matters under LOCAL_CC_CONCURRENCY > 1.
    const otherStep0 = configFor(OTHER_RUN, 0);
    assert.notEqual(outputDirOf(step0), outputDirOf(otherStep0));

    // The per-step config must NOT reuse the shared fallback directory — that
    // would be the silent mis-filing this whole mechanism exists to prevent.
    const shared = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8")) as McpConfig;
    assert.notEqual(outputDirOf(step0), outputDirOf(shared));

    // The output dir must exist by the time claude starts, so an absent dir
    // afterwards unambiguously means "this step captured nothing".
    assert.ok(fs.existsSync(outputDirOf(step0)), "step output dir should be created up front");

    // The devpilot-board relay survives unchanged — an agent must not lose its
    // board tools because we changed where screenshots go.
    assert.deepEqual(
      Object.keys(step0.mcpServers).sort(),
      Object.keys(shared.mcpServers).sort(),
      "per-step config must expose the same MCP servers as the shared one",
    );
    assert.equal(
      JSON.stringify(step0.mcpServers["devpilot-board"]),
      JSON.stringify(shared.mcpServers["devpilot-board"]),
      "the devpilot-board relay must be byte-identical in the per-step config",
    );

    // (2) The per-step config is what `claude -p` is told to load.
    const stepConfigPath = written[0]!;
    const argv = buildClaudeBaseArgs(null, stepConfigPath);
    const at = argv.indexOf("--mcp-config");
    assert.ok(at >= 0, "--mcp-config must be present");
    assert.equal(argv[at + 1], stepConfigPath);

    // Non-regression: the default is still the shared config, so every caller
    // that has no step (smoke runs, the tmux takeover) is untouched.
    const defaultArgv = buildClaudeBaseArgs();
    assert.equal(defaultArgv[defaultArgv.indexOf("--mcp-config") + 1], MCP_CONFIG_PATH);

    // The config file lands in the OS temp dir, never in a git workspace.
    for (const p of written) assert.ok(p.startsWith(os.tmpdir() + path.sep));

    // Cleanup is real, and removing an already-removed config is a no-op.
    removeStepMcpConfig(stepConfigPath);
    assert.equal(fs.existsSync(stepConfigPath), false);
    removeStepMcpConfig(stepConfigPath);
  } finally {
    for (const p of written) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best-effort */
      }
    }
    for (const [runId, idx] of [
      [RUN, 0],
      [RUN, 1],
      [OTHER_RUN, 0],
    ] as const) {
      try {
        fs.rmSync(browserArtifactDirForStep(runId, idx), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  console.log("all step-mcp-config tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
