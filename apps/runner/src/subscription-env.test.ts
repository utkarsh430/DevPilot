// Credential isolation on the subscription `claude -p` spawn (security criterion 1).
//
// The regression these tests exist to prevent is LIVE, not hypothetical: the
// per-project vault was spread into `envOverrides` with no key-name filter, and
// `envOverrides` is spread LAST into the spawn env — so it WON over the
// `delete procEnv.ANTHROPIC_API_KEY` that the subscription guarantee depends on.
// A project secret named ANTHROPIC_API_KEY silently moved the tenant onto
// per-token billing; one named ANTHROPIC_BASE_URL redirected the agent's entire
// conversation (prompts, repo contents, the OAuth token in the Authorization
// header) to a host of the writer's choosing.
//
// Run: tsx src/subscription-env.test.ts

import assert from "node:assert/strict";
import {
  SUBSCRIPTION_BLOCKED_ENV_KEYS,
  buildSubscriptionEnvOverrides,
  isBlockedSubscriptionEnvKey,
  parseSecretsForEnvOverrides,
  sanitizeSubscriptionEnvOverrides,
} from "./subscription-env.js";

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("subscription-env — credential isolation");

test("a project secret named ANTHROPIC_API_KEY does NOT reach the spawn env", () => {
  const env = buildSubscriptionEnvOverrides({
    runId: "run-1",
    tenantId: "tenant-1",
    qaVerifyEnabled: false,
    runnerConfig: {},
    projectSecretsJson: JSON.stringify({
      ANTHROPIC_API_KEY: "sk-ant-stolen",
      DATABASE_URL: "postgres://localhost/app",
    }),
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "the stripped key must not be re-injected");
  // …while an ordinary project secret still gets through: the filter is a deny
  // list on a subscription spawn, not a blanket refusal to pass secrets.
  assert.equal(env.DATABASE_URL, "postgres://localhost/app");
});

test("the NEW provider key (DEVPILOT_LLM_API_KEY) does NOT reach the spawn env either", () => {
  const env = buildSubscriptionEnvOverrides({
    runId: "run-1",
    tenantId: "tenant-1",
    qaVerifyEnabled: false,
    runnerConfig: {},
    projectSecretsJson: JSON.stringify({
      DEVPILOT_LLM_API_KEY: "sk-provider-key",
      LLM_PROVIDER_API_KEY: "sk-instance-key",
      LLM_PROVIDER_BASE_URL: "https://evil.example.com/v1",
    }),
  });
  assert.equal(env.DEVPILOT_LLM_API_KEY, undefined);
  assert.equal(env.LLM_PROVIDER_API_KEY, undefined);
  assert.equal(env.LLM_PROVIDER_BASE_URL, undefined);
});

test("ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN can't redirect or re-auth the agent", () => {
  const env = buildSubscriptionEnvOverrides({
    runId: "run-1",
    tenantId: "tenant-1",
    qaVerifyEnabled: false,
    runnerConfig: {},
    projectSecretsJson: JSON.stringify({
      ANTHROPIC_BASE_URL: "https://attacker.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-ant-oauth-shaped",
    }),
  });
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("the filter is case-insensitive — a lower-cased name is the same env var", () => {
  const env = buildSubscriptionEnvOverrides({
    runId: "run-1",
    tenantId: "tenant-1",
    qaVerifyEnabled: false,
    runnerConfig: {},
    projectSecretsJson: JSON.stringify({ anthropic_api_key: "sk-ant-lowercase" }),
  });
  assert.equal(env.anthropic_api_key, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("no layer can smuggle a blocked name in — not even the engine-fetched tenant config", () => {
  const env = buildSubscriptionEnvOverrides({
    runId: "run-1",
    tenantId: "tenant-1",
    qaVerifyEnabled: false,
    // runnerConfigEnvOverrides() excludes it by construction today, but the filter
    // must not RELY on that — a future key added to the fetch list would otherwise
    // re-open the hole silently.
    runnerConfig: { ANTHROPIC_API_KEY: "sk-ant-from-config", ENGINEER_QA_COMMAND: "pnpm test" },
    projectSecretsJson: null,
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ENGINEER_QA_COMMAND, "pnpm test");
});

test("the run-scoping vars the MCP relay depends on still arrive intact", () => {
  const env = buildSubscriptionEnvOverrides({
    runId: "run-9",
    tenantId: "tenant-9",
    ticketId: "ticket-9",
    role: "engineer",
    workspacePath: "/ws/ticket-1",
    baseSha: "abc123",
    qaVerifyEnabled: true,
    runnerConfig: { ENGINEER_BUILD_COMMAND: "pnpm build" },
    projectSecretsJson: null,
  });
  assert.equal(env.DEVPILOT_RUN_ID, "run-9");
  assert.equal(env.DEVPILOT_TENANT_ID, "tenant-9");
  // WI-14 — `devpilot_create_ticket` scopes the new ticket off this id server-side.
  assert.equal(env.DEVPILOT_TICKET_ID, "ticket-9");
  assert.equal(env.DEVPILOT_ROLE, "engineer");
  assert.equal(env.DEVPILOT_WORKSPACE_PATH, "/ws/ticket-1");
  assert.equal(env.DEVPILOT_BASE_SHA, "abc123");
  assert.equal(env.ENGINEER_QA_VERIFY_ENABLED, "1");
  assert.equal(env.ENGINEER_BUILD_COMMAND, "pnpm build");
});

test("a project secret still wins over the tenant default (the documented precedence)", () => {
  const env = buildSubscriptionEnvOverrides({
    runId: "run-1",
    tenantId: "tenant-1",
    qaVerifyEnabled: false,
    runnerConfig: { ENGINEER_QA_COMMAND: "tenant-level" },
    projectSecretsJson: JSON.stringify({ ENGINEER_QA_COMMAND: "project-level" }),
  });
  assert.equal(env.ENGINEER_QA_COMMAND, "project-level");
});

test("malformed / absent secrets payloads degrade to an empty map, never a throw", () => {
  assert.deepEqual(parseSecretsForEnvOverrides(null), {});
  assert.deepEqual(parseSecretsForEnvOverrides("not json"), {});
  assert.deepEqual(parseSecretsForEnvOverrides('{"A": 1, "B": null}'), {});
  assert.deepEqual(parseSecretsForEnvOverrides('{"A": "1"}'), { A: "1" });
});

test("sanitize is idempotent and leaves innocent keys alone", () => {
  const once = sanitizeSubscriptionEnvOverrides({ FOO: "1", ANTHROPIC_API_KEY: "x" });
  assert.deepEqual(once, { FOO: "1" });
  assert.deepEqual(sanitizeSubscriptionEnvOverrides(once), { FOO: "1" });
});

test("every documented blocked name is actually blocked", () => {
  for (const key of SUBSCRIPTION_BLOCKED_ENV_KEYS) {
    assert.ok(isBlockedSubscriptionEnvKey(key), `${key} should be blocked`);
  }
  assert.equal(isBlockedSubscriptionEnvKey("DATABASE_URL"), false);
  // A project's own OpenAI key is NOT blocked from its workspace .env.local — but
  // it has no business on the agent spawn, so it is blocked here.
  assert.ok(isBlockedSubscriptionEnvKey("LLM_PROVIDER_API_KEY"));
});

if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
