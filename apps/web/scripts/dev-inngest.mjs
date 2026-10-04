#!/usr/bin/env node
// Launcher for the Inngest dev server, with a BOUNDED log.
//
// `dev:inngest` used to be a bare `inngest dev -u …`, which writes to whatever
// the caller redirects it to and grows without limit. On 2026-08-03 that
// produced a 29.9 GB file containing 4,992,566 copies of one line
// (`could not check constraints to lease item`) while the server was wedged.
// On a smaller disk that fills the volume and takes the machine down.
//
// This wrapper changes nothing about how the dev server runs. It only:
//   • tees output to the terminal exactly as before, so `pnpm dev:inngest`
//     still looks and behaves the way it always has;
//   • ALSO writes it to ~/.devpilot/logs/inngest.dev.log, next to the runner's
//     logs (infra/README.md), so a wedge that happened overnight is still
//     diagnosable in the morning — a terminal scrollback is not;
//   • rotates that file at a byte ceiling, keeping one predecessor;
//   • collapses consecutive identical lines to one line plus a count.
//
// The rules for both bounds are pure and unit-tested in
// `lib/dev/inngest-log.ts` (see its header for why BOTH are needed and why the
// collapse is safe). This file is only the plumbing.
//
// ── ONE MEASURED SIDE EFFECT: the log format changes to JSON ───────────────
// `inngest dev`'s `--json` flag defaults to "true if stdout is not a TTY", and
// teeing REQUIRES a pipe, so the child no longer sees a terminal and emits one
// JSON object per line instead of the coloured human format. Verified against
// the real 1.40.0 binary, including under a pty via `script`: the format is
// TTY-gated, not flag-gated — `--json=false` does NOT restore it.
//
// Kept rather than worked around, for two reasons: a structured log file is
// strictly better to grep six hours after a wedge, and `normalizeLogLine`
// handles both formats so collapsing works either way. If you want the original
// coloured stream interactively, `pnpm dev:inngest:raw` runs the bare CLI —
// with no log file and no bound, which is exactly the old behaviour.
//
// Run under `node --import tsx` so it can import that module directly, the same
// arrangement `scripts/guide-capture.mjs` uses. Imports must be RELATIVE — `@/`
// does not resolve under bare tsx.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";

import {
  INNGEST_LOG_KEEP,
  RepeatCollapser,
  renderRepeat,
  resolveLogMaxBytes,
  shouldRotate,
} from "../lib/dev/inngest-log.ts";
import { parseDotenv } from "../lib/dev/env-template.ts";
import { inngestModeFor, inngestServerSpec } from "../lib/dev/local-stack.ts";

const LOG_PATH =
  process.env.DEVPILOT_INNGEST_LOG ?? join(homedir(), ".devpilot", "logs", "inngest.dev.log");
const MAX_BYTES = resolveLogMaxBytes(process.env.DEVPILOT_INNGEST_LOG_MAX_BYTES);

// ── Which Inngest, and where its state lives ─────────────────────────────────
// Two modes, decided by `apps/web/.env.local` (the file the app itself reads),
// so this launcher and the SDK can never disagree:
//
//   server  `INNGEST_DEV=0` + INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY (what
//           `pnpm setup:local` writes). Runs `inngest start`: the self-hosted
//           server, queue + run state in the local Redis (db 1), history in
//           SQLite under DATA_DIR. A restart RESUMES every in-flight run - the
//           `lc-await` for a step result, a `step.sleep`, a human pause.
//   dev     anything else. Runs `inngest dev`, the keyless dev server, which
//           keeps all of that IN MEMORY: `--persist` was measured to keep only
//           the history (a sleeping run came back "Running" with no job behind
//           it, forever). Kept for a hand-written env; dev:local warns.
//
// DATA_DIR is outside the repo; `.inngest/` is gitignored as belt and braces.
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DEVPILOT_INNGEST_DATA_DIR ?? join(homedir(), ".devpilot", "inngest");
const ENV_LOCAL = join(HERE, "..", ".env.local");
const fileEnv = existsSync(ENV_LOCAL) ? parseDotenv(readFileSync(ENV_LOCAL, "utf8")) : {};
// The process env wins over the file, exactly as it does for `next dev`.
const effectiveEnv = { ...fileEnv, ...process.env };
const MODE = inngestModeFor(effectiveEnv);

mkdirSync(dirname(LOG_PATH), { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });

let written = fileSize(LOG_PATH);
let stream = createWriteStream(LOG_PATH, { flags: "a" });

function fileSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Roll `log` → `log.1`, dropping any older generation. Keeps the bound at
 *  (KEEP + 1) × MAX_BYTES rather than letting generations accumulate. */
function rotate() {
  stream.end();
  for (let i = INNGEST_LOG_KEEP; i >= 1; i--) {
    const older = `${LOG_PATH}.${i + 1}`;
    const newer = i === 1 ? LOG_PATH : `${LOG_PATH}.${i}`;
    try {
      if (i === INNGEST_LOG_KEEP) rmSync(older, { force: true });
      renameSync(newer, `${LOG_PATH}.${i}`);
    } catch {
      // A rotation that cannot happen must not take the dev server down with
      // it; the next write simply continues in the current file.
    }
  }
  stream = createWriteStream(LOG_PATH, { flags: "a" });
  written = 0;
}

function writeLine(text) {
  const buf = `${text}\n`;
  if (shouldRotate(written + Buffer.byteLength(buf), MAX_BYTES)) rotate();
  written += Buffer.byteLength(buf);
  stream.write(buf);
}

const collapser = new RepeatCollapser();

function emit(line, toStderr) {
  for (const e of collapser.push(line)) {
    const text = e.kind === "line" ? e.text : renderRepeat(e.count);
    // The terminal sees the collapsed stream too: five million identical lines
    // scrolling past is what made the wedge hard to notice in the first place.
    (toStderr ? process.stderr : process.stdout).write(`${text}\n`);
    writeLine(text);
  }
}

function drain() {
  for (const e of collapser.flush()) {
    const text = e.kind === "line" ? e.text : renderRepeat(e.count);
    process.stdout.write(`${text}\n`);
    writeLine(text);
  }
}

// Resolve the CLI from this package's own `node_modules/.bin` rather than
// trusting PATH. `spawn` without a shell does NOT get npm/pnpm's PATH
// augmentation, so a bare "inngest" works under `pnpm run` and fails with a
// bare ENOENT under a direct `node` invocation — which is precisely how this
// was first run. Falling back to PATH keeps a globally-installed CLI working.
const LOCAL_BIN = join(HERE, "..", "node_modules", ".bin", "inngest");
const BIN = existsSync(LOCAL_BIN) ? LOCAL_BIN : "inngest";

const explicitArgs = process.argv.slice(2);
let args;
let childEnv = process.env;
if (explicitArgs.length > 0) {
  args = explicitArgs; // escape hatch: run exactly what was asked
} else if (MODE === "server") {
  const spec = inngestServerSpec(effectiveEnv, { dataDir: DATA_DIR });
  args = spec.args;
  // The keys travel in the environment, never in argv (they would be visible
  // in `ps` otherwise); the server reads INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY.
  childEnv = { ...process.env, ...spec.env };
  process.stdout.write(
    `[dev-inngest] durable mode: inngest start (state in Redis db 1, history in ${DATA_DIR})\n`,
  );
} else {
  // `--persist` keeps the dev server's HISTORY across restarts (not its queue).
  args = ["dev", "-u", "http://127.0.0.1:3000/api/inngest", "--persist"];
  process.stdout.write(
    "[dev-inngest] dev-server mode (in-flight runs do NOT survive a restart) — set INNGEST_DEV=0 and re-run pnpm setup:local for the durable server\n",
  );
}

const child = spawn(BIN, args, {
  // cwd is the data directory: the dev server's `--persist` stores relative to
  // it. The binary path, the SDK URL and --sqlite-dir are all absolute.
  cwd: DATA_DIR,
  stdio: ["inherit", "pipe", "pipe"],
  env: childEnv,
});

createInterface({ input: child.stdout }).on("line", (l) => emit(l, false));
createInterface({ input: child.stderr }).on("line", (l) => emit(l, true));

child.on("error", (e) => {
  process.stderr.write(`[dev-inngest] failed to start 'inngest': ${e.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  drain();
  stream.end();
  process.exit(code ?? (signal ? 1 : 0));
});

// Forward the signals a developer actually sends, so Ctrl-C stops the dev
// server rather than orphaning it behind this wrapper.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
