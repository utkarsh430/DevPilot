// Regression coverage for the devpilot-board MCP tool surface (the "reviewer can't
// move the ticket" freeze, plus the later WI-6/WI-14 drift where devpilot_handoff
// and devpilot_create_ticket shipped in the TOOLS catalog but were never added to
// the force-load list). Three prior fixes (#34 --tools force-load, #36
// server-path resolution) were each falsely reported "fixed" while
// `devpilot_move_ticket` was still landing DEFERRED/unavailable, so every QA/verifier
// run silently failed to record its verdict and tickets froze. These checks
// would have caught all of them:
//   (B) the devpilot-board server source path the runner generates resolves to a file
//       that actually exists (the #36 ERR_MODULE_NOT_FOUND regression).
//   (C) spawning that server exactly as the runner does and calling tools/list
//       returns the live tool catalog — proving it starts and exposes tools.
//   (A) EVERY tool name the live server reports (not a hand-maintained subset)
//       is present in AGENT_TOOLS_CSV, in the --tools argv value (force DIRECT
//       load — the difference between DIRECT and DEFERRED/uncallable on claude
//       2.1.207+), and in --allowedTools (auto-approve). The expected set is
//       derived from the server's own tools/list response, so a future tool
//       added to the TOOLS catalog but forgotten in DEVPILOT_BOARD_TOOLS fails this
//       test automatically instead of silently landing deferred.
//
// NOT a jest/vitest suite — the runner has no test runner wired up, so this
// follows the same bare-`main()` convention as git-utils.test.ts /
// producer-verification.test.ts. Run it directly:
//
//   cd apps/runner && npx tsx src/board-tools.test.ts

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// claude.ts imports env.ts, which `process.exit(1)`s on missing required vars.
// Populate dummies BEFORE the dynamic import so the module loads in a bare test.
// (These are never used — nothing here reaches Redis or the engine.)
for (const [k, v] of Object.entries({
  UPSTASH_REDIS_REST_URL: "http://127.0.0.1:0",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
  DEVPILOT_RUNNER_REGISTRATION_KEY: "test-registration-key",
  DEVPILOT_RUNNER_TENANT_ID: "00000000-0000-0000-0000-000000000000",
})) {
  if (!process.env[k]) process.env[k] = v;
}

async function main(): Promise<void> {
  const { AGENT_TOOLS_CSV, MCP_CONFIG_PATH, buildClaudeBaseArgs } = await import("./claude.js");

  // AGENT_TOOLS_CSV must not contain empty elements — a stray `,,` (e.g. from
  // a trailing comma in one of the arrays it's built from) silently truncates
  // every tool listed after it once split(",") is consumed downstream.
  const csvTools = AGENT_TOOLS_CSV.split(",");
  assert.ok(
    csvTools.every((t) => t.trim().length > 0),
    `AGENT_TOOLS_CSV must not contain empty elements (check for a stray trailing comma); got ${csvTools.length} entries`,
  );

  // (B) The devpilot-board server path the runner bakes into its MCP config resolves
  // to a real file (the #36 regression: a hardcoded `.ts` extension made the
  // prod `node dist/…` build point at a nonexistent file → server never started).
  const cfg = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8")) as {
    mcpServers?: Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string> }
    >;
  };
  const aceBoard = cfg.mcpServers?.["devpilot-board"];
  assert.ok(aceBoard, "runtime MCP config must define the devpilot-board server");
  const command = aceBoard.command ?? "";
  const serverArgs = aceBoard.args ?? [];
  const serverSource = serverArgs[serverArgs.length - 1] ?? "";
  assert.ok(
    serverSource && fs.existsSync(serverSource),
    `devpilot-board server source must resolve to an existing file, got: ${serverSource}`,
  );
  assert.ok(
    command && fs.existsSync(command),
    `devpilot-board server launcher (tsx) must exist, got: ${command}`,
  );
  console.log(
    `✓ (B) devpilot-board server source resolves to an existing file (${path.basename(serverSource)})`,
  );

  // (C) Spawn the server exactly as the runner does and prove it starts and
  // exposes its tool catalog via tools/list. tools/list is answered from the
  // static catalog with no engine call, so no live engine is needed. This is
  // also the source of truth for (A) below — the live catalog, not a
  // hand-maintained literal list.
  const listed = await listToolsFromServer(command, serverArgs, aceBoard.env ?? {});
  assert.ok(listed.length > 0, "devpilot-board tools/list must return at least one tool");
  console.log(`✓ (C) devpilot-board server starts and tools/list returns ${listed.length} tools`);

  // (A) EVERY tool the live server exposes must be force-loaded via --tools
  // (DIRECT load) and pre-approved via --allowedTools. A tool present in the
  // TOOLS catalog but missing from DEVPILOT_BOARD_TOOLS (apps/runner/src/claude.ts)
  // lands DEFERRED on claude 2.1.207+ and the agent silently cannot call it —
  // this is exactly how devpilot_handoff and devpilot_create_ticket shipped dead.
  const expected = listed.map((name) => `mcp__devpilot-board__${name}`);

  const argv = buildClaudeBaseArgs();
  const toolsIdx = argv.indexOf("--tools");
  const allowedIdx = argv.indexOf("--allowedTools");
  assert.ok(toolsIdx >= 0, "runClaude argv must pass --tools (force DIRECT load)");
  assert.ok(allowedIdx >= 0, "runClaude argv must pass --allowedTools (auto-approve)");
  const toolsValue = (argv[toolsIdx + 1] ?? "").split(",");
  const allowedValue = (argv[allowedIdx + 1] ?? "").split(",");

  const missingFromCsv = expected.filter((t) => !csvTools.includes(t));
  assert.deepEqual(
    missingFromCsv,
    [],
    `AGENT_TOOLS_CSV (DEVPILOT_BOARD_TOOLS in apps/runner/src/claude.ts) is missing: ${missingFromCsv.join(", ")} — these land DEFERRED and become uncallable`,
  );
  const missingFromTools = expected.filter((t) => !toolsValue.includes(t));
  assert.deepEqual(
    missingFromTools,
    [],
    `--tools argv (force DIRECT load) is missing: ${missingFromTools.join(", ")}`,
  );
  const missingFromAllowed = expected.filter((t) => !allowedValue.includes(t));
  assert.deepEqual(
    missingFromAllowed,
    [],
    `--allowedTools argv is missing: ${missingFromAllowed.join(", ")}`,
  );
  console.log(
    `✓ (A) all ${expected.length} live devpilot-board tools are force-loaded via --tools and pre-approved via --allowedTools`,
  );

  console.log("\nAll board-tools regression checks passed.");
}

/**
 * Speak just enough MCP stdio JSON-RPC to drive `initialize` + `tools/list`
 * against the spawned server and return the tool names. Kills the child as soon
 * as the tools/list reply lands; a timeout guards against a server that never
 * answers (which is itself the regression).
 */
function listToolsFromServer(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `devpilot-board server tools/list timed out (20s). stderr:\n${stderrBuf.slice(0, 800)}`,
        ),
      );
    }, 20_000);
    timer.unref?.();

    const succeed = (tools: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(tools);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(err);
    };

    child.on("error", fail);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderrBuf += c;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; result?: { tools?: Array<{ name?: string }> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON diagnostic line
        }
        if (msg.id === 2 && Array.isArray(msg.result?.tools)) {
          succeed(msg.result!.tools.map((t) => String(t.name)));
          return;
        }
      }
    });
    child.on("close", (code) => {
      fail(
        new Error(
          `devpilot-board server exited (code ${code}) before tools/list. stderr:\n${stderrBuf.slice(0, 800)}`,
        ),
      );
    });

    // MCP stdio frames: one JSON-RPC message per line.
    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "devpilot-board-regression-test", version: "0" },
          },
        }) + "\n",
      );
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
