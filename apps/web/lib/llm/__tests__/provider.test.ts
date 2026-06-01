// Provider selection, the `--model` default-OFF contract + safe fallback, the
// credential-ref grammar, and the routing rule that keeps the subscription runner
// Anthropic-only.

import { describe, expect, it } from "vitest";
import { MODEL_IDS } from "@/lib/llm/models";
import {
  normalizeLlmProvider,
  providerSupportsLocalCc,
  resolveApiModelId,
  resolveClaudeModelArg,
  selectProvider,
} from "@/lib/llm/provider";
import { decideRunnerPolicy, routeForProvider } from "@/lib/llm/routing";
import { parseCredentialRef, PROJECT_VAULT_REF } from "@/lib/llm/credential-ref";

describe("normalizeLlmProvider", () => {
  it("only an exact 'openai_compatible' opts out of the Anthropic default", () => {
    expect(normalizeLlmProvider("openai_compatible")).toBe("openai_compatible");
    for (const junk of [null, undefined, "", "openai", "OPENAI_COMPATIBLE", "ollama", 7]) {
      expect(normalizeLlmProvider(junk)).toBe("anthropic");
    }
  });
});

describe("resolveClaudeModelArg — DEFAULT-OFF is the contract", () => {
  it("emits NO model when nothing is configured (today's exact behaviour)", () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(resolveClaudeModelArg(v)).toEqual({
        kind: "account_default",
        reason: "not_configured",
      });
    }
  });

  it("passes through a recognised alias or pinned id", () => {
    expect(resolveClaudeModelArg("sonnet")).toEqual({ kind: "explicit", model: "sonnet" });
    expect(resolveClaudeModelArg(MODEL_IDS.heavy)).toEqual({
      kind: "explicit",
      model: MODEL_IDS.heavy,
    });
  });

  it("SAFE FALLBACK: an unrecognised model drops to the account default, never a hard failure", () => {
    // Including the shapes an attacker would try — the value reaches a subprocess argv.
    for (const bogus of [
      "gpt-4o",
      "--dangerously-skip-permissions",
      "sonnet; rm -rf /",
      "sonnet --verbose",
    ]) {
      expect(resolveClaudeModelArg(bogus).kind, bogus).toBe("account_default");
    }
    expect(resolveClaudeModelArg("gpt-4o")).toMatchObject({
      reason: "unrecognised_model",
      rejected: "gpt-4o",
    });
  });

  it("surrounding whitespace is trimmed, not treated as a different model", () => {
    expect(resolveClaudeModelArg("  opus  ")).toEqual({ kind: "explicit", model: "opus" });
  });
});

describe("resolveApiModelId", () => {
  it("anthropic falls back to the tier map when no model is configured", () => {
    expect(resolveApiModelId("anthropic", "cheap", null)).toBe(MODEL_IDS.cheap);
    expect(resolveApiModelId("anthropic", "heavy", null)).toBe(MODEL_IDS.heavy);
  });

  it("anthropic honours a recognised pinned id, but a CLI alias falls back (the API needs a concrete id)", () => {
    expect(resolveApiModelId("anthropic", "cheap", MODEL_IDS.heavy)).toBe(MODEL_IDS.heavy);
    expect(resolveApiModelId("anthropic", "cheap", "sonnet")).toBe(MODEL_IDS.cheap);
    expect(resolveApiModelId("anthropic", "cheap", "made-up")).toBe(MODEL_IDS.cheap);
  });

  it("openai_compatible uses the configured model for every tier, and null without one", () => {
    expect(resolveApiModelId("openai_compatible", "heavy", "llama3.1:70b")).toBe("llama3.1:70b");
    expect(resolveApiModelId("openai_compatible", "cheap", "llama3.1:70b")).toBe("llama3.1:70b");
    expect(resolveApiModelId("openai_compatible", "default", null)).toBeNull();
  });
});

describe("selectProvider — precedence project » tenant » default", () => {
  const openaiProject = {
    provider: "openai_compatible" as const,
    baseUrl: "https://llm.example.com/v1",
    model: "llama3.1:70b",
    credentialRef: PROJECT_VAULT_REF,
  };

  it("a project override wins outright", () => {
    expect(selectProvider({ project: openaiProject, tenantProvider: "anthropic" })).toMatchObject({
      provider: "openai_compatible",
      baseUrl: "https://llm.example.com/v1",
      source: "project",
    });
  });

  it("falls through to the tenant default when the project doesn't choose", () => {
    expect(
      selectProvider({
        project: { provider: null, baseUrl: null, model: null, credentialRef: null },
        tenantProvider: "openai_compatible",
      }),
    ).toMatchObject({ provider: "openai_compatible", source: "tenant" });
  });

  it("defaults to anthropic when nothing is configured anywhere", () => {
    expect(selectProvider({})).toMatchObject({ provider: "anthropic", source: "default" });
  });

  it("an anthropic project can never carry a base URL, even if the row somehow has one", () => {
    // Defence in depth against a hand-edited row: a project-settable Anthropic
    // endpoint would be a way to siphon the tenant's Anthropic key.
    const selection = selectProvider({
      project: {
        provider: "anthropic",
        baseUrl: "https://evil.example.com",
        model: null,
        credentialRef: null,
      },
    });
    expect(selection.baseUrl).toBeNull();
  });
});

describe("routing — the subscription runner stays Anthropic-only", () => {
  it("openai_compatible FORCES the API path regardless of auth-mode", () => {
    expect(routeForProvider("claude_code", "openai_compatible")).toBe("direct_api");
    expect(routeForProvider("api_key", "openai_compatible")).toBe("direct_api");
    expect(decideRunnerPolicy("claude_code", "openai_compatible")).toBe("api");
  });

  it("anthropic leaves today's auth-mode routing completely untouched", () => {
    expect(routeForProvider("claude_code", "anthropic")).toBe("local_cc");
    expect(routeForProvider("api_key", "anthropic")).toBe("direct_api");
    expect(decideRunnerPolicy("claude_code", "anthropic")).toBe("local-cc");
    expect(decideRunnerPolicy("api_key", "anthropic")).toBe("api");
  });

  it("only Anthropic can ride local-cc", () => {
    expect(providerSupportsLocalCc("anthropic")).toBe(true);
    expect(providerSupportsLocalCc("openai_compatible")).toBe(false);
  });
});

describe("parseCredentialRef — the ref is a NAME, never a value", () => {
  it("parses the two supported stores", () => {
    expect(parseCredentialRef("project_secret:DEVPILOT_LLM_API_KEY")).toEqual({
      store: "project_secret",
      key: "DEVPILOT_LLM_API_KEY",
    });
    expect(parseCredentialRef("platform:LLM_PROVIDER_API_KEY")).toEqual({
      store: "platform",
      key: "LLM_PROVIDER_API_KEY",
    });
  });

  it("returns null for an unknown store or a malformed key rather than guessing", () => {
    for (const junk of [
      null,
      "",
      "DEVPILOT_LLM_API_KEY",
      "file:/etc/passwd",
      "project_secret:",
      "project_secret:lower_case",
      "project_secret:HAS SPACE",
      "s3://bucket/key",
    ]) {
      expect(parseCredentialRef(junk), String(junk)).toBeNull();
    }
  });
});
