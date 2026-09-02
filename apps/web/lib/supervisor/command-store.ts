// The supervisor console's COMMAND execution. MARKER-FREE BY CONSTRUCTION -
// every primitive arrives as an INJECTED dep, with production wiring in the
// `.server.ts` twin. Same split, same reasoning, as `console-store.ts` next
// door: `transitionTicket`, `createTicketCore`, `pauseTicket` and the dependency
// resolver all reach `server-only`, so a module importing any of them directly
// could not load under Vitest - which is precisely the gap defects in this
// codebase keep living in.
//
// ══════════════════════════════════════════════════════════════════════════
// IT REIMPLEMENTS NOTHING. EVERY COMMAND IS AN EXISTING PRIMITIVE.
// ══════════════════════════════════════════════════════════════════════════
//
//   dispatch_ticket   → `ticket/dispatch-needed` with `forceRole`, the same
//                       event the aggregator's fan-in routing emits. The
//                       dispatcher then re-applies the billing gate, the
//                       automation pause, the WIP limit and the QA retry
//                       ceiling, in that order, exactly as it always does.
//   pause / resume    → `pauseTicket` / `resumeTicket` (pause-resume.ts).
//   rescope           → `addComment` as a HUMAN, plus the documented
//                       `input_required → in_progress` resume that
//                       `postCommentAction` performs for the same reason.
//   move / done /     → `transitionTicket` with `actor: "human"`. Every gate
//   close / reopen      it carries applies: the safety gate, the reopen gate,
//                       the plan-hold gate, `assertTransition`.
//   create_ticket     → `createTicketCore`, the one shared insert path.
//   set_dependencies  → `resolveDependencyRefs` → `planTicketDependencies`
//                       (the cycle guard) → `insertTicketDependencies`.
//   spawn_team        → the dispatcher's OWN `cohort_plan` fan-out. This arms
//                       the plan and asks for a dispatch; `decideFanOut` reads
//                       it back, re-runs `validateCohortPlan`, and seeds the
//                       cohort.
//   spawn_goal_team   → one root `agent/run.requested`. Every child that lead
//                       spawns goes through the UNMODIFIED spawn route, so
//                       depth, fan-out, the tenant cap and budget headroom are
//                       all re-checked per child by `assertCanSpawn`.
//
// A second opinion about how to dispatch, create or spawn is how a console
// starts fighting the engine, in exactly the way AGENTS.md says a second
// opinion about what counts as broken is how a supervisor starts fighting the
// reapers.
//
// ══════════════════════════════════════════════════════════════════════════
// THE THREE THINGS THAT MAKE COMMANDING SAFE, IN ORDER
// ══════════════════════════════════════════════════════════════════════════
//
//  1. THE OFFER LIST IS RE-DERIVED HERE, from the live database AND from the
//     operator's own message. The caller sends an id, a payload and a
//     confirmation; an id that is not on the freshly computed list is refused.
//     Because ticket-scoped commands only exist for tickets the operator NAMED,
//     a forged POST cannot conjure a target and neither can a model reply.
//  2. THE CONFIRMATION IS RE-CHECKED HERE. The UI collects it; the UI is not
//     the gate - `"use server"` exports are browser-reachable endpoints.
//  3. THE PRIMITIVE RE-DERIVES AGAIN. `transitionTicket` re-reads the row and
//     re-runs every gate; the dispatcher re-runs `decideFanOut` and
//     `validateCohortPlan`; `assertCanSpawn` re-runs on every spawned child. A
//     refusal from any of them is REPORTED, never worked around.
//
// It is gated on `projects.supervisor_enabled` - the operator's own statement
// about whether this platform may move tickets on this board - and deliberately
// NOT on engine health, for the reason `console-actions.ts`'s header gives at
// length: a human is asking, now, and refusing because a cron might eventually
// get to it is what teaches people to go to the database by hand.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TicketStatus } from "@/lib/board/state";
import type { CohortPlan } from "@/lib/engine/fan-out";
import type { BlockingEdge, DependencyRef, TicketDependencyRow } from "@/lib/board/ticket-deps";
import { planTicketDependencies } from "@/lib/board/ticket-deps";
import { formatTicketKey } from "@/lib/board/ticket-key";
import { extractTicketKeys } from "@/lib/supervisor/console-brief";
import {
  CONFIRM_ACK_TOKEN,
  checkCommandConfirmation,
  describeCommandRefusal,
  deriveOperatorCommands,
  deriveOperatorTargets,
  findConsoleCommand,
  listValue,
  numberValue,
  parseDependencyList,
  planCommandedTeam,
  stringValue,
  validateCommandPayload,
  type ConsoleCommand,
  TEAM_BUDGET_DEFAULT_CENTS,
} from "@/lib/supervisor/console-commands";
import {
  loadConsoleSnapshot,
  recordConsoleAction,
  type ConsoleDeps,
} from "@/lib/supervisor/console-store";

// ───────────────────────────────────────────────────────────────────────────
// Deps
// ───────────────────────────────────────────────────────────────────────────

export type CommandDeps = ConsoleDeps & {
  /** Role slugs the dispatcher would honour: built-ins plus this tenant's
   *  custom agents. Exactly the set `decideNextRole` accepts as a `forceRole`. */
  loadDispatchableRoles: (tenantId: string) => Promise<string[]>;
  /** Active runs in this tenant - the number `MAX_TOTAL_AGENTS` bounds. The
   *  SAME count `assertCanSpawn` takes, via `countActiveRunsForTenant`. */
  countActiveRuns: (tenantId: string) => Promise<number | null>;

  /** `ticket/dispatch-needed`, bounded. */
  emitDispatch: (args: {
    ticketId: string;
    tenantId: string;
    forceRole?: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** `transitionTicket`, always with `actor: "human"`. */
  transition: (args: {
    ticketId: string;
    tenantId: string;
    to: TicketStatus;
    expectedFrom?: TicketStatus;
  }) => Promise<{ transitioned: boolean; refusal?: string }>;
  /** `addComment`. */
  comment: (args: {
    ticketId: string;
    tenantId: string;
    authorType: "human" | "system";
    authorId: string;
    body: string;
  }) => Promise<void>;
  /** `pauseTicket`. */
  pauseTicket: (args: {
    ticketId: string;
    tenantId: string;
    byUserId: string;
  }) => Promise<
    { ok: true; paused: boolean; cancelledRuns: number } | { ok: false; error: string }
  >;
  /** `resumeTicket`. */
  resumeTicket: (args: {
    ticketId: string;
    tenantId: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** `createTicketCore`. */
  createTicket: (args: {
    tenantId: string;
    projectId: string;
    title: string;
    description: string;
    requestedRole: string | null;
  }) => Promise<
    { ok: true; ticketId: string; ticketNumber: number | null } | { ok: false; error: string }
  >;
  /** `resolveDependencyRefs`, scoped to this tenant AND project. */
  resolveDependencyRefs: (args: {
    tenantId: string;
    projectId: string;
    refs: readonly DependencyRef[];
  }) => Promise<{
    blockers: Array<{ ref: string; ticketId: string; status: string }>;
    unresolved: string[];
  }>;
  /** `loadBlockingEdgeClosure` - what the cycle guard reasons over. */
  loadBlockingEdges: (args: {
    tenantId: string;
    fromTicketIds: readonly string[];
  }) => Promise<BlockingEdge[]>;
  /** `insertTicketDependencies`. */
  insertDependencies: (
    rows: readonly TicketDependencyRow[],
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** CAS'd write of `tickets.cohort_plan`. Refuses a ticket that has already
   *  fanned out, which is the dispatcher's own idempotency anchor. */
  armCohortPlan: (args: {
    ticketId: string;
    tenantId: string;
    plan: CohortPlan;
    strategy: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** One ROOT `agent/run.requested` for a goal with no ticket. */
  startGoalRun: (args: {
    tenantId: string;
    projectId: string;
    role: string;
    goal: string;
    budgetCents: number;
  }) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
};

// ───────────────────────────────────────────────────────────────────────────
// Offer
// ───────────────────────────────────────────────────────────────────────────

/**
 * The commands available for ONE operator message.
 *
 * `question` is the operator's own text and is the ONLY source of ticket
 * targets - see `deriveOperatorTargets`. Passing an empty question yields the
 * project-scoped commands and nothing else, which is the correct answer: with
 * no ticket named, there is no ticket to act on.
 */
export async function loadOperatorCommands(
  deps: CommandDeps,
  args: { tenantId: string; projectId: string; question: string },
): Promise<
  | {
      ok: true;
      commands: ConsoleCommand[];
      missingKeys: string[];
    }
  | { ok: false; error: string }
> {
  const loaded = await loadConsoleSnapshot(deps, {
    tenantId: args.tenantId,
    projectId: args.projectId,
    // PIN every ticket the operator named, so a named ticket the base scan
    // excluded (settled, or past the scan cap) still has commands derived for
    // it. Deliberately the SAME extraction `deriveOperatorTargets` uses - a
    // ticket the console can act on and a ticket it detailed must be one set.
    focusTicketKeys: extractTicketKeys(args.question),
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { snapshot } = loaded.result;

  const [roles, activeRuns] = await Promise.all([
    deps.loadDispatchableRoles(args.tenantId).catch(() => [] as string[]),
    deps.countActiveRuns(args.tenantId).catch(() => null),
  ]);

  const targets = deriveOperatorTargets(args.question, snapshot);
  return {
    ok: true,
    commands: deriveOperatorCommands({
      snapshot,
      targets,
      dispatchableRoles: roles,
      activeRuns,
    }),
    missingKeys: targets.missingKeys,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Run
// ───────────────────────────────────────────────────────────────────────────

export type CommandOutcome =
  | { ok: true; applied: true; summary: string }
  /** The PRIMITIVE declined. Not an error, and not something to work around. */
  | { ok: true; applied: false; summary: string; reason: string }
  | { ok: false; error: string };

export async function runConsoleCommand(
  deps: CommandDeps,
  args: {
    tenantId: string;
    projectId: string;
    /** The operator's message that produced the offer. THE source of targets;
     *  re-parsed here so the server never trusts the client's idea of which
     *  ticket was named. */
    question: string;
    commandId: string;
    payload?: Record<string, unknown> | null;
    confirmation?: string | null;
    requestedBy: string;
    requestedByUserId: string;
    /**
     * The transcript row this command came out of, when it could be PROVEN to
     * be the one - `decideConsoleMessageLink` compares the stored message
     * against `question`, and the caller passes null when it does not match.
     *
     * NOT a security input. The target is still derived by re-parsing
     * `question` server-side and every gate is still re-checked against the
     * live database; this only decides whether the ledger row can say which
     * conversation turn caused the fix.
     */
    consoleMessageId?: string | null;
  },
): Promise<CommandOutcome> {
  const loaded = await loadConsoleSnapshot(deps, {
    tenantId: args.tenantId,
    projectId: args.projectId,
    // PIN every ticket the operator named, so a named ticket the base scan
    // excluded (settled, or past the scan cap) still has commands derived for
    // it. Deliberately the SAME extraction `deriveOperatorTargets` uses - a
    // ticket the console can act on and a ticket it detailed must be one set.
    focusTicketKeys: extractTicketKeys(args.question),
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { snapshot } = loaded.result;

  if (!snapshot.supervisorEnabled) {
    return {
      ok: false,
      error:
        "Supervision is switched off for this project, so the console may explain this board but " +
        "not change it. Turn on Supervision in the project settings to allow it.",
    };
  }

  const [roles, activeRuns] = await Promise.all([
    deps.loadDispatchableRoles(args.tenantId).catch(() => [] as string[]),
    deps.countActiveRuns(args.tenantId).catch(() => null),
  ]);
  const targets = deriveOperatorTargets(args.question, snapshot);
  const commands = deriveOperatorCommands({
    snapshot,
    targets,
    dispatchableRoles: roles,
    activeRuns,
  });

  const command = findConsoleCommand(commands, args.commandId);
  if (!command) {
    return {
      ok: false,
      error:
        "That command is not available on this board right now - either the ticket you named is no " +
        "longer in the state it was offered for, or this request did not name it at all. Ask again " +
        "for a fresh read.",
    };
  }

  const confirmed = checkCommandConfirmation(command, args.confirmation);
  if (!confirmed.ok) return { ok: false, error: confirmed.error };

  const payload = validateCommandPayload(command, args.payload);
  if (!payload.ok) return { ok: false, error: payload.error };
  const values = payload.values;

  const ticket = command.ticketId
    ? snapshot.tickets.find((t) => t.ticketId === command.ticketId)
    : undefined;
  if (command.ticketId && !ticket) {
    return { ok: false, error: "That ticket is no longer in the state that was offered." };
  }

  const record = async (detail: string, ticketId: string | null) =>
    recordConsoleAction(deps, {
      tenantId: args.tenantId,
      projectId: args.projectId,
      ticketId,
      cause: command.cause,
      action: `operator:${command.kind}`,
      detail: `${args.requestedBy} ran "${command.label}". ${detail}`,
      consoleMessageId: args.consoleMessageId ?? null,
    });

  switch (command.kind) {
    case "dispatch_ticket": {
      const role = stringValue(values, "role");
      const sent = await deps.emitDispatch({
        ticketId: ticket!.ticketId,
        tenantId: args.tenantId,
        forceRole: role,
      });
      if (!sent.ok) {
        return {
          ok: true,
          applied: false,
          reason: sent.error,
          summary: describeCommandRefusal(command.kind, sent.error),
        };
      }
      await record(`dispatch requested as \`${role}\`.`, ticket!.ticketId);
      return {
        ok: true,
        applied: true,
        summary:
          `Asked the dispatcher to start ${ticket!.key} as \`${role}\`. It applies the billing gate, ` +
          `the automation pause and the WIP limit before anything runs, so watch the ticket - it may ` +
          `queue behind the limit rather than start immediately.`,
      };
    }

    case "rescope_ticket": {
      const directive = stringValue(values, "directive");
      await deps.comment({
        ticketId: ticket!.ticketId,
        tenantId: args.tenantId,
        authorType: "human",
        authorId: args.requestedByUserId,
        body: directive,
      });
      // The `input_required` resume, performed here for the SAME reason
      // `postCommentAction` performs it: a human reply is the only thing that
      // restarts a ticket parked on a question, and a comment that silently
      // failed to resume it is a directive nothing will ever read.
      let resumed = false;
      if (ticket!.status === "input_required") {
        const moved = await deps.transition({
          ticketId: ticket!.ticketId,
          tenantId: args.tenantId,
          to: "in_progress",
          expectedFrom: "input_required",
        });
        resumed = moved.transitioned;
      }
      await record(
        `directive posted${resumed ? " and the ticket resumed" : ""}.`,
        ticket!.ticketId,
      );
      return {
        ok: true,
        applied: true,
        summary:
          `Posted your directive on ${ticket!.key}.` +
          (resumed
            ? ` It was waiting on you, so it is back in In progress and a fresh run has been asked for.`
            : ` The ticket's next run reads the comment thread, so this takes effect then - it does not start a run on its own.`),
      };
    }

    case "pause_ticket": {
      const res = await deps.pauseTicket({
        ticketId: ticket!.ticketId,
        tenantId: args.tenantId,
        byUserId: args.requestedByUserId,
      });
      if (!res.ok) return { ok: false, error: res.error };
      if (!res.paused) {
        return {
          ok: true,
          applied: false,
          reason: "not-pausable",
          summary: describeCommandRefusal(command.kind, "the ticket was not in a pausable state"),
        };
      }
      await record(`paused; ${res.cancelledRuns} run(s) cancelled.`, ticket!.ticketId);
      return {
        ok: true,
        applied: true,
        summary:
          `${ticket!.key} is Paused` +
          (res.cancelledRuns > 0
            ? `, and ${res.cancelledRuns} run(s) on it were cancelled at their next safe boundary. Committed work is kept.`
            : `. Nothing was running on it.`),
      };
    }

    case "resume_ticket": {
      const res = await deps.resumeTicket({ ticketId: ticket!.ticketId, tenantId: args.tenantId });
      if (!res.ok) {
        return {
          ok: true,
          applied: false,
          reason: res.error,
          summary: describeCommandRefusal(command.kind, res.error),
        };
      }
      await record("resumed from Paused.", ticket!.ticketId);
      return { ok: true, applied: true, summary: `${ticket!.key} is out of Paused and resuming.` };
    }

    case "move_ticket":
    case "mark_done":
    case "close_obsolete":
    case "reopen_ticket": {
      const to: TicketStatus =
        command.kind === "move_ticket"
          ? (stringValue(values, "to") as TicketStatus)
          : command.kind === "mark_done"
            ? "done"
            : command.kind === "close_obsolete"
              ? "failed"
              : "backlog";

      // The reason goes on the ticket BEFORE the move, so a ticket closed as
      // obsolete carries the explanation even if the transition then refuses -
      // a terminal ticket with no recorded reason is the thing this command
      // exists to avoid producing.
      const reason = stringValue(values, "reason");
      if (reason.length > 0) {
        await deps.comment({
          ticketId: ticket!.ticketId,
          tenantId: args.tenantId,
          authorType: "human",
          authorId: args.requestedByUserId,
          body: reason,
        });
      }

      // ⚠️ A REFUSAL AFTER THIS POINT IS NOT "NOTHING CHANGED", and saying so
      // would be the exact class of untrue copy this surface exists to avoid:
      // the reason comment is already on the ticket. `describeCommandRefusal`'s
      // wording is corrected here rather than at the call site so both the
      // thrown and the CAS-lost paths carry it.
      const commented = reason.length > 0;
      const refuse = (why: string): CommandOutcome => ({
        ok: true,
        applied: false,
        reason: why,
        summary:
          describeCommandRefusal(command.kind, why) +
          (commented
            ? ` Your note IS on ${ticket!.key} - the comment was written before the move was attempted, so the ticket carries the explanation either way.`
            : ""),
      });

      let moved: { transitioned: boolean; refusal?: string };
      try {
        moved = await deps.transition({
          ticketId: ticket!.ticketId,
          tenantId: args.tenantId,
          to,
          // CAS on the status the offer was computed from. A ticket that moved
          // between the console reading it and the operator clicking is not
          // clobbered - it simply does not match, and we say so.
          expectedFrom: ticket!.status,
        });
      } catch (err) {
        // `transitionTicket` THROWS for an illegal edge and for the reopen /
        // plan-hold gates. Those are refusals, not crashes, and the operator
        // needs the sentence rather than a stack trace.
        return refuse(err instanceof Error ? err.message : String(err));
      }

      if (!moved.transitioned) {
        return refuse(moved.refusal ?? `${ticket!.key} is no longer in ${ticket!.status}`);
      }
      await record(`moved ${ticket!.status} → ${to}.`, ticket!.ticketId);
      return {
        ok: true,
        applied: true,
        summary: `${ticket!.key} is now ${to.replace(/_/g, " ")}.`,
      };
    }

    case "create_ticket": {
      const created = await deps.createTicket({
        tenantId: args.tenantId,
        projectId: args.projectId,
        title: stringValue(values, "title"),
        description: stringValue(values, "description"),
        requestedRole: stringValue(values, "role") || null,
      });
      if (!created.ok) return { ok: false, error: created.error };
      const key = formatTicketKey(created.ticketNumber, created.ticketId);
      await record(`filed ${key}.`, created.ticketId);
      return {
        ok: true,
        applied: true,
        summary: `Filed ${key} in the Backlog. Nothing dispatches from Backlog - move it to Ready when you want it picked up.`,
      };
    }

    case "set_dependencies": {
      const parsed = parseDependencyList(stringValue(values, "dependsOn"));
      if (!parsed.ok) return { ok: false, error: parsed.error };

      const resolved = await deps.resolveDependencyRefs({
        tenantId: args.tenantId,
        projectId: args.projectId,
        refs: parsed.refs,
      });
      if (resolved.unresolved.length > 0) {
        return {
          ok: false,
          error:
            `No dependency was added. ${resolved.unresolved.join(", ")} ` +
            `${resolved.unresolved.length === 1 ? "does" : "do"} not name a ticket on this board.`,
        };
      }

      const edges = await deps.loadBlockingEdges({
        tenantId: args.tenantId,
        fromTicketIds: resolved.blockers.map((b) => b.ticketId),
      });
      // THE CYCLE GUARD, reused verbatim. A deadlocked pair is permanent and
      // invisible - neither ticket can ever become ready and nothing on the
      // board says why - so it is checked rather than argued, at the one seam
      // that computes edges.
      const plan = planTicketDependencies({
        newTicketId: ticket!.ticketId,
        blockers: resolved.blockers.map((b) => ({ ticketId: b.ticketId, ref: b.ref })),
        existingEdges: edges,
      });
      if (!plan.ok) return { ok: false, error: plan.refusal.reason };

      const inserted = await deps.insertDependencies(plan.rows);
      if (!inserted.ok) {
        return {
          ok: true,
          applied: false,
          reason: inserted.error,
          summary:
            `The dependencies were NOT recorded (${inserted.error}). Do not treat ${ticket!.key} as ` +
            `ordered - nothing is holding it back.`,
        };
      }
      const dead = resolved.blockers.filter((b) => b.status === "failed");
      await record(`added ${plan.rows.length} blocker(s).`, ticket!.ticketId);
      return {
        ok: true,
        applied: true,
        summary:
          `${ticket!.key} now waits on ${resolved.blockers.map((b) => b.ref).join(", ")}.` +
          (dead.length > 0
            ? ` Warning: ${dead.map((b) => b.ref).join(", ")} ${dead.length === 1 ? "is" : "are"} FAILED, and a failed blocker never counts as satisfied - ${ticket!.key} cannot become Ready until it is reopened.`
            : ""),
      };
    }

    case "spawn_team": {
      const planned = planCommandedTeam({
        members: listValue(values, "roles"),
        strategy: stringValue(values, "strategy"),
        ticketKey: ticket!.key,
      });
      if (!planned.ok) return { ok: false, error: planned.error };

      const armed = await deps.armCohortPlan({
        ticketId: ticket!.ticketId,
        tenantId: args.tenantId,
        plan: planned.plan,
        strategy: stringValue(values, "strategy"),
      });
      if (!armed.ok) {
        return {
          ok: true,
          applied: false,
          reason: armed.error,
          summary: describeCommandRefusal(command.kind, armed.error),
        };
      }

      const sent = await deps.emitDispatch({
        ticketId: ticket!.ticketId,
        tenantId: args.tenantId,
        forceRole: planned.leadRole,
      });
      if (!sent.ok) {
        return {
          ok: true,
          applied: false,
          reason: sent.error,
          summary:
            `The team is armed on ${ticket!.key} but the dispatch could not be sent (${sent.error}). ` +
            `Dispatch it again and the cohort will fire - the plan is already on the ticket.`,
        };
      }
      await record(
        `team armed [${planned.members.join(", ")}] strategy=${stringValue(values, "strategy")}.`,
        ticket!.ticketId,
      );
      return {
        ok: true,
        applied: true,
        summary:
          `Armed a ${planned.members.length}-agent team on ${ticket!.key} (${planned.members.join(", ")}) ` +
          `and asked the dispatcher to start it. The dispatcher re-checks the cohort ceilings before ` +
          `it emits anything, so watch the ticket for the cohort appearing.`,
      };
    }

    case "spawn_goal_team": {
      const started = await deps.startGoalRun({
        tenantId: args.tenantId,
        projectId: args.projectId,
        role: stringValue(values, "role"),
        goal: stringValue(values, "goal"),
        budgetCents: numberValue(values, "budgetCents", TEAM_BUDGET_DEFAULT_CENTS),
      });
      if (!started.ok) return { ok: false, error: started.error };
      await record(
        `goal run ${started.runId.slice(0, 8)} started as \`${stringValue(values, "role")}\` ` +
          `with a ${numberValue(values, "budgetCents", TEAM_BUDGET_DEFAULT_CENTS)}c ceiling.`,
        null,
      );
      return {
        ok: true,
        applied: true,
        summary:
          `Started run ${started.runId.slice(0, 8)} as \`${stringValue(values, "role")}\` on your goal, ` +
          `with a ${numberValue(values, "budgetCents", TEAM_BUDGET_DEFAULT_CENTS)}-cent ceiling on the ` +
          `whole subtree. Any specialist it spawns is checked against depth, fan-out, the tenant run ` +
          `cap and that remaining budget before it starts.`,
      };
    }

    default: {
      // Exhaustiveness. A new command kind is a COMPILE ERROR here until it
      // decides what primitive it routes to - which is the property that keeps
      // this file from growing a reimplementation by accident.
      const never: never = command.kind;
      return { ok: false, error: `unhandled command: ${String(never)}` };
    }
  }
}

/** Re-exported so the server-action layer can hand the UI's acknowledgement
 *  token back without importing the vocabulary module twice. */
export { CONFIRM_ACK_TOKEN };
