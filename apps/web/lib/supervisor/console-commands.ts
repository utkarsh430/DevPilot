// The supervisor console's COMMAND vocabulary - full operating authority over
// one board, expressed as a closed set of operator commands. PURE (no IO, no
// `server-only`), like `console-actions.ts` and `console-facts.ts` beside it.
//
// ══════════════════════════════════════════════════════════════════════════
// WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT CHANGE
// ══════════════════════════════════════════════════════════════════════════
//
// `console-actions.ts` is the RECOVERY half: two remediations derived from
// board state, each delegating to a cron's own primitive. It is untouched by
// this module - `release_dispatch_queue` and `recover_stalled_ticket` keep
// their ids, their causes, their copy and their behaviour.
//
// This is the COMMAND half: everything an operator does today by driving agents
// from a terminal - dispatch, re-scope, move, close, reopen, file, wire
// dependencies, run a team - available from the console.
//
// ══════════════════════════════════════════════════════════════════════════
// THE SECURITY PROPERTY, WHICH IS **STRICTLY THE SAME ONE**, GENERALISED
// ══════════════════════════════════════════════════════════════════════════
//
// AGENTS.md states it for the recovery half: THE MODEL CANNOT NAME A TARGET,
// structurally rather than by prompt instruction. Ticket titles and comment
// bodies are AGENT-WRITABLE and they are the substance of what this console
// shows a model, so principle 6 forbids the model being an edge on any path to
// a mutation.
//
// A wider vocabulary does not weaken that, because the target still does not
// come from the model. It comes from the OPERATOR'S OWN MESSAGE:
//
//   1. `deriveOperatorTargets` reads `DevPilot-<N>` keys out of the operator's
//      QUESTION - and out of nothing else. Ticket titles are never scanned,
//      comment bodies are never scanned, and the model's reply has no field in
//      which a target could be expressed (`ConsoleReplySchema` is UNCHANGED by
//      this PR - not one field was added to it).
//   2. `deriveOperatorCommands` enumerates what is legal on THOSE tickets, from
//      the database snapshot, here.
//   3. The model may only echo ids from that list; `groundConsoleReply` drops
//      everything else. An id is LOOKED UP, never parsed, so a model cannot
//      construct one for a ticket the operator did not name.
//   4. `runConsoleCommand` recomputes the list server-side, from the live
//      database AND the operator's original message, before it acts.
//
// So a fully compromised model - one doing exactly what an injected ticket
// title tells it - achieves exactly one thing: a command that was ALREADY
// available on a ticket THE OPERATOR ALREADY NAMED appears higher in a list the
// operator reads and clicks, or does not. If the operator named no ticket, no
// ticket-scoped command exists to recommend, whatever the model says.
//
// ⚠️ DO NOT "improve" this by letting the model return a ticket key, and do NOT
// auto-run a recommended command because the operator's message read like an
// instruction. Either change makes the fence in `console-brief.ts` - which
// AGENTS.md is explicit is a speed bump, not a boundary - the only thing left.
//
// ══════════════════════════════════════════════════════════════════════════
// THE CONFIRMATION ENVELOPE
// ══════════════════════════════════════════════════════════════════════════
//
// Full authority is not unconfirmed authority. Every command declares a
// `ConfirmationLevel`, and the level is a property of the COMMAND rather than
// of the UI, so the server can re-check it (`runConsoleCommand` refuses a
// `type_to_confirm` command whose confirmation does not match, exactly as
// `discardAndRestartFromDevAction` does).
//
//   • `none`            - reversible and cheap. Dispatch, a directive comment.
//   • `acknowledge`     - real effect, real cost, still reversible. Pausing a
//                         ticket, moving it, filing one, starting a team.
//   • `type_to_confirm` - IRREVERSIBLE or an acceptance of work. The operator
//                         types the ticket key. `close_obsolete` (→ `failed`,
//                         which has NO out-edges in the FSM at all), `mark_done`
//                         (accepting work, and the human half of the SME safety
//                         gate) and `reopen_ticket` (discards the finished
//                         state of a ticket).
//
// ══════════════════════════════════════════════════════════════════════════
// WHAT IS STILL REFUSED, AND WHY IT IS NOT IN THIS FILE
// ══════════════════════════════════════════════════════════════════════════
//
// Discarding uncommitted work, force pushes, anything touching credentials, and
// anything outward-facing (land, push, deploy, promote). These are not gated
// commands with a high confirmation level - THEY ARE ABSENT FROM THE
// VOCABULARY, so there is no id an operator or a model could send. Every one of
// them already has a purpose-built operator surface with its own confirmation
// (`discardAndRestartFromDevAction`'s type-to-confirm, the Land/Push controls,
// the Vercel deploy card), and duplicating them here would be a second path to
// an irreversible act with a second confirmation policy - which is exactly how
// one of the two policies ends up being the weaker one.

import { ROLES } from "@/lib/roles";
import { canTransition, type TicketStatus } from "@/lib/board/state";
import {
  MAX_FAN_OUT as MAX_COHORT_SIZE,
  MAX_TOTAL_COHORTS_PER_TICKET,
  planFanOut,
  validateCohortPlan,
  type CohortPlan,
} from "@/lib/engine/fan-out";
import { MAX_TOTAL_AGENTS } from "@/lib/engine/spawn-caps";
import {
  AGENT_MAX_DEPENDENCIES,
  classifyDependencyRef,
  dependencyRefKey,
  type DependencyRef,
} from "@/lib/board/ticket-deps";
import { extractTicketKeys } from "@/lib/supervisor/console-brief";
import type { ConsoleSnapshot, ConsoleTicketFact } from "@/lib/supervisor/console-facts";

// ───────────────────────────────────────────────────────────────────────────
// Vocabulary
// ───────────────────────────────────────────────────────────────────────────

export const CONSOLE_COMMAND_KINDS = [
  /** Dispatch or re-dispatch a ticket, with an explicit role. Primitive:
   *  `ticket/dispatch-needed` with `forceRole`. */
  "dispatch_ticket",
  /** Pause a ticket and cancel its in-flight runs. Primitive: `pauseTicket`. */
  "pause_ticket",
  /** Take a ticket out of Paused. Primitive: `resumeTicket`. */
  "resume_ticket",
  /** Re-scope: post a directive the ticket's next run reads. Primitive:
   *  `addComment` (+ the `input_required` resume path). */
  "rescope_ticket",
  /** Move a ticket between NON-terminal columns. Primitive: `transitionTicket`
   *  with `actor: "human"`, so every gate applies. */
  "move_ticket",
  /** Accept the work: → `done`. Its own kind rather than a `move_ticket`
   *  target, because it is an acceptance and carries type-to-confirm. */
  "mark_done",
  /** Close as obsolete: → `failed`, which is TERMINAL with no out-edges. */
  "close_obsolete",
  /** Reopen a settled ticket to the backlog. Human-only FSM edge. */
  "reopen_ticket",
  /** File a new backlog ticket. Primitive: `createTicketCore`. */
  "create_ticket",
  /** Declare what a ticket waits on. Primitive: the `dependsOn` resolver plus
   *  `planTicketDependencies`' cycle guard. */
  "set_dependencies",
  /** Run a TEAM on a ticket: a fan-out cohort. Primitive: the dispatcher's own
   *  `cohort_plan` path - this arms the plan, the dispatcher runs it. */
  "spawn_team",
  /** Run a team on a GOAL with no ticket: one lead agent with the authority to
   *  spawn its own specialists through `devpilot_spawn_agent`. */
  "spawn_goal_team",
] as const;

export type ConsoleCommandKind = (typeof CONSOLE_COMMAND_KINDS)[number];

/** See the header. A property of the command, re-checked server-side. */
export type ConfirmationLevel = "none" | "acknowledge" | "type_to_confirm";

/**
 * The ledger cause for every command in this vocabulary.
 *
 * NOT one of the autonomous supervisor's defect causes, and that is the one
 * place this module's reasoning diverges from `console-store.ts`'s. A commanded
 * REMEDIATION shares `board_deadlock` / `stalled_ticket` so the repeat-defect
 * indictment counts the sweeps a human performs - the whole reason the ledger
 * exists. Commanding a dispatch is not a remediation of anything, so counting
 * it toward a suspected defect would accuse a healthy board of being broken for
 * the crime of being used. `NON_INDICTABLE_CAUSES` is where that is enforced.
 */
export const CONSOLE_COMMAND_CAUSE = "operator_command" as const;

/** One field of a command's operator-supplied payload. Rendered generically, so
 *  a new command needs no new UI. */
export type CommandField =
  | {
      name: string;
      kind: "text";
      label: string;
      help?: string;
      placeholder?: string;
      maxChars: number;
      required: boolean;
      multiline?: boolean;
    }
  | {
      name: string;
      kind: "select";
      label: string;
      help?: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      required: boolean;
      defaultValue?: string;
    }
  | {
      name: string;
      kind: "multiselect";
      label: string;
      help?: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      min: number;
      max: number;
    }
  | {
      name: string;
      kind: "number";
      label: string;
      help?: string;
      min: number;
      max: number;
      defaultValue: number;
    };

export type ConsoleCommand = {
  /**
   * Stable, content-derived id and the ONLY thing a client or a model may send.
   * It is LOOKED UP against a freshly derived list, never parsed - so a
   * well-formed id for a ticket the operator did not name matches nothing.
   */
  id: string;
  kind: ConsoleCommandKind;
  cause: typeof CONSOLE_COMMAND_CAUSE;
  /** Button text. Imperative, names the target. */
  label: string;
  /** What will actually happen, in one sentence. An operator must be able to
   *  decline from this alone. */
  consequence: string;
  confirmation: ConfirmationLevel;
  /** The ticket this acts on. Set for every ticket-scoped command, and ALWAYS
   *  a ticket the operator named in their own message. */
  ticketId?: string;
  ticketKey?: string;
  fields: readonly CommandField[];
};

function commandId(kind: ConsoleCommandKind, target: string): string {
  return `cmd:${kind}:${target}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Targets - the security seam
// ───────────────────────────────────────────────────────────────────────────

export type OperatorTargets = {
  /** Tickets the operator named, in the order named, resolved against the
   *  snapshot. THE ONLY tickets any ticket-scoped command may act on. */
  tickets: ConsoleTicketFact[];
  /** Keys the operator named that this project has no ticket for. Reported, not
   *  silently ignored - see `buildBoardReport`'s missing-focus note. */
  missingKeys: string[];
};

/**
 * Which tickets the OPERATOR named.
 *
 * ⚠️ THIS IS THE SECURITY SEAM OF THE WHOLE COMMAND HALF. Its only input from
 * outside the database is `question`, which is the operator's own text. It does
 * NOT read ticket titles, comment bodies, land errors, branch names, or the
 * model's reply - all of which are agent-writable, all of which the console
 * shows a model, and none of which may select what gets acted on.
 *
 * `extractTicketKeys` is reused verbatim rather than re-implemented: it is
 * already the function that decides which tickets an operator's question is
 * about (it pins them into the snapshot), so having a second parser here would
 * mean the console could act on a ticket it did not detail, or detail one it
 * could not act on.
 */
export function deriveOperatorTargets(
  question: string,
  snapshot: ConsoleSnapshot,
): OperatorTargets {
  const keys = extractTicketKeys(question);
  const byKey = new Map(snapshot.tickets.map((t) => [t.key, t]));
  const tickets: ConsoleTicketFact[] = [];
  const missingKeys: string[] = [];
  for (const k of keys) {
    const hit = byKey.get(k);
    if (hit) tickets.push(hit);
    else missingKeys.push(k);
  }
  return { tickets, missingKeys };
}

// ───────────────────────────────────────────────────────────────────────────
// Derivation
// ───────────────────────────────────────────────────────────────────────────

/** Non-terminal columns `move_ticket` may target. `done`, `failed` and
 *  `backlog` are excluded ON PURPOSE - each has its own kind with its own
 *  confirmation level, and offering a second, weaker route to the same
 *  irreversible move is how one of the two policies becomes the weak one. */
const PLAIN_MOVE_TARGETS: readonly TicketStatus[] = [
  "ready",
  "assigned",
  "in_progress",
  "in_review",
  "blocked",
];

/** Statuses a team may be started on. Deliberately narrow: the dispatcher's
 *  cohort path transitions `ready → in_progress` and seeds runs, so starting a
 *  team on a `backlog` ticket would leave runs executing under a ticket sitting
 *  in Backlog, and starting one on a settled ticket is meaningless. */
const TEAM_STARTABLE_STATUSES = new Set<TicketStatus>(["ready", "in_progress"]);

/** Budget bounds for a commanded team, in cents. The floor is not a preference:
 *  `assertCanSpawn` refuses `budgetCents <= 0` outright, so a zero-budget lead
 *  could spawn nothing at all and would look like a broken feature. */
export const TEAM_BUDGET_MIN_CENTS = 25;
export const TEAM_BUDGET_MAX_CENTS = 2000;
export const TEAM_BUDGET_DEFAULT_CENTS = 200;

export type CommandDerivationInput = {
  snapshot: ConsoleSnapshot;
  targets: OperatorTargets;
  /**
   * Role slugs the dispatcher would actually honour: built-ins plus this
   * tenant's custom agents. Passed in rather than read here so this function
   * stays pure AND so the console can never offer a role `decideNextRole` would
   * silently drop back to the state machine on.
   */
  dispatchableRoles: readonly string[];
  /** Live active-run count for the tenant, or null when it could not be read.
   *  Null DISABLES the goal-team offer rather than guessing - see below. */
  activeRuns: number | null;
};

/**
 * Everything the operator may command right now.
 *
 * Ticket-scoped commands exist ONLY for tickets in `targets.tickets`, i.e. only
 * for tickets the operator named. Project-scoped commands (`create_ticket`,
 * `spawn_goal_team`) need no ticket - the operator selected their target by
 * having this project's console open.
 *
 * Legality is decided by the FSM (`canTransition`) and by board facts, so an
 * offered command is one the primitive will accept. It is still only an OFFER:
 * `transitionTicket`, `pauseTicket` and the dispatcher all re-derive and may
 * refuse, and a refusal is REPORTED rather than worked around - the same
 * contract the recovery half already has.
 */
export function deriveOperatorCommands(input: CommandDerivationInput): ConsoleCommand[] {
  const { snapshot, targets, dispatchableRoles, activeRuns } = input;
  const out: ConsoleCommand[] = [];
  const roleOptions = roleSelectOptions(dispatchableRoles);

  for (const t of targets.tickets) {
    out.push(...ticketCommands(t, roleOptions, activeRuns));
  }

  // ── Project-scoped ──────────────────────────────────────────────────────
  out.push({
    id: commandId("create_ticket", snapshot.projectId),
    kind: "create_ticket",
    cause: CONSOLE_COMMAND_CAUSE,
    label: "File a new ticket",
    consequence:
      `Creates a ticket in ${snapshot.projectName}'s BACKLOG. Nothing dispatches from Backlog, so ` +
      `it starts no run and spends nothing - you move it to Ready when you want it picked up.`,
    confirmation: "acknowledge",
    fields: [
      { name: "title", kind: "text", label: "Title", maxChars: 200, required: true },
      {
        name: "description",
        kind: "text",
        label: "Description",
        maxChars: 8000,
        required: false,
        multiline: true,
      },
      {
        name: "role",
        kind: "select",
        label: "Role (optional)",
        help: "Leave unset to let the dispatcher classify it.",
        options: [{ value: "", label: "Auto — let the dispatcher pick" }, ...roleOptions],
        required: false,
        defaultValue: "",
      },
    ],
  });

  if (activeRuns !== null && activeRuns < MAX_TOTAL_AGENTS) {
    out.push({
      id: commandId("spawn_goal_team", snapshot.projectId),
      kind: "spawn_goal_team",
      cause: CONSOLE_COMMAND_CAUSE,
      label: "Start an agent on a goal",
      consequence:
        `Starts ONE lead agent, with no ticket, on the goal you write. It may spawn its own ` +
        `specialists through the ordinary spawn route, which re-checks depth, fan-out, the ` +
        `${MAX_TOTAL_AGENTS}-run tenant cap and budget headroom on every child. Its whole subtree ` +
        `draws from the budget you set here and cannot exceed it.`,
      confirmation: "acknowledge",
      fields: [
        {
          name: "goal",
          kind: "text",
          label: "Goal",
          help: "What the lead agent should achieve. It has no ticket, so this is all it gets.",
          maxChars: 4000,
          required: true,
          multiline: true,
        },
        {
          name: "role",
          kind: "select",
          label: "Lead role",
          options: roleOptions,
          required: true,
          defaultValue: roleOptions.some((r) => r.value === "tech_lead")
            ? "tech_lead"
            : roleOptions[0]?.value,
        },
        {
          name: "budgetCents",
          kind: "number",
          label: "Budget (cents)",
          help: "A hard ceiling on the whole subtree, not an estimate.",
          min: TEAM_BUDGET_MIN_CENTS,
          max: TEAM_BUDGET_MAX_CENTS,
          defaultValue: TEAM_BUDGET_DEFAULT_CENTS,
        },
      ],
    });
  }

  return out;
}

function ticketCommands(
  t: ConsoleTicketFact,
  roleOptions: ReadonlyArray<{ value: string; label: string }>,
  activeRuns: number | null,
): ConsoleCommand[] {
  const out: ConsoleCommand[] = [];
  const key = t.key;

  // Dispatch. Offered whenever the ticket is not settled - including while a
  // run is live, because "re-dispatch, it is going nowhere" is a real operator
  // move; the consequence text says so rather than the offer being withheld.
  if (!isSettled(t.status)) {
    out.push({
      id: commandId("dispatch_ticket", t.ticketId),
      kind: "dispatch_ticket",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Dispatch ${key}`,
      consequence:
        `Asks the dispatcher to start ${key} as the role you pick. It re-applies every gate first - ` +
        `automation pause, billing, the WIP limit, the QA retry ceiling - so it may queue or refuse, ` +
        `and it reports which.` +
        (t.hasLiveRun
          ? " A run is LIVE on this ticket right now; this does not cancel it, so you may end up with two."
          : ""),
      confirmation: t.hasLiveRun ? "acknowledge" : "none",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [
        {
          name: "role",
          kind: "select",
          label: "Role",
          options: roleOptions,
          required: true,
          // Pre-fill with the ticket's own requested role ONLY when it is still
          // a role the dispatcher would honour. A `requested_role` naming a
          // custom agent that has since been deleted is a real state, and a
          // default outside the option list makes the command un-runnable
          // (validation refuses it) for a reason the operator cannot see.
          defaultValue: roleOptions.some((o) => o.value === t.requestedRole)
            ? (t.requestedRole ?? undefined)
            : undefined,
        },
      ],
    });
  }

  // Re-scope. A comment is additive and reversible, so no confirmation - but it
  // is NOT a no-op: on an `input_required` ticket a human comment is the
  // documented resume path and fires a fresh dispatch.
  if (!isSettled(t.status)) {
    out.push({
      id: commandId("rescope_ticket", t.ticketId),
      kind: "rescope_ticket",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Re-scope ${key}`,
      consequence:
        `Posts your directive on ${key} as a comment from you. The ticket's next run reads the ` +
        `comment thread, so this is how you change what it is meant to do without editing the ` +
        `ticket.` +
        (t.status === "input_required"
          ? " This ticket is waiting on you, so replying also resumes it: it moves back to In progress and a fresh run starts."
          : ""),
      confirmation: "none",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [
        {
          name: "directive",
          kind: "text",
          label: "Directive",
          maxChars: RESCOPE_MAX_CHARS,
          required: true,
          multiline: true,
        },
      ],
    });
  }

  // Pause / resume.
  if (PAUSABLE_STATUSES.has(t.status)) {
    out.push({
      id: commandId("pause_ticket", t.ticketId),
      kind: "pause_ticket",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Pause ${key}`,
      consequence:
        `Moves ${key} to Paused and CANCELS every run in flight on it at the next safe boundary. ` +
        `Work already committed is kept; the run resumes from its last checkpoint when you unpause.`,
      confirmation: "acknowledge",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [],
    });
  }
  if (t.status === "paused") {
    out.push({
      id: commandId("resume_ticket", t.ticketId),
      kind: "resume_ticket",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Unpause ${key}`,
      consequence: `Takes ${key} out of Paused and resumes it from its last checkpoint.`,
      confirmation: "none",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [],
    });
  }

  // Plain column moves.
  const moveTargets = PLAIN_MOVE_TARGETS.filter((to) => canTransition(t.status, to));
  if (moveTargets.length > 0) {
    out.push({
      id: commandId("move_ticket", t.ticketId),
      kind: "move_ticket",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Move ${key}`,
      consequence:
        `Moves ${key} to the column you pick, as you rather than as an agent - so the QA hand-off ` +
        `gate does not apply and the move may start a fresh run, exactly as dragging the card would.`,
      confirmation: "acknowledge",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [
        {
          name: "to",
          kind: "select",
          label: "Column",
          options: moveTargets.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
          required: true,
        },
      ],
    });
  }

  // Accept the work.
  if (canTransition(t.status, "done")) {
    out.push({
      id: commandId("mark_done", t.ticketId),
      kind: "mark_done",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Mark ${key} done`,
      consequence:
        `Accepts ${key}'s work and moves it to Done, which enqueues its branch for landing on the ` +
        `integration branch.` +
        (t.safetyCritical
          ? " This ticket is SAFETY-CRITICAL: only a human may complete it, and doing this here is that approval."
          : ""),
      confirmation: "type_to_confirm",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [],
    });
  }

  // Close as obsolete. `failed` has NO out-edges in the FSM, so this is the one
  // ticket-scoped command that cannot be undone from the board at all.
  if (canTransition(t.status, "failed")) {
    out.push({
      id: commandId("close_obsolete", t.ticketId),
      kind: "close_obsolete",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Close ${key} as obsolete`,
      consequence:
        `Moves ${key} to Failed and records your reason on it. Failed is TERMINAL - the state ` +
        `machine has no way out of it, so this cannot be undone from the board. Anything blocked ` +
        `on ${key} stays blocked forever, because a failed blocker never counts as satisfied.`,
      confirmation: "type_to_confirm",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [
        {
          name: "reason",
          kind: "text",
          label: "Why it is obsolete",
          maxChars: RESCOPE_MAX_CHARS,
          required: true,
          multiline: true,
        },
      ],
    });
  }

  // Reopen. The human-only `→ backlog` edge.
  if (canTransition(t.status, "backlog")) {
    out.push({
      id: commandId("reopen_ticket", t.ticketId),
      kind: "reopen_ticket",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Reopen ${key}`,
      consequence:
        `Sends ${key} back to the Backlog so it can run again. It does NOT touch the workspace: any ` +
        `uncommitted or unpushed work on its branch is left exactly where it is, and the next run ` +
        `re-enters that same checkout. Use "Discard & restart from dev" on the ticket itself if you ` +
        `want a clean tree - this console will not discard work.`,
      confirmation: "type_to_confirm",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [],
    });
  }

  // Dependencies.
  if (!isSettled(t.status)) {
    out.push({
      id: commandId("set_dependencies", t.ticketId),
      kind: "set_dependencies",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Set what ${key} waits on`,
      consequence:
        `Adds blocking dependencies to ${key}, so it cannot become Ready until they are done AND ` +
        `their commits are on the integration branch. Refuses anything that would deadlock, and ` +
        `only ADDS - existing dependencies are left alone.`,
      confirmation: "acknowledge",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [
        {
          name: "dependsOn",
          kind: "text",
          label: "Blockers",
          help: `Ticket keys or uuids, comma-separated. At most ${AGENT_MAX_DEPENDENCIES}.`,
          placeholder: "DevPilot-12, DevPilot-14",
          maxChars: 600,
          required: true,
        },
      ],
    });
  }

  // Team on the ticket.
  //
  // The tenant-cap arm is a LEGIBILITY pre-check, and it is honest about being
  // one: the dispatcher's cohort path seeds its sibling runs directly and does
  // NOT consult `MAX_TOTAL_AGENTS` (only `assertCanSpawn`, on the spawn-tree
  // path, does). That is pre-existing engine behaviour this console does not
  // change - so withholding the offer when the tenant has no room for even a
  // minimum team is the console declining to make a bad situation worse, not a
  // ceiling being enforced here. The ceilings that DO bind are the cohort's:
  // `planFanOut` and `validateCohortPlan`, imported and re-run by the
  // dispatcher.
  const roomForATeam = activeRuns === null || activeRuns + 2 <= MAX_TOTAL_AGENTS;
  if (TEAM_STARTABLE_STATUSES.has(t.status) && !t.automationPaused && roomForATeam) {
    out.push({
      id: commandId("spawn_team", t.ticketId),
      kind: "spawn_team",
      cause: CONSOLE_COMMAND_CAUSE,
      label: `Run a team on ${key}`,
      consequence:
        `Starts up to ${MAX_COHORT_SIZE} agents on ${key} at once, one per role, and holds the ` +
        `ticket until they have all reported. This is the dispatcher's own fan-out - every ceiling ` +
        `it enforces still applies, and it refuses outright if ${key} has already fanned out.`,
      confirmation: "acknowledge",
      ticketId: t.ticketId,
      ticketKey: key,
      fields: [
        {
          name: "roles",
          kind: "multiselect",
          label: "Team",
          help: `Between 2 and ${MAX_COHORT_SIZE} roles. The first is the lead the dispatcher starts from.`,
          options: roleOptions,
          min: 2,
          max: MAX_COHORT_SIZE,
        },
        {
          name: "strategy",
          kind: "select",
          label: "Accept when",
          options: [
            { value: "all", label: "Every member has reported" },
            { value: "quorum(2)", label: "Any two have reported" },
            { value: "single", label: "Any one has reported" },
          ],
          required: true,
          defaultValue: "all",
        },
      ],
    });
  }

  return out;
}

const PAUSABLE_STATUSES = new Set<TicketStatus>([
  "assigned",
  "in_progress",
  "input_required",
  "blocked",
  "in_review",
]);

const STATUS_LABELS: Record<TicketStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  assigned: "Assigned",
  in_progress: "In progress",
  input_required: "Input required",
  blocked: "Blocked",
  in_review: "In review",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
};

export const RESCOPE_MAX_CHARS = 4000;

function isSettled(s: TicketStatus): boolean {
  return s === "done" || s === "failed";
}

function roleSelectOptions(
  slugs: readonly string[],
): ReadonlyArray<{ value: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ value: string; label: string }> = [];
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const builtin = (ROLES as Record<string, { displayName?: string } | undefined>)[slug];
    out.push({ value: slug, label: builtin?.displayName ?? slug });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** Look one up by the id a client or a model sent. Undefined for anything not
 *  in the freshly derived list - which is the whole point. */
export function findConsoleCommand(
  available: readonly ConsoleCommand[],
  id: unknown,
): ConsoleCommand | undefined {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return undefined;
  return available.find((c) => c.id === id);
}

// ───────────────────────────────────────────────────────────────────────────
// Payload validation
// ───────────────────────────────────────────────────────────────────────────

export type CommandValues = Record<string, string | string[] | number>;

export type PayloadResult = { ok: true; values: CommandValues } | { ok: false; error: string };

/**
 * Validate the operator's payload against the command's OWN field list.
 *
 * Every option a `select`/`multiselect` accepts was computed from the database
 * (role slugs the dispatcher honours, statuses the FSM permits), so this is
 * also the point at which a forged POST naming an arbitrary role or an illegal
 * column is refused - not by a second policy, but by the same list the operator
 * was shown.
 */
export function validateCommandPayload(
  command: ConsoleCommand,
  raw: Record<string, unknown> | null | undefined,
): PayloadResult {
  const input = raw ?? {};
  const values: CommandValues = {};

  for (const field of command.fields) {
    const supplied = input[field.name];

    if (field.kind === "text") {
      const s = typeof supplied === "string" ? supplied.trim() : "";
      if (s.length === 0) {
        if (field.required) return { ok: false, error: `${field.label} is required.` };
        values[field.name] = "";
        continue;
      }
      if (s.length > field.maxChars) {
        return {
          ok: false,
          error: `${field.label} is ${s.length} characters; the limit is ${field.maxChars}.`,
        };
      }
      values[field.name] = s;
      continue;
    }

    if (field.kind === "select") {
      const s = typeof supplied === "string" ? supplied.trim() : (field.defaultValue ?? "");
      if (s.length === 0) {
        if (field.required) return { ok: false, error: `${field.label} is required.` };
        values[field.name] = "";
        continue;
      }
      if (!field.options.some((o) => o.value === s)) {
        return {
          ok: false,
          error: `${field.label}: "${s.slice(0, 40)}" is not one of the choices.`,
        };
      }
      values[field.name] = s;
      continue;
    }

    if (field.kind === "multiselect") {
      const list = Array.isArray(supplied)
        ? supplied.filter((x): x is string => typeof x === "string").map((x) => x.trim())
        : [];
      const deduped: string[] = [];
      for (const item of list) {
        // Deliberately NOT silent: the cohort path refuses a duplicate role
        // outright (`planFanOut`), so accepting one and quietly shrinking the
        // team would give the operator a smaller team than they asked for.
        if (deduped.includes(item)) {
          return { ok: false, error: `${field.label}: ${item} is listed twice.` };
        }
        if (!field.options.some((o) => o.value === item)) {
          return {
            ok: false,
            error: `${field.label}: "${item.slice(0, 40)}" is not one of the choices.`,
          };
        }
        deduped.push(item);
      }
      if (deduped.length < field.min || deduped.length > field.max) {
        return {
          ok: false,
          error: `${field.label} needs between ${field.min} and ${field.max} entries (got ${deduped.length}).`,
        };
      }
      values[field.name] = deduped;
      continue;
    }

    // number
    const n = typeof supplied === "number" ? supplied : Number(supplied);
    const resolved = Number.isFinite(n) ? Math.round(n) : field.defaultValue;
    if (resolved < field.min || resolved > field.max) {
      return {
        ok: false,
        error: `${field.label} must be between ${field.min} and ${field.max} (got ${resolved}).`,
      };
    }
    values[field.name] = resolved;
  }

  return { ok: true, values };
}

export function stringValue(values: CommandValues, name: string): string {
  const v = values[name];
  return typeof v === "string" ? v : "";
}

export function listValue(values: CommandValues, name: string): string[] {
  const v = values[name];
  return Array.isArray(v) ? v : [];
}

export function numberValue(values: CommandValues, name: string, fallback: number): number {
  const v = values[name];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// ───────────────────────────────────────────────────────────────────────────
// Confirmation
// ───────────────────────────────────────────────────────────────────────────

export type ConfirmationResult = { ok: true } | { ok: false; error: string };

/**
 * Re-check the operator's confirmation SERVER-SIDE.
 *
 * The UI collects it, but the UI is not the gate: `"use server"` exports are
 * browser-reachable endpoints, so a forged POST would otherwise reach a
 * type-to-confirm command with no confirmation at all. The token an operator
 * must type is the TICKET KEY, following `discardAndRestartFromDevAction`'s
 * precedent - a key names the thing being acted on, so what is confirmed and
 * what happens cannot drift apart the way a checkbox and its label can.
 */
export function checkCommandConfirmation(
  command: ConsoleCommand,
  confirmation: unknown,
): ConfirmationResult {
  if (command.confirmation === "none") return { ok: true };

  const supplied = typeof confirmation === "string" ? confirmation.trim() : "";

  if (command.confirmation === "acknowledge") {
    if (supplied !== CONFIRM_ACK_TOKEN) {
      return {
        ok: false,
        error: `${command.label} needs to be confirmed before it runs. Nothing has changed.`,
      };
    }
    return { ok: true };
  }

  const expected = command.ticketKey ?? "";
  if (expected.length === 0) {
    // Unreachable today (every type_to_confirm command is ticket-scoped) and
    // fails CLOSED rather than degrading to an acknowledgement, because the
    // failure it would otherwise permit is an irreversible move.
    return { ok: false, error: "This command cannot be confirmed, so it will not run." };
  }
  if (supplied.toLowerCase() !== expected.toLowerCase()) {
    return {
      ok: false,
      error:
        `This is irreversible, so it needs typing out: enter ${expected} to confirm. ` +
        `Nothing has changed.`,
    };
  }
  return { ok: true };
}

/** The literal an `acknowledge` command expects. A constant rather than "any
 *  truthy value" so an empty form field can never read as a confirmation. */
export const CONFIRM_ACK_TOKEN = "confirm";

// ───────────────────────────────────────────────────────────────────────────
// Team planning - the ceilings, quoted rather than re-derived
// ───────────────────────────────────────────────────────────────────────────

export type TeamPlan =
  | { ok: true; plan: CohortPlan; leadRole: string; members: string[] }
  | { ok: false; error: string };

/**
 * Turn an operator's team into the dispatcher's OWN `cohort_plan` shape, and
 * refuse anything the dispatcher would refuse.
 *
 * ⚠️ EVERY CEILING HERE IS THE ENGINE'S, IMPORTED, NEVER RE-DERIVED.
 * `planFanOut` is the cohort-size cap and `validateCohortPlan` is the
 * depth/total/cycle/dangling-parent check - the exact functions `decideFanOut`
 * calls, so the two cannot disagree about what is too big.
 *
 * And this is a PRE-check for legibility, not the enforcement point: the plan we
 * write is read back by the dispatcher, which runs `validateCohortPlan` again
 * on it before emitting a single sibling. Refusing here is what turns an
 * over-cap request into a sentence the operator reads instead of a
 * NonRetriableError buried in a run they never open.
 */
export function planCommandedTeam(args: {
  members: readonly string[];
  strategy: string;
  ticketKey: string;
}): TeamPlan {
  const members = args.members.map((m) => m.trim()).filter((m) => m.length > 0);
  const size = planFanOut(members);
  if (!size.ok) {
    return {
      ok: false,
      error:
        `That team is not runnable: ${size.reason}. The engine caps one cohort at ` +
        `${MAX_COHORT_SIZE} agents, and it would refuse this on the way in.`,
    };
  }

  const leadRole = members[0]!;
  const plan: CohortPlan = {
    version: 1,
    cohorts: [
      {
        // Namespaced so it cannot collide with a cohort key an operator wired
        // in the visual builder, and so the ledger can tell the two apart.
        cohort_key: "operator_team",
        members: [...members],
        acceptance_strategy: args.strategy,
        // No fan-in role: the cohort decides and the state machine takes over,
        // which is the ordinary path. Naming one here would be the console
        // deciding who reviews the team's work, which is the ticket's business.
        fan_in_role: null,
        parent_cohort_key: null,
        // The dispatcher fires a top-level cohort when its `trigger_role`
        // matches the role it was going to pick - so the command dispatches
        // with `forceRole = leadRole` and the two match by construction.
        trigger_role: leadRole,
      },
    ],
  };

  try {
    validateCohortPlan(plan);
  } catch (err) {
    return {
      ok: false,
      error:
        `That team is not runnable: ${err instanceof Error ? err.message : String(err)}. ` +
        `A ticket may carry at most ${MAX_TOTAL_COHORTS_PER_TICKET} cohorts.`,
    };
  }

  return { ok: true, plan, leadRole, members };
}

/**
 * Parse the operator's comma-separated blocker list into the SAME reference
 * forms `devpilot_create_ticket` accepts.
 *
 * The `alias` form is refused rather than resolved: an alias is scoped to the
 * RUN that coined it, and a console command has no run, so an alias here could
 * only resolve against some other run's labels - which is precisely the
 * cross-talk `resolveDependencyRefs` scopes aliases to prevent.
 */
export function parseDependencyList(
  raw: string,
): { ok: true; refs: DependencyRef[] } | { ok: false; error: string } {
  const parts = raw
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { ok: false, error: "Name at least one blocker." };
  if (parts.length > AGENT_MAX_DEPENDENCIES) {
    return {
      ok: false,
      error:
        `That names ${parts.length} blockers; the limit is ${AGENT_MAX_DEPENDENCIES}. A ticket ` +
        `with more blockers than that is usually two tickets.`,
    };
  }

  const refs: DependencyRef[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const ref = classifyDependencyRef(part);
    if (!ref) {
      return {
        ok: false,
        error: `"${part.slice(0, 40)}" is not a ticket reference. Use a key like DevPilot-34, or a ticket uuid.`,
      };
    }
    if (ref.kind === "alias") {
      return {
        ok: false,
        error:
          `"${part.slice(0, 40)}" looks like an agent's run-local label, not a ticket. Those only ` +
          `mean anything inside the run that coined them. Use a key like DevPilot-34, or a uuid.`,
      };
    }
    const k = dependencyRefKey(ref);
    if (seen.has(k)) continue;
    seen.add(k);
    refs.push(ref);
  }
  return { ok: true, refs };
}

// ───────────────────────────────────────────────────────────────────────────
// Copy
// ───────────────────────────────────────────────────────────────────────────

/**
 * What the console will NOT do, and why - shown when an operator asks for
 * something outside the vocabulary.
 *
 * Rewritten for the command half, and the shape of the sentence matters: it
 * names the boundary as a boundary rather than as a failure, and it points at
 * where each refused capability actually lives. An operator who asks the
 * console to push a branch and gets a shrug learns nothing; one who is told the
 * console never touches a remote, and that Review changes is the control,
 * learns the shape of the tool.
 */
export function describeRefusedCapability(): string {
  return (
    "I can command this board - dispatch and re-dispatch, re-scope, move, close, reopen, file " +
    "tickets, wire dependencies, and run teams - and I can release a stuck dispatch queue or hand " +
    "a stalled ticket back to you.\n\n" +
    "What I will not do, at all: discard uncommitted or unpushed work, force-push or rewrite " +
    "history, touch credentials or secrets, or publish anything outward - land, push, deploy, " +
    "promote. Those are irreversible or outward-facing, and each already has its own control with " +
    "its own confirmation (Discard & restart on the ticket, Review changes, the deploy card). " +
    "Having a second route to them here would mean two confirmation policies for one irreversible " +
    "act, and one of the two would end up the weaker.\n\n" +
    "I also cannot raise a WIP, budget, depth or fan-out ceiling. Those refuse me exactly as they " +
    "refuse an agent."
  );
}

/**
 * Turn a primitive's refusal into a sentence an operator can act on.
 *
 * Same contract as `describeActionOutcome` next door: a refusal is the safety
 * mechanism working, so the copy has to make that legible. "Nothing happened"
 * invites a retry loop and, worse, invites the next engineer to add a bypass.
 */
export function describeCommandRefusal(kind: ConsoleCommandKind, reason: string): string {
  switch (kind) {
    case "dispatch_ticket":
      return (
        `The dispatch was accepted but the engine declined to start it: ${reason}. That is a gate ` +
        `doing its job - the ticket has not moved and nothing was spent.`
      );
    case "pause_ticket":
      return (
        `Nothing paused: ${reason}. Either the ticket had already left a pausable state, or ` +
        `something moved it between the console reading the board and you clicking.`
      );
    case "resume_ticket":
      return `Nothing resumed: ${reason}.`;
    case "spawn_team":
      return (
        `No team started: ${reason}. The ticket is unchanged and no run was seeded - the fan-out ` +
        `stamp is taken before any agent is emitted precisely so a refusal leaves nothing behind.`
      );
    default:
      return `Nothing changed: ${reason}.`;
  }
}
