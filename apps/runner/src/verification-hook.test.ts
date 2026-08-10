// L1 (ticket-speed audit) — end-to-end coverage for the install step wired
// into `runAndRecordVerification`.
//
// THE DEFECT (measured 2026-08-06, olympussai board): the QA verification
// gate ran `pnpm test` without ever installing dependencies first, so a
// producer run passed or failed its gate depending on whether the agent
// happened to run an install itself. DevPilot-8 and DevPilot-9 both parked
// asking a human to adjudicate a `pnpm test` failure that was NOT real —
// re-running the exact gate command in each workspace passed clean, and the
// runner log contained zero `pnpm install` invocations across its history.
//
// This drives the REAL `runAndRecordVerification` end to end: a real temp
// workspace directory, a fake `pnpm` binary put on PATH (so no network / real
// package manager is needed), and a local HTTP server standing in for the
// engine to capture the POSTed verification record — matching git-utils.
// test.ts's convention of driving real behaviour rather than mocking the
// module under test.
//
//   cd apps/runner
//   npx tsx src/verification-hook.test.ts

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { runAndRecordVerification, type VerificationResultBody } from "./verification-hook.js";

let failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

/** A local stand-in for `POST /api/runs/:id/verification`. Captures every
 *  body it receives so a test can assert what the runner actually recorded. */
async function startCaptureServer(): Promise<{
  url: string;
  bodies: () => VerificationResultBody[];
  close: () => Promise<void>;
}> {
  const bodies: VerificationResultBody[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        // ignore unparsable bodies — no test here sends one
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies: () => bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A fake `pnpm` executable on its own bin dir. Appends every invocation's
 *  args (one line) to `.pnpm-invocations` in whatever cwd it's run from —
 *  proof it ran and with what argv — then exits `exitCode`. */
async function writeFakePnpm(binDir: string, exitCode: number): Promise<void> {
  await fs.mkdir(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    'echo "$@" >> "$PWD/.pnpm-invocations"',
    `exit ${exitCode}`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(binDir, "pnpm"), script, { mode: 0o755 });
}

async function pnpmInvocations(cwd: string): Promise<string[] | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, ".pnpm-invocations"), "utf8");
    return raw.split("\n").filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

/** A tiny node script used as a QA command — avoids all shell-quoting
 *  fragility. Exits 0 if `.pnpm-invocations` exists in its cwd, else 1. */
async function writeQaCheckInstallRan(dir: string): Promise<string> {
  const p = path.join(dir, "qa-check-install-ran.mjs");
  await fs.writeFile(
    p,
    "import fs from 'node:fs';\n" + "process.exit(fs.existsSync('.pnpm-invocations') ? 0 : 1);\n",
  );
  return p;
}

async function writeQaAlwaysExit(dir: string, code: number, stdout: string): Promise<string> {
  const p = path.join(dir, `qa-exit-${code}.mjs`);
  await fs.writeFile(
    p,
    `process.stdout.write(${JSON.stringify(stdout)});\n` + `process.exit(${code});\n`,
  );
  return p;
}

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devpilot-verify-hook-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Prepend `binDir` to PATH for the duration of `fn`, then restore it — this
 *  is how the fake `pnpm` gets found by the real (un-injected) `runCommand`
 *  spawn path in verification-hook.ts. */
async function withFakePnpmOnPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${original ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

function silentLog() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(`WARN: ${m}`),
    },
  };
}

console.log("verification-hook — install step wired into runAndRecordVerification\n");

await test("THE DEFECT, FIXED: no node_modules, install runs before the QA command", async () => {
  await withWorkspace(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const binDir = path.join(dir, "bin");
    await writeFakePnpm(binDir, 0);
    const qaScript = await writeQaCheckInstallRan(dir);

    const server = await startCaptureServer();
    const { logger, lines } = silentLog();
    try {
      await withFakePnpmOnPath(binDir, () =>
        runAndRecordVerification({
          runId: "run-defect-fixed",
          verifyEnabled: true,
          role: "engineer",
          cwd: dir,
          qaCommand: `node ${qaScript}`,
          buildCommand: null,
          engineUrl: server.url,
          registrationKey: "test-key",
          tenantId: "tenant-1",
          log: logger,
        }),
      );

      const invocations = await pnpmInvocations(dir);
      assert.ok(invocations, "pnpm must have been invoked");
      const [firstInvocation] = invocations ?? [];
      assert.ok(firstInvocation, "pnpm must have been invoked at least once");
      assert.match(firstInvocation, /install/, "pnpm must have been invoked with install");
      assert.match(firstInvocation, /--frozen-lockfile/, "must use the frozen-lockfile install");

      const [body] = server.bodies();
      assert.ok(body, "a verification record must have been posted");
      assert.equal(
        body.exit_code,
        0,
        "install succeeded, then the QA check (which requires " +
          "install to have run) also succeeded — the previously-reported false failure is gone",
      );
      assert.match(
        body.command,
        /node .*qa-check-install-ran\.mjs/,
        "the record names the QA command, since it's the last (and only surviving) step",
      );
      assert.ok(
        lines.some((l) => /install/.test(l) && /pnpm install --frozen-lockfile/.test(l)),
        "the runner must log that it ran an install — its absence is what made the original " +
          `defect invisible. Logged lines:\n${lines.join("\n")}`,
      );
    } finally {
      await server.close();
    }
  });
});

await test("an install failure is reported as an install failure, never as a test failure", async () => {
  await withWorkspace(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const binDir = path.join(dir, "bin");
    // Simulate a genuine install problem (e.g. the lockfile drifted from
    // package.json) by having the fake pnpm exit non-zero.
    await writeFakePnpm(binDir, 1);
    const qaScript = await writeQaAlwaysExit(dir, 0, "all good\n");

    const server = await startCaptureServer();
    const { logger } = silentLog();
    try {
      await withFakePnpmOnPath(binDir, () =>
        runAndRecordVerification({
          runId: "run-install-fails",
          verifyEnabled: true,
          role: "engineer",
          cwd: dir,
          qaCommand: `node ${qaScript}`,
          buildCommand: null,
          engineUrl: server.url,
          registrationKey: "test-key",
          tenantId: "tenant-1",
          log: logger,
        }),
      );

      // Fail-fast: the QA command must never have run.
      const qaMarkerExists = await fs
        .access(path.join(dir, `qa-exit-0.mjs`))
        .then(() => true)
        .catch(() => false);
      assert.ok(qaMarkerExists, "sanity: the script file itself exists");

      const [body] = server.bodies();
      assert.ok(body, "a verification record must have been posted");
      assert.ok(body.exit_code > 0, "install failed — must be recorded as a real failure");
      assert.match(
        body.command,
        /pnpm install --frozen-lockfile/,
        "THE CORE ASSERTION: the failing command named in the record is the INSTALL command, " +
          "never the qa command — this is what stops a failed install from being reported as " +
          `'tests failed'. Got: ${body.command}`,
      );
      assert.doesNotMatch(
        body.command,
        /qa-exit-0\.mjs/,
        "must not name the qa command — the qa command never ran",
      );
    } finally {
      await server.close();
    }
  });
});

await test("a genuine test failure is still reported distinctly, naming the qa command", async () => {
  await withWorkspace(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const binDir = path.join(dir, "bin");
    await writeFakePnpm(binDir, 0); // install succeeds cleanly
    const qaScript = await writeQaAlwaysExit(dir, 1, "3 tests failed\n");

    const server = await startCaptureServer();
    const { logger } = silentLog();
    try {
      await withFakePnpmOnPath(binDir, () =>
        runAndRecordVerification({
          runId: "run-real-test-failure",
          verifyEnabled: true,
          role: "engineer",
          cwd: dir,
          qaCommand: `node ${qaScript}`,
          buildCommand: null,
          engineUrl: server.url,
          registrationKey: "test-key",
          tenantId: "tenant-1",
          log: logger,
        }),
      );

      const invocations = await pnpmInvocations(dir);
      assert.ok(invocations, "install must have run (and succeeded) before the real test failure");

      const [body] = server.bodies();
      assert.ok(body, "a verification record must have been posted");
      assert.ok(body.exit_code > 0, "a real test failure must still fail the gate");
      assert.match(body.command, /qa-exit-1\.mjs/, "the record names the QA command, not install");
      assert.match(body.output_tail, /3 tests failed/, "the real failure output must be captured");
    } finally {
      await server.close();
    }
  });
});

await test("THE CONTROL: a non-Node repo (no package.json) never invokes pnpm and gates normally", async () => {
  await withWorkspace(async (dir) => {
    // No package.json at all — e.g. `scoursh` or any other non-Node project.
    const binDir = path.join(dir, "bin");
    await writeFakePnpm(binDir, 1); // would fail loudly if ever invoked
    const qaScript = await writeQaAlwaysExit(dir, 0, "ok\n");

    const server = await startCaptureServer();
    const { logger } = silentLog();
    try {
      await withFakePnpmOnPath(binDir, () =>
        runAndRecordVerification({
          runId: "run-non-node-repo",
          verifyEnabled: true,
          role: "engineer",
          cwd: dir,
          qaCommand: `node ${qaScript}`,
          buildCommand: null,
          engineUrl: server.url,
          registrationKey: "test-key",
          tenantId: "tenant-1",
          log: logger,
        }),
      );

      const invocations = await pnpmInvocations(dir);
      assert.equal(invocations, null, "pnpm must NEVER be invoked for a repo with no package.json");

      const [body] = server.bodies();
      assert.ok(body, "a verification record must have been posted");
      assert.equal(body.exit_code, 0, "the gate must run normally against the repo's own check");
      assert.match(body.command, /qa-exit-0\.mjs/);
    } finally {
      await server.close();
    }
  });
});

await test("a workspace that already has current dependencies is not reinstalled", async () => {
  await withWorkspace(async (dir) => {
    const now = Date.now() / 1000;
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.utimes(path.join(dir, "package.json"), now, now);
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.utimes(path.join(dir, "pnpm-lock.yaml"), now, now);
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    const marker = path.join(dir, "node_modules", ".modules.yaml");
    await fs.writeFile(marker, "");
    await fs.utimes(marker, now + 5, now + 5); // installed AFTER the manifest — current

    const binDir = path.join(dir, "bin");
    await writeFakePnpm(binDir, 1); // would fail loudly if ever invoked
    const qaScript = await writeQaAlwaysExit(dir, 0, "ok\n");

    const server = await startCaptureServer();
    const { logger } = silentLog();
    try {
      await withFakePnpmOnPath(binDir, () =>
        runAndRecordVerification({
          runId: "run-already-installed",
          verifyEnabled: true,
          role: "engineer",
          cwd: dir,
          qaCommand: `node ${qaScript}`,
          buildCommand: null,
          engineUrl: server.url,
          registrationKey: "test-key",
          tenantId: "tenant-1",
          log: logger,
        }),
      );

      const invocations = await pnpmInvocations(dir);
      assert.equal(
        invocations,
        null,
        "a workspace with current dependencies must not pay a full install on every step",
      );

      const [body] = server.bodies();
      assert.ok(body, "a verification record must have been posted");
      assert.equal(body.exit_code, 0);
    } finally {
      await server.close();
    }
  });
});

if (failures > 0) {
  console.error(`\n${failures} verification-hook test(s) failed.`);
  process.exit(1);
}
console.log("\nAll verification-hook tests passed.");
