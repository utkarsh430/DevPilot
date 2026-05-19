// Ambient agent-activity rules — "is anything working right now, and what?"
//
// This module is PURE (no `server-only`, no Supabase import) so every semantic
// decision below is unit-testable. The realtime IO half lives in
// `lib/realtime/use-active-runs.ts`; the chrome surface in
// `components/shell/activity-indicator.tsx`.
//
// ── WHAT COUNTS AS "WORKING" ─────────────────────────────────────────────────
//
// Exactly one thing: a run whose `status = 'running'`. Everything else is
// deliberately excluded, and the exclusions are the substance of this file —
// an over-inclusive count is worse than no indicator at all, because it claims
// agents are burning the operator's subscription when they are not.
//
// (1) `awaiting_human` is NOT working. It is a run PARKED on a human decision,
//     and it can sit there for days (the engine exists to support exactly that
//     — see LIVE_RUN_STATUSES in lib/engine/orphan-ticket-policy.ts, which
//     groups the two because it is asking a different question: "is this ticket
//     owned by anything at all"). Summing them into one "3 working" badge is
//     precisely the misleading number this surface must not produce: it reads
//     as "the machine is busy, leave it alone" when the truth is the opposite —
//     it is stalled and waiting on YOU. So it is counted separately, worded as
//     waiting, and never added to the working count.
//
// (2) A ticket queued but not yet claimed is NOT working, and is not even
//     representable here: this surface reads `runs`, and until a runner claims
//     a dispatch there is no run row. That is the honest answer rather than an
//     omission — nothing has started, so no agent is working. Reading
//     `dispatch_queue` and calling a pending row "working" would assert an
//     agent is on it when none has picked it up.
//
// (3) SYNTHETIC PLATFORM RUNS are excluded. Internal one-shot LLM calls
//     (dependency suggestion, lesson extraction, capability inference, dispatch
//     classifiers, plan distill) each INSERT a `runs` row so their spend is
//     metered — see `invokeLocalCcOneShot` and `lib/plan/runner-bridge.ts`.
//     They are `running` for a second or two apiece and they are platform
//     plumbing, not an agent working on a ticket. Counting them would flash the
//     indicator on every ticket create. This is not hypothetical: the scoreboard
//     shipped ranking one of these fictions at #1 over every real agent
//     (`isSyntheticPlatformRun`, lib/metrics/agent-score.ts) — the predicate is
//     REUSED from there rather than restated, so the two surfaces cannot drift
//     into disagreeing about what a real run is.
//
// ── SCOPE ────────────────────────────────────────────────────────────────────
//
// TENANT-WIDE — every project, not the active one. The whole point is ambient
// awareness from ANYWHERE, including pages with no project context at all
// (/settings, /agents, /marketplace). A project-scoped badge would go silent
// the moment the operator switched projects while work continued elsewhere,
// which is the opposite of what was asked for. Because that is a real choice
// and not an implementation detail, the popover SAYS "across all projects" and
// every row names its own project.

import { isSyntheticPlatformRun } from "@/lib/metrics/agent-score";

/**
 * The only status that means an agent is doing work right now.
 *
 * Deliberately NOT `LIVE_RUN_STATUSES` (running + awaiting_human), which
 * answers a different question — see (1) in the header.
 */
export const WORKING_RUN_STATUSES = ["running"] as const;

/** Statuses reported separately as "waiting on you", never as working. */
export const WAITING_RUN_STATUSES = ["awaiting_human"] as const;

/** A run as this surface needs it — the shape both the hook and tests build. */
export type ActivityRun = {
  id: string;
  tenantId: string;
  status: string;
  runnerKind: string | null;
  agentId: string | null;
  ticketId: string | null;
  parentRunId: string | null;
  fanOutRole: string | null;
  /** Resolved display role, `COALESCE(fan_out_role, agents.role)`. */
  role: string | null;
  ticketTitle: string | null;
  ticketNumber: number | null;
  projectId: string | null;
  projectName: string | null;
  startedAt: string;
  lastEventAt: string | null;
};

/**
 * Is this row a real agent run that is executing right now?
 *
 * Both clauses are load-bearing: the status clause excludes parked and terminal
 * runs, the synthetic clause excludes platform plumbing.
 */
export function isWorkingRun(run: ActivityRun): boolean {
  if (run.status !== "running") return false;
  return !isSyntheticPlatformRun({
    runnerKind: run.runnerKind,
    agentId: run.agentId,
    ticketId: run.ticketId,
    fanOutRole: run.fanOutRole,
    parentRunId: run.parentRunId,
  });
}

/**
 * Is this row parked on a human decision?
 *
 * Synthetic one-shots are filtered here too — a platform call has no human to
 * wait on, but if one ever wedged into `awaiting_human` it would be noise in a
 * surface whose entire value is being quiet when nothing needs the operator.
 */
export function isWaitingOnHuman(run: ActivityRun): boolean {
  if (run.status !== "awaiting_human") return false;
  return !isSyntheticPlatformRun({
    runnerKind: run.runnerKind,
    agentId: run.agentId,
    ticketId: run.ticketId,
    fanOutRole: run.fanOutRole,
    parentRunId: run.parentRunId,
  });
}

/** Anything this surface tracks at all — working OR waiting. */
export function isTrackedRun(run: ActivityRun): boolean {
  return isWorkingRun(run) || isWaitingOnHuman(run);
}

export type ActivitySummary = {
  /** Runs executing right now. THE number the badge shows. */
  working: ActivityRun[];
  /** Runs parked on a human. Reported separately, never summed into `working`. */
  waiting: ActivityRun[];
  /** `working.length` — named so no caller is tempted to add the two. */
  workingCount: number;
  waitingCount: number;
  /** True when there is nothing at all to say. The indicator renders nothing. */
  idle: boolean;
  /** Distinct projects represented, so the popover can say "3 projects". */
  projectCount: number;
};

/** Oldest-first: the run that has been going longest is the one worth seeing. */
function byStartedAtAsc(a: ActivityRun, b: ActivityRun): number {
  return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
}

/**
 * Fold raw rows into what the chrome renders.
 *
 * `idle` is true when BOTH buckets are empty — that is the quiet state, and the
 * component renders `null` for it rather than a zero badge. This lives on every
 * page in the app; a persistent "0" competing for attention is worse than
 * absent.
 */
export function summarizeActivity(runs: ActivityRun[]): ActivitySummary {
  const working = runs.filter(isWorkingRun).sort(byStartedAtAsc);
  const waiting = runs.filter(isWaitingOnHuman).sort(byStartedAtAsc);
  const projectIds = new Set<string>();
  for (const r of [...working, ...waiting]) {
    if (r.projectId) projectIds.add(r.projectId);
  }
  return {
    working,
    waiting,
    workingCount: working.length,
    waitingCount: waiting.length,
    idle: working.length === 0 && waiting.length === 0,
    projectCount: projectIds.size,
  };
}

/** "Engineer", "Front-end engineer" — a role slug rendered for a human. */
export function formatRole(role: string | null): string {
  if (!role) return "Agent";
  const spaced = role.replace(/_/g, " ").trim();
  if (!spaced) return "Agent";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Compact elapsed label: "just now", "4m", "1h 12m".
 *
 * Rounded down and capped in granularity on purpose — this is ambient context,
 * not a stopwatch, and a ticking seconds counter in the chrome is noise.
 */
export function formatElapsed(startedAt: string, now: number): string {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "";
  const seconds = Math.floor((now - started) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

/** Deep link into the existing run view — this surface never duplicates it. */
export function runHref(run: ActivityRun): string {
  return `/runs/${run.id}`;
}
