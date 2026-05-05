// `claude -p --model` — the runner half of the model plumb-through (WI-12).
//
// DEFAULT-OFF is the contract: the engine sends `model: null` for every project
// that hasn't explicitly configured one (which is all of them, until an operator
// opts in), and `modelArgs(null)` returns `[]` — no flag, account default, byte-
// for-byte today's behaviour. There is no "sensible default" to invent here; the
// account's own default IS the sensible default, and quietly pinning a model for
// everyone would change what every existing run costs and how it performs.
//
// SAFE FALLBACK, half 2 of 2. The engine already refuses a model id it doesn't
// recognise (lib/llm/provider.ts → resolveClaudeModelArg). What the engine CANNOT
// know is whether a perfectly valid model is available on this operator's actual
// subscription — Opus on a Pro plan is the obvious case, and the answer changes
// with the plan, not with the code. Only `claude` itself finds out, at spawn time.
// So when a run fails with a model-availability error, the runner retries ONCE
// without `--model` and lets the account default answer.
//
// Why retry rather than fail: the operator's alternative outcomes are "the ticket
// runs on Sonnet instead of Opus" and "the ticket fails". Nobody wants the second
// one. The retry is logged loudly so the misconfiguration is visible rather than
// silently absorbed forever.

/** Model ids are vendor-shaped slugs. The engine already allowlists what it sends
 *  (lib/llm/provider.ts), and the DB CHECK-constrains what can be stored — this is
 *  the runner's own guard on a value that reaches a subprocess argv.
 *
 *  Defence in depth, not paranoia: the model arrives in the LOCAL_CC_QUEUE job
 *  payload, so it is only as trustworthy as write access to Redis. `spawn` takes
 *  an argv ARRAY (no shell), so there's no metacharacter injection to worry about
 *  — but a value like `--verbose` shouldn't get anywhere near the flag position,
 *  and a runner that re-checks doesn't have to reason about what the engine
 *  promised. */
const MODEL_ARG_RE = /^[A-Za-z0-9._:\-/]{1,120}$/;

/** Build the `--model` argv fragment. Empty when no model is pinned OR when the
 *  value doesn't look like a model id — dropping the flag runs on the account
 *  default, which is the same safe fallback as everywhere else on this path. */
export function modelArgs(model: string | null | undefined): string[] {
  const m = (model ?? "").trim();
  if (m.length === 0) return [];
  if (m.startsWith("-") || !MODEL_ARG_RE.test(m)) {
    console.warn(
      `[devpilot-runner] refusing implausible model value ${JSON.stringify(m.slice(0, 60))} — running on the account default.`,
    );
    return [];
  }
  return ["--model", m];
}

/**
 * Does this failure look like "that model isn't available to you"?
 *
 * Deliberately NARROW. A false positive here retries a run that was going to fail
 * anyway (cheap, and the second attempt fails too). A false NEGATIVE just means we
 * surface the original error, which is the status quo. What we must not do is
 * treat a generic failure as a model problem and retry every broken run twice —
 * hence matching on model/plan wording rather than on any error at all.
 *
 * NOT overlapping with claude.ts's AUTH_FAILURE_PATTERNS on purpose: an auth or
 * quota failure means the account can't run ANY model, so dropping `--model` and
 * trying again would just burn a second failure. Those trip the circuit breaker
 * instead, and that ordering is enforced at the call site.
 */
const MODEL_UNAVAILABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /model[^.\n]{0,40}(?:not\s+(?:available|found|supported)|unavailable|unknown|invalid)/i,
  /(?:not\s+(?:available|supported)|unavailable)[^.\n]{0,40}\b(?:on|with|for)\s+your\s+(?:plan|subscription|account)/i,
  /unknown model/i,
  /invalid model/i,
  /does not have access to (?:the )?model/i,
  /upgrade (?:your plan|to \w+) to (?:use|access)/i,
];

export function isModelUnavailableError(message: string | null | undefined): boolean {
  const text = (message ?? "").trim();
  // Availability errors are short and specific; a 50KB stack trace that happens to
  // contain the word "model" is not one.
  if (text.length === 0 || text.length > 2_000) return false;
  return MODEL_UNAVAILABLE_PATTERNS.some((re) => re.test(text));
}
