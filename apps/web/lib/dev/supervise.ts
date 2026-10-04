// Child-process policy for `scripts/dev-local.mjs`, which runs the web app,
// the Inngest dev server and the runner as one foreground job. The script
// owns the spawning; this module owns the decisions, so they can be tested.
//
// Two of those decisions fail silently when wrong, which is why they are here:
//
//   • A child that exits while the others are running is a CRASH even when
//     its exit code is 0 — a dev process has no legitimate "finished". Without
//     this, a runner that dies on a bad env var leaves web + Inngest up and the
//     board looks healthy while every ticket sits in progress forever.
//   • Ctrl-C on a TTY reaches the WHOLE process group at once, so a child can
//     report `signal: "SIGINT"` before the supervisor's own handler has run.
//     Reading that as a crash would print "web exited — stopping the rest" on
//     every clean shutdown and exit 1.

export const CHILD_ORDER = ["web", "inngest", "runner"] as const;
export type ChildName = (typeof CHILD_ORDER)[number];

/** How long to wait for `GET /health` on the web child before starting the
 *  others anyway. A cold `next dev` compile can take a while; past this we
 *  warn and continue rather than fail — Inngest and the runner both retry
 *  until the engine answers. */
export const WEB_READY_TIMEOUT_MS = 120_000;

/** After a crash or a shutdown request: SIGTERM, then this long, then SIGKILL.
 *  Sized for the RUNNER's graceful shutdown, which is the slow one: it puts
 *  interrupted jobs back on the queue (fast), then gives dev servers 5s, waits
 *  up to 30s for a step that is mid-POST to finish, then 5s for stragglers.
 *  Cutting that short with SIGKILL would lose a result the engine was about to
 *  receive. With nothing in flight the runner exits in well under a second,
 *  so Ctrl-C only ever waits when there is something worth waiting for. */
export const KILL_GRACE_MS = 45_000;

export type ChildExit = {
  name: string;
  code: number | null;
  signal: string | null;
};

export type ExitPlan =
  | { kind: "crash"; exitCode: 1; message: string }
  | { kind: "shutdown"; message: string };

/** Signals a terminal delivers to the whole foreground process group. A child
 *  killed by one of these did not crash; the operator stopped the stack. */
const GROUP_SIGNALS = new Set(["SIGINT", "SIGHUP"]);

export function planOnChildExit(exit: ChildExit, shuttingDown: boolean): ExitPlan {
  if (shuttingDown || (exit.signal !== null && GROUP_SIGNALS.has(exit.signal))) {
    return { kind: "shutdown", message: `${exit.name} stopped` };
  }
  const how =
    exit.signal !== null ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`;
  return {
    kind: "crash",
    exitCode: 1,
    message: `${exit.name} ${how} — stopping the rest`,
  };
}

/** `[web]     line` — padded so the three streams line up. */
export function prefixLine(name: string, line: string, names: readonly string[]): string {
  const width = Math.max(...names.map((n) => n.length), name.length);
  return `[${name}]${" ".repeat(width - name.length + 1)}${line}`;
}
