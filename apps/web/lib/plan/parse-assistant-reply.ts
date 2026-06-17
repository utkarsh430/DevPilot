// Pure parser for plan-mode lead replies.
//
// The LEAD_SYSTEM_PROMPT contract: a markdown prose preamble followed by a
// SINGLE fenced ```json block carrying `{summary, questions[]}`. This module
// splits a raw message string into both halves, Zod-validates the JSON, and
// returns a graceful fallback shape on any parse / validation failure so the
// UI degrades to plain prose.
//
// No runtime dependency on react — this is a pure function so the parser
// can be unit-tested in isolation.

import { z } from "zod";

// Hard caps mirroring the prompt. Anything beyond these the parser drops
// silently and surfaces via `truncatedCount`.
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

const OptionSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().max(280).optional(),
  recommended: z.boolean().optional(),
});

const QuestionSchema = z.object({
  q: z.string().min(1).max(400),
  options: z.array(OptionSchema).min(2),
  allowMultiple: z.boolean().optional(),
});

const FenceBodySchema = z.object({
  summary: z.string().max(400).optional(),
  questions: z.array(QuestionSchema).max(20), // soft cap; we re-cap below
});

export type ParsedOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};
export type ParsedQuestion = {
  q: string;
  options: ParsedOption[];
  allowMultiple: boolean;
};
export type ParsedAssistantReply = {
  prose: string;
  summary: string | null;
  questions: ParsedQuestion[];
  truncatedCount: number;
  parseError: string | null;
};

/**
 * Heuristic repair for one specific failure mode we see in lead replies:
 * the model writes an unescaped `"` inside a string value, e.g.
 *
 *   `"q": "What does "summarise" mean in this context?",`
 *
 * Strict JSON.parse rejects this; the intent is obvious. We walk the text
 * tracking in-string state. On every `"` we hit while in a string, peek past
 * whitespace to the next significant char: if it's `,`, `}`, `]`, `:`, or
 * EOF the quote is a real string close; otherwise the quote is an unescaped
 * intra-string quote and we rewrite it as `\"`.
 *
 * This is intentionally narrow — does NOT try to be a full json5/jsonrepair.
 * Returns the input unchanged when no repair was needed (caller uses that to
 * skip the retry parse and surface the original error).
 */
export function repairUnescapedQuotes(text: string): string {
  const out: string[] = [];
  let inString = false;
  let escape = false;
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      out.push(ch);
      escape = false;
      continue;
    }
    if (ch === "\\") {
      out.push(ch);
      escape = true;
      continue;
    }
    if (ch !== '"') {
      out.push(ch);
      continue;
    }
    if (!inString) {
      inString = true;
      out.push(ch);
      continue;
    }
    // We're in a string and hit `"`. Closing quote or intra-string quote?
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j]!)) j++;
    const next = j < text.length ? text[j]! : "";
    if (next === "" || next === "," || next === "}" || next === "]" || next === ":") {
      inString = false;
      out.push(ch);
    } else {
      out.push('\\"');
      changed = true;
    }
  }
  return changed ? out.join("") : text;
}

// Locate the first fenced JSON block. Tolerates both ```json...``` and
// plain ```...``` fences. Returns the body string + start/end indexes in
// the original content. Returns null if no fence is found.
//
// Anchored on the opening fence so prose can contain triple-backticks
// elsewhere (e.g. inline code samples) without false-positiving — we look
// for the FIRST fence that smells like JSON (starts with `{` after the
// fence opener, modulo whitespace).
function locateFence(content: string): { body: string; start: number; end: number } | null {
  // Regex captures: opening fence + optional lang tag + body + closing fence.
  // Non-greedy body capture so it stops at the first matching ```.
  const re = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const body = match[1] ?? "";
    if (body.trimStart().startsWith("{")) {
      return {
        body,
        start: match.index,
        end: match.index + match[0].length,
      };
    }
  }
  return null;
}

/**
 * Parse a raw assistant message into `{prose, summary, questions}`.
 *
 * Graceful failure modes — ALL return `{prose: content, questions: []}`:
 * - No fence at all (pre-change messages, plain-prose replies).
 * - Fence present but JSON.parse fails (malformed model output).
 * - JSON valid but Zod schema rejects (e.g. missing `options`).
 *
 * On graceful failure the UI renders the entire message as plain prose,
 * the composer remains usable, and `parseError` is populated for telemetry.
 */
export function parseAssistantReply(content: string): ParsedAssistantReply {
  const empty: ParsedAssistantReply = {
    prose: content,
    summary: null,
    questions: [],
    truncatedCount: 0,
    parseError: null,
  };

  const fence = locateFence(content);
  if (!fence) return empty;

  // Prose = everything before the fence, trimmed of trailing whitespace.
  const prose = content.slice(0, fence.start).trimEnd();

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(fence.body);
  } catch (err) {
    // First-try failure is dominated by ONE pattern in practice: the model
    // wrote an unescaped double quote inside a string value (e.g.
    // `"q": "What does "summarise" mean in this context?"`). Try a
    // single repair pass that escapes the intra-string quotes, then retry.
    // Keep the original error for telemetry when the repair also fails.
    const repaired = repairUnescapedQuotes(fence.body);
    if (repaired !== fence.body) {
      try {
        rawJson = JSON.parse(repaired);
      } catch {
        return {
          prose: content,
          summary: null,
          questions: [],
          truncatedCount: 0,
          parseError: `json: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      return {
        prose: content,
        summary: null,
        questions: [],
        truncatedCount: 0,
        parseError: `json: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const parsed = FenceBodySchema.safeParse(rawJson);
  if (!parsed.success) {
    return {
      prose: content,
      summary: null,
      questions: [],
      truncatedCount: 0,
      parseError: `schema: ${parsed.error.issues[0]?.message ?? "invalid shape"}`,
    };
  }

  const rawQuestions = parsed.data.questions;
  const cappedQuestions = rawQuestions
    .map((q): ParsedQuestion => {
      const cleaned = q.options
        .map((o) => ({
          label: o.label.trim(),
          description: o.description?.trim() || undefined,
          recommended: o.recommended === true,
        }))
        .filter((o) => o.label.length > 0)
        .slice(0, MAX_OPTIONS);
      // Enforce single recommendation: keep the first `recommended: true`,
      // demote the rest. Then surface that option at the top so the UI's
      // "best choice" matches keyboard shortcut 1.
      let seenRecommended = false;
      const normalized = cleaned.map((o) => {
        if (o.recommended && !seenRecommended) {
          seenRecommended = true;
          return o;
        }
        return { ...o, recommended: false };
      });
      const sorted = normalized
        .slice()
        .sort((a, b) => (a.recommended === b.recommended ? 0 : a.recommended ? -1 : 1));
      const options: ParsedOption[] = sorted.map((o) =>
        o.recommended ? o : { label: o.label, description: o.description },
      );
      return {
        q: q.q.trim(),
        options,
        allowMultiple: q.allowMultiple ?? false,
      };
    })
    // Drop questions that lost too many options to remain meaningful (must
    // still have ≥2 selectable choices).
    .filter((q) => q.options.length >= 2)
    .slice(0, MAX_QUESTIONS);

  const truncatedCount = Math.max(0, rawQuestions.length - MAX_QUESTIONS);

  return {
    prose,
    summary: parsed.data.summary?.trim() || null,
    questions: cappedQuestions,
    truncatedCount,
    parseError: null,
  };
}
