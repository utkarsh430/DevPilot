// The project supervisor's CLOCK.
//
// ── WHY THIS LIVES IN THE RUNNER ──────────────────────────────────────────
// Every recovery mechanism in devpilot is an Inngest cron: stuckTicketSweeper,
// orphanTicketReaper, staleRunReaper, landRescueReaper, integrationQueueReaper,
// devServerReaper, runnerWatchdog, ticketScheduleCronFn, workspaceReaper,
// dispatchRescueReaper. They all die at the same instant, because they all hang
// off one scheduler.
//
// On 2026-08-03 that scheduler wedged: the local Inngest dev server emitted
// `could not check constraints to lease item` ~5,000,000 times into a 30 GB log
// while still accepting events. Every cron stopped. Five tickets sat
// `in_progress` with dead runs holding every WIP slot; tickets queued behind
// them waited seven hours; the board reported "at WIP limit" throughout. A
// human found it, because nothing else could.
//
// The runner is the only RESIDENT process in the system. It already runs
// `pullLoop`, `cancelLoop`, `devServerPullLoop`, `takeoverPullLoop` and
// `cleanupLoop` with a heartbeat and an auth circuit breaker. A supervision loop
// belongs here as a sibling, because a supervisor scheduled by the thing it
// supervises is not a supervisor.
//
// ── THE TDD'S LONG-LIVED-LOOP RULE, AND WHY THIS DOES NOT BREAK IT ────────
// `docs/DEVPILOT_TDD.md` says "The harness never runs the loop in a single
// long-lived process", and `docs/runbooks/add-inngest-function.md` says "never
// hold state in a long-lived in-memory loop". Both are about AGENT RUNS: an
// agent's iteration state, its checkpoints and its human pauses must live in the
// durable engine so a crash or a multi-day wait resumes from the exact step.
// That rule is untouched here and must stay untouched.
//
// THIS LOOP IS STATELESS BETWEEN ITERATIONS, and that is a requirement rather
// than an implementation detail. Every decision is re-derived from the database
// on each pass by the engine; nothing about the board is carried in memory from
// one tick to the next. The only in-memory state is the consecutive-failure
// counter below, which exists purely to back off a poll - it is rate limiting,
// not knowledge. If this file ever starts remembering what it saw last time,
// that is the rule being broken. (Both docs have been amended to draw the
// distinction explicitly.)
//
// ── COST ──────────────────────────────────────────────────────────────────
// This loop touches UPSTASH NOT AT ALL. It is one engine HTTP POST per interval,
// on a cadence two orders of magnitude slower than job pulling (60s vs the pull
// loop's 1s floor), so it adds nothing to the Redis request budget that
// `poll-backoff.ts` exists to protect. It performs NO LLM call, ever - the
// engine's pass is pure Postgres, and reasoning, if it is ever added, belongs
// behind a threshold rather than in the loop.

import { nextIdleDelayMs } from "./poll-backoff.js";

/**
 * How often to tick. 60 seconds.
 *
 * The reapers this stands in for run every 5 minutes, so a slower cadence would
 * make the supervisor the bottleneck; a faster one buys nothing, because the
 * engine's liveness window is five minutes wide and the pass is leased
 * instance-wide anyway. Override with DEVPILOT_SUPERVISOR_POLL_SECONDS.
 */
const DEFAULT_POLL_SECONDS = 60;

/** Ceiling for the failure backoff. Ten minutes: a supervisor that has been
 *  unable to reach the engine for ten minutes should keep trying at a cadence
 *  that costs nothing, not give up - the engine coming back is exactly the
 *  moment it is needed. */
const MAX_BACKOFF_MS = 600_000;

/** Bound on the POST. The engine is the thing we suspect is unhealthy, so an
 *  unbounded fetch here could park the loop forever on a socket that accepts and
 *  never answers - the same hang that `sendEventBounded` exists to prevent on
 *  the engine side. A missed tick is free; a wedged supervisor is not. */
const REQUEST_TIMEOUT_MS = 30_000;

export type SupervisionResponse = {
  throttled?: boolean;
  ok?: boolean;
  error?: string;
  mode?: "observe" | "remediate";
  modeReason?: string;
  liveness?: { state: string; ageSeconds?: number };
  findings?: Array<{ cause: string; detail: string }>;
  applied?: Array<{ cause: string; action: string; outcome: string }>;
  indictments?: Array<{ cause: string; count: number }>;
  supervisedProjects?: number;
};

export type SupervisorLoopOptions = {
  engineUrl: string;
  registrationKey: string;
  tenantId: string;
  runnerId: () => string | null;
  /**
   * The runs this process is ACTUALLY executing right now.
   *
   * This is the one fact the runner has and the database does not, and it is
   * why supervision belongs here rather than in a second cron. On this board
   * `runs` rows lied in both directions - rows marked `failed` whose agent
   * processes were still working 56 minutes later, and rows marked `running`
   * that were never claimed at all. The engine treats this list as a VETO ONLY:
   * a run named here stops the supervisor touching its ticket, and a run absent
   * from it proves nothing (the pool is multi-host). So the worst a wrong
   * report can do is make the supervisor act LESS.
   */
  activeRunIds: () => string[];
  getStopping: () => boolean;
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
};

export function supervisorPollMs(): number {
  const raw = Number(process.env.DEVPILOT_SUPERVISOR_POLL_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_SECONDS;
  return seconds * 1000;
}

/** Off by default? No - the LOOP is always on, because observing costs one HTTP
 *  call a minute and the incident it exists to catch was invisible for six
 *  hours. What is opt-in, per project and off by default, is REMEDIATION, and
 *  that gate lives server-side on `projects.supervisor_enabled` where an
 *  operator can see and change it. A runner-side kill switch is still provided
 *  for an operator who wants the loop itself gone. */
export function supervisorLoopEnabled(): boolean {
  return (process.env.DEVPILOT_SUPERVISOR ?? "1") !== "0";
}

/**
 * One tick. Never throws.
 *
 * Returns the parsed response, or null when the engine could not be reached -
 * which is itself informative and is what drives the backoff.
 */
export async function supervisionTick(
  opts: SupervisorLoopOptions,
): Promise<SupervisionResponse | null> {
  const log = opts.log ?? {
    info: (m: string) => console.log(`[devpilot-runner] ${m}`),
    warn: (m: string) => console.warn(`[devpilot-runner] ${m}`),
    error: (m: string) => console.error(`[devpilot-runner] ${m}`),
  };
  try {
    const res = await fetch(`${opts.engineUrl}/api/runners/supervision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-devpilot-runner-key": opts.registrationKey,
        "x-devpilot-runner-tenant": opts.tenantId,
      },
      // No tenant, no project, no ticket. The engine derives all of those from
      // the rows it reads - the runner is pooled across tenants and must never
      // be trusted to name one.
      body: JSON.stringify({
        runnerId: opts.runnerId(),
        activeRunIds: opts.activeRunIds(),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`supervision tick failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const body = (await res.json()) as SupervisionResponse;
    reportSupervision(body, log);
    return body;
  } catch (err) {
    log.warn(`supervision tick unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Say what happened, at the volume it deserves.
 *
 * A supervisor whose whole justification is "the last outage was invisible for
 * six hours" cannot itself be quiet. But it also runs every minute forever, so
 * a healthy tick must say NOTHING - a log line per minute is how a signal turns
 * into wallpaper.
 */
function reportSupervision(
  body: SupervisionResponse,
  log: NonNullable<SupervisorLoopOptions["log"]>,
): void {
  if (body.throttled) return; // another runner ran this pass.
  if (body.error) {
    log.warn(`supervision pass errored: ${body.error}`);
    return;
  }

  for (const ind of body.indictments ?? []) {
    // The loudest thing this loop can say, and deliberately so: an automatic
    // fix that keeps firing for the same reason is a bug report, not routine
    // maintenance. An operator hand-swept this board ~six times in one day and
    // each successful sweep hid the defect underneath it.
    log.error(
      `SUPERVISOR - SUSPECTED DEFECT: \`${ind.cause}\` auto-remediated ${ind.count} times ` +
        `in the escalation window. Investigate what keeps producing it.`,
    );
  }

  for (const a of body.applied ?? []) {
    log.warn(`supervisor remediated ${a.cause} → ${a.action}: ${a.outcome}`);
  }

  if ((body.applied ?? []).length === 0 && (body.findings ?? []).length > 0) {
    const causes = [...new Set((body.findings ?? []).map((f) => f.cause))].join(", ");
    log.warn(`supervisor observing (${body.mode}): ${causes} - ${body.modeReason ?? ""}`);
  }
}

/**
 * The loop. A sibling of `pullLoop` / `cancelLoop` / `cleanupLoop`, on its own
 * slot in the runner's `Promise.race`, so a slow supervision pass never delays
 * a job pull and vice versa.
 */
export async function supervisorLoop(opts: SupervisorLoopOptions): Promise<void> {
  const log = opts.log ?? {
    info: (m: string) => console.log(`[devpilot-runner] ${m}`),
    warn: (m: string) => console.warn(`[devpilot-runner] ${m}`),
    error: (m: string) => console.error(`[devpilot-runner] ${m}`),
  };
  if (!supervisorLoopEnabled()) {
    log.info("supervision loop disabled (DEVPILOT_SUPERVISOR=0)");
    return;
  }
  const base = supervisorPollMs();
  log.info(`supervision loop up (every ${Math.round(base / 1000)}s)`);

  // The ONLY state this loop carries between iterations, and it is rate
  // limiting rather than knowledge: how long to wait after a failed tick. It
  // says nothing about the board and is discarded the moment a tick succeeds.
  let backoffMs = base;

  while (!opts.getStopping()) {
    await new Promise((r) => setTimeout(r, backoffMs));
    if (opts.getStopping()) return;

    const result = await supervisionTick({ ...opts, log });
    // Reuse the shared idle-backoff ramp (the same doubling every other runner
    // loop uses) but with THIS loop's own base and cap: a supervision tick is
    // not latency-sensitive, so it may back off far past the 5s ceiling those
    // Upstash-billed loops need. A successful tick resets to the base cadence.
    backoffMs = result === null ? nextIdleDelayMs(backoffMs, base, MAX_BACKOFF_MS) : base;
  }
}
