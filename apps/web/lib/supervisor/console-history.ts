// The supervisor console's CONVERSATION - the pure half.
//
// The console shipped with no persistence: every reload started empty. Two
// things were lost, and only the first is obvious.
//
//  1. The operator loses the thread of what they asked and what they were told.
//  2. THE AUDIT TRAIL WAS HALF A TRAIL. `supervisor_actions` records every
//     commanded fix with its cause - the whole reason that ledger exists is
//     that an operator hand-swept one board about six times in a day and every
//     sweep hid a WIP-slot leak. But the console's design is that a command's
//     TARGET comes from the operator's own words, and those words lived only in
//     browser memory. So the ledger could say "ticket 47 was recovered by
//     operator X" while nothing could say what they had asked, or what they had
//     been told, when they decided to.
//
// Everything here is pure and unit-tested. The IO is `console-history-store.ts`
// (injected client, marker-free) with production wiring in the `.server.ts`
// twin - the same split as the rest of this surface, and for the same reason:
// `console-server-actions.ts` reaches `next/headers` and cannot load under
// Vitest, which is exactly the gap defects in this codebase keep living in.
//
// ── BOTH HALVES OF THE CONVERSATION ARE UNTRUSTED ─────────────────────────
// An operator turn is a human's own text and can still contain a pasted agent
// comment; a console turn IS model output. Principle 6 applies to both, and the
// place it is enforced is `buildConsolePrompt`, which already fences every
// replayed turn. What this module owns is the OTHER half of the rule: the
// replayed window is BOUNDED, so a thread that grows for a month cannot grow
// the prompt with it.

import { CONSOLE_HISTORY_TURNS, type ConsoleTurn } from "@/lib/supervisor/console-brief";

/** Who said it. */
export type ConsoleMessageRole = "operator" | "console";

/**
 * What kind of turn it was.
 *
 * Not for rendering - the UI draws every console turn the same way - but for
 * READING THE TRAIL BACK. "The operator commanded a recovery immediately after
 * the model failed" and "…after the console recommended it" are different
 * stories about the same two rows, and `role` alone cannot tell them apart.
 */
export const CONSOLE_MESSAGE_KINDS = [
  /** The operator's own message. */
  "ask",
  /** A grounded model reply. */
  "answer",
  /** The model was unreachable, or answered unusably. */
  "model_failure",
  /** Something the console said without the model. */
  "notice",
  /** The outcome of a command or a recovery action. */
  "action_result",
] as const;

export type ConsoleMessageKind = (typeof CONSOLE_MESSAGE_KINDS)[number];

export type ConsoleMessage = {
  id: string;
  role: ConsoleMessageRole;
  kind: ConsoleMessageKind;
  body: string;
  createdAtIso: string;
};

/**
 * The stored bound on one turn.
 *
 * Wider than `CONSOLE_QUESTION_MAX_CHARS` (2,000) because a console answer is a
 * whole board explanation and `ConsoleReplySchema` already allows 6,000 - a
 * store that truncated below the schema's own ceiling would silently record
 * something other than what the operator read. The extra headroom covers a
 * failure turn, which carries the model's raw reply as evidence.
 */
export const CONSOLE_MESSAGE_MAX_CHARS = 12_000;

/**
 * How many turns the console reloads for DISPLAY.
 *
 * Deliberately much larger than the model-context window below: reading back
 * what you asked an hour ago costs nothing, while replaying it into a prompt
 * costs tokens on every question and describes a board that has since moved.
 */
export const CONSOLE_THREAD_DISPLAY_LIMIT = 60;

/** How many turns are replayed into the model's context. Re-exported from
 *  `console-brief.ts` rather than re-declared, so the bound the prompt builder
 *  slices to and the bound the store reads to cannot drift apart. */
export const CONSOLE_HISTORY_CONTEXT_TURNS = CONSOLE_HISTORY_TURNS;

/** Narrow an arbitrary string to a known role, or null. Rows come from our own
 *  table with a CHECK on it, so this is defence in depth against a schema that
 *  grows a third speaker before this module learns about it. */
export function asConsoleMessageRole(value: unknown): ConsoleMessageRole | null {
  return value === "operator" || value === "console" ? value : null;
}

/** Narrow an arbitrary string to a known kind. An UNRECOGNISED kind degrades to
 *  a neutral one rather than being dropped: the turn's TEXT is the thing worth
 *  keeping, and losing a message because a later version of the app labelled it
 *  differently would be a transcript with holes in it. */
export function asConsoleMessageKind(value: unknown, role: ConsoleMessageRole): ConsoleMessageKind {
  if (typeof value === "string" && (CONSOLE_MESSAGE_KINDS as readonly string[]).includes(value)) {
    return value as ConsoleMessageKind;
  }
  return role === "operator" ? "ask" : "notice";
}

/**
 * Bound one turn before it is stored.
 *
 * Returns null for an empty turn - the table's CHECK refuses one, and a store
 * that inserted whitespace would be recording that the console said nothing.
 */
export function boundConsoleMessageBody(text: string): string | null {
  const t = (text ?? "").trim();
  if (t.length === 0) return null;
  return t.slice(0, CONSOLE_MESSAGE_MAX_CHARS);
}

/**
 * The window replayed into the model's context, oldest first.
 *
 * TWO bounds, and both are load-bearing. The COUNT keeps an old turn describing
 * a board that has since moved out of a prompt whose board report is current.
 * The per-turn CHAR bound is what stops the window growing without limit as
 * answers get longer - `buildConsolePrompt` fences each turn at 700 chars
 * anyway, so trimming here only avoids shipping bytes that would be discarded.
 */
export function toModelContextTurns(
  messages: readonly ConsoleMessage[],
  limit: number = CONSOLE_HISTORY_CONTEXT_TURNS,
): ConsoleTurn[] {
  return messages
    .slice(-Math.max(0, limit))
    .map((m) => ({ role: m.role, text: m.body.slice(0, 1200) }));
}

/**
 * WHETHER A COMMANDED FIX MAY BE LINKED TO A MESSAGE.
 *
 * ── THE PROBLEM THIS SOLVES, WHICH IS NOT THE OBVIOUS ONE ─────────────────
 * The client sends a message id alongside the question. Both are
 * client-supplied, and the id is not a security boundary for the COMMAND - the
 * target is still derived server-side by re-parsing the question, exactly as
 * before, and `runConsoleCommand` re-checks every gate against the live
 * database. Nothing here can widen what may be commanded.
 *
 * What it CAN corrupt is the audit trail. A client that sent the id of one
 * message and the text of another would produce a ledger row pointing at a
 * conversation turn that says something else - and a WRONG link is worse than a
 * MISSING one, because a gap is visible and a plausible lie is not.
 *
 * So the link is written only when the STORED message is provably the text the
 * target was derived from: same tenant, same project, an operator turn, and its
 * body equal to the question after the identical bounding both sides apply. A
 * mismatch DROPS THE LINK and lets the command proceed - refusing the fix
 * because its provenance could not be recorded would put bookkeeping ahead of
 * an operator trying to unstick a board.
 */
export type ConsoleMessageLinkDecision =
  | { link: true; messageId: string }
  | { link: false; reason: "no-id" | "not-found" | "not-operator" | "text-mismatch" };

export function decideConsoleMessageLink(args: {
  /** The id the client sent, if any. */
  messageId: string | null | undefined;
  /**
   * The row loaded for that id, ALREADY tenant- and project-scoped by the
   * caller's query. A row from another tenant must not reach here at all; the
   * store's co-located `.eq("tenant_id", …)` is that boundary, not this
   * function.
   */
  message: Pick<ConsoleMessage, "id" | "role" | "body"> | null;
  /** The question the command's target was derived from. */
  question: string;
}): ConsoleMessageLinkDecision {
  const id = (args.messageId ?? "").trim();
  if (id.length === 0) return { link: false, reason: "no-id" };
  if (!args.message || args.message.id !== id) return { link: false, reason: "not-found" };
  if (args.message.role !== "operator") return { link: false, reason: "not-operator" };
  // Compared after the SAME bounding the store applied on the way in, so a
  // question at exactly the cap is not judged a mismatch against its own
  // truncated record.
  const stored = boundConsoleMessageBody(args.message.body);
  const asked = boundConsoleMessageBody(args.question);
  if (stored === null || asked === null || stored !== asked) {
    return { link: false, reason: "text-mismatch" };
  }
  return { link: true, messageId: id };
}
