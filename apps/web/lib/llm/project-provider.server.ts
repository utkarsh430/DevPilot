import "server-only";

// The ONE validation path for a project's LLM provider config, shared by every
// write surface (the new-project forms and the project settings card).
//
// It exists so the SSRF check cannot be forgotten by a future write path: any
// code that wants to put a provider on a projects row asks this module for the
// columns, and this module refuses to produce them for a base URL it wouldn't
// dereference. A second write path that hand-rolled its own checks is exactly how
// an SSRF guard rots.

import { validateLlmBaseUrl } from "@/lib/llm/base-url.server";
import type { LlmProvider } from "@/lib/llm/provider";

export type ProviderFormInput = {
  /** null = clear any project override and inherit (tenant » instance » env). */
  provider: LlmProvider | null;
  baseUrl: string | null;
  model: string | null;
};

/** The projects-row columns. `llm_credential_ref` is NOT here — the credential is
 *  a separate concern with a separate store, and the caller wires it after the
 *  row exists (a create has no project id to key the vault by until it does). */
export type ProviderColumns = {
  llm_provider: LlmProvider | null;
  llm_base_url: string | null;
  llm_model: string | null;
};

export type ProviderValidation =
  | { ok: true; columns: ProviderColumns }
  | { ok: false; error: string };

export async function validateProviderConfig(
  input: ProviderFormInput,
): Promise<ProviderValidation> {
  const baseUrl = trimToNull(input.baseUrl);
  const model = trimToNull(input.model);

  if (input.provider === null) {
    if (baseUrl || model) {
      return {
        ok: false,
        error: "Pick a provider before setting a base URL or model, or clear both to inherit.",
      };
    }
    return { ok: true, columns: { llm_provider: null, llm_base_url: null, llm_model: null } };
  }

  if (input.provider === "anthropic") {
    // No custom endpoint, ever. A project-settable Anthropic base URL would let
    // whoever sets it siphon the tenant's Anthropic credential (and every prompt
    // the agents send) to a host of their choosing, and there is no legitimate use
    // for it — the Anthropic endpoint is fixed.
    if (baseUrl) {
      return {
        ok: false,
        error:
          "The Anthropic provider has a fixed endpoint — a custom base URL isn't accepted for it.",
      };
    }
    return {
      ok: true,
      columns: { llm_provider: "anthropic", llm_base_url: null, llm_model: model },
    };
  }

  // openai_compatible — the SSRF-relevant branch.
  if (!baseUrl) {
    return {
      ok: false,
      error: "An OpenAI-compatible provider needs a base URL (e.g. https://api.example.com/v1).",
    };
  }
  if (!model) {
    return {
      ok: false,
      error:
        "Name the model your endpoint serves (e.g. `llama3.1:70b`) — an OpenAI-compatible endpoint has no default we can guess.",
    };
  }
  // REJECT ON WRITE: https-only, no credentials-in-URL, and the host is RESOLVED
  // with every returned address required to be public unicast. Nothing that fails
  // here reaches the database, so there is no stored-bad-value case for a future
  // caller to trip over.
  const safe = await validateLlmBaseUrl(baseUrl);
  if (!safe.ok) return { ok: false, error: safe.message };

  return {
    ok: true,
    columns: {
      llm_provider: "openai_compatible",
      llm_base_url: safe.normalized,
      llm_model: model,
    },
  };
}

function trimToNull(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length === 0 ? null : s;
}
