// The supervisor CONSOLE - the fact vocabulary and the classification rules.
// PURE (no IO, no `server-only`), like `supervisor-policy.ts` next door.
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
// The runner-resident supervisor (`lib/engine/supervisor-policy.ts` +
// `supervisor-store.ts`) is the AUTONOMOUS half: a clock, a liveness gate, and
// two remediations that fire only once the engine's own crons have provably
// stopped. This is the CONVERSATIONAL half on top of it. It is not a second
// supervisor, and it reaches no decision the autonomous one does not: detection
// is `detectDispatchStall` and `decideOrphanRecovery`, imported and called, and
// remediation is `releaseGroup` and `recoverOrphanedTicket`, injected. What is
// new here is a vocabulary for saying, in plain language, WHAT A BOARD IS DOING.
//
// ── THE QUESTION IT EXISTS TO ANSWER ──────────────────────────────────────
// "Why is nothing moving?" is asked of a board whose tickets are individually
// explicable and collectively opaque. Every fact needed to answer it already
// exists in the database and is scattered across six tables, and each surface
// that shows one of them - the blocker chip, the landing chip, the WIP refusal
// comment - shows it alone. The operator is the only thing joining them, which
// is precisely the join that took hours during the 2026-08-03 incident.
//
// ── THE ONE DISTINCTION THAT MATTERS MOST: WHO IS THE BLOCKER ─────────────
// `waitingOn` is the field this module is really for. A board with twelve
// stopped tickets is a completely different situation depending on whether they
// are stopped on the MACHINE (something is running, or is queued behind
// something that is), on a HUMAN (a gate refused, a secret was asked for, an
// operator paused it), or on NOBODY - the state in which no process and no
// person owns the ticket and it will sit there forever.
//
// `nobody` is the alarm. Everything else is, at worst, slow. Collapsing the
// three into "stuck" is what makes a board summary useless, because the
// remedies are disjoint: wait, act, or investigate.
//
// ── UNTRUSTED CONTENT ─────────────────────────────────────────────────────
// Ticket titles, comment bodies and land errors are AGENT-WRITABLE. They are
// carried through here as opaque strings and are never interpreted; the fencing
// happens at the one place they reach a model (`console-brief.ts`). This module
// must not grow a branch that keys on their content.

import { classifyBlocker, type BlockerOpenness } from "@/lib/integration/landed";
import { decideOrphanRecovery, type OrphanEvidence } from "@/lib/engine/orphan-ticket-policy";
import type { DispatchStallSignal } from "@/lib/engine/dispatch-rescue-policy";
import type { EngineRecoveryLiveness } from "@/lib/engine/supervisor-policy";
import type { LandingState } from "@/lib/integration/landing-state";
import type { TicketStatus } from "@/lib/board/state";

// ───────────────────────────────────────────────────────────────────────────
// Who is holding this ticket up
// ───────────────────────────────────────────────────────────────────────────

/**
 * `machine` - a process owns this: a run is executing, or it is queued behind
 *             one that is. Waiting is the correct behaviour.
 * `human`   - a person owns this: a gate refused, an agent asked a question, an
 *             operator paused it. It will never move on its own, and it is not
 *             broken.
 * `nobody`  - nothing owns this. No run, nothing queued, no human asked. THE
 *             alarming state, and the only one that is a defect rather than a
 *             wait.
 * `none`    - settled (done and landed / failed). Not waiting at all.
 */
export type WaitingOn = "machine" | "human" | "nobody" | "none";

/**
 * How a ticket is stopped. A closed vocabulary, deliberately: every member has
 * a distinct remedy, and a member that shares its remedy with another belongs
 * merged into it. Adding one means writing the sentence for it in
 * `describeTicketState` - which is a compile error until you do.
 */
export const TICKET_STATE_KINDS = [
  /** A run is executing right now. */
  "working",
  /** A `dispatch_queue` row is holding it behind the agent's WIP limit. */
  "queued_behind_wip",
  /** A human was asked something: `input_required`, or a run `awaiting_human`. */
  "awaiting_operator",
  /** An operator paused it, or the board/workspace automation is paused. */
  "paused_by_operator",
  /** A gate or a park refused it and left it `blocked` with a reason. */
  "blocked_at_gate",
  /** Held by a dependency whose own work is not finished. */
  "blocked_by_dependency",
  /** Held by a dependency that IS finished but whose commits are not on the
   *  integration branch yet. A transient wait with a known resolver. */
  "awaiting_dependency_land",
  /** Non-terminal, agent-owned, and nothing owns it - the orphan shape. */
  "stalled",
  /** Agent-owned and quiet, but a named mechanism still owns it: the recovery
   *  grace has not elapsed, the stuck-ticket sweeper owns a finished run, or a
   *  fan-out cohort is mid-settle. Distinct from `stalled` because the remedy is
   *  "wait", and distinct from `working` because nothing is executing. */
  "settling",
  /** Startable: unblocked, nothing queued, waiting only for the drain. */
  "ready_to_start",
  /** Finished, but its commits never reached the integration branch. */
  "done_not_landed",
  /** Finished and settled. */
  "settled",
] as const;

export type TicketStateKind = (typeof TICKET_STATE_KINDS)[number];

/** A blocker as the console reports it. `openness` is `classifyBlocker`'s own
 *  verdict - never re-derived here, so the console and the scheduler cannot
 *  disagree about whether a dependency is holding something back. */
export type ConsoleBlocker = {
  key: string;
  /** UNTRUSTED (agent-writable). Never interpreted. */
  title: string;
  status: TicketStatus;
  landedSha: string | null;
  landPending: boolean;
  openness: BlockerOpenness;
};

/** The newest platform-authored note on a ticket. This is what turns "blocked"
 *  into a reason, and it is the single highest-value field on the whole
 *  snapshot: the refusal copy IS the documentation (see the agent-ticket entry
 *  in AGENTS.md), so quoting it back is usually the entire answer. */
export type ConsoleNotice = {
  /** `comments.author_id`. A platform author id, e.g. `devpilot_qa_gate`. */
  author: string;
  createdAtIso: string;
  /** UNTRUSTED. Fenced at the model boundary; rendered as quoted text in the UI. */
  excerpt: string;
};

export type ConsoleTicketFact = {
  ticketId: string;
  /** `DevPilot-<N>`, via `formatTicketKey`. */
  key: string;
  /** UNTRUSTED (agent-writable). */
  title: string;
  status: TicketStatus;
  requestedRole: string | null;
  updatedAtIso: string;
  blockers: readonly ConsoleBlocker[];
  /**
   * False when the dependency read FAILED, so `blockers` being empty means
   * "we could not look" rather than "there are none".
   *
   * The distinction is the whole reason this field exists: an unreadable
   * dependency read that reports as "unblocked, ready to start" is a confident
   * wrong answer, and it is the one this console shipped with until it was
   * driven against a real board (see `loadBlockerMap`).
   */
  blockersKnown: boolean;
  hasLiveRun: boolean;
  hasPendingDispatch: boolean;
  latestRunStatus: string | null;
  latestRunActivityIso: string | null;
  /** True when any run on the ticket is `awaiting_human` - a legitimate,
   *  possibly multi-day wait that must never read as a stall. */
  hasRunAwaitingHuman: boolean;
  /** Newest platform note, if any. UNTRUSTED body. */
  notice: ConsoleNotice | null;
  /** Landing verdict, from `deriveLandingState`. Null when not computed (only
   *  terminal tickets carry one). */
  landing: LandingState | null;
  /** Branches with commits that never reached the remote. The data-loss-guard
   *  signal; also the reason a "restart from dev" would refuse. */
  unpushedBranches: readonly { branch: string; commits: number }[];
  retryCount: number;
  gateRetryCount: number;
  safetyCritical: boolean;
  /** Project/tenant automation pause, resolved for this ticket. */
  automationPaused: boolean;
  /**
   * `decideOrphanRecovery`'s verdict, when the ticket is in an orphanable
   * status. Computed by the caller from the SAME evidence the reaper gathers so
   * the console can never claim a ticket is recoverable that the primitive
   * would refuse. Null when the status is not orphanable at all.
   */
  orphan: { recoverable: boolean; to: TicketStatus | null; reason: string } | null;
};

export type ConsoleDiagnosis = {
  kind: TicketStateKind;
  waitingOn: WaitingOn;
  /** One sentence, operator-facing, naming the actual holder. */
  detail: string;
};

const TERMINAL_STATUSES = new Set<TicketStatus>(["done", "failed"]);

/**
 * Classify one ticket.
 *
 * ORDER IS THE DESIGN, and it is the same shape as `deriveLandingState`'s: each
 * branch answers a question the branches after it cannot, so moving one changes
 * which explanation an operator is given for the same board.
 *
 *  1. A live run outranks everything. Whatever else is true of the row, work is
 *     in flight, and telling an operator a running ticket is stuck is the one
 *     error that would make the console actively misleading.
 *  2. `awaiting_human` next - it is a run status, so it also outranks the
 *     ticket column, and it is the case most easily mistaken for a stall.
 *  3. Then the ticket's own column, for the states that ARE a human wait.
 *  4. Then the queue, then dependencies, then the orphan verdict.
 *
 * Every branch sets `waitingOn` explicitly rather than deriving it from `kind`,
 * because the two are genuinely independent: `blocked_at_gate` waits on a human
 * while `awaiting_dependency_land` waits on the machine, and both are `blocked`
 * on the board.
 */
export function classifyTicketState(f: ConsoleTicketFact): ConsoleDiagnosis {
  // 1. Something is executing.
  if (f.hasLiveRun && !f.hasRunAwaitingHuman) {
    return {
      kind: "working",
      waitingOn: "machine",
      detail: "An agent run is executing on this ticket right now.",
    };
  }

  // 2. A run parked on a person. Legitimate and possibly multi-day.
  if (f.hasRunAwaitingHuman) {
    return {
      kind: "awaiting_operator",
      waitingOn: "human",
      detail:
        "A run on this ticket is parked waiting for a human decision. Nothing will move until " +
        "someone answers it.",
    };
  }

  // 3. The columns that ARE a human wait, before anything else can call them
  //    stuck. `paused` is checked before `input_required` only because an
  //    operator pause is the more deliberate act of the two.
  if (f.status === "paused") {
    return {
      kind: "paused_by_operator",
      waitingOn: "human",
      detail: "Paused. It will not be picked up until someone moves it out of Paused.",
    };
  }
  if (f.automationPaused && !TERMINAL_STATUSES.has(f.status)) {
    return {
      kind: "paused_by_operator",
      waitingOn: "human",
      detail:
        "Automation is paused for this board (or the whole workspace), so nothing here will be " +
        "dispatched until it is resumed.",
    };
  }
  if (f.status === "input_required") {
    return {
      kind: "awaiting_operator",
      waitingOn: "human",
      detail:
        "Waiting on you. Replying on this ticket starts a fresh run - that is the resume path.",
    };
  }

  // 4. Terminal states. `done` splits on whether the work actually shipped.
  if (f.status === "done") {
    const landed = f.landing?.kind === "landed" || f.landing?.kind === "nothing_to_land";
    if (landed || f.landing === null) {
      return { kind: "settled", waitingOn: "none", detail: "Done, and its work is accounted for." };
    }
    return {
      kind: "done_not_landed",
      waitingOn: "nobody",
      detail:
        `Done, but its commits are not on the integration branch: ` +
        `${f.landing.kind === "not_landed" ? f.landing.reason : "unrecorded"}.`,
    };
  }
  if (f.status === "failed") {
    return {
      kind: "settled",
      waitingOn: "none",
      detail: "Failed. It will not be retried on its own.",
    };
  }

  // 5. Queued behind the WIP limit. Checked before dependencies because a
  //    queued ticket has already passed the readiness guard.
  if (f.hasPendingDispatch) {
    return {
      kind: "queued_behind_wip",
      waitingOn: "machine",
      detail:
        "Queued behind its agent's work-in-progress limit. It starts when a sibling run finishes.",
    };
  }

  // 6. Dependencies. The two open kinds are reported separately because their
  //    remedies differ: one waits on upstream WORK, the other only on a
  //    LANDING, and only the latter is something a human may override.
  const open = f.blockers.filter((b) => b.openness !== "closed");
  if (open.length > 0) {
    const working = open.filter((b) => b.openness === "working");
    if (working.length > 0) {
      return {
        kind: "blocked_by_dependency",
        waitingOn: "machine",
        detail:
          `Held by ${plural(working.length, "dependency", "dependencies")} that ${working.length === 1 ? "has" : "have"} not finished: ` +
          working.map((b) => `${b.key} (${b.status})`).join(", "),
      };
    }
    return {
      kind: "awaiting_dependency_land",
      waitingOn: "machine",
      detail:
        `Its ${plural(open.length, "dependency is", "dependencies are")} finished but not yet on the ` +
        `integration branch: ${open.map((b) => b.key).join(", ")}. The land worker resolves this.`,
    };
  }

  // 7. `blocked` with no open dependency means something PARKED it. The notice
  //    is the reason, and there is essentially always one - every park in the
  //    engine writes a comment under its own author.
  if (f.status === "blocked") {
    return {
      kind: "blocked_at_gate",
      waitingOn: "human",
      detail: f.notice
        ? `Parked by \`${f.notice.author}\`. Nothing will move it until you do.`
        : "Blocked with no open dependency and no recorded reason. Nothing will move it until you do.",
    };
  }

  // 8. The orphan shape - the reaper's own verdict, never a second opinion.
  if (f.orphan?.recoverable) {
    return {
      kind: "stalled",
      waitingOn: "nobody",
      detail:
        `Nothing owns this ticket: ${f.orphan.reason}. The board says an agent is working on it; ` +
        `nothing is, and a comment posted in this state is read by nothing.`,
    };
  }
  if (f.orphan && !f.orphan.recoverable) {
    // The reaper stood down, and WHY it stood down is the answer to "should I
    // wait?". Two genuinely different answers hide behind one `action: "none"`:
    //
    //   • a named mechanism still owns the ticket (the grace has not elapsed;
    //     the stuck-ticket sweeper owns a `done` run; the aggregator owns a
    //     fan-out cohort) - waiting is correct, and reporting it as stalled
    //     would send an operator to intervene in work that is settling;
    //   • the recovery itself cannot proceed (it already recovered once and
    //     the transition kept failing; the timestamps are unreadable) - nothing
    //     owns the ticket AND nothing will pick it up, which is strictly worse
    //     than an ordinary stall and must not read as "fine".
    //
    // Unknown reasons fall to the second, alarming branch on purpose: a reason
    // this code does not recognise is not evidence that someone is handling it.
    const settling =
      f.orphan.reason === "within-grace" ||
      f.orphan.reason === "latest-run-done" ||
      f.orphan.reason === "fan-out-cohort";
    return settling
      ? {
          kind: "settling",
          waitingOn: "machine",
          detail: `Agent-owned and quiet; the recovery check stood down (${f.orphan.reason}).`,
        }
      : {
          kind: "stalled",
          waitingOn: "nobody",
          detail:
            `Agent-owned with nothing running, and the automatic recovery cannot proceed ` +
            `(${f.orphan.reason}). It will not move on its own.`,
        };
  }

  // 9. Startable - but only CLAIMED as unblocked when we could actually read
  //    the dependencies. Saying "unblocked" off a failed read is the confident
  //    wrong answer this console exists to avoid.
  return {
    kind: "ready_to_start",
    waitingOn: "machine",
    detail: f.blockersKnown
      ? "Unblocked with nothing queued - waiting for the backlog drain to pick it up."
      : "Nothing is queued for this ticket, but its dependencies could not be read - so I cannot confirm it is unblocked.",
  };
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

// ───────────────────────────────────────────────────────────────────────────
// The board-level summary
// ───────────────────────────────────────────────────────────────────────────

export type ConsoleSnapshot = {
  nowIso: string;
  tenantId: string;
  projectId: string;
  projectName: string;
  /** Per-project opt-in. Gates ACT only - never EXPLAIN. */
  supervisorEnabled: boolean;
  automation: { project: "running" | "paused"; tenant: "running" | "paused" };
  /** Whether the engine's own cron recovery is executing. Reused verbatim from
   *  the autonomous supervisor so both halves agree about engine health. */
  engine: EngineRecoveryLiveness;
  /** `detectDispatchStall` over this tenant's queue groups. */
  dispatch: DispatchStallSignal;
  tickets: readonly ConsoleTicketFact[];
  /** True when the ticket scan hit its cap, so counts are a floor not a total. */
  truncated: boolean;
};

export type BoardSummary = {
  total: number;
  byWaitingOn: Record<WaitingOn, number>;
  byKind: Partial<Record<TicketStateKind, number>>;
  /** The tickets nothing owns. The alarm set. */
  unowned: readonly { key: string; kind: TicketStateKind; detail: string }[];
  /** One sentence for the top of the console. */
  headline: string;
};

export function summarizeBoard(snapshot: ConsoleSnapshot): BoardSummary {
  const byWaitingOn: Record<WaitingOn, number> = { machine: 0, human: 0, nobody: 0, none: 0 };
  const byKind: Partial<Record<TicketStateKind, number>> = {};
  const unowned: Array<{ key: string; kind: TicketStateKind; detail: string }> = [];

  for (const t of snapshot.tickets) {
    const d = classifyTicketState(t);
    byWaitingOn[d.waitingOn] += 1;
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    if (d.waitingOn === "nobody") unowned.push({ key: t.key, kind: d.kind, detail: d.detail });
  }

  return {
    total: snapshot.tickets.length,
    byWaitingOn,
    byKind,
    unowned,
    headline: renderHeadline(snapshot, byWaitingOn, unowned.length),
  };
}

/**
 * The one sentence at the top.
 *
 * ORDERED BY WHAT AN OPERATOR CAN ACT ON, most urgent first, and each branch is
 * silent unless it is TRUE - a headline that always says something has learnt
 * to say nothing. The engine wedge outranks everything because while it holds,
 * every other number on the board is a consequence rather than a cause.
 */
function renderHeadline(
  snapshot: ConsoleSnapshot,
  byWaitingOn: Record<WaitingOn, number>,
  unowned: number,
): string {
  if (snapshot.engine.state === "wedged") {
    return (
      `The engine's scheduled recovery has not run for ${snapshot.engine.ageSeconds}s. Every cron ` +
      `safety net is dead, so nothing on this board will self-heal until that is fixed.`
    );
  }
  if (snapshot.automation.tenant === "paused") {
    return "The whole workspace is paused. No ticket in any project will be dispatched until you resume it.";
  }
  if (snapshot.automation.project === "paused") {
    return "This board is paused. Nothing will be dispatched until you resume it.";
  }
  if (snapshot.dispatch.contradiction) {
    return (
      `${snapshot.dispatch.stalledRows} ticket(s) are queued behind ${snapshot.dispatch.stalledAgents} ` +
      `agent(s) at the WIP limit while nothing is running - that queue cannot drain on its own.`
    );
  }
  if (unowned > 0) {
    return `${unowned} ticket(s) have nobody working on them and nothing scheduled to.`;
  }
  if (byWaitingOn.machine > 0) {
    return `${byWaitingOn.machine} ticket(s) are with the machine; ${byWaitingOn.human} are waiting on you.`;
  }
  if (byWaitingOn.human > 0) {
    return `Nothing is running. ${byWaitingOn.human} ticket(s) are waiting on you.`;
  }
  return "Nothing is in flight and nothing is waiting on you.";
}

/** Build the evidence shape `decideOrphanRecovery` wants and run it, returning
 *  the console's compact form. Exported so the store and the tests use the one
 *  path into the reaper's policy rather than each calling it their own way. */
export function evaluateOrphan(evidence: OrphanEvidence | null): ConsoleTicketFact["orphan"] {
  if (!evidence) return null;
  const d = decideOrphanRecovery(evidence);
  return d.action === "recover"
    ? { recoverable: true, to: d.to, reason: d.reason }
    : { recoverable: false, to: null, reason: d.reason };
}

/** Re-export so callers classify blockers through the one predicate. */
export { classifyBlocker };
