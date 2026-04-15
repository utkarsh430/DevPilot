// Regression coverage for the libuv-threadpool starvation that FIFO readers
// caused (fifo-reader.ts; scout report data/devpilot-connect-timeout-rc1/).
//
// NOT a jest/vitest suite — the runner has no test runner wired up, so this
// follows the same bare-`main()` convention as poll-backoff.test.ts. Run it
// directly (no env needed — fifo-reader.ts imports nothing from env.ts):
//
//   cd apps/runner
//   npx tsx src/fifo-reader.test.ts
//
// THE FAILURE IS TIMING-DEPENDENT AND INVISIBLE IN SOURCE, which is why this
// test measures rather than inspects: it holds four FIFOs open (= two runs at
// LOCAL_CC_CONCURRENCY=2) and asks whether the threadpool still answers.
//
// TWO PROBES, AND THE CONTROL IS NOT DECORATION. Probe A opens the FIFOs the
// way this code used to (`fs.createReadStream`) and MUST starve; probe B uses
// the real `openFifoReadStream` the production path calls and must not. Without
// A, B passes on any machine whose pool happens to be big enough and the test
// proves nothing — the scout's own first two reproduction attempts reported
// "not reproduced" and were both wrong for exactly that reason. So A is what
// establishes that this test can still SEE the defect.
//
// EACH PROBE RUNS IN A CHILD PROCESS, deliberately. A starved threadpool
// cannot be un-starved from inside: probe A's blocking `read(2)`s sit in the
// kernel and closing the fds does not reliably wake them, so running the
// control in-process would leave the test itself unable to complete. The child
// prints one JSON verdict and exits.
//
// UV_THREADPOOL_SIZE IS PINNED TO 4 for both children. That is the Node
// default, and pinning it makes the test independent of an operator's
// environment — the fix has to stand at the default pool size, since raising
// UV_THREADPOOL_SIZE is a separate operational mitigation that only moves the
// cliff (N runs still pin 2N threads).

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as dns from "node:dns";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openFifoReadStream } from "./fifo-reader.js";

const execFileP = promisify(execFile);
const HERE = fileURLToPath(import.meta.url);

// Four readers = two concurrent tmux runs at the shipped LOCAL_CC_CONCURRENCY.
const READERS = 4;
// A pool op that has not answered in this long is starved, not slow: on a
// healthy pool every measurement in the scout's matrix was 0-1ms.
const POOL_TIMEOUT_MS = 3_000;

type Verdict = {
  mode: string;
  poolUsable: boolean;
  dnsUsable: boolean;
  chunks: number;
  survivedWriterGap: boolean;
};

// ---------------------------------------------------------------- child ----

/** Resolves to the elapsed ms, or null if the op never came back in time.
 *  Both ops are threadpool-served, and DNS is the one the incident actually
 *  killed — undici's connectTimeout includes the lookup. */
function raceThreadpoolOp(run: (done: () => void) => void): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, POOL_TIMEOUT_MS);
    timer.unref();
    run(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Date.now() - t0);
    });
  });
}

async function runChild(mode: "legacy" | "fixed"): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `fifo-probe-${mode}-`));
  const fifos: string[] = [];
  for (let i = 0; i < READERS; i++) {
    const p = path.join(dir, `f${i}`);
    await execFileP("mkfifo", [p]);
    fifos.push(p);
  }

  let chunks = 0;
  const closers: Array<() => void> = [];
  for (const [i, p] of fifos.entries()) {
    if (mode === "legacy") {
      const s = fsSync.createReadStream(p, { encoding: "utf8" });
      s.on("data", () => {
        if (i === 0) chunks++;
      });
      s.on("error", () => {});
      closers.push(() => s.destroy());
    } else {
      const s = openFifoReadStream(p);
      s.on("data", () => {
        if (i === 0) chunks++;
      });
      s.on("error", () => {});
      closers.push(() => s.destroy());
    }
  }

  // FIFOs 1..3 get a long-lived writer that writes NOTHING — the steady state
  // of a real run (the agent thinks for tens of seconds between output chunks,
  // and a healthy run's `err` FIFO produces zero bytes for its whole life).
  // FIFO 0 is left writer-less on purpose so the fourth slot is consumed by a
  // blocked OPEN rather than a blocked read; both cost a pool worker, and it
  // leaves FIFO 0 free for the writer-gap test below.
  const writers = fifos.slice(1).map((p) => {
    const w = spawn("sh", ["-c", `sleep 30 > "${p}"`], { detached: true, stdio: "ignore" });
    w.unref();
    return w;
  });
  await new Promise((r) => setTimeout(r, 800));

  const statMs = await raceThreadpoolOp((done) => fsSync.stat("/etc/hosts", () => done()));
  const dnsMs = await raceThreadpoolOp((done) => dns.lookup("localhost", () => done()));

  // Does the reader still deliver the agent's output? A fix that stops the
  // starvation but drops stdout would be worse than the bug. Then a SECOND,
  // SEPARATE writer: a FIFO signals EOF when its LAST writer closes, and in
  // production there is a real window with no writer at all (before tmux has
  // started `claude`) plus further gaps between writers, so a reader that
  // cannot survive a writer gap silently drops the rest of a run's output.
  //
  // BOTH WRITERS ARE FIRE-AND-FORGET, WHICH IS LOAD-BEARING FOR THE TEST
  // ITSELF: opening a FIFO for write blocks until a reader has it open, so
  // awaiting a writer against a reader that has already ended hangs forever
  // and the child never reports anything. Detached writers plus BOUNDED waits
  // make a broken reader show up as "no data arrived" — a clean, fast
  // assertion — rather than as a timeout that says nothing about what went
  // wrong.
  //
  // THE TWO WRITERS ARE SEQUENCED ON EVIDENCE, NOT ON A CLOCK. An earlier
  // version spawned both at once (`sleep 0.4` on the second) and snapshotted
  // `chunks` after a fixed 400ms — a margin of a few milliseconds between the
  // shell's start-up and the JS timer. On a loaded CI runner that snapshot
  // landed on the wrong side in both directions (first write not yet arrived,
  // or second write already in), and the reader was blamed for a race in the
  // probe. Now: write, wait until the data is seen, wait until that writer has
  // actually EXITED (so its write end is closed — the gap the test exists to
  // cross), then write again and wait for the second delivery.
  const waitUntil = (pred: () => boolean, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const tick = (): void => {
        if (pred()) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(tick, 10);
      };
      tick();
    });
  const spawnGapWriter = (word: string) => {
    const w = spawn("sh", ["-c", `printf '${word}\\n' > "${fifos[0]}"`], {
      detached: true,
      stdio: "ignore",
    });
    w.unref();
    writers.push(w);
    return w;
  };
  const first = spawnGapWriter("first");
  const firstArrived = await waitUntil(() => chunks > 0, 3_000);
  const afterFirst = chunks;
  // Bounded: a writer blocked in open() (the broken-reader case) never exits,
  // and that must read as a failed gap, not a hung probe.
  await new Promise<void>((resolve) => {
    if (first.exitCode !== null) return resolve();
    const t = setTimeout(resolve, 1_500);
    t.unref();
    first.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
  spawnGapWriter("second");
  const secondArrived = await waitUntil(() => chunks > afterFirst, 3_000);

  // CLEAN UP BEFORE REPORTING, AND SYNCHRONOUSLY. The parent SIGKILLs this
  // process the instant it sees the verdict, so anything after the write may
  // never run; and every async fs op here would be dispatched to the
  // threadpool, which in `legacy` mode is exactly the thing that no longer
  // answers. `rmSync` runs on the calling thread and needs no pool slot.
  for (const w of writers) {
    try {
      process.kill(-w.pid!, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  for (const c of closers) {
    try {
      c();
    } catch {
      /* ignore */
    }
  }
  try {
    fsSync.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const verdict: Verdict = {
    mode,
    poolUsable: statMs !== null,
    dnsUsable: dnsMs !== null,
    chunks,
    survivedWriterGap: firstArrived && secondArrived,
  };
  process.stdout.write(`VERDICT ${JSON.stringify(verdict)}\n`);
  process.exit(0);
}

// --------------------------------------------------------------- parent ----

/**
 * THE PARENT RESOLVES ON THE VERDICT LINE AND THEN SIGKILLS THE CHILD — it
 * deliberately does not wait for the child to exit on its own.
 *
 * A starved child CANNOT exit. Measured on Node 24: with four libuv workers
 * wedged in a blocking `read(2)`, `process.exit(0)` never returns, because the
 * platform teardown on the way out waits for the threadpool. (That is not just
 * a test inconvenience — the runner's own shutdown path ends in
 * `process.exit(0)`, so this starvation also blocked graceful shutdown.)
 * Waiting for exit therefore hangs the whole suite for the kill timeout on the
 * one probe that is behaving exactly as intended.
 */
function runProbe(mode: "legacy" | "fixed"): Promise<Verdict> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", HERE, "--probe", mode], {
      env: { ...process.env, UV_THREADPOOL_SIZE: "4" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      fn();
    };
    const kill = setTimeout(
      () => finish(() => reject(new Error(`probe ${mode} timed out; stdout was:\n${out}`))),
      60_000,
    );
    kill.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      out += c;
      const line = out.split("\n").find((l) => l.startsWith("VERDICT "));
      if (line) finish(() => resolve(JSON.parse(line.slice("VERDICT ".length)) as Verdict));
    });
    child.on("exit", () =>
      finish(() => reject(new Error(`probe ${mode} produced no verdict; stdout was:\n${out}`))),
    );
    child.on("error", (err) => finish(() => reject(err)));
  });
}

async function testLegacyReaderStarvesThePool(): Promise<void> {
  const v = await runProbe("legacy");
  // NON-VACUITY CONTROL. If this ever goes green, the probe has stopped being
  // able to observe the defect and the `fixed` assertion below is worthless —
  // fix the probe, do not delete this.
  assert.equal(
    v.poolUsable,
    false,
    "control failed: fs.createReadStream on 4 FIFOs did NOT starve the threadpool, " +
      "so this test can no longer detect the regression it exists to catch",
  );
  assert.equal(v.dnsUsable, false, "control: dns.lookup should also be starved (it is the victim)");
}

async function testFixedReaderLeavesThePoolFree(): Promise<void> {
  const v = await runProbe("fixed");
  assert.equal(
    v.poolUsable,
    true,
    "openFifoReadStream starved the libuv threadpool: a FIFO must never be opened " +
      "in a way that blocks a pool worker (see fifo-reader.ts)",
  );
  assert.equal(
    v.dnsUsable,
    true,
    "dns.lookup was starved — this is the exact failure that produced " +
      "UND_ERR_CONNECT_TIMEOUT against a healthy engine",
  );
  assert.ok(v.chunks > 0, "reader delivered no data at all — worse than the bug it replaces");
  // NOTE ON WHAT THIS DOES AND DOES NOT PROVE. It pins the REQUIREMENT — the
  // reader must keep delivering across a writer gap, because a run has
  // writer-less windows and anything less silently truncates the agent's
  // output. It does NOT prove that O_RDWR is what delivers it: an
  // O_RDONLY|O_NONBLOCK net.Socket was measured NOT to end on writer close on
  // macOS + Node 24 either, so that mutation stays green here. O_RDWR is kept
  // because it makes EOF unreachable by construction rather than by an
  // unspecified libuv behaviour never verified on Linux. This assertion is
  // still live: it fails against any reader that DOES end on EOF, which is
  // what the fs.ReadStream being replaced did.
  assert.equal(
    v.survivedWriterGap,
    true,
    "reader stopped delivering after the first writer closed — a run's output would be " +
      "silently truncated at the first writer gap (see the O_RDWR note in fifo-reader.ts)",
  );
}

// ------------------------------------------------------------ source scan ---

/** Strip comments so a scan cannot be satisfied (or defeated) by prose. Hand-
 *  rolled rather than regex: a regex stripper silently mispairs a stray quote
 *  or backtick and then stops seeing whole files, and a scanner that
 *  under-reports reads exactly like a clean sweep. */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Files permitted to call createReadStream, each with the reason it is safe.
 *  A FIFO/pipe/socket is never safe; a regular file is. Empty today: adding an
 *  entry should mean writing down which one you are opening. */
const CREATE_READ_STREAM_ALLOWLIST: Record<string, string> = {
  // This file's own non-vacuity control deliberately opens FIFOs the broken
  // way, in a throwaway child process, to prove the probe can still see the
  // defect. It is never reached by the runner.
  "fifo-reader.test.ts": "the `legacy` control probe — the regression this scan guards",
};

async function testNoBlockingFifoOpensRemain(): Promise<void> {
  const srcDir = path.dirname(HERE);
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const rel = path.relative(srcDir, full);
      if (rel in CREATE_READ_STREAM_ALLOWLIST) continue;
      const code = stripCommentsAndStrings(await fs.readFile(full, "utf8"));
      if (/\bcreateReadStream\s*\(/.test(code)) offenders.push(rel);
    }
  };
  await walk(srcDir);
  assert.deepEqual(
    offenders,
    [],
    `createReadStream() found in apps/runner/src: ${offenders.join(", ")}. ` +
      "Opening a FIFO/pipe with fs.createReadStream blocks a libuv threadpool worker " +
      "for as long as there is nothing to read, which starves dns.lookup() and kills " +
      "every outbound fetch in the runner. Use openFifoReadStream (fifo-reader.ts). " +
      "If it is genuinely a regular file, add it to CREATE_READ_STREAM_ALLOWLIST with the reason.",
  );
}

/** The stripper is the scan's only defence against prose, so prove it works:
 *  a commented-out call must not register, and a real one must. */
function testSourceScanStripperIsSound(): void {
  const re = /\bcreateReadStream\s*\(/;
  assert.equal(re.test(stripCommentsAndStrings("// fsSync.createReadStream(p)\n")), false);
  assert.equal(re.test(stripCommentsAndStrings("/* createReadStream(p) */\n")), false);
  assert.equal(re.test(stripCommentsAndStrings('const s = "createReadStream(";\n')), false);
  assert.equal(re.test(stripCommentsAndStrings("const s = fsSync.createReadStream(p);\n")), true);
  // A stray backtick inside a line comment must not swallow the rest of the file.
  assert.equal(
    re.test(stripCommentsAndStrings("// don't ` do this\nconst s = createReadStream(p);\n")),
    true,
  );
}

async function main(): Promise<void> {
  const probeIdx = process.argv.indexOf("--probe");
  if (probeIdx !== -1) {
    await runChild(process.argv[probeIdx + 1] as "legacy" | "fixed");
    return;
  }

  testSourceScanStripperIsSound();
  await testNoBlockingFifoOpensRemain();
  await testLegacyReaderStarvesThePool();
  await testFixedReaderLeavesThePoolFree();
  console.log("fifo-reader.test.ts: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
