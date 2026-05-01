"use server";

// WI-12 — per-project LLM provider settings.
//
// This is the ONLY write path for `projects.llm_provider` / `llm_base_url` /
// `llm_credential_ref` / `llm_model`. No agent, MCP tool, runner route, or engine
// path writes these columns — the same shape as the safety-critical flag and the
// auto-land opt-in, and for the same reason: an agent that could set its own base
// URL could redirect the platform's egress, and one that could set its own
// credential ref could point at a key it shouldn't read.
//
// THREE THINGS THIS ACTION IS RESPONSIBLE FOR:
//
//   1. SSRF — the base URL is DNS-validated before it is allowed to persist
//      (`validateLlmBaseUrl`: https-only, no credentials-in-URL, and every
//      resolved address must be public unicast). Rejecting on WRITE is what makes
//      "a bad base_url can never be in the table" a true statement rather than a
//      hope; the call-time re-check in the provider factory then covers the DNS
//      record that turns malicious afterwards.
//
//   2. CREDENTIAL STORAGE — the API key the operator pastes goes into the
//      per-project AES-256-GCM vault (`project_secrets`), and the projects row
//      gets an opaque REF to it, never the value. The key is never returned from
//      this action, never rendered, and never logged; the UI only ever learns
//      whether one is configured.
//
//   3. AUDIT — changing where a project's agents send their prompts is an
//      elevated action, so every accepted change logs actor + project + the OLD
//      and NEW host. Hosts, not URLs-with-paths, and never the key.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { loadProjectById } from "@/lib/projects/load";
import { deleteProjectSecret, setProjectSecret } from "@/lib/projects/secrets";
import { validateProviderConfig } from "@/lib/llm/project-provider.server";
import { PROJECT_LLM_API_KEY, PROJECT_VAULT_REF } from "@/lib/llm/credential-ref";
import { type LlmProvider } from "@/lib/llm/provider-form";
import { SetProjectLlmProviderSchema } from "./llm-provider-schema";

export type SetProjectLlmProviderInput = z.input<typeof SetProjectLlmProviderSchema>;
export type SetProjectLlmProviderResult =
  | { ok: true; provider: LlmProvider | null; baseUrl: string | null }
  | { ok: false; error: string };

export async function setProjectLlmProviderAction(
  input: SetProjectLlmProviderInput,
): Promise<SetProjectLlmProviderResult> {
  const user = await requireUser();
  const callerTenantId = await requireTenantId();

  const parsed = SetProjectLlmProviderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { projectId, provider } = parsed.data;

  const project = await loadProjectById(projectId);
  if (!project) return { ok: false, error: "Project not found." };
  if (project.tenantId !== callerTenantId) {
    return { ok: false, error: "Project does not belong to your tenant." };
  }

  // An edit may leave the base URL alone (the operator is only rotating the key,
  // say), so an omitted value inherits the stored one — and then goes through the
  // SAME validator anyway. Re-validating a URL we previously accepted is not
  // wasted work: it re-resolves the host, which is the whole point of the
  // call-time half of the rebinding defence.
  const baseUrl = emptyToNull(parsed.data.baseUrl) ?? project.llmBaseUrl;
  const model = emptyToNull(parsed.data.model) ?? project.llmModel;

  const validated = await validateProviderConfig({
    provider,
    baseUrl: provider === "openai_compatible" ? baseUrl : null,
    model,
  });
  if (!validated.ok) return { ok: false, error: validated.error };
  const columns = validated.columns;

  // The credential. `undefined` = leave whatever is stored alone (so the operator
  // can edit the URL without re-pasting the secret); a value = replace it; "" or
  // null = clear it. The key goes to the encrypted per-project vault and the row
  // gets an opaque pointer — never the value.
  let credentialRef: string | null = project.llmCredentialRef;
  const apiKey = parsed.data.apiKey;
  if (provider === null) {
    // Inheriting again: drop the vault entry too. Holding an encrypted provider
    // key for a project that no longer uses one is a credential we're keeping for
    // no reason.
    await deleteProjectSecret({
      projectId,
      tenantId: callerTenantId,
      secretKey: PROJECT_LLM_API_KEY,
    }).catch(() => {});
    credentialRef = null;
  } else if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    try {
      await setProjectSecret({
        projectId,
        secretKey: PROJECT_LLM_API_KEY,
        value: apiKey.trim(),
        userId: user.id,
      });
    } catch (err) {
      // The vault throws when SECRETS_ENCRYPTION_KEY is missing/invalid. Refusing
      // is right: the alternative is persisting a provider config whose credential
      // silently didn't save, and discovering that at dispatch time.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Couldn't store the API key: ${message}` };
    }
    credentialRef = PROJECT_VAULT_REF;
  } else if (apiKey === "" || apiKey === null) {
    await deleteProjectSecret({
      projectId,
      tenantId: callerTenantId,
      secretKey: PROJECT_LLM_API_KEY,
    }).catch(() => {});
    credentialRef = null;
  }

  const { error } = await supabaseService()
    .from("projects")
    .update({ ...columns, llm_credential_ref: credentialRef })
    .eq("id", projectId);
  if (error) return { ok: false, error: `Failed to save: ${error.message}` };

  auditProviderChange({
    userId: user.id,
    projectId,
    from: { provider: project.llmProvider, baseUrl: project.llmBaseUrl },
    to: { provider: columns.llm_provider, baseUrl: columns.llm_base_url },
  });
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, provider: columns.llm_provider, baseUrl: columns.llm_base_url };
}

function emptyToNull(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length === 0 ? null : s;
}

/** Elevated-action audit line. HOSTS only — a full URL can carry a path that
 *  identifies a tenant on a shared gateway, and the credential never appears here
 *  at all. */
function auditProviderChange(entry: {
  userId: string;
  projectId: string;
  from: { provider: LlmProvider | null; baseUrl: string | null };
  to: { provider: LlmProvider | null; baseUrl: string | null };
}): void {
  const host = (url: string | null) => {
    if (!url) return "-";
    try {
      return new URL(url).host;
    } catch {
      return "unparseable";
    }
  };
  console.warn(
    `[audit] llm-provider-change project=${entry.projectId} actor=${entry.userId} ` +
      `provider: ${entry.from.provider ?? "inherit"} → ${entry.to.provider ?? "inherit"} ` +
      `host: ${host(entry.from.baseUrl)} → ${host(entry.to.baseUrl)}`,
  );
}
