// The project supervisor - the decision core. PURE (no IO), like its siblings
// `dispatch-rescue-policy.ts` and `orphan-ticket-policy.ts`.
//
// ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
// Every recovery mechanism in devpilot is an Inngest cron: `stuckTicketSweeper`,
// `orphanTicketReaper`, `staleRunReaper`, `landRescueReaper`,
// `integrationQueueReaper`, `devServerReaper`, `runnerWatchdog`,
// `ticketScheduleCronFn`, `workspaceReaper`, `dispatchRescueReaper`. They are
// carefully written, capped and idempotent, and they share ONE point of
// failure: the durable-execution layer that schedules them.
//
// On 2026-08-03 that layer wedged. The local Inngest dev server emitted
// `could not check constraints to lease item` ~5,000,000 times into a 30 GB log
// while STILL ACCEPTING EVENTS. Every cron stopped at once. Five tickets sat
// `in_progress` with dead runs holding every WIP slot; tickets queued behind
// them waited seven hours; the board reported "at WIP limit" throughout. It was
// found by a human looking at it, not by any alarm.
//
// The supervisor is the thing that keeps ticking when the scheduler does not.
// It runs in the RUNNER process (`apps/runner/src/supervisor-loop.ts`) - the
// only resident process in the system - so it survives the failure it exists to
// catch. The runner is the CLOCK; the engine remains the ACTOR (it holds the
// database credentials, and the runner must never gain any).
//
// ── THE SINGLE MOST IMPORTANT RULE: DO NOT DUPLICATE THE REAPERS ───────────
// When Inngest is healthy the existing crons already handle every stall here,
// and they do it with caps and idempotency this module does not reimplement. A
// second actor doing the same job is not redundancy, it is the two-writer
// problem - on this very board duplicate dispatch put two agents in one git
// workspace and one agent's commit swept up the other's half-finished edits.
//
// So remediation is GATED ON THE ENGINE'S OWN RECOVERY BEING UNAVAILABLE:
//
//   • engine recovery ALIVE   → OBSERVE ONLY. Report; change nothing.
//   • engine recovery UNKNOWN → OBSERVE ONLY. Fail closed; see below.
//   • engine recovery WEDGED  → the crons are dead, so remediate.
//
// That gate is `decideSupervisorMode`, and `planSupervision` populates
// `remediations` inside a single `if (mode === "remediate")` block - structural,
// not a convention each future branch has to remember.
//
// READ THE RULE AS WRITTEN: it is a NON-DUPLICATION rule. It applies to the two
// remediations that duplicate a cron, because there the gate is the only thing
// standing between us and the two-writer problem. It is NOT a blanket "the
// supervisor may only act during an outage" - `bookkeepingRepairs` is the one
// thing on this path that runs whatever the engine's state, because it
// duplicates no cron, moves nothing on the board, and its defect only ever
// happens WHILE the engine is healthy. That exception is argued in full on
// `SupervisorBookkeepingRepair`; adding a second one needs the same argument
// made again, not a reference to this one.
//
// ── HOW LIVENESS IS ESTABLISHED, AND WHY NOT THE TWO OBVIOUS WAYS ─────────
// The signal is a CANARY: `engineLivenessCanary` (lib/engine/liveness.ts) is a
// one-minute Inngest cron whose entire job is to stamp `engine_liveness`. If
// that stamp is stale, cron execution has stopped - which is precisely,
// directly, the property the gate needs, because the reapers this module must
// not duplicate ARE crons in the same app. It is not a proxy for the question;
// it is the question.
//
// Two existing signals were considered and are NOT sufficient:
//
//   • `probeInngest` (lib/health/probes.ts) would have been GREEN throughout the
//     incident. Read it: it never contacts the Inngest dev server at all - it
//     dynamically imports our OWN `/api/inngest` route and calls its GET handler
//     IN-PROCESS. That answers "is our serve endpoint wired", which was true the
//     whole time. The failure was that nothing was EXECUTING.
//
//   • `lib/dev/inngest-log.ts` is a log-BOUNDING module (size rotation plus
//     consecutive-duplicate collapsing), not a classifier. It has no notion of
//     the lease-wedge signature as a health signal, its `normalizeLogLine` exists
//     to make repeats comparable rather than to recognise any particular error,
//     and it reads a file local to the machine running `dev:inngest` - which is
//     the web host, not necessarily the runner host, and does not exist at all
//     outside local dev.
//
// A canary also degrades correctly against futures neither of those handles: an
// Inngest Cloud outage, a signing-key rotation that silently unregisters the
// app, and a deploy that drops the cron registration all show up as a stale
// stamp, with no new detector to write.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
//   • It does not remove, raise or bypass the WIP limit, the budget gates, or
//     `assertCanSpawn`. It operates inside them like anything else.
//   • It does not reimplement any recovery. A `board_deadlock` remediation is
//     `releaseGroup` (dispatch-rescue-store.ts) and a `stalled_ticket`
//     remediation is `recoverOrphanedTicket` (orphan-ticket-reaper.ts) - the
//     same functions the crons call, with the same caps, the same idempotency
//     and the same operator-facing comments.
//   • It holds NO state between iterations. Every decision is re-derived from
//     the database each pass. See the note on the TDD's long-lived-loop rule in
//     `apps/runner/src/supervisor-loop.ts`.

import {
  decideDispatchRescue,
  describeDispatchStall,
  detectDispatchStall,
  type DispatchQueueGroup,
} from "@/lib/engine/dispatch-rescue-policy";
import { decideOrphanRecovery, type OrphanEvidence } from "@/lib/engine/orphan-ticket-policy";
import type { TicketStatus } from "@/lib/board/state";

// ───────────────────────────────────────────────────────────────────────────
// Liveness
// ───────────────────────────────────────────────────────────────────────────

/** The single `engine_liveness` row the canary stamps. A literal, not a uuid,
 *  so the canary needs no lookup and the table can never grow. */
export const ENGINE_LIVENESS_CANARY_ID = "recovery-cron";

/**
 * How stale the canary stamp may be before we call cron execution dead. Five
 * minutes.
 *
 * The canary runs every MINUTE, so this is five consecutive missed ticks. It
 * has to clear the ordinary reasons one tick is late - a deploy rolling, a
 * cold serve endpoint, a brief Inngest backlog, a dev server being restarted on
 * purpose - none of which mean the crons are gone.
 *
 * It also has to stay BELOW the interval at which acting matters. The reapers
 * this stands in for run every 5 minutes, so a supervisor that waited 30
 * minutes to notice would be slower than the mechanism it replaces. Five
 * minutes is the first number that clears the noise without becoming the
 * bottleneck.
 *
 * Override with DEVPILOT_SUPERVISOR_ENGINE_STALE_SECONDS.
 */
export const ENGINE_RECOVERY_STALE_SECONDS_DEFAULT = 300;

export type EngineRecoveryLiveness =
  | { state: "alive"; lastSeenIso: string; ageSeconds: number }
  | { state: "wedged"; lastSeenIso: string; ageSeconds: number }
  | { state: "unknown"; reason: string };

/**
 * Is the engine's own recovery machinery executing?
 *
 * THREE states, not two, and `unknown` is the one that earns its place. A
 * never-stamped canary is what a fresh install, a not-yet-deployed canary, a
 * truncated table and a failed read all look like. Reading any of those as
 * "wedged" would mean the supervisor's first act on a brand-new instance is to
 * start moving tickets nobody asked it to touch. `decideSupervisorMode` treats
 * `unknown` exactly like `alive`: observe, and say so.
 */
export function assessEngineRecovery(
  lastSeenIso: string | null,
  nowIso: string,
  staleSeconds: number,
): EngineRecoveryLiveness {
  if (!lastSeenIso) {
    return { state: "unknown", reason: "the engine liveness canary has never been stamped" };
  }
  const ageMs = Date.parse(nowIso) - Date.parse(lastSeenIso);
  if (!Number.isFinite(ageMs)) {
    return { state: "unknown", reason: `unparseable liveness stamp (${lastSeenIso})` };
  }
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
  return ageSeconds > staleSeconds
    ? { state: "wedged", lastSeenIso, ageSeconds }
    : { state: "alive", lastSeenIso, ageSeconds };
}

export type SupervisorMode = "observe" | "remediate";

/**
 * THE non-duplication gate. The whole safety argument for this feature is that
 * this function returns "observe" in every case except a proven wedge.
 */
export function decideSupervisorMode(l: EngineRecoveryLiveness): {
  mode: SupervisorMode;
  reason: string;
} {
  switch (l.state) {
    case "alive":
      return {
        mode: "observe",
        reason: `engine recovery is alive (canary ${l.ageSeconds}s old) - the crons own this`,
      };
    case "unknown":
      // Fail closed. "We cannot tell" must never authorise a second writer.
      return { mode: "observe", reason: `engine recovery liveness unknown: ${l.reason}` };
    case "wedged":
      return {
        mode: "remediate",
        reason:
          `engine recovery has not run for ${l.ageSeconds}s (last stamp ${l.lastSeenIso}) - ` +
          `every cron safety net is dead`,
      };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The runner's own evidence
// ───────────────────────────────────────────────────────────────────────────

/**
 * Fold in what the runner alone knows: which runs it is ACTUALLY executing
 * right now.
 *
 * This is admitted as a VETO and never as an authorisation, and the asymmetry
 * is the point. On this board `runs` rows lied in both directions - runs marked
 * `failed` whose agent processes were still working 56 minutes later, and runs
 * marked `running` that were never claimed at all. A runner reporting a live
 * process is CONCLUSIVE that work is in flight, so it must stop us. A runner
 * NOT reporting one proves nothing: the runner pool is multi-host, and this
 * report describes one process. So absence can never turn a stand-down into an
 * action, and the worst a wrong report can do is make the supervisor act LESS.
 *
 * (Consequence, stated rather than hidden: a ticket held by a phantom `running`
 * run - a row nobody ever claimed - is NOT recoverable here, because the
 * orphan policy correctly stands down on `hasLiveRun`. `staleRunReaper` owns
 * that case, and when Inngest is wedged it is dead too. That is a real
 * remaining gap, and it is the one the incident did not exhibit: those five
 * tickets' runs had all ended `failed`/`cancelled`.)
 */
export function isVetoedByLiveRunner(
  candidateRunIds: readonly string[],
  liveRunIds: ReadonlySet<string>,
): boolean {
  return candidateRunIds.some((id) => liveRunIds.has(id));
}

// ───────────────────────────────────────────────────────────────────────────
// Findings and remediations
// ───────────────────────────────────────────────────────────────────────────

/**
 * Why the supervisor acted. This string is the LEDGER KEY - `detectRepeatDefect`
 * groups on it - so it must name a CAUSE ("the queue could not drain"), never an
 * instance ("ticket 47 stalled"). Grouping on an instance would make every
 * indictment a count of one and the whole escalation dead.
 */
export const SUPERVISOR_CAUSES = [
  /** Cron execution has stopped. Detection #3: "events accepted, nothing runs". */
  "engine_recovery_wedged",
  /** Tickets in flight while zero runs execute. Individually normal, jointly
   *  impossible, and invisible for six hours. */
  "board_deadlock",
  /** A non-terminal ticket whose latest run is failed/cancelled, with no live
   *  run and no pending dispatch, past the grace period. */
  "stalled_ticket",
  /**
   * Work reached the integration branch by a route that did not settle its
   * `pending_pushes` row.
   *
   * NAMED FOR THE ROUTE, NOT THE ROW, and that is the whole reason it can be
   * indicted at all. "Ticket 47's push row is stale" is an instance and would
   * make every accusation a count of one; "work landed by a path that skipped
   * the settle" is the CAUSE, so a recurring route accumulates under one key and
   * gets named. Which route it was is not knowable from the data (nothing
   * records which landing path stamped the sha), so the diagnosis goes in
   * `detail` where a human reads it and the grouping stays on the cause.
   */
  "landed_push_unsettled",
  /**
   * An operator drove the board from the supervisor console - a dispatch, a
   * status move, a ticket filed, a team started. NOT A DEFECT, and the ONLY
   * member of this list that is not; see `NON_INDICTABLE_CAUSES` below.
   *
   * ⚠️ A COMMANDED **REMEDIATION** DOES NOT USE THIS. `release_dispatch_queue`
   * and `recover_stalled_ticket` still record `board_deadlock` /
   * `stalled_ticket` exactly as the autonomous loop does, deliberately and for
   * the reason `console-store.ts`'s header gives: an operator hand-swept one
   * board six times in a day and every sweep hid a WIP-slot leak, so a console
   * that lets him sweep faster is strictly worse unless the sweeps count into
   * the same bucket the indictment groups on. Giving those their own cause
   * would silently re-open that hole.
   *
   * Ordinary commanding is a different act. Dispatching a ticket is not
   * evidence of anything being broken, so counting it toward a suspected defect
   * would fire the accusation on a healthy board that is merely being used -
   * which is the false alarm that teaches an operator to stop reading the real
   * one.
   */
  "operator_command",
] as const;

export type SupervisorCause = (typeof SUPERVISOR_CAUSES)[number];

/**
 * Causes that record an ACT rather than a FAULT, and so must never accumulate
 * into a suspected-defect accusation.
 *
 * A DENYLIST, not an allowlist, and the direction is the design: the two errors
 * are not symmetric. A cause wrongly listed here is a defect that never gets
 * accused - silent, and exactly what the indictment exists to prevent. A cause
 * wrongly left out is a false alarm, which is visible and gets fixed. So a
 * future cause is INDICTED BY DEFAULT and has to be argued out of it here.
 */
export const NON_INDICTABLE_CAUSES: ReadonlySet<SupervisorCause> = new Set(["operator_command"]);

export type SupervisorFinding = {
  cause: SupervisorCause;
  /** Tenant this finding belongs to, or null for instance-wide facts (the
   *  wedge itself). ALWAYS derived from a row, never asserted by the runner. */
  tenantId: string | null;
  projectId: string | null;
  ticketId: string | null;
  /** Operator-facing sentence. States the impossibility, not the symptom. */
  detail: string;
  /** True when this finding was seen but deliberately not acted on, with the
   *  reason folded into `detail`. Observe mode makes every finding advisory. */
  advisory: boolean;
};

export type SupervisorRemediation =
  | {
      cause: "board_deadlock";
      action: "release_dispatch_queue";
      tenantId: string;
      agentId: string;
      slots: number;
      detail: string;
    }
  | {
      cause: "stalled_ticket";
      action: "recover_ticket";
      tenantId: string;
      projectId: string | null;
      ticketId: string;
      to: TicketStatus;
      detail: string;
    };

/**
 * A repair of a RECORD rather than of the BOARD, and the distinction is the
 * whole safety argument for the one thing on this path that is NOT gated on the
 * engine being wedged.
 *
 * ── WHY THE LIVENESS GATE DOES NOT APPLY HERE ─────────────────────────────
 * The gate above exists for exactly one reason, stated in this module's header:
 * `release_dispatch_queue` and `recover_ticket` DUPLICATE A CRON
 * (`dispatchRescueReaper`, `orphanTicketReaper`), and two writers doing one
 * job on a healthy board is the failure this feature is otherwise so careful to
 * avoid. That is a non-duplication rule, not a blanket "never act" rule - the
 * supervisor CONSOLE reached the same conclusion for operator-commanded fixes
 * and says so in its own header.
 *
 * This repair duplicates NOTHING. There is no cron over `pending_pushes` and
 * there deliberately never has been: PR #156 refused one because the stale rows
 * were the only visible evidence the write path was incomplete. So there is no
 * second writer to fight.
 *
 * And gating it would make it useless in the direction that matters. Both
 * routes found leaking on 2026-08-04 - a landing that arrived via a hand-merged
 * rescue pull request, and PR #191's merger-landing path - leaked while Inngest
 * was perfectly healthy. A wedge-gated version of this would fire approximately
 * never, the rows would go on accumulating, and the feature would be theatre.
 *
 * What makes it safe is not the gate but the evidence rule
 * (`decideUnsettledPushRepair`) and the fact that it changes no board state: no
 * ticket moves, no queue row is claimed, no dispatch is emitted. It stamps a
 * timestamp on a bookkeeping row whose subject has already shipped - and
 * refuses to do even that unless the landing itself vouches for the row.
 *
 * KEEPING IT IN A SEPARATE ARRAY IS DELIBERATE. `remediations` must stay
 * provably empty in observe mode; `planSupervision` writes it inside a single
 * `if (mode === "remediate")` block precisely so that is structural rather than
 * a convention. Folding a non-duplicating repair into that array would either
 * break the property or bury this argument inside it.
 */
export type SupervisorBookkeepingRepair = {
  cause: "landed_push_unsettled";
  action: "settle_landed_push";
  tenantId: string;
  projectId: string | null;
  ticketId: string;
  pushId: string;
  detail: string;
};

/** A (tenant, agent) queue group, plus the opt-in fact the supervisor needs. */
export type SupervisedDispatchGroup = DispatchQueueGroup & {
  /**
   * True only when EVERY pending row in this group belongs to a project with
   * the supervisor opted in.
   *
   * ALL, not any, and the strictness is deliberate. The atomic claim
   * (`dispatch_queue_claim_next`) takes the head of the (tenant, agent) queue
   * and cannot be steered to a project, so releasing from a mixed group would
   * touch a row in a project whose operator never opted in. Detect it, report
   * it, leave it - an unsupervised project is not a project we may act on
   * because a supervised one happens to share an agent with it.
   */
  allRowsSupervised: boolean;
};

/** A candidate stalled ticket, carrying the evidence the orphan policy needs
 *  plus the run ids the runner veto is checked against. */
export type SupervisedTicket = {
  ticketId: string;
  tenantId: string;
  projectId: string | null;
  /** Every run on this ticket, for `isVetoedByLiveRunner`. */
  runIds: readonly string[];
  evidence: OrphanEvidence;
};

/**
 * One landed ticket whose push row is still unsettled. Already adjudicated by
 * `decideUnsettledPushRepair` in the store - the plan only places it, exactly as
 * it places a `decideOrphanRecovery` verdict rather than re-deriving one.
 */
export type UnsettledLandedPush = {
  tenantId: string;
  projectId: string | null;
  ticketId: string;
  pushId: string;
  /** The operator-facing sentence, already composed by
   *  `describeUnsettledPushRepair`. */
  detail: string;
};

export type SupervisorSnapshot = {
  liveness: EngineRecoveryLiveness;
  /** Only groups whose tenant has at least one supervised project. */
  dispatchGroups: readonly SupervisedDispatchGroup[];
  /** Only tickets in supervised projects. */
  stalledTickets: readonly SupervisedTicket[];
  /** Only rows in supervised projects, already passed through the evidence
   *  rule. Empty on a healthy board, which is the point. */
  unsettledLandedPushes: readonly UnsettledLandedPush[];
  nowIso: string;
  dispatchGraceSeconds: number;
};

export type SupervisorPlan = {
  mode: SupervisorMode;
  modeReason: string;
  findings: SupervisorFinding[];
  /** EMPTY whenever `mode === "observe"`, by construction - the array is only
   *  written inside the remediate branch below. */
  remediations: SupervisorRemediation[];
  /**
   * NOT gated on liveness, deliberately and with an argument - see
   * `SupervisorBookkeepingRepair`. These duplicate no cron, move nothing on the
   * board, and fix a record whose subject has already shipped.
   */
  bookkeepingRepairs: SupervisorBookkeepingRepair[];
};

/**
 * One supervision pass, as a pure function of a database snapshot plus the
 * runner's live-run set.
 *
 * Detection reuses the existing policies verbatim (`detectDispatchStall`,
 * `decideOrphanRecovery`) rather than restating their rules. That is not only
 * DRY: those two functions encode which states are NOT faults - a queue held by
 * `awaiting_human`, an automation-paused board, a fan-out cohort mid-settle -
 * and a second opinion about what counts as broken is exactly how a supervisor
 * starts fighting the reapers.
 */
export function planSupervision(
  snapshot: SupervisorSnapshot,
  /** Run ids the reporting runner is provably executing right now. */
  liveRunIds: ReadonlySet<string>,
): SupervisorPlan {
  const { mode, reason: modeReason } = decideSupervisorMode(snapshot.liveness);
  const advisory = mode === "observe";
  const findings: SupervisorFinding[] = [];

  // ── Detection #3: the queue is not executing. ─────────────────────────────
  // The liveness signal IS this detector - "events accepted but no function
  // completions" is precisely a stale canary - so it is recorded as a finding
  // rather than given separate machinery that could disagree with the gate.
  if (snapshot.liveness.state === "wedged") {
    findings.push({
      cause: "engine_recovery_wedged",
      tenantId: null,
      projectId: null,
      ticketId: null,
      detail:
        `No Inngest cron has executed for ${snapshot.liveness.ageSeconds}s ` +
        `(last stamp ${snapshot.liveness.lastSeenIso}). Every cron safety net - the stuck-ticket ` +
        `sweeper, the orphan/stale-run/land reapers, the dispatch rescue, the runner watchdog - ` +
        `is dead until this is fixed.`,
      advisory: false,
    });
  }

  // ── Detection #1: board deadlock. ─────────────────────────────────────────
  // Per group, so one busy agent never masks a stalled one.
  const deadlocked: SupervisedDispatchGroup[] = [];
  for (const group of snapshot.dispatchGroups) {
    const stall = detectDispatchStall([group], snapshot.nowIso, snapshot.dispatchGraceSeconds);
    if (!stall.contradiction) continue;
    deadlocked.push(group);
    const blocked = group.allRowsSupervised
      ? ""
      : " Not remediated: this agent's queue spans projects that have not opted in to supervision.";
    findings.push({
      cause: "board_deadlock",
      tenantId: group.tenantId,
      projectId: null,
      ticketId: null,
      detail: `${describeDispatchStall(stall)}${blocked}`,
      advisory: advisory || !group.allRowsSupervised,
    });
  }

  // ── Detection #2: stalled tickets. ────────────────────────────────────────
  const recoverable: Array<{ ticket: SupervisedTicket; to: TicketStatus; why: string }> = [];
  for (const ticket of snapshot.stalledTickets) {
    const decision = decideOrphanRecovery(ticket.evidence);
    if (decision.action !== "recover") continue;

    // The veto runs AFTER the policy, never before: it may only subtract from
    // what the policy already decided.
    if (isVetoedByLiveRunner(ticket.runIds, liveRunIds)) {
      findings.push({
        cause: "stalled_ticket",
        tenantId: ticket.tenantId,
        projectId: ticket.projectId,
        ticketId: ticket.ticketId,
        detail:
          `This ticket looks stalled (${decision.reason}), but a runner reports it is still ` +
          `executing one of its runs. The run record disagrees with the process; trusting the ` +
          `process and standing down.`,
        advisory: true,
      });
      continue;
    }

    recoverable.push({ ticket, to: decision.to, why: decision.reason });
    findings.push({
      cause: "stalled_ticket",
      tenantId: ticket.tenantId,
      projectId: ticket.projectId,
      ticketId: ticket.ticketId,
      detail: `Stalled: ${decision.reason}.`,
      advisory,
    });
  }

  // ── Detection #4: work that landed without settling its push row. ─────────
  // Every candidate here has ALREADY been adjudicated by
  // `decideUnsettledPushRepair` against evidence this function does not hold
  // (the landing's own resolved push id, the `nothing_to_land` notice). Placing
  // a verdict rather than re-deriving one is the same discipline that keeps
  // `decideOrphanRecovery` the single opinion about what a stall is.
  //
  // NOTE THE PLACEMENT: above the gate, on purpose. See
  // `SupervisorBookkeepingRepair` for why the non-duplication gate does not
  // apply to a repair that duplicates nothing - and note that this loop writes
  // only `bookkeepingRepairs`, never `remediations`, so the structural property
  // asserted below survives untouched.
  const bookkeepingRepairs: SupervisorBookkeepingRepair[] = [];
  for (const push of snapshot.unsettledLandedPushes) {
    bookkeepingRepairs.push({
      cause: "landed_push_unsettled",
      action: "settle_landed_push",
      tenantId: push.tenantId,
      projectId: push.projectId,
      ticketId: push.ticketId,
      pushId: push.pushId,
      detail: push.detail,
    });
    findings.push({
      cause: "landed_push_unsettled",
      tenantId: push.tenantId,
      projectId: push.projectId,
      ticketId: push.ticketId,
      detail: push.detail,
      // Never advisory: this one is acted on whatever the engine's state, so
      // reporting it as "seen but not acted on" would be false.
      advisory: false,
    });
  }

  // ── THE GATE. ─────────────────────────────────────────────────────────────
  // Everything above is observation, plus the one repair that duplicates no
  // cron. Nothing below runs on a healthy engine.
  if (mode === "observe") {
    return { mode, modeReason, findings, remediations: [], bookkeepingRepairs };
  }

  const remediations: SupervisorRemediation[] = [];

  for (const group of deadlocked) {
    if (!group.allRowsSupervised) continue;
    // Reuse the rescue policy's own capacity arithmetic rather than computing
    // free slots here - the WIP limit still bites, and a second calculation
    // could disagree with the gate the dispatcher will re-apply anyway.
    const decision = decideDispatchRescue(group, snapshot.nowIso, snapshot.dispatchGraceSeconds);
    if (decision.action !== "release") continue;
    remediations.push({
      cause: "board_deadlock",
      action: "release_dispatch_queue",
      tenantId: group.tenantId,
      agentId: group.agentId,
      slots: decision.slots,
      detail: decision.reason,
    });
  }

  for (const { ticket, to, why } of recoverable) {
    remediations.push({
      cause: "stalled_ticket",
      action: "recover_ticket",
      tenantId: ticket.tenantId,
      projectId: ticket.projectId,
      ticketId: ticket.ticketId,
      to,
      detail: why,
    });
  }

  return { mode, modeReason, findings, remediations, bookkeepingRepairs };
}

// ───────────────────────────────────────────────────────────────────────────
// THE INDICTMENT
//
// This is the part that matters most, and it is not a logging nicety.
//
// An operator hand-swept stalled tickets roughly six times in one day. Every
// sweep worked. Every sweep also hid the underlying defect - a WIP-slot leak -
// which stayed invisible for hours precisely because its symptoms kept getting
// cleared. The board looked like it was recovering. It was failing repeatedly
// and being rescued.
//
// An automatic supervisor makes that failure mode STRICTLY WORSE by default: it
// sweeps faster, more reliably, and without a human forming the impression that
// they keep doing the same thing. So repeated remediation of the same cause
// within a window is escalated as a SUSPECTED DEFECT, naming the cause and the
// count.
//
// "I re-dispatched this ticket" is maintenance. "I have re-dispatched tickets 14
// times in two hours" is the thing a human needs to see.
// ───────────────────────────────────────────────────────────────────────────

/**
 * How far back a repeat is counted. Two hours.
 *
 * Long enough to span the shape actually observed (six sweeps across a working
 * day is one every ~90 minutes, so a two-hour window catches an accelerating
 * one), short enough that a board healthy for a morning does not carry
 * yesterday's incident into today's alarm. Override with
 * DEVPILOT_SUPERVISOR_INDICTMENT_WINDOW_SECONDS.
 */
export const INDICTMENT_WINDOW_SECONDS_DEFAULT = 7200;

/**
 * How many remediations of ONE cause constitute an accusation. Five.
 *
 * Below this it is genuinely maintenance: a wedge is a real event, and clearing
 * a handful of tickets behind one is the supervisor working. Five separate
 * remediations of the same cause inside two hours is not an event, it is a
 * pattern, and a pattern that keeps needing the same fix is a bug report.
 * Override with DEVPILOT_SUPERVISOR_INDICTMENT_THRESHOLD.
 */
export const INDICTMENT_THRESHOLD_DEFAULT = 5;

/** One recorded remediation, as the ledger stores it. */
export type SupervisorLedgerEntry = {
  cause: SupervisorCause;
  createdAtIso: string;
  /** When this row was already counted into a fired escalation, or null/absent
   *  if it has not been. Only `selectUnescalatedIndictments` reads it - see the
   *  two-functions note below for why the STATE and the EVENT are different
   *  questions. */
  escalatedAtIso?: string | null;
};

export type SupervisorIndictment = {
  cause: SupervisorCause;
  count: number;
  windowSeconds: number;
  /** Oldest counted remediation - the "since when" of the pattern. */
  sinceIso: string;
};

/**
 * Find every cause remediated often enough, inside the window, to be a
 * suspected defect rather than maintenance.
 *
 * GROUPED BY CAUSE. Two unrelated one-offs are not a defect, and reporting them
 * as one is the false alarm that teaches an operator to ignore the real one -
 * the same reasoning that keeps `detectDispatchStall` silent on an
 * `awaiting_human` queue.
 *
 * An entry with an unparseable timestamp is DROPPED rather than counted. We
 * cannot place it in the window, and inflating an accusation with entries we
 * cannot date would make the count - the whole content of the accusation -
 * untrue.
 *
 * A `NON_INDICTABLE_CAUSES` entry is dropped for a different reason: it records
 * an operator ACT, not a fault, so counting it would accuse a healthy board of
 * a defect for the crime of being used. See that set for why it is a denylist.
 */
export function detectRepeatDefect(
  entries: readonly SupervisorLedgerEntry[],
  nowIso: string,
  windowSeconds: number,
  threshold: number,
): SupervisorIndictment[] {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return [];
  const cutoff = now - windowSeconds * 1000;

  const byCause = new Map<SupervisorCause, { count: number; oldest: string }>();
  for (const e of entries) {
    if (NON_INDICTABLE_CAUSES.has(e.cause)) continue;
    const at = Date.parse(e.createdAtIso);
    if (!Number.isFinite(at) || at < cutoff) continue;
    const seen = byCause.get(e.cause);
    if (!seen) {
      byCause.set(e.cause, { count: 1, oldest: e.createdAtIso });
      continue;
    }
    seen.count += 1;
    if (e.createdAtIso < seen.oldest) seen.oldest = e.createdAtIso;
  }

  const out: SupervisorIndictment[] = [];
  for (const [cause, agg] of byCause) {
    if (agg.count < threshold) continue;
    out.push({ cause, count: agg.count, windowSeconds, sinceIso: agg.oldest });
  }
  // Deterministic order so the rendered escalation is stable across ticks.
  return out.sort((a, b) => a.cause.localeCompare(b.cause));
}

/**
 * Which indictments should FIRE RIGHT NOW.
 *
 * ── WHY THIS IS A SECOND FUNCTION AND NOT A FLAG ──────────────────────────
 * `detectRepeatDefect` answers a question about STATE: "does this window look
 * like a defect?" That is what a status surface wants, and it must keep saying
 * yes for as long as it is true - a health row that went quiet after firing once
 * would tell an operator the board had recovered when it had not.
 *
 * This answers a question about an EVENT: "is there something NEW to say?"
 * Without it, a ledger that stays over threshold makes `detectRepeatDefect` true
 * on every pass, and the supervisor posts the same accusation to the same ticket
 * once a minute forever. An alarm that repeats itself into wallpaper is exactly
 * the failure this whole feature exists to prevent, so implementing it that way
 * would defeat the feature with the feature.
 *
 * The gate is the count of NOT-YET-ESCALATED rows. A cause fires at 5, its rows
 * are stamped, and it stays quiet until 5 MORE accumulate - a drumbeat that gets
 * louder as a defect gets worse, rather than either one lost message or a stream
 * of identical ones. The reported `count` is still the FULL window total,
 * because the number an operator needs is how many times this has happened, not
 * how many times it has happened since we last mentioned it.
 */
export function selectUnescalatedIndictments(
  entries: readonly SupervisorLedgerEntry[],
  nowIso: string,
  windowSeconds: number,
  threshold: number,
): SupervisorIndictment[] {
  const fresh = entries.filter((e) => !e.escalatedAtIso);
  // Which causes have enough NEW evidence to be worth saying again…
  const firing = new Set(
    detectRepeatDefect(fresh, nowIso, windowSeconds, threshold).map((i) => i.cause),
  );
  if (firing.size === 0) return [];
  // …reported against the FULL window, so the count is the true one.
  return detectRepeatDefect(entries, nowIso, windowSeconds, 1).filter((i) => firing.has(i.cause));
}

/**
 * The operator-facing accusation.
 *
 * Written to make the distinction the feature turns on impossible to miss: this
 * is not a report that something was fixed, it is a report that something keeps
 * needing fixing. It names the cause and the count because those two facts are
 * the whole content - "the supervisor has been busy" is exactly the reassuring
 * non-signal the hand-sweeping produced.
 */
export function renderIndictment(i: SupervisorIndictment): string {
  const hours = Math.round((i.windowSeconds / 3600) * 10) / 10;
  return (
    `SUSPECTED DEFECT - \`${i.cause}\` has been auto-remediated ${i.count} times in the last ` +
    `${hours}h (since ${i.sinceIso}). Each individual fix succeeded, which is why this is being ` +
    `reported: repeatedly clearing a symptom is how an underlying defect stays invisible. This is ` +
    `not routine maintenance. Investigate what keeps producing \`${i.cause}\` rather than ` +
    `letting the supervisor keep absorbing it.`
  );
}

/** One-line summary for the health probe / runner log. */
export function describeSupervisorPlan(plan: SupervisorPlan): string {
  if (plan.findings.length === 0) return "no findings";
  const counts = new Map<SupervisorCause, number>();
  for (const f of plan.findings) counts.set(f.cause, (counts.get(f.cause) ?? 0) + 1);
  const parts = [...counts].map(([cause, n]) => `${n}×${cause}`);
  const verb = plan.mode === "observe" ? "observed" : `remediating ${plan.remediations.length}`;
  // Reported separately, because "observed" would otherwise be a lie on a
  // healthy engine that nonetheless repaired a push row.
  const repairs =
    plan.bookkeepingRepairs.length > 0 ? `, repairing ${plan.bookkeepingRepairs.length}` : "";
  return `${verb}${repairs} - ${parts.join(", ")}`;
}
