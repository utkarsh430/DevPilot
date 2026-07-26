// Framework-free core for the per-tenant LLM call routing. Pure functions only
// (mirrors the auth-mode.ts / auth-mode.server.ts split) so acceptance scripts
// can exercise the routing decision and the user-facing error copy without a
// DB or the Next.js runtime. The server-side orchestration that consumes these
// lives in lib/llm/generate.server.ts.
//
// The invariant this file guards: the RAW env crash ("Missing required env
// var: ANTHROPIC_API_KEY") must never be what an operator sees. Every branch
// that can't proceed maps to one of the friendly, actionable messages below,
// each pointing at Settings → LLM auth.

import type { LlmAuthMode } from "./auth-mode";
import { providerSupportsLocalCc, type LlmProvider } from "./provider";

/** Which credential path a server-side LLM feature must use. */
export type LlmRoute = "local_cc" | "direct_api";

/** The single mode → route mapping. Matches `decidePolicy` in
 *  lib/plan/runner-bridge.ts: only an explicit `api_key` opts into the
 *  per-token direct path; everything else rides the Claude Code subscription
 *  through the local runner. */
export function routeForAuthMode(mode: LlmAuthMode): LlmRoute {
  return mode === "api_key" ? "direct_api" : "local_cc";
}

/**
 * The mode → route mapping WITH the provider dimension folded in — the single
 * rule every dispatch path reads (run-agent, the plan bridge, the one-shot
 * generator).
 *
 * The provider OVERRIDES the auth-mode, and can only ever push a run TOWARD the
 * API path, never away from it. That asymmetry is the whole safety property: the
 * local-cc runner is `claude -p`, which speaks Anthropic and nothing else, so a
 * project on an OpenAI-compatible endpoint has exactly one place it can run. A
 * provider that can't ride the subscription therefore forces `direct_api`
 * regardless of what the tenant's auth-mode says — and an Anthropic project is
 * left entirely alone, so today's behaviour is untouched for everyone who
 * configures nothing.
 */
export function routeForProvider(mode: LlmAuthMode, provider: LlmProvider): LlmRoute {
  if (!providerSupportsLocalCc(provider)) return "direct_api";
  return routeForAuthMode(mode);
}

/** The same decision in the engine's `RunnerKind` vocabulary (`runs.runner_kind`,
 *  the plan bridge's PolicyDecision). Kept beside `routeForProvider` so the two
 *  can't drift. */
export function decideRunnerPolicy(mode: LlmAuthMode, provider: LlmProvider): "api" | "local-cc" {
  return routeForProvider(mode, provider) === "direct_api" ? "api" : "local-cc";
}

/** An OpenAI-compatible project whose endpoint/model/credential doesn't resolve.
 *  Distinct copy from the Anthropic missing-key error because the fix is a
 *  different screen. */
export function providerMisconfiguredError(featureName: string, detail: string): string {
  return `${featureName} can't run: ${detail}`;
}

/** claude_code mode but no runner is heartbeating. */
export function runnerNotConnectedError(featureName: string): string {
  return (
    `${featureName} runs on your Claude Code subscription via your local runner, ` +
    "which isn't connected. Start your runner (pnpm --filter @devpilot/runner dev), " +
    "or switch to API-key mode in Settings → LLM auth."
  );
}

/** api_key mode but no ANTHROPIC_API_KEY resolves (tenant » instance » env). */
export function apiKeyMissingError(featureName: string): string {
  return (
    `${featureName} uses the direct Anthropic API because this workspace's LLM ` +
    "auth-mode is set to API key, but no ANTHROPIC_API_KEY is configured. Add the " +
    "key, or switch to Claude Code auth in Settings → LLM auth."
  );
}

/** claude_code mode on a feature that cannot ride the runner (e.g. a tool call
 *  made FROM an in-flight runner job, where a nested job can deadlock the
 *  concurrency slots). */
export function featureNeedsApiKeyModeError(featureName: string): string {
  return (
    `${featureName} is only available in API-key mode — it runs inside an active ` +
    "runner job, so it can't be routed back through the runner. Switch to API-key " +
    "mode in Settings → LLM auth to use it."
  );
}

// ─── structured output over `claude -p` ─────────────────────────────────────
//
// The local runner returns free text (it doesn't honour the Vercel AI SDK's
// `generateObject` contract), so structured callers sandwich a strict JSON
// contract around their system prompt and parse the reply. The head+tail
// repetition mirrors lib/engine/ticket-role-classifier.ts (OUTPUT_SPEC_HEADER)
// — empirically the most reliable way to keep the model from prose-ifying.

export function buildJsonContractSystemPrompt(system: string, schemaHint: string): string {
  return [
    "# CRITICAL OUTPUT CONTRACT (read first, obey absolutely)",
    "",
    "Your ENTIRE response must be ONE JSON object and NOTHING else:",
    "- No markdown headings, no prose preamble, no commentary, no fences.",
    "- Start your reply with the literal character `{` and end with `}`.",
    "- All fields are required; do not add extra fields.",
    "",
    // THE CLAUSE THE CONSOLE NEEDED, and the reason a generic "return JSON"
    // was not enough. A caller that asks for an EXPLANATION is asking for a
    // narrative, and a model handed both instructions resolves them by writing
    // the narrative and appending nothing - which is exactly what happened on
    // 2026-08-04. Saying where the narrative GOES resolves the conflict instead
    // of restating one side of it.
    "If the task asks you to explain, diagnose or summarise, the explanation is the VALUE of a",
    "string field inside that object. It does NOT go before the object, after it, or instead of",
    "it. Write the prose inside the JSON string, escaping newlines as `\\n`.",
    "",
    "Schema:",
    schemaHint,
    "",
    system,
    "",
    "# Reply format reminder",
    "",
    "Return ONE JSON object matching the schema above. First character MUST be `{`.",
    "No preamble. No sign-off. Your narrative belongs inside a field, not around the object.",
  ].join("\n");
}

/** How much of a rejected reply is quoted back to the model on the retry. Enough
 *  for it to recognise what it did; not so much that the retry prompt is
 *  dominated by the mistake. */
const RETRY_ECHO_CHARS = 600;

/**
 * The ONE bounded retry's prompt.
 *
 * A model that answered in prose almost always answered WELL - the content is
 * right and the envelope is wrong - so the retry re-states the original request
 * verbatim and adds the one fact the first attempt was missing: what it sent
 * was not JSON. Telling it only "return JSON" without showing what it did leaves
 * it free to make the same call again.
 *
 * The echo is stripped of backtick runs before it is fenced, exactly as
 * `fenceUntrustedOutput` does: a rejected reply is model output being fed back
 * into a prompt, and a reply containing ``` would otherwise close our fence and
 * let its own text read as instructions.
 */
export function buildJsonRetryPrompt(originalPrompt: string, previousReply: string): string {
  const echo = (previousReply ?? "").slice(0, RETRY_ECHO_CHARS).replace(/`{3,}/g, "'''").trimEnd();
  return [
    "# YOUR PREVIOUS REPLY WAS REJECTED",
    "",
    "It was not JSON. It could not be parsed, so it was discarded and nobody read it.",
    "This is what you sent (truncated):",
    "",
    "```",
    echo || "(empty)",
    "```",
    "",
    "Answer the SAME request again, with the same content, as ONE JSON object matching the",
    "schema in your instructions. Put the prose you just wrote inside the string field it",
    "belongs in. Emit nothing before the opening `{` and nothing after the closing `}`.",
    "",
    "# The request, unchanged",
    "",
    originalPrompt,
  ].join("\n");
}

/**
 * Below this much remaining wall clock the retry is skipped. A second attempt
 * that cannot finish is strictly worse than the first failure: it spends the
 * rest of the operator's patience and returns the same thing.
 */
export const MIN_JSON_RETRY_BUDGET_MS = 15_000;

/**
 * MAY THE UNUSABLE REPLY BE ASKED AGAIN, AND WITH HOW LONG?
 *
 * ONE wall-clock budget across BOTH attempts. The caller asked for a ceiling
 * and a retry must not silently double it - the supervisor console's is 180s,
 * and an operator waiting six minutes for a diagnosis has been failed either
 * way. So the retry gets what is LEFT, and only if that is enough to be worth
 * spending.
 *
 * The retry is worth making at all only because the failure it answers means
 * THE MODEL ANSWERED: a timeout or a dead runner will not answer differently,
 * and retrying one would burn the rest of the budget proving it. That
 * distinction is the caller's (`attemptLocalCc` splits `transport` from
 * `rejected`); this function only bounds the clock.
 */
export function decideJsonRetry(args: {
  budgetMs: number;
  elapsedMs: number;
}): { retry: true; timeoutMs: number } | { retry: false } {
  const remaining = args.budgetMs - args.elapsedMs;
  if (!Number.isFinite(remaining) || remaining < MIN_JSON_RETRY_BUDGET_MS) return { retry: false };
  return { retry: true, timeoutMs: remaining };
}

/** Bounds on the balanced scan. A reply is a few KB; these exist so a
 *  pathological one (5,000 unmatched `{`) cannot turn extraction into an O(n²)
 *  walk on a request path. */
const MAX_JSON_CANDIDATES = 12;
const MAX_SCAN_STARTS = 64;

/**
 * Every JSON object that can be read out of a text blob, in document order.
 *
 * ── WHY THIS IS NOT "PARSE THE REPLY" ─────────────────────────────────────
 * The local-cc path gets TEXT back: `claude -p` has no structured-output mode,
 * so the schema is a request and not a constraint. A model asked to explain
 * something will lead with prose, and the previous extractor took a single span
 * from the first `{` to the last `}` - so one brace anywhere in that prose (a
 * quoted `{}`, a closing brace in a trailing sentence) made the span
 * unparseable and threw a good answer away. That is defect 1 of 2026-08-04.
 *
 * So: try every fenced block, then walk each `{` with a BALANCED scan that
 * respects string literals and escapes, and return everything that parses. The
 * caller with the schema picks - which is the only thing that can tell a
 * wrapper object from the object that was wanted.
 *
 * Order is: fences first (a model that fences is signalling "this is the
 * payload"), then balanced spans left to right, so the outermost object is
 * offered before anything nested inside it.
 */
export function extractJsonCandidates(text: string): unknown[] {
  if (!text || text.trim().length === 0) return [];
  const out: unknown[] = [];
  const seen = new Set<string>();

  const offer = (raw: string): void => {
    if (out.length >= MAX_JSON_CANDIDATES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    // Cheap identity: two candidates that stringify the same ARE the same, and
    // the fence and the balanced scan routinely both see the one object.
    let key: string;
    try {
      key = JSON.stringify(parsed);
    } catch {
      return; // cyclic is impossible from JSON.parse, but a getter-free guard costs nothing
    }
    if (seen.has(key)) return;
    seen.add(key);
    out.push(parsed);
  };

  // 1. Fenced blocks. EVERY one, not just the first: a reply that shows a shell
  //    snippet before its answer used to lose the answer.
  for (const m of text.matchAll(/```(?:json|jsonc)?[ \t]*\r?\n?([\s\S]*?)```/gi)) {
    const body = m[1];
    if (body) offer(body.trim());
  }

  // 2. Balanced spans, left to right.
  let starts = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    if (++starts > MAX_SCAN_STARTS) break;
    if (out.length >= MAX_JSON_CANDIDATES) break;
    const end = findBalancedEnd(text, i);
    if (end > i) offer(text.slice(i, end + 1));
  }
  return out;
}

/** Index of the `}` closing the `{` at `open`, or -1 if it never closes.
 *  String-aware: braces and quotes inside a JSON string are literal text, and a
 *  backslash escapes the next character. */
function findBalancedEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The first readable JSON object in a text blob, or null.
 *
 * Retained for callers that have no schema to disambiguate with (the classifier
 * bridge, and anything that only ever asks for one flat object).
 * Schema-carrying callers should use `extractJsonCandidates` and validate each.
 */
export function extractJsonBlock<T = unknown>(text: string): T | null {
  const [first] = extractJsonCandidates(text);
  return first === undefined ? null : (first as T);
}
