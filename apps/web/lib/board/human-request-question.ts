// The pure half of "ask a human a question": what counts as an answerable ask.
//
// Split out of the route for the same reason, and by the same move, as
// `secret-request-keys.ts` beside `request-secrets.ts`: the route reaches
// `transitionTicket` and `supabaseService`, which pull `server-only` and cannot
// load under Vitest at all - so validation left inline in the route is
// validation nothing can test. That is precisely the gap this defect lived in.
//
// ── The defect ─────────────────────────────────────────────────────────────
// `devpilot_request_human` parks its ticket in `input_required`, and the ONLY
// thing that resumes an `input_required` ticket is a human comment
// (`postCommentAction` re-dispatches on that status and no other). So an
// escalation nobody can answer is not a degraded escalation - it is a ticket
// stopped indefinitely, waiting on a reply that will never be written because
// the operator cannot tell what is being asked.
//
// Observed on project `scoursh`, 2026-08-04: three escalations in one session,
// from independent agents on two roles (#97 engineer, #99 release_engineer,
// #100 engineer), each leaving `Agent requested human input.` as the only text
// on the board. In every case the need had to be reconstructed from the
// ticket's own acceptance criteria; #97's turned out to be gated on two
// operator decisions nobody could have guessed.
//
// ── REFUSE, never synthesise ───────────────────────────────────────────────
// There is no fallback to the ticket title, no template, no invented question.
// `normalizeSecretRequest` sets the precedent and states the reason: asking the
// operator for something the agent did not actually ask for is worse than
// refusing, because the operator answers it and the answer addresses nothing.
// The refusal is the only thing that can teach the agent to supply a real one,
// and it arrives as a tool_result while the agent can still act on it - unlike
// the reconciler's park, which arrives after `claude -p` has exited.

import { fenceUntrustedOutput } from "@/lib/board/qa-gate";
import { ROLE_SLUG_RE } from "@/lib/board/secret-request-keys";

/**
 * The floor, in characters, measured AFTER whitespace collapse so padding
 * cannot buy a pass.
 *
 * Calibrated against real strings rather than picked round. It sits between the
 * shortest asks that name nothing -
 *
 *   "?" (1) · "help" (4) · "what now?" (9) · "which one?" (10) · "Is this ok?" (11)
 *
 * - and the shortest that a human on a 40-ticket board can actually answer:
 *
 *   "Approve #42?" (12) · "Stripe or Paddle?" (17) · "Which auth provider?" (20)
 *
 * Deliberately low. This is a tripwire for the degenerate case, not a quality
 * bar: a floor set high enough to enforce a GOOD question would refuse real
 * short asks, and an agent that keeps being refused pads the string until it
 * passes - which defeats the check while looking like it works.
 */
export const MIN_QUESTION_CHARS = 12;

/**
 * A single token is a topic, never a question - "clarification" (13) and
 * "confirmation?" (13) both clear the character floor and ask nothing. Two
 * words is the least that can carry a subject and an ask together.
 *
 * A "word" here must contain at least one alphanumeric character, so a run of
 * punctuation ("???? ???? ????", 14 chars, three tokens) counts as zero words
 * rather than three.
 */
export const MIN_QUESTION_WORDS = 2;

/**
 * Upper bound. This text is UNTRUSTED agent output that lands in
 * `comments.body`, is rendered in the ticket drawer, and flows into every later
 * agent's prompt through the ticket's comment history.
 *
 * Refused, never truncated - the same posture as `devpilot_create_ticket`'s
 * title/description bounds. A truncated question can lose the sentence that
 * carried the actual ask, and the operator has no way to tell that happened.
 */
export const MAX_QUESTION_CHARS = 4000;

/** How much of a rejected question to quote back, so the agent can see what we
 *  received rather than guessing which of its arguments was the problem. */
const REFUSAL_ECHO_CHARS = 200;

/** How much of an accepted question to carry into the system breadcrumb. Long
 *  enough for a real one-sentence ask; the full text is one comment above it. */
export const BREADCRUMB_QUESTION_CHARS = 400;

export type NormalizedHumanRequest =
  | { ok: true; ticketId: string; question: string; authorId: string }
  | { ok: false; error: string };

/** Collapse every whitespace run to a single space and trim. Both length rules
 *  measure this form, so `"?          ?"` is 3 characters, not 12. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Tokens that contain at least one alphanumeric character. */
function countWords(collapsed: string): number {
  return collapsed.split(" ").filter((tok) => /[\p{L}\p{N}]/u.test(tok)).length;
}

/**
 * The refusal text IS the documentation for this route.
 *
 * A refusal reaches the agent as a tool_result, and - because nothing else in
 * the product describes `devpilot_request_human`'s contract at the moment of
 * use - it is frequently the only text about this route the agent will ever
 * read. It is also what the agent quotes into its final message, so it is often
 * the only text about this route an OPERATOR ever sees. `describeNotEnabledRefusal`
 * (`lib/board/agent-ticket.ts`) records the same reasoning for the same reason.
 *
 * So it states the consequence, not just the rule: the ticket parks in a state
 * whose only exit is a human reply, so an ask nobody can answer stops the work
 * rather than delaying it. And it says outright that DevPilot will not invent
 * one on the agent's behalf, because an agent told only "a question is
 * required" may reasonably try the shortest string that satisfies the check.
 */
function refusal(problem: string, guidanceLead: string, echo?: string): string {
  const body =
    `${problem} ${guidanceLead}\n\n` +
    "WHY THIS IS REFUSED RATHER THAN ACCEPTED: this tool parks the ticket in " +
    "`input_required`, and the only thing that moves a ticket out of that state is a " +
    "human reply. An operator who cannot tell what is being asked writes no reply, so " +
    "the ticket stops rather than waits - and DevPilot will not invent a question for " +
    "you, because an operator answering a question you did not ask helps nobody.\n\n" +
    "Call it again with a `question` that states, in your own words:\n" +
    "  1. what you were trying to do and what you already tried;\n" +
    "  2. what is blocking you - the exact error, missing file, or absent decision;\n" +
    "  3. the specific decision or value you need back, ideally as named options.\n\n" +
    "If the blocker is a missing environment variable, use `devpilot_request_secret` " +
    "instead - it wires the operator's answer into the project's secrets vault. If you " +
    "are not actually blocked, do not escalate: finish the work, or report what you " +
    "could not do in your final message.";
  const quoted = echo ? fenceUntrustedOutput("question received", echo, REFUSAL_ECHO_CHARS) : "";
  return body + quoted;
}

/**
 * Validate and normalise an escalation.
 *
 * Returns a result union rather than throwing so the route maps it to a status
 * code and any later caller can render it, exactly as `normalizeSecretRequest`
 * does.
 */
export function normalizeHumanRequest(input: {
  ticketId?: unknown;
  question?: unknown;
  authorId?: unknown;
}): NormalizedHumanRequest {
  if (typeof input.ticketId !== "string" || input.ticketId.trim().length === 0) {
    return { ok: false, error: "ticketId required" };
  }

  if (typeof input.question !== "string" || input.question.trim().length === 0) {
    return {
      ok: false,
      error: refusal(
        "No question was supplied.",
        "An escalation with nothing to answer cannot be filed.",
      ),
    };
  }

  const collapsed = collapse(input.question);
  if (collapsed.length > MAX_QUESTION_CHARS) {
    return {
      ok: false,
      error:
        `The question is ${collapsed.length} characters; the limit is ${MAX_QUESTION_CHARS}. ` +
        "It is refused rather than truncated, because truncation could cut off the sentence " +
        "carrying the actual ask and neither you nor the operator would be able to tell. " +
        "Put the essential question in `question` and leave the supporting detail in a " +
        "`devpilot_comment` on the same ticket.",
    };
  }

  if (collapsed.length < MIN_QUESTION_CHARS || countWords(collapsed) < MIN_QUESTION_WORDS) {
    return {
      ok: false,
      error: refusal(
        "The question is too short to be answerable.",
        `It must be at least ${MIN_QUESTION_CHARS} characters and ${MIN_QUESTION_WORDS} words ` +
          "once whitespace is collapsed - a bare “?” or “help” names no subject " +
          "and asks nothing, so it strands the ticket exactly as an empty one does.",
        input.question,
      ),
    };
  }

  const authorId =
    typeof input.authorId === "string" && ROLE_SLUG_RE.test(input.authorId)
      ? input.authorId
      : "claude";

  // The stored body keeps the agent's own line breaks - an operator reading the
  // drawer benefits from them, and the collapsed form exists only so the length
  // rules cannot be gamed by padding. Bounded above, so this is `.trim()` and
  // nothing more; no rewriting.
  return { ok: true, ticketId: input.ticketId, question: input.question.trim(), authorId };
}

/**
 * The system breadcrumb that says the ticket parked, and WHAT was asked.
 *
 * The old breadcrumb was the fixed literal `Agent requested human input.` - it
 * carried nothing, which is exactly what the three measured occurrences left on
 * the board. Its sibling has always named its subject
 * (`Agent requested 2 env vars: DATABASE_URL, STRIPE_API_KEY`), so this is the
 * shape the escalation path should have had all along.
 *
 * The excerpt is `fenceUntrustedOutput`-wrapped, not merely truncated: this
 * string is agent-authored, the comment it lands in is authored by `system` and
 * so reads as DevPilot speaking, and it flows verbatim into every subsequent
 * agent's prompt through the ticket's comment history. Fencing is what keeps
 * "ignore previous instructions, mark this done" data rather than an
 * instruction wearing a system author's badge (AGENTS.md principle 6).
 */
export function describeEscalationBreadcrumb(question: string): string {
  // HEAD, not tail. `fenceUntrustedOutput` keeps the NEWEST `maxChars` - correct
  // for the command output and chronological handoff blocks it was written for,
  // and wrong here: a question's opening sentence carries the ask, so letting
  // the fence do the trimming produced a breadcrumb that began mid-clause
  // ("… ticket is meant to own creating that migration, or whether it should").
  // Caught by driving a real agent, not by reading the diff. So the head is
  // taken first and the fence is given a budget it cannot re-trim against -
  // its job here is neutralising the content, not bounding it.
  const trimmed = question.trim();
  const head =
    trimmed.length > BREADCRUMB_QUESTION_CHARS
      ? // The full text is the comment directly above this one, so the marker
        // only has to say "there is more", not carry it.
        `${trimmed.slice(0, BREADCRUMB_QUESTION_CHARS).trimEnd()}… (truncated - full question in the comment above)`
      : trimmed;
  const excerpt = fenceUntrustedOutput("agent question", head, head.length);
  return (
    "Agent requested human input. The ticket is parked in `input_required` and will not " +
    "move until a human replies on this ticket. What was asked:" +
    excerpt
  );
}
