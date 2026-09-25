// The shapes the console's UI renders. A plain module, deliberately separate
// from `console-server-actions.ts`.
//
// `"use server"` files may only export async functions - so a type declared
// there is erased before the check and technically passes, but a client
// component importing from one still pulls a server-action module into its
// import graph. Keeping the view types here means the presentational half
// (`components/supervisor/console-report.tsx`) imports nothing that reaches the
// server at all, which is what keeps it loadable in the node-environment render
// tests.

import type { ConsoleAction } from "@/lib/supervisor/console-actions";
import type { BoardSummary } from "@/lib/supervisor/console-facts";

/**
 * What the console renders WITHOUT the model.
 *
 * Computed deterministically from the database, so the surface still answers
 * "what is this board doing" when the LLM is unreachable - a real state, and
 * one that CORRELATES with the board being broken, since the default LLM route
 * and the agent runner are the same process. A console that goes blank exactly
 * when the runner is down would be useless at the only moment it matters.
 */
export type ConsoleBrief = {
  projectName: string;
  /** The per-project opt-in. Gates ACT only - never EXPLAIN. */
  supervisorEnabled: boolean;
  engine: { state: "alive" | "wedged" | "unknown"; detail: string };
  summary: BoardSummary;
  actions: ConsoleAction[];
  /** True when the ticket scan hit its cap, so the counts are a floor. */
  truncated: boolean;
};

/**
 * The sentence the console shows when the MODEL half failed.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────
 * The console said, verbatim: "I could not reach the model to write that up:
 * The supervisor console returned no parseable JSON — try again." The model was
 * reached. A one-shot had completed seconds earlier with a 3,270-character
 * response. The failure was PARSING.
 *
 * Those two have different causes and different fixes - is the runner up, versus
 * what did the model actually say - so a single sentence claiming both sends the
 * reader at the wrong one, and the reader is usually mid-incident and short of
 * patience. The console had one hardcoded prefix because it had one bit of
 * information; `LlmFailureKind` is the missing bit, and this is the only place
 * that turns it into words.
 *
 * PURE, and here rather than inline in `SupervisorConsole.tsx`, for the reason
 * the rest of this surface is split that way: the component is `"use client"`
 * and carries hooks, so nothing in it loads under the repo's node-environment
 * Vitest. The wording IS the fix, so the wording has to be assertable.
 *
 * An UNKNOWN kind degrades to the neutral sentence, never to a reachability
 * claim: a future kind we have not thought about must not silently inherit the
 * accusation this function exists to stop making.
 */
/**
 * The console's sentence for what a run did.
 *
 * `applied: false` is NOT a failure - it is a primitive standing down, which is
 * the safety mechanism working (`recoverOrphanedTicket` re-derives its evidence
 * and refuses a ticket that came alive in between). The wording keeps the two
 * apart, and it lives here because it is now written to the transcript as well
 * as to the screen; one sentence, one owner, so a reloaded thread cannot read
 * differently from the live one.
 */
export function describeConsoleRunOutcome(applied: boolean, summary: string): string {
  return `**${applied ? "Done." : "Nothing changed."}** ${summary}`;
}

/**
 * The console's own sentence for "you named something that is not on this
 * board".
 *
 * Here rather than in the component because it is now said TWICE - once to the
 * operator and once into the durable transcript, so a reloaded thread reads the
 * same as the live one. Two copies of a sentence is how a reload starts
 * disagreeing with what was on screen.
 */
export function describeMissingTicketKeys(keys: readonly string[]): string {
  const list = keys.join(", ");
  const one = keys.length === 1;
  return (
    `**${list}** ${one ? "is not a ticket" : "are not tickets"} on this board, so there are ` +
    `no commands for ${one ? "it" : "them"}.`
  );
}

/** How much of an unusable reply is rendered. Long enough for the answer the
 *  console lost (the measured one was 1,453 chars); short enough that a runaway
 *  reply cannot become the whole transcript. */
const RAW_REPLY_RENDER_CHARS = 4000;

/**
 * The reply, contained inside a markdown BLOCKQUOTE.
 *
 * ── WHY A BLOCKQUOTE AND NOT A CODE FENCE, WHICH IS WHAT THIS SHIPPED AS ──
 * Found by looking at it in a browser, which is the only way this class of
 * defect is ever found: a fenced block renders through `MessageMarkdown`'s
 * `pre`, which is `whitespace-pre` + `overflow-x-auto` - correct for code, and
 * wrong for a 1,400-character paragraph. The whole recovered answer came out on
 * ONE line, clipped at the edge of the sheet. It was technically present and
 * practically unreadable, which is the same failure as not showing it.
 *
 * A blockquote wraps, and it still reads unmistakably as somebody else's words.
 *
 * CONTAINMENT IS PER LINE, and that is what makes this at least as safe as the
 * fence it replaces. EVERY line is prefixed - blank ones included, as `>` - so
 * there is no sequence the reply can contain that ends the quote early. A fence
 * has exactly one such sequence (```), which is why it needed the backtick
 * collapse; a per-line prefix has none, so the reply reaches the operator
 * VERBATIM rather than lightly mangled.
 *
 * Markdown INSIDE the quote still renders, deliberately: it makes the answer
 * readable, and everything it produces is nested inside the quote, under a
 * label that says it is unverified. What must not happen is text escaping to
 * top level, where it would be indistinguishable from the console's own words -
 * and the line prefix is what prevents that.
 */
function quoteRawReply(raw: string): string {
  return raw
    .trim()
    .slice(0, RAW_REPLY_RENDER_CHARS)
    .split("\n")
    .map((line) => (line.trim().length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * The block that shows an operator the answer the parser lost.
 *
 * ── WHY RAW MODEL OUTPUT IS ON SCREEN AT ALL ──────────────────────────────
 * This module's own header used to say the reply "is not ours to render". That
 * was measured wrong on 2026-08-04: the operator asked what the board was doing,
 * the model wrote a specific, grounded, honest answer, and the console showed
 * them a parse error instead of one word of it. The reply was in the server log,
 * which is not a place an operator reads mid-incident.
 *
 * What makes it safe is not the copy, it is that NOTHING WAS DERIVED FROM IT.
 * `groundConsoleReply` never ran, so there is no recommended action, no linked
 * ticket and nothing to click - just prose. The label says so, because prose
 * that looks like a normal console answer would imply it had been checked
 * against the board, and it has not.
 */
function rawReplyBlock(raw: string): string {
  return [
    "",
    "Here is what it said, raw and **unverified** - nothing in it has been checked against the",
    "board, so treat any action it names as a suggestion to look into, not one to run:",
    "",
    quoteRawReply(raw),
  ].join("\n");
}

export function describeConsoleModelFailure(
  kind: string,
  error: string,
  /** The model's own reply, when it answered and the answer could not be used.
   *  Only rendered for the two kinds that mean it answered. */
  rawReply?: string,
): string {
  const tail =
    `The board summary above is still current - it is read straight from the database and ` +
    `does not need the model.`;
  const raw = (rawReply ?? "").trim();
  // Where to send them when there is nothing to show. The log line is
  // `[llm] …: no parseable JSON in a N-char reply`.
  const logPointer = `What came back is in the server log, under \`[llm]\`.`;
  const evidence = raw.length > 0 ? rawReplyBlock(raw) : `\n\n${logPointer}`;

  switch (kind) {
    case "unreachable":
      return `I could not reach the model to write that up: ${error}\n\n${tail}`;
    case "misconfigured":
      return (
        `The model is not usable with this project's current LLM settings, so I could not ` +
        `write that up: ${error}\n\n${tail}`
      );
    case "unparseable":
      // NOT "could not reach". The model answered, and it was asked a second
      // time before we gave up; the reply itself is the evidence.
      return (
        `The model answered, but I could not read its reply as an answer: ${error}\n\n` +
        `This is not a connection problem - the reply arrived and could not be parsed.` +
        `${evidence}\n\n${tail}`
      );
    case "invalid_shape":
      return (
        `The model answered, but its reply did not have the shape this console needs: ` +
        `${error}\n\nThis is not a connection problem - the reply arrived and was ` +
        `rejected.${evidence}\n\n${tail}`
      );
    default:
      return `I could not write that up: ${error}\n\n${tail}`;
  }
}
