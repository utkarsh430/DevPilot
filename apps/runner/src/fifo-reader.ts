// Non-blocking FIFO readers for the runner.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: no code in apps/runner may hold a
// libuv THREADPOOL slot for an unbounded time. `fs.createReadStream()` on a
// FIFO does exactly that, twice per tmux-wrapped run, and it took the runner
// down in production on 2026-08-03.
//
// The mechanism, measured end to end (scout report:
// data/devpilot-connect-timeout-rc1/report.md):
//
//   1. Opening a FIFO for read BLOCKS until a writer arrives, and both the
//      open and the subsequent read(2) are executed by libuv on a THREADPOOL
//      worker — not on the event loop. A FIFO with no data pending pins that
//      worker until the agent writes something.
//   2. `startHeadlessRunInTmux` opens two FIFOs per run (stdout + stderr). The
//      `err` FIFO of a healthy run produces ZERO bytes for the run's entire
//      lifetime, so at least one worker per run is pinned permanently.
//   3. The default pool is 4 threads. At LOCAL_CC_CONCURRENCY=2 that is every
//      slot.
//   4. `dns.lookup()` ALSO runs on that pool. With every slot pinned, name
//      resolution stops dead — and undici's 10s `connectTimeout` INCLUDES the
//      DNS lookup, so every engine call dies as UND_ERR_CONNECT_TIMEOUT
//      against a completely healthy engine.
//
// The distinguishing evidence, which is what rules out every network-level
// theory: in the same process at the same instant, `http://127.0.0.1:3000`
// returned 401 in 2ms while `http://localhost:3000` timed out at 10.5s, and
// the main-thread event loop ticked cleanly through the whole failure. Only
// the name-resolution step was starved. Consequence: the runner missed six
// consecutive heartbeats, which is past runner-watchdog's 60s threshold, so
// the watchdog failed the very in-flight runs that were succeeding.
//
// The fix is to take the fd out of the threadpool's hands entirely: open it
// with O_NONBLOCK (which never blocks) and hand the raw fd to `net.Socket`,
// so libuv watches it with kqueue/epoll ON THE EVENT LOOP and consumes no
// pool slot at all. Validated at the DEFAULT pool size of 4 with four FIFOs
// held open: poolUsable=true, hostnameFetch=true, dataFlows=true — where the
// same matrix on `createReadStream` gives poolUsable=false, hostnameFetch=false.
//
// DO NOT "fix" this class by raising UV_THREADPOOL_SIZE. That is a separate
// operational mitigation; N concurrent runs still pin 2N threads, so it moves
// the cliff rather than removing it. The code fix must stand at pool size 4.
//
// Lives in its own module (rather than inline in tmux-session.ts) for the
// usual reason: tmux-session.ts imports ./env.js, which `process.exit(1)`s on
// a missing var, so anything defined there is untestable. This file imports
// nothing from the runner, so fifo-reader.test.ts can drive the REAL function
// the production path calls.

import * as fsSync from "node:fs";
import * as net from "node:net";

/**
 * Open a FIFO for reading WITHOUT ever blocking a libuv threadpool worker.
 *
 * Returns a `net.Socket` — a Duplex that emits `'data'` exactly like the
 * `fs.ReadStream` it replaces, so callers keep their existing listeners and
 * line-splitting untouched. `destroy()` closes the underlying fd (verified:
 * `fstat` on it afterwards throws EBADF), so the socket is the sole owner of
 * the fd and callers must NOT also close it — a second close is an fd-reuse
 * hazard in a long-lived process.
 *
 * `O_RDWR` IS LOAD-BEARING, NOT A STYLE CHOICE — and the reason is stated
 * carefully, because it is partly a measurement and partly a hazard we chose
 * to make unreachable rather than to rely on a platform behaviour.
 *
 * THE HAZARD IS REAL AND DEMONSTRATED. A FIFO signals EOF the moment its LAST
 * writer closes, and a run has genuine writer-less windows: before tmux has
 * started `claude` at all, and between writers afterwards. A reader that ends
 * there silently drops the rest of the run's output. The `fs.ReadStream` this
 * replaces does exactly that — `fifo-reader.test.ts` reproduces it, and the
 * `survivedWriterGap` assertion fails against such a reader.
 *
 * WHAT WAS MEASURED, AND ITS LIMIT. A `net.Socket` over an
 * `O_RDONLY|O_NONBLOCK` FIFO fd did NOT surface that EOF on macOS + Node 24 —
 * probed two ways (a transient writer, and a held-open writer that then
 * exits), neither produced an `'end'`. So on this platform the read-only
 * variant appears to work, and no test here can pin the difference. That is
 * exactly why it is not what we ship: it would make correct delivery of every
 * agent's output depend on an unspecified libuv/kqueue detail that was never
 * verified on Linux, where a runner may also be hosted. `O_RDWR` holds a write
 * end open ourselves, which makes EOF UNREACHABLE BY CONSTRUCTION on any
 * platform. The scout's O_RDONLY variant needed an `'end'` → re-arm handler
 * for precisely this hazard; this one needs none. Keep O_RDWR.
 *
 * `openSync` is deliberate and must not be "improved" to `fs.promises.open`:
 * the async version dispatches the open to the threadpool, which is the exact
 * thing this function exists to avoid. With O_NONBLOCK the open never blocks,
 * so doing it synchronously costs nothing.
 */
export function openFifoReadStream(fifoPath: string): net.Socket {
  const fd = fsSync.openSync(fifoPath, fsSync.constants.O_RDWR | fsSync.constants.O_NONBLOCK);
  try {
    const stream = new net.Socket({ fd, readable: true, writable: true });
    stream.setEncoding("utf8");
    return stream;
  } catch (err) {
    // The socket never took ownership, so the fd is ours to release. Without
    // this the failed construction leaks one fd per attempt.
    try {
      fsSync.closeSync(fd);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
