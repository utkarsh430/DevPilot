// LLM auth-mode acceptance — pure-logic regression for the resolver default and
// the health-check mode-awareness. No DB / env / Next.js runtime needed: it
// exercises the framework-free core in `lib/llm/auth-mode.ts` directly, so it
// runs anywhere.
//
// What this proves
// ────────────────
// 1. RESOLVER DEFAULT: an absent / null / "" / unrecognised stored value
//    resolves to `claude_code` — a fresh install is Claude Code auth with zero
//    config, and only the exact string "api_key" opts out.
// 2. HEALTH MODE-AWARENESS: the ANTHROPIC_API_KEY check applies ONLY in
//    `api_key` mode. Under the default `claude_code` mode it does not apply, so
//    a missing key must never surface as "down".
//
// The DB-backed `getLlmAuthMode` (auth-mode.server.ts) is a thin read that maps
// `tenants.config.llm_auth_mode` through `normalizeLlmAuthMode`, so exercising
// the normaliser here covers its resolution semantics end to end.
//
// Run: pnpm exec tsx scripts/authmode-accept.mts   (from apps/web)

import assert from "node:assert/strict";
import {
  DEFAULT_LLM_AUTH_MODE,
  LLM_AUTH_MODES,
  apiKeyCheckAppliesForMode,
  normalizeLlmAuthMode,
} from "@/lib/llm/auth-mode";

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${label}`);
}

// 1. Resolver default — everything that isn't exactly "api_key" is claude_code.
check("default is claude_code", () => assert.equal(DEFAULT_LLM_AUTH_MODE, "claude_code"));
check("undefined → claude_code", () =>
  assert.equal(normalizeLlmAuthMode(undefined), "claude_code"),
);
check("null → claude_code", () => assert.equal(normalizeLlmAuthMode(null), "claude_code"));
check("empty string → claude_code", () => assert.equal(normalizeLlmAuthMode(""), "claude_code"));
check("empty config object key → claude_code", () =>
  assert.equal(normalizeLlmAuthMode(({} as Record<string, unknown>).llm_auth_mode), "claude_code"),
);
check("legacy / typo value → claude_code", () =>
  assert.equal(normalizeLlmAuthMode("apikey"), "claude_code"),
);
check("explicit claude_code → claude_code", () =>
  assert.equal(normalizeLlmAuthMode("claude_code"), "claude_code"),
);
check("explicit api_key → api_key (only opt-out)", () =>
  assert.equal(normalizeLlmAuthMode("api_key"), "api_key"),
);

// 2. Health-check mode awareness.
check("api-key check does NOT apply in claude_code mode", () =>
  assert.equal(apiKeyCheckAppliesForMode("claude_code"), false),
);
check("api-key check applies in api_key mode", () =>
  assert.equal(apiKeyCheckAppliesForMode("api_key"), true),
);

// Guard against the enum silently growing without this test being updated.
check("exactly two modes exist", () =>
  assert.deepEqual([...LLM_AUTH_MODES].sort(), ["api_key", "claude_code"]),
);

console.log(`\n${passed} checks passed.`);
