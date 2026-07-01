// Settings → LLM auth. Choose which credential the platform uses to reach
// Claude: the Claude Code subscription (default, via the local runner) or a
// per-token Anthropic API key. Reads the current per-tenant mode server-side
// and hands it to the client card selector.

import { requireUser, requireTenantId } from "@/lib/auth";
import { getLlmAuthMode } from "@/lib/llm/auth-mode.server";
import { LlmAuthForm } from "./llm-auth-form";

export const dynamic = "force-dynamic";

export default async function LlmAuthSettingsPage() {
  await requireUser();
  const tenantId = await requireTenantId();
  const mode = await getLlmAuthMode(tenantId);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="font-display text-xl font-bold tracking-tight">LLM auth</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Choose how DevPilot authenticates to Claude for every agent run. Claude Code auth uses
          your own subscription through the local runner and needs no API key — it&apos;s the
          default and the recommended path for a single-operator setup.
        </p>
      </header>

      <LlmAuthForm initialMode={mode} />
    </div>
  );
}
