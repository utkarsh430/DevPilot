"use server";

// The supervisor console's server actions - the auth wrapper, and nothing else.
//
// It lives in `lib/` rather than under a route folder because the console opens
// from the board header AND from the project page, and both need it; same
// precedent as `lib/automation/actions.ts` and `lib/roles/overlay-actions.ts`.
//
// ── EVERY EXPORT DERIVES THE TENANT FROM THE SESSION ──────────────────────
// `"use server"` means every exported async function here is a browser-reachable
// endpoint. So `tenantId` is resolved with `requireTenantId()` and is NOT an
// input on any of them - a caller can name a project, and the store then refuses
// a project that is not in the caller's tenant. That ordering (session first,
// caller's id checked against it) is the whole boundary, because everything
// downstream runs service-role with RLS off.
//
// ── THE DECISIONS ARE NOT HERE ────────────────────────────────────────────
// This file cannot load under Vitest (it reaches `next/headers`), which is
// exactly the gap defects in this codebase keep living in - so it holds no
// policy. What may be commanded is `deriveAvailableActions`; what actually
// happens is `runConsoleAction` plus the injected primitives; both are
// marker-free and unit-tested.

import { requireUser, requireTenantId } from "@/lib/auth";
import { CONSOLE_QUESTION_MAX_CHARS, extractTicketKeys } from "@/lib/supervisor/console-brief";
import {
  CONSOLE_HISTORY_CONTEXT_TURNS,
  CONSOLE_THREAD_DISPLAY_LIMIT,
  decideConsoleMessageLink,
  toModelContextTurns,
  type ConsoleMessage,
} from "@/lib/supervisor/console-history";
import {
  appendConsoleMessage,
  loadConsoleMessageById,
  loadConsoleThread,
} from "@/lib/supervisor/console-history-store";
import { defaultConsoleHistoryDeps } from "@/lib/supervisor/console-history-store.server";
import { answerConsoleQuestion } from "@/lib/supervisor/console-answer.server";
import { loadConsoleSnapshot, runConsoleAction } from "@/lib/supervisor/console-store";
import { defaultConsoleDeps } from "@/lib/supervisor/console-store.server";
import { loadOperatorCommands, runConsoleCommand } from "@/lib/supervisor/command-store";
import { defaultCommandDeps } from "@/lib/supervisor/command-store.server";
import { summarizeBoard } from "@/lib/supervisor/console-facts";
import {
  describeConsoleModelFailure,
  describeConsoleRunOutcome,
  describeMissingTicketKeys,
  type ConsoleBrief,
} from "@/lib/supervisor/console-view";
import type { LlmFailureKind } from "@/lib/llm/generate.server";
import type { ConsoleAction } from "@/lib/supervisor/console-actions";
import type { ConsoleCommand } from "@/lib/supervisor/console-commands";
import type { ConsoleOffer } from "@/lib/supervisor/console-answer.server";

type ConsoleBriefResult = { ok: true; brief: ConsoleBrief } | { ok: false; error: string };

export async function loadSupervisorConsoleBriefAction(input: {
  projectId: string;
}): Promise<ConsoleBriefResult> {
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  const deps = defaultConsoleDeps(new Date().toISOString());
  const loaded = await loadConsoleSnapshot(deps, { tenantId, projectId: input.projectId });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { snapshot, actions } = loaded.result;
  return {
    ok: true,
    brief: {
      projectName: snapshot.projectName,
      supervisorEnabled: snapshot.supervisorEnabled,
      engine: {
        state: snapshot.engine.state,
        detail:
          snapshot.engine.state === "unknown"
            ? snapshot.engine.reason
            : `last scheduled tick ${snapshot.engine.ageSeconds}s ago`,
      },
      summary: summarizeBoard(snapshot),
      actions,
      truncated: snapshot.truncated,
    },
  };
}

/**
 * RELOAD THE THREAD.
 *
 * Ungated for the same reason EXPLAIN is: the conversation is a record of this
 * board and a board is most worth reading about when it is broken. It answers
 * only what was already said, so it is strictly narrower than the brief beside
 * it.
 */
export async function loadSupervisorConsoleThreadAction(input: {
  projectId: string;
}): Promise<{ ok: true; messages: ConsoleMessage[] } | { ok: false; error: string }> {
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  // The project is validated against the session's tenant by the store's own
  // co-located predicate: a project in another tenant matches no row, so a
  // forged id returns an empty thread rather than someone else's.
  const messages = await loadConsoleThread(defaultConsoleHistoryDeps(), {
    tenantId,
    projectId: input.projectId,
    limit: CONSOLE_THREAD_DISPLAY_LIMIT,
  });
  return { ok: true, messages };
}

type ConsoleAskResult =
  | {
      ok: true;
      answer: string;
      aboutTickets: string[];
      recommendedActions: ConsoleOffer[];
      /**
       * Commands available for THIS message. Ticket-scoped ones exist only for
       * tickets the operator named in it, which is why they are returned per
       * ask rather than on the always-loaded brief - a command list that
       * persisted across turns would let a ticket named three questions ago
       * stay actionable after the operator moved on.
       */
      commands: ConsoleCommand[];
      /** Keys the operator named that this project has no ticket for. */
      missingKeys: string[];
      outOfScope: boolean;
      droppedActionIds: string[];
      brief: ConsoleBrief;
      /** The transcript row for THIS operator message. Sent back with a command
       *  run so the ledger can record which conversation turn caused the fix.
       *  Absent when the transcript write failed - a lost record must never
       *  block the answer. */
      messageId?: string;
    }
  | {
      ok: false;
      error: string;
      brief?: ConsoleBrief;
      /** WHY it failed, so the console can say which failure this was rather
       *  than blaming reachability for all of them. Absent when the failure
       *  happened before the model was consulted at all (a snapshot load). */
      failureKind?: LlmFailureKind;
      /** What the model said, when it answered and the answer could not be
       *  used. Prose only - nothing was grounded off it, so it carries no
       *  action, no ticket link and nothing to click. */
      rawReply?: string;
      commands?: ConsoleCommand[];
      missingKeys?: string[];
      messageId?: string;
    };

/**
 * EXPLAIN. Deliberately NOT gated on `supervisor_enabled` and NOT gated on
 * engine health: a board is most worth explaining exactly when it is broken and
 * when nobody opted in to automatic repair. Only ACT is gated.
 */
export async function askSupervisorConsoleAction(input: {
  projectId: string;
  question: string;
}): Promise<ConsoleAskResult> {
  const [user, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  const nowIso = new Date().toISOString();
  const deps = defaultConsoleDeps(nowIso);
  const historyDeps = defaultConsoleHistoryDeps();
  // Bounded here as well as in the prompt builder: this is a request field, and
  // the builder's cap is about context budget rather than input validation.
  const question = String(input.question ?? "").slice(0, CONSOLE_QUESTION_MAX_CHARS);
  const loaded = await loadConsoleSnapshot(deps, {
    tenantId,
    projectId: input.projectId,
    // A ticket the operator named is pulled in even when the scan would have
    // excluded it - see `extractTicketKeys` for the drive that found this.
    focusTicketKeys: extractTicketKeys(question),
  });
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { snapshot, actions } = loaded.result;

  // The COMMANDS this message unlocks. Derived from the operator's own text -
  // `deriveOperatorTargets` reads ticket keys out of `question` and out of
  // nothing else - so with no ticket named there is nothing ticket-scoped to
  // offer, whatever a ticket title in the report might be telling the model.
  const commanded = await loadOperatorCommands(defaultCommandDeps(nowIso), {
    tenantId,
    projectId: input.projectId,
    question,
  });
  const commands = commanded.ok ? commanded.commands : [];
  const missingKeys = commanded.ok ? commanded.missingKeys : [];

  const brief: ConsoleBrief = {
    projectName: snapshot.projectName,
    supervisorEnabled: snapshot.supervisorEnabled,
    engine: {
      state: snapshot.engine.state,
      detail:
        snapshot.engine.state === "unknown"
          ? snapshot.engine.reason
          : `last scheduled tick ${snapshot.engine.ageSeconds}s ago`,
    },
    summary: summarizeBoard(snapshot),
    actions,
    truncated: snapshot.truncated,
  };

  // ── THE MODEL'S CONVERSATIONAL CONTEXT IS SERVER-DERIVED ─────────────────
  // It used to arrive as an `history` field on this request, i.e. the client
  // could put any text it liked into the prompt as "earlier in this
  // conversation". Fenced, but still a client-controlled prompt input for no
  // reason. Now it is read from the transcript, bounded to the same small
  // window, so what the model is told was said IS what was said.
  //
  // Read BEFORE this turn is appended: the operator's current question is added
  // to the prompt separately by `buildConsolePrompt`, and having it in the
  // history block as well would present it as something already answered.
  const priorTurns = await loadConsoleThread(historyDeps, {
    tenantId,
    projectId: input.projectId,
    limit: CONSOLE_HISTORY_CONTEXT_TURNS,
  });
  const history = toModelContextTurns(priorTurns);

  // Persisted BEFORE the model call, deliberately: a question that timed out or
  // hit an unreachable runner is exactly the one an operator comes back to, and
  // it is also the message a command run from this turn will be attributed to.
  const asked = await appendConsoleMessage(historyDeps, {
    tenantId,
    projectId: input.projectId,
    role: "operator",
    kind: "ask",
    body: question,
    authorUserId: user.id,
  });
  const messageId = asked.ok ? asked.id : undefined;

  // Said out loud in the transcript as well as on screen, so the reloaded
  // thread reads the same as the live one. One sentence, one owner.
  if (missingKeys.length > 0) {
    await appendConsoleMessage(historyDeps, {
      tenantId,
      projectId: input.projectId,
      role: "console",
      kind: "notice",
      body: describeMissingTicketKeys(missingKeys),
    });
  }

  const answered = await answerConsoleQuestion({
    tenantId,
    projectId: input.projectId,
    snapshot,
    actions,
    commands,
    question,
    history,
  });
  // The deterministic brief is returned EVEN WHEN THE MODEL FAILED. That is the
  // point of computing it separately: an unreachable runner must not turn the
  // console into a blank box on the one board that needed it.
  if (!answered.ok) {
    // The failure is a turn too - including the model's own unusable reply when
    // there was one, since that is what the operator was shown and what they
    // will be reasoning from when they come back to this thread.
    await appendConsoleMessage(historyDeps, {
      tenantId,
      projectId: input.projectId,
      role: "console",
      kind: "model_failure",
      body: describeConsoleModelFailure(answered.kind, answered.error, answered.rawReply),
    });
    return {
      ok: false,
      error: answered.error,
      brief,
      failureKind: answered.kind,
      rawReply: answered.rawReply,
      messageId,
      // The commands are returned EVEN WHEN THE MODEL FAILED, for the same
      // reason the brief is: they were computed from the database and the
      // operator's own message without the model, and a console that cannot be
      // commanded exactly when the runner is down is useless at the moment it
      // exists for.
      commands,
      missingKeys,
    };
  }

  await appendConsoleMessage(historyDeps, {
    tenantId,
    projectId: input.projectId,
    role: "console",
    kind: "answer",
    // The GROUNDED answer, which is the prose and nothing else. Recommended
    // actions are deliberately NOT stored: an action derived from the board an
    // hour ago may no longer be offered, and a restored button that is refused
    // when clicked is worse than no button. Same rule the live surface already
    // follows for the command list, and for the same reason.
    body: answered.reply.answer,
  });

  return {
    ok: true,
    answer: answered.reply.answer,
    aboutTickets: answered.reply.aboutTickets,
    recommendedActions: answered.reply.recommendedActions,
    commands,
    missingKeys,
    outOfScope: answered.reply.outOfScope,
    droppedActionIds: answered.reply.droppedActionIds,
    brief,
    messageId,
  };
}

type ConsoleRunResult =
  | { ok: true; applied: boolean; summary: string; brief: ConsoleBrief }
  | { ok: false; error: string };

/**
 * ACT. The operator commands; the store re-derives what is available from the
 * live database and routes to the primitive, which re-derives again.
 *
 * `requestedBy` is the signed-in user's id, stamped into the ledger `detail`, so
 * a commanded fix is attributable in the audit trail rather than merged into the
 * autonomous supervisor's activity. The `cause` is deliberately shared with the
 * autonomous path - see `console-store.ts` for why that must not be split.
 */
export async function runSupervisorConsoleAction(input: {
  projectId: string;
  actionId: string;
}): Promise<ConsoleRunResult> {
  const [user, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  const nowIso = new Date().toISOString();
  const deps = defaultConsoleDeps(nowIso);

  const outcome = await runConsoleAction(deps, {
    tenantId,
    projectId: input.projectId,
    actionId: String(input.actionId ?? "").slice(0, 200),
    requestedBy: `operator ${user.id}`,
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };

  // A recovery run from the REPORT is not caused by a message, so no
  // `console_message_id` is written for it - but what it did is still part of
  // the conversation, and a reloaded thread that skipped it would show the
  // operator asking about a board and never show what they then did to it.
  await appendConsoleMessage(defaultConsoleHistoryDeps(), {
    tenantId,
    projectId: input.projectId,
    role: "console",
    kind: "action_result",
    body: describeConsoleRunOutcome(outcome.applied, outcome.summary),
  });

  // Re-read AFTER acting so the surface shows the board the action produced,
  // not the one it was computed from. A console that reports a fix and then
  // keeps showing the broken state is how an operator ends up running it twice.
  const refreshed = await loadSupervisorConsoleBriefAction({ projectId: input.projectId });
  if (!refreshed.ok) return { ok: false, error: refreshed.error };

  return { ok: true, applied: outcome.applied, summary: outcome.summary, brief: refreshed.brief };
}

/**
 * COMMAND. The wider half of ACT.
 *
 * ── `question` IS NOT A CONVENIENCE, IT IS THE TARGET ──────────────────────
 * It is the operator's own message, and the store re-parses it to re-derive
 * which tickets they named. That is why the client sends it back rather than
 * sending a ticket id: a ticket id from the client would be a target the client
 * chose, and the whole point of this design is that the target comes from the
 * operator's words. A forged POST can therefore only reach a ticket it also
 * NAMES, which is the operator's own act by construction.
 *
 * ── EVERY GATE IS RE-CHECKED SERVER-SIDE ──────────────────────────────────
 * The offer list, the confirmation and the payload are all re-derived and
 * re-validated in `runConsoleCommand` from the live database. The UI's copies
 * of them are conveniences.
 *
 * ── `consoleMessageId` IS PROVENANCE, NOT AUTHORITY ───────────────────────
 * It changes nothing about what may be commanded: the target still comes from
 * re-parsing `question`, and every gate is still re-checked. What it does is let
 * the ledger row say WHICH conversation turn caused the fix - the half of the
 * audit trail that was missing, because the operator's words lived only in
 * browser memory.
 *
 * And it is only recorded when it can be PROVEN: the stored message must be in
 * this tenant and project, be an operator turn, and say the same thing as
 * `question`. A mismatch drops the link and lets the command proceed, because a
 * WRONG link is worse than a missing one (a gap is visible; a plausible lie is
 * not) and because bookkeeping must not stand in front of an operator unsticking
 * a board.
 */
export async function runSupervisorConsoleCommandAction(input: {
  projectId: string;
  question: string;
  commandId: string;
  payload?: Record<string, unknown> | null;
  confirmation?: string | null;
  /** The transcript row this command came out of, from the ask that offered it. */
  consoleMessageId?: string | null;
}): Promise<ConsoleRunResult> {
  const [user, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  const nowIso = new Date().toISOString();
  const deps = defaultCommandDeps(nowIso);
  const historyDeps = defaultConsoleHistoryDeps();
  const question = String(input.question ?? "").slice(0, CONSOLE_QUESTION_MAX_CHARS);

  const requestedId = String(input.consoleMessageId ?? "").slice(0, 64);
  // Tenant- AND project-scoped, so a foreign id resolves to nothing rather than
  // to another workspace's conversation.
  const message = requestedId
    ? await loadConsoleMessageById(historyDeps, {
        tenantId,
        projectId: input.projectId,
        messageId: requestedId,
      })
    : null;
  const link = decideConsoleMessageLink({ messageId: requestedId, message, question });
  if (!link.link && link.reason !== "no-id") {
    console.warn(
      `[supervisor-console] not linking a commanded fix to message ${requestedId}: ${link.reason}`,
    );
  }

  const outcome = await runConsoleCommand(deps, {
    tenantId,
    projectId: input.projectId,
    question,
    commandId: String(input.commandId ?? "").slice(0, 200),
    payload: input.payload ?? null,
    confirmation: input.confirmation ?? null,
    // Stamped into the ledger `detail`, so a commanded change is attributable
    // rather than merged into the autonomous supervisor's activity.
    requestedBy: `operator ${user.id}`,
    // The comment author for a directive / a close reason. The operator's own
    // identity, so the board shows a human wrote it.
    requestedByUserId: user.email ?? user.id,
    consoleMessageId: link.link ? link.messageId : null,
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };

  await appendConsoleMessage(historyDeps, {
    tenantId,
    projectId: input.projectId,
    role: "console",
    kind: "action_result",
    body: describeConsoleRunOutcome(outcome.applied, outcome.summary),
  });

  const refreshed = await loadSupervisorConsoleBriefAction({ projectId: input.projectId });
  if (!refreshed.ok) return { ok: false, error: refreshed.error };

  return { ok: true, applied: outcome.applied, summary: outcome.summary, brief: refreshed.brief };
}
