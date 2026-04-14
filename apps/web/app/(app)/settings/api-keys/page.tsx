// Phase 1 / M14 — API key management page.
//
// Reads the tenant's existing keys via RLS-bound Supabase client; renders the
// `KeyList` client component for mutations. Cleartext keys are NEVER stored
// or fetched — only the secret returned from `createApiKeyAction` (in-memory
// for the request lifetime) is shown to the operator, and only once.

import { KeyRound } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/db/server";
import { KeyList, type KeyRow, type AgentOption } from "./key-list";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  await requireUser();
  await requireTenantId();
  const supabase = await supabaseServer();
  const { data: keys } = await supabase
    .from("api_keys")
    .select("id, name, prefix, scope, agent_id, last_used_at, revoked_at, created_at")
    .order("created_at", { ascending: false });
  const { data: agents } = await supabase
    .from("agents")
    .select("id, name, role")
    .order("created_at", { ascending: true });

  const rows: KeyRow[] = (keys ?? []).map((k) => ({
    id: k.id as string,
    name: k.name as string,
    prefix: k.prefix as string,
    scope: (k.scope as "api" | "widget") ?? "api",
    agentId: (k.agent_id as string | null) ?? null,
    lastUsedAt: (k.last_used_at as string | null) ?? null,
    revokedAt: (k.revoked_at as string | null) ?? null,
    createdAt: k.created_at as string,
  }));

  const agentOptions: AgentOption[] = (agents ?? []).map((a) => ({
    id: a.id as string,
    name: a.name as string,
    role: (a.role as string | null) ?? null,
  }));

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="bg-muted text-muted-foreground flex h-8 w-8 items-center justify-center rounded-md">
              <KeyRound className="h-4 w-4" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight">API keys</h1>
          </div>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Keys authenticate the public platform surface (
            <code className="font-mono text-xs">/v1/agents/&lt;id&gt;/runs</code> and{" "}
            <code className="font-mono text-xs">/v1/chat/completions</code>). Secrets are shown{" "}
            <strong className="text-foreground">once</strong> at creation and never stored in
            plaintext. Widget tokens are scoped to a single agent and can only be used by the
            embeddable widget.
          </p>
        </div>
      </header>
      <KeyList initial={rows} agents={agentOptions} />
    </div>
  );
}
