// Agent-shared platform secrets — the guards, as refusals.
//
// The load-bearing assertion of the whole feature is the FIRST describe block:
// an unmarked platform secret does not reach an agent. If someone later flips
// the default to "share everything unless opted out", these fail loudly.

import { describe, expect, it } from "vitest";

import {
  AGENT_ENV_DENY_KEYS,
  agentShareablePlatformKeys,
  isAgentEnvDenied,
  isAgentShareableEntry,
  isAgentShareableKey,
  mergeAgentSecretsJson,
  type PlatformSecretResolve,
  resolveSharedPlatformSecrets,
} from "@/lib/platform-secrets/agent-shared";
import { PLATFORM_SECRET_CATALOG } from "@/lib/platform-secrets/catalog";
import { SUBSCRIPTION_BLOCKED_ENV_KEYS } from "../../../../runner/src/subscription-env";

describe("default is OFF — an unmarked platform secret never reaches an agent", () => {
  // Named explicitly rather than derived: this list is the reason the feature is
  // per-key opt-in, and naming them is what makes a regression legible.
  const MUST_NEVER_BE_SHARED = [
    "ANTHROPIC_API_KEY",
    "SUPABASE_SECRET_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "UPSTASH_REDIS_REST_TOKEN",
    "INNGEST_SIGNING_KEY",
    "INNGEST_EVENT_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "DEVPILOT_RUNNER_REGISTRATION_KEY",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "VERCEL_OAUTH_CLIENT_SECRET",
    "LANGFUSE_SECRET_KEY",
  ];

  it.each(MUST_NEVER_BE_SHARED)("%s is not shareable", (key) => {
    expect(isAgentShareableKey(key)).toBe(false);
    expect(agentShareablePlatformKeys()).not.toContain(key);
  });

  it("VERCEL_TOKEN is the ONLY shared key", () => {
    // Adding a second key here should be a deliberate decision with its own
    // justification in the PR — this assertion makes that unavoidable.
    expect(agentShareablePlatformKeys()).toEqual(["VERCEL_TOKEN"]);
  });

  it("every other catalog entry leaves the flag unset", () => {
    const flagged = PLATFORM_SECRET_CATALOG.filter((e) => e.shareWithAgents === true).map(
      (e) => e.key,
    );
    expect(flagged).toEqual(["VERCEL_TOKEN"]);
  });

  it("an unknown key is not shareable", () => {
    expect(isAgentShareableKey("SOME_KEY_NOT_IN_THE_CATALOG")).toBe(false);
  });
});

describe("the blocklist beats the flag — eligibility is not delivery", () => {
  it("web mirror stays in lockstep with the runner deny list", () => {
    // Drift in the safe direction (extra names here) is fine; a name the runner
    // blocks and this list does not is what must never happen.
    for (const key of SUBSCRIPTION_BLOCKED_ENV_KEYS) {
      expect(AGENT_ENV_DENY_KEYS).toContain(key);
    }
  });

  it("a blocklisted key is refused even when EXPLICITLY marked shareable", () => {
    // THE assertion for guard #3. It goes through `isAgentShareableEntry` rather
    // than the catalog lookup on purpose: every blocklisted key is already
    // unflagged in the real catalog, so asserting `isAgentShareableKey(...) ===
    // false` there would pass on the flag alone and prove nothing about the deny
    // list. Here the entry IS marked shareable — exactly what a future
    // maintainer would do — and the deny list still refuses it.
    for (const key of AGENT_ENV_DENY_KEYS) {
      expect(isAgentEnvDenied(key)).toBe(true);
      expect(isAgentShareableEntry({ key, shareWithAgents: true })).toBe(false);
    }
    // Sanity: the same shape with a non-blocked name IS accepted, so the
    // assertion above is refusing on the deny list and not on something else.
    expect(isAgentShareableEntry({ key: "SOME_HARMLESS_KEY", shareWithAgents: true })).toBe(true);
  });

  it("the same key is refused through the catalog path too", () => {
    for (const key of AGENT_ENV_DENY_KEYS) {
      expect(isAgentShareableKey(key)).toBe(false);
    }
  });

  it("a blocklisted key is stripped from the merged payload even if resolved", () => {
    // The deny list is re-asserted at merge time, so a blocked value cannot ride
    // in via a caller that selected it some other way.
    const json = mergeAgentSecretsJson({
      sharedPlatform: { ANTHROPIC_API_KEY: "sk-leak", VERCEL_TOKEN: "vt_ok" },
      projectSecretsJson: null,
    });
    expect(JSON.parse(json!)).toEqual({ VERCEL_TOKEN: "vt_ok" });
    expect(json).not.toContain("sk-leak");
  });

  it("case-insensitively — a lower-cased blocked name is still blocked", () => {
    expect(isAgentEnvDenied("anthropic_api_key")).toBe(true);
    const json = mergeAgentSecretsJson({
      sharedPlatform: { anthropic_api_key: "sk-leak" },
      projectSecretsJson: null,
    });
    expect(json).toBeNull();
  });
});

describe("precedence — project vault wins over the shared default", () => {
  it("a project value overrides the shared one", () => {
    const json = mergeAgentSecretsJson({
      sharedPlatform: { VERCEL_TOKEN: "shared" },
      projectSecretsJson: JSON.stringify({ VERCEL_TOKEN: "project" }),
    });
    expect(JSON.parse(json!)).toEqual({ VERCEL_TOKEN: "project" });
  });

  it("the shared value fills in when the project does not define the key", () => {
    const json = mergeAgentSecretsJson({
      sharedPlatform: { VERCEL_TOKEN: "shared" },
      projectSecretsJson: JSON.stringify({ DATABASE_URL: "postgres://x" }),
    });
    expect(JSON.parse(json!)).toEqual({ VERCEL_TOKEN: "shared", DATABASE_URL: "postgres://x" });
  });

  it("an empty shared value never shadows anything", () => {
    const json = mergeAgentSecretsJson({
      sharedPlatform: { VERCEL_TOKEN: "" },
      projectSecretsJson: null,
    });
    expect(json).toBeNull();
  });

  it("no shared secrets and no project secrets is null, the runner's legacy path", () => {
    expect(mergeAgentSecretsJson({ sharedPlatform: {}, projectSecretsJson: null })).toBeNull();
  });

  it("unparseable project JSON does not discard the shared layer", () => {
    const json = mergeAgentSecretsJson({
      sharedPlatform: { VERCEL_TOKEN: "shared" },
      projectSecretsJson: "{not json",
    });
    expect(JSON.parse(json!)).toEqual({ VERCEL_TOKEN: "shared" });
  });
});

describe("tenant scoping — a shared secret is resolved for the RUN's tenant only", () => {
  const OURS = "tenant-a";
  const THEIRS = "tenant-b";

  /** Store shaped like the real platform_secrets table: rows keyed by
   *  (tenant_id, secret_key), with tenant_id NULL meaning the instance default. */
  const rows: Array<{ tenantId: string | null; key: string; value: string }> = [
    { tenantId: OURS, key: "VERCEL_TOKEN", value: "ours" },
    { tenantId: THEIRS, key: "VERCEL_TOKEN", value: "theirs" },
  ];

  /** Fake resolver that ACTUALLY applies the tenant predicate — a fake that
   *  ignored it would make every assertion below vacuous. */
  const scopedResolve: PlatformSecretResolve = async (key, { tenantId }) =>
    rows.find((r) => r.key === key && r.tenantId === tenantId)?.value;

  /** CONTROL: the same fake with the tenant predicate NEUTERED. It must produce
   *  a visibly different (wrong) answer, proving the assertion has teeth. */
  const unscopedResolve: PlatformSecretResolve = async (key) =>
    rows.find((r) => r.key === key)?.value;

  it("resolves this tenant's value, never another tenant's", async () => {
    await expect(resolveSharedPlatformSecrets(OURS, scopedResolve)).resolves.toEqual({
      VERCEL_TOKEN: "ours",
    });
    await expect(resolveSharedPlatformSecrets(THEIRS, scopedResolve)).resolves.toEqual({
      VERCEL_TOKEN: "theirs",
    });
  });

  it("CONTROL — dropping the tenant predicate leaks the wrong tenant's value", async () => {
    await expect(resolveSharedPlatformSecrets(THEIRS, unscopedResolve)).resolves.toEqual({
      VERCEL_TOKEN: "ours",
    });
  });

  it("passes the run's tenant and nothing else to the resolver", async () => {
    const seen: Array<{ key: string; tenantId: string | null }> = [];
    await resolveSharedPlatformSecrets(OURS, async (key, opts) => {
      seen.push({ key, tenantId: opts.tenantId });
      return undefined;
    });
    expect(seen).toEqual([{ key: "VERCEL_TOKEN", tenantId: OURS }]);
  });

  it("never asks for an unshared key", async () => {
    const asked: string[] = [];
    await resolveSharedPlatformSecrets(OURS, async (key) => {
      asked.push(key);
      return "value";
    });
    expect(asked).not.toContain("ANTHROPIC_API_KEY");
    expect(asked).not.toContain("SUPABASE_SECRET_KEY");
    expect(asked).not.toContain("STRIPE_SECRET_KEY");
  });

  it("a throwing resolver drops the key rather than failing the dispatch", async () => {
    await expect(
      resolveSharedPlatformSecrets(OURS, async () => {
        throw new Error("db down");
      }),
    ).resolves.toEqual({});
  });
});
