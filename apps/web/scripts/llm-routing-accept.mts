// LLM call-routing acceptance — pure-logic regression for the auth-mode-aware
// routing that server-side LLM features use (the JD role synthesizer, the
// suggestion rankers, text-to-SQL). No DB / env / Next.js runtime needed: it
// exercises the framework-free core in `lib/llm/routing.ts` directly.
//
// What this proves
// ────────────────
// 1. ROUTE DECISION: `claude_code` (the default, and every unrecognised
//    stored value via the normaliser) routes to the local-cc subscription
//    runner; only the explicit `api_key` mode routes to the direct API.
//    This is the fix for the live bug where Synthesize role ignored the
//    tenant's auth-mode and died on the env getter.
// 2. FRIENDLY ERRORS: every can't-proceed branch (no runner in claude_code
//    mode, no key in api_key mode, runner-infeasible feature) produces
//    actionable copy pointing at Settings → LLM auth — and NEVER the raw
//    "Missing required env var" crash text.
// 3. STRUCTURED-OUTPUT PLUMBING for the local-cc path: the JSON contract
//    sandwich embeds the schema hint + caller system prompt, and
//    `extractJsonBlock` tolerates fenced/bare/noisy replies.
//
// The server orchestration (`lib/llm/generate.server.ts`) is a thin composition
// of these pieces with `getLlmAuthMode`, `readRunnerHealth`, and the one-shot
// bridge, so exercising the core here covers the routing semantics end to end.
//
// Run: pnpm exec tsx scripts/llm-routing-accept.mts   (from apps/web)

import assert from "node:assert/strict";
import { normalizeLlmAuthMode } from "@/lib/llm/auth-mode";
import {
  apiKeyMissingError,
  buildJsonContractSystemPrompt,
  extractJsonBlock,
  featureNeedsApiKeyModeError,
  routeForAuthMode,
  runnerNotConnectedError,
} from "@/lib/llm/routing";

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${label}`);
}

// 1. Route decision — only the explicit api_key opt-out leaves the runner.
check("claude_code → local_cc", () => assert.equal(routeForAuthMode("claude_code"), "local_cc"));
check("api_key → direct_api", () => assert.equal(routeForAuthMode("api_key"), "direct_api"));
check("absent stored mode → local_cc (fresh install runs on the runner)", () =>
  assert.equal(routeForAuthMode(normalizeLlmAuthMode(undefined)), "local_cc"),
);
check("unrecognised stored mode → local_cc", () =>
  assert.equal(routeForAuthMode(normalizeLlmAuthMode("apikey")), "local_cc"),
);

// 2. Friendly errors — actionable, and never the raw env crash.
const RAW_CRASH = "Missing required env var";
const errors = [
  runnerNotConnectedError("Role synthesis"),
  apiKeyMissingError("Role synthesis"),
  featureNeedsApiKeyModeError("Natural-language querying (smart mode)"),
];
check("every error points at Settings → LLM auth", () => {
  for (const e of errors) assert.match(e, /Settings → LLM auth/);
});
check("no error leaks the raw env-var crash text", () => {
  for (const e of errors) assert.equal(e.includes(RAW_CRASH), false);
});
check("runner error names the feature and the runner", () => {
  const e = runnerNotConnectedError("Role synthesis");
  assert.match(e, /^Role synthesis/);
  assert.match(e, /runner/);
  assert.match(e, /isn't connected/);
});
check("api-key error names the feature and the missing key", () => {
  const e = apiKeyMissingError("Role synthesis");
  assert.match(e, /^Role synthesis/);
  assert.match(e, /ANTHROPIC_API_KEY/);
});

// 3a. JSON contract sandwich — schema hint + caller system prompt embedded,
//     contract framing at head AND tail (the classifier-proven pattern).
check("contract sandwich embeds schema hint and system prompt", () => {
  const out = buildJsonContractSystemPrompt("You are a role designer.", '{"slug":"<x>"}');
  assert.match(out, /^# CRITICAL OUTPUT CONTRACT/);
  assert.ok(out.includes('{"slug":"<x>"}'));
  assert.ok(out.includes("You are a role designer."));
  assert.match(out, /Reply format reminder/);
});

// 3b. extractJsonBlock — the local-cc reply parser.
check("parses a bare JSON object", () => assert.deepEqual(extractJsonBlock('{"a":1}'), { a: 1 }));
check("parses a ```json fenced block", () =>
  assert.deepEqual(extractJsonBlock('prose\n```json\n{"a":1}\n```\nmore'), { a: 1 }),
);
check("parses braces surrounded by prose", () =>
  assert.deepEqual(extractJsonBlock('Sure! Here it is: {"a":{"b":2}} Hope that helps.'), {
    a: { b: 2 },
  }),
);
check("returns null on no JSON", () => assert.equal(extractJsonBlock("no json here"), null));
check("returns null on empty input", () => assert.equal(extractJsonBlock(""), null));
check("returns null on malformed JSON", () =>
  assert.equal(extractJsonBlock('{"a":unterminated'), null),
);

console.log(`\n${passed} checks passed.`);
