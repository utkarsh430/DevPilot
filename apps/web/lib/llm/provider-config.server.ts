import "server-only";

// The provider resolver — the ONE place that turns (tenantId, projectId, role)
// into a usable LLM provider config.
//
// Two precedence chains meet here, and they are deliberately separate:
//   • PROVIDER (endpoint + credential): project » tenant » instance » env,
//     decided atomically and whole-layer by `selectProvider`.
//   • MODEL: agent+project » agent-global » project » tenant » instance » env —
//     the two AGENT rungs are resolved first (a project-scoped override row beats
//     the agent-wide default, which is an `agent_project_models` row with a NULL
//     project_id), then applied AFTER the provider is settled, by
//     `applyRoleModelOverride`, and only when its provider matches the winning
//     one. See lib/llm/role-model.ts for why that compatibility rule is
//     load-bearing rather than tidy — it applies identically to a global, which
//     is why an agent-wide Claude model on an `openai_compatible` project is
//     ignored and logged rather than forwarded into a 404.
//
// SERVER-SIDE RESOLUTION IS THE SECURITY PROPERTY, not an implementation detail.
// Every input to this function is an id the ENGINE already trusts (a run's own
// tenant_id, and the project_id reached through that run's ticket). Nothing here
// is ever read from the LOCAL_CC_QUEUE job payload, an MCP tool argument, or any
// other runner-supplied field — a runner that could name its own base_url or
// credential ref could point the platform's egress anywhere and read back the
// response. The runner is told WHAT model to run, never WHERE to send it or WITH
// WHAT KEY (and on the subscription path it isn't even told the key exists).
//
// The credential never crosses a client boundary: this module is `server-only`,
// its result is consumed by the model factory and the runner bridge, and no
// server action returns it.

import { supabaseService } from "@/lib/db/server";
import { loadProjectById } from "@/lib/projects/load";
import { getProjectSecret } from "@/lib/projects/secrets";
import { resolvePlatformSecret } from "@/lib/platform-secrets/resolver";
import {
  LLM_PROVIDER_API_KEY,
  LLM_PROVIDER_BASE_URL,
  parseCredentialRef,
} from "@/lib/llm/credential-ref";
import {
  LLM_PROVIDER_CONFIG_KEY,
  isLlmProvider,
  selectProvider,
  type LlmProvider,
  type ProviderSelection,
} from "@/lib/llm/provider";
import { applyRoleModelOverride, type RoleModelOutcome } from "@/lib/llm/role-model";
import { loadRoleModelOverride } from "@/lib/llm/role-model.server";

export type ResolvedProviderConfig = {
  provider: LlmProvider;
  /** Non-null exactly when provider === "openai_compatible" and it resolved. */
  baseUrl: string | null;
  /** The credential. NEVER log, never return from an action, never put in a
   *  prompt. Null when nothing resolved — the caller decides whether that's a
   *  hard error (it is, on the API path) or irrelevant (subscription path). */
  apiKey: string | null;
  /** Explicit model id/alias, or null = tier map / account default. */
  model: string | null;
  source: ProviderSelection["source"];
  /** What became of the winning per-agent model override (project-scoped if
   *  there is one, else the agent-wide default). `none` for every run that has
   *  neither — i.e. pre-feature behaviour, byte for byte. `shadowed` is the case
   *  a UI must not render as if it were live. */
  roleModel: RoleModelOutcome;
};

/** The tenant-level default provider (`tenants.config.llm_provider`), the same
 *  jsonb bag `llm_auth_mode` lives in. Absent → null, which lets `selectProvider`
 *  fall through to the Anthropic default. Any DB error swallows to null for the
 *  same reason `getLlmAuthMode` does: a Supabase blip must not silently reroute a
 *  tenant's traffic to a different provider. */
export async function getTenantLlmProvider(tenantId: string | null): Promise<LlmProvider | null> {
  if (!tenantId) return null;
  try {
    const { data, error } = await supabaseService()
      .from("tenants")
      .select("config")
      .eq("id", tenantId)
      .maybeSingle();
    if (error || !data) return null;
    const cfg = (data.config ?? {}) as Record<string, unknown>;
    const raw = cfg[LLM_PROVIDER_CONFIG_KEY];
    return isLlmProvider(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the provider config for a run.
 *
 * `projectId` null (a ticket-less run, a planner session with no project) simply
 * skips the project layer — everything still resolves, just from the tenant
 * default down. Such a run has no project-scoped override by construction, but
 * the AGENT-WIDE default still applies: "set it once for this agent" would not
 * be true if it silently excluded a headless /v1 call or a supervisor child.
 *
 * `role` must be an id the ENGINE already trusts, exactly like `tenantId` and
 * `projectId`: the dispatch decision's role, or the run row's own role column.
 * Never a runner-supplied or MCP-tool-supplied string — a runner that could name
 * its own role could pick whichever role has the model it would rather run on.
 */
export async function resolveLlmProviderConfig(args: {
  tenantId: string | null;
  projectId?: string | null;
  role?: string | null;
}): Promise<ResolvedProviderConfig> {
  const [project, tenantProvider, override] = await Promise.all([
    args.projectId ? loadProjectById(args.projectId).catch(() => null) : Promise.resolve(null),
    getTenantLlmProvider(args.tenantId),
    loadRoleModelOverride({
      tenantId: args.tenantId,
      projectId: args.projectId ?? null,
      role: args.role ?? null,
    }),
  ]);

  const selection = selectProvider({
    project: project
      ? {
          provider: project.llmProvider,
          baseUrl: project.llmBaseUrl,
          model: project.llmModel,
          credentialRef: project.llmCredentialRef,
        }
      : null,
    tenantProvider,
  });

  // The MODEL rung, applied to the ALREADY-DECIDED provider. Never changes the
  // provider, the endpoint or the credential — only which model runs on them.
  const { model, outcome } = applyRoleModelOverride({
    provider: selection.provider,
    projectModel: selection.model,
    override: override.override,
  });
  if (outcome.kind === "shadowed") {
    // Ignored, but never SILENTLY: this is the case where an operator set a
    // model that does not take effect, and the whole point of this feature is
    // that such a value is either honoured or visibly not honoured.
    console.warn(
      `[provider-config] tenant=${args.tenantId ?? "-"} project=${args.projectId ?? "-"} ` +
        `role=${args.role ?? "-"}: ${override.scope}-scope model override "${outcome.stored}" ` +
        `is for provider ` +
        `${outcome.storedProvider} but this project resolves to ${outcome.provider} — ` +
        `ignoring it and running on the project's own model.`,
    );
  }

  const [apiKey, baseUrl] = await Promise.all([
    resolveApiKey(selection, args.tenantId, args.projectId ?? null),
    resolveBaseUrl(selection, args.tenantId),
  ]);

  return {
    provider: selection.provider,
    baseUrl,
    apiKey,
    model,
    source: selection.source,
    roleModel: outcome,
  };
}

/**
 * The credential for the selected provider.
 *
 *   anthropic         → ANTHROPIC_API_KEY (tenant » instance » env), exactly as
 *                       today. Irrelevant on the subscription path, where the
 *                       runner authenticates with the operator's own OAuth token
 *                       and this value never leaves the engine.
 *   openai_compatible → the project's credential-ref if it has one, else the
 *                       instance-scoped LLM_PROVIDER_API_KEY. Null is legal: a
 *                       local Ollama needs no key at all.
 */
async function resolveApiKey(
  selection: ProviderSelection,
  tenantId: string | null,
  projectId: string | null,
): Promise<string | null> {
  if (selection.provider === "anthropic") {
    return (await resolvePlatformSecret("ANTHROPIC_API_KEY", { tenantId })) ?? null;
  }

  const ref = parseCredentialRef(selection.credentialRef);
  // `tenantId` is now part of the guard, not just of the call: the
  // `project_secrets` read is tenant-scoped, so without a tenant we cannot
  // authorise it and must not try. Not a behaviour change in practice — every
  // caller of `resolveLlmProviderConfig` passes a real tenant id and the
  // `| null` here is defensive typing — and where it did bind, falling through
  // to the platform/env tiers is exactly the precedence chain's existing answer
  // for "this credential did not resolve".
  if (ref?.store === "project_secret" && projectId && tenantId) {
    const value = await getProjectSecret(projectId, ref.key, tenantId);
    if (value) return value;
  }
  if (ref?.store === "platform") {
    const value = await resolvePlatformSecret(ref.key, { tenantId });
    if (value) return value;
  }
  return (await resolvePlatformSecret(LLM_PROVIDER_API_KEY, { tenantId })) ?? null;
}

/** The endpoint. Only meaningful for `openai_compatible`; `anthropic` is a fixed
 *  endpoint the SDK owns and we never override it (a project-settable Anthropic
 *  base URL would be a way to siphon the tenant's Anthropic key to a host of the
 *  operator's choosing). */
async function resolveBaseUrl(
  selection: ProviderSelection,
  tenantId: string | null,
): Promise<string | null> {
  if (selection.provider !== "openai_compatible") return null;
  if (selection.baseUrl) return selection.baseUrl;
  return (await resolvePlatformSecret(LLM_PROVIDER_BASE_URL, { tenantId })) ?? null;
}
