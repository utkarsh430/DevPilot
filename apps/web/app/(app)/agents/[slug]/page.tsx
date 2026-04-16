// Agent prompt inspector — `/agents/[slug]`, read-only.
//
// Keyed on the ROLE SLUG, not `agents.id`, and that is load-bearing:
//   • a built-in role's materialized `agents` row carries NO `role_config`
//     (`materialize_builtin_agents` seeds only wip/assignment/runner/tier), so
//     an id-keyed route would have nothing to render for 52 of the 53 roles;
//   • a fan-out sibling carries no `agent_id` at all (`runs.fan_out_role`), so
//     the slug is the only identity every dispatch path shares.
// Same constraint, same reason, as the per-agent model override (PR #110).

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Bot } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import { loadAgentPromptInspection } from "@/lib/roles/prompt-inspection.server";
import { PromptView } from "./prompt-view";
import { PromptViewSkeleton } from "./prompt-view-skeleton";

export const dynamic = "force-dynamic";

const CATALOG_BY_SLUG = new Map(ROLE_CATALOG.map((e) => [e.slug, e]));

// The (app) shell paints first; only the prompt load streams under <Suspense>,
// so the header lands with the shell. The page component stays synchronous.
export default function AgentPromptPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <Button asChild size="sm" variant="ghost" className="-ml-2 mb-4">
        <Link href="/agents">
          <ArrowLeft className="h-3.5 w-3.5" />
          All agents
        </Link>
      </Button>
      <Suspense fallback={<PromptViewSkeleton />}>
        <AgentPromptContent params={params} />
      </Suspense>
    </div>
  );
}

async function AgentPromptContent({ params }: { params: Promise<{ slug: string }> }) {
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  const { slug } = await params;

  const inspection = await loadAgentPromptInspection(tenantId, decodeURIComponent(slug));
  // Null means: not a built-in slug, AND this tenant has no agents row for it
  // carrying a `role_config`. Either way there is no prompt to show.
  if (!inspection) notFound();

  const purpose = CATALOG_BY_SLUG.get(inspection.slug)?.purpose ?? null;

  return (
    <>
      <header className="mb-6">
        <div className="flex items-start gap-3">
          <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-md border">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-bold tracking-tight">
              {inspection.displayName}
            </h1>
            {purpose && <p className="text-muted-foreground mt-1 text-sm">{purpose}</p>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
            {inspection.slug}
          </code>
          <Badge tone={inspection.source === "builtin" ? "default" : "violet"}>
            {inspection.agentSource ?? inspection.source}
          </Badge>
          <Badge tone="muted">on success → {inspection.onSuccessStatus.replace(/_/g, " ")}</Badge>
          <Badge tone="muted">{inspection.runnerPolicy}</Badge>
        </div>
      </header>

      <PromptView inspection={inspection} />
    </>
  );
}
