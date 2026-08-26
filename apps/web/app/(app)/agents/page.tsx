// Agents index — a categorized card gallery of every role (built-in + custom)
// the current tenant has materialized. Each card sells what the role *does*:
// its one-line purpose (from `lib/roles/catalog.ts`) and the model it actually
// runs on. From a card the operator can jump into the visual builder, or set
// that agent's model per project.
//
// ── The model shown here is RESOLVED, not the catalog tier ─────────────────
// This card used to render `role_config.modelTier`, a static catalog value that
// is a documented NO-OP on the local-cc path — so the badge asserted a model
// that never took effect, and disagreed with `/scoreboard`, which resolved it
// properly. Both screens now go through the one shared resolver
// (lib/metrics/project-models.ts), so they cannot disagree again.
//
// The 52-role team is one of DevPilot's biggest differentiators, so this surface
// reuses the same Card/Grid/Section idiom as the marketplace — the two read as
// one system.

import { Suspense } from "react";
import Link from "next/link";
import { Bot } from "lucide-react";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import { CATEGORY_ORDER, CUSTOM_CATEGORY, categoryAccent } from "@/lib/roles/gallery-meta";
import {
  agentModelScope,
  loadAgentModelContext,
  type AgentModelScope,
} from "@/lib/metrics/agent-models.server";
import { AgentModelControl } from "@/components/metrics/agent-model-control";
import { NewAgentMenu } from "./new-agent-menu";
import { HandoffDiagram } from "@/components/roles/handoff-diagram";
import { AgentsGallerySkeleton } from "./agents-gallery-skeleton";

export const dynamic = "force-dynamic";

type AgentRow = {
  id: string;
  name: string;
  role: string | null;
  config: Record<string, unknown> | null;
  created_at: string;
};

type SourceTone = "violet" | "info" | "muted" | "default";

type GalleryCard = {
  id: string;
  name: string;
  slug: string | null;
  purpose: string | null;
  category: string;
  /** The projects this agent's model can be set on, already resolved. */
  modelScope: AgentModelScope;
  source: string;
  sourceTone: SourceTone;
  createdAt: string;
};

// Static lookups derived from the catalog — the source of truth for a role's
// purpose phrase and its coarse category.
const CATALOG_BY_SLUG = new Map(ROLE_CATALOG.map((e) => [e.slug, e]));

function sourceToneFor(source: string): SourceTone {
  if (source === "jd-synth") return "violet";
  if (source === "builder") return "info";
  if (source === "builder-test") return "muted";
  return "default";
}

function toGalleryCard(row: AgentRow, modelScope: AgentModelScope): GalleryCard {
  const cfg = row.config ?? {};
  const source = (cfg.source as string | undefined) ?? "builtin";
  const slug = row.role;
  const catalogEntry = slug ? CATALOG_BY_SLUG.get(slug) : undefined;

  return {
    id: row.id,
    name: row.name,
    slug,
    purpose: catalogEntry?.purpose ?? null,
    category: catalogEntry?.category ?? CUSTOM_CATEGORY,
    modelScope,
    source,
    sourceTone: sourceToneFor(source),
    createdAt: row.created_at,
  };
}

// The (app) shell paints first; this page keeps its header static (title,
// description, New-agent menu) and streams only the role gallery under
// <Suspense>, so the header lands with the shell while the tenant's agents
// query resolves (S1). The page component stays synchronous so nothing blocks
// that flush.
export default function AgentsIndex() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            A team of specialized roles — each with a defined job and the model it runs on. Built-in
            roles materialise automatically per tenant; custom roles come from the JD synthesizer or
            the visual builder.
          </p>
        </div>
        <NewAgentMenu />
      </div>

      <Suspense fallback={<AgentsGallerySkeleton />}>
        <AgentsGallery />
      </Suspense>
    </div>
  );
}

async function AgentsGallery() {
  // Auth + tenant are independent round trips — resolve them together.
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  const supabase = supabaseService();
  const [{ data }, modelCtx] = await Promise.all([
    supabase
      .from("agents")
      .select("id, name, role, config, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true }),
    loadAgentModelContext(tenantId),
  ]);

  const rows = (data ?? []) as AgentRow[];
  // A card is a CONFIGURATION surface, so it offers every project in the
  // workspace — an agent can be given a model before it has ever run. (The
  // scoreboard makes the other choice deliberately: a row is a measurement, so
  // it targets only the projects that agent's runs actually touched.)
  const allProjectIds = modelCtx.projects.map((p) => p.projectId);
  const cards = rows.map((row) =>
    toGalleryCard(
      row,
      row.role
        ? agentModelScope(row.role, allProjectIds, modelCtx)
        : { targets: [], global: { currentValue: "", overriding: [] } },
    ),
  );

  // Group by catalog category, preserving the catalog's declared order and
  // appending the Custom bucket last if present.
  const byCategory = new Map<string, GalleryCard[]>();
  for (const card of cards) {
    const bucket = byCategory.get(card.category);
    if (bucket) bucket.push(card);
    else byCategory.set(card.category, [card]);
  }
  const orderedCategories = [
    ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...(byCategory.has(CUSTOM_CATEGORY) ? [CUSTOM_CATEGORY] : []),
  ];

  if (cards.length === 0) {
    return <EmptyState />;
  }

  return (
    <>
      <HandoffDiagram className="mb-8" />
      <div className="flex flex-col gap-8">
        {orderedCategories.map((category) => (
          <CategorySection key={category} category={category} cards={byCategory.get(category)!} />
        ))}
      </div>
    </>
  );
}

function CategorySection({ category, cards }: { category: string; cards: GalleryCard[] }) {
  const accent = categoryAccent(category);
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{category}</h2>
        <span className="text-muted-foreground text-xs tabular-nums">{cards.length}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <RoleCard key={card.id} card={card} accent={accent} />
        ))}
      </div>
    </section>
  );
}

function RoleCard({ card, accent }: { card: GalleryCard; accent: string }) {
  return (
    <Card className="group flex flex-col transition-shadow hover:shadow-md">
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${accent}`}
        >
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate text-sm">{card.name}</CardTitle>
          <CardDescription className="mt-1 line-clamp-2 text-xs">
            {card.purpose ?? "Custom agent — no catalog description."}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 pb-3 pt-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {card.slug && (
            <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
              {card.slug}
            </code>
          )}
          <Badge tone={card.sourceTone}>{card.source}</Badge>
        </div>
        {card.slug && (
          <div className="bg-muted/40 -mx-1 rounded-md px-1 py-1">
            <AgentModelControl
              roleSlug={card.slug}
              displayName={card.name}
              targets={card.modelScope.targets}
              globalTarget={card.modelScope.global}
              variant="card"
            />
          </div>
        )}
      </CardContent>
      <CardFooter className="mt-auto justify-between border-t pt-3">
        <span className="text-muted-foreground text-[11px]">
          {new Date(card.createdAt).toLocaleDateString()}
        </span>
        {/* "View prompt", not "Open in builder": what the operator wants from a
            card is to see what the agent is instructed to do, and the prompt
            view answers that. It is also keyed on the SLUG, so it works for the
            52 built-in roles whose agents row carries no `role_config` — the
            builder has nothing to show for those. A slug-less row (custom agent
            with a null `role`) has no prompt to route to, so it keeps the
            builder link. */}
        {card.slug ? (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/agents/${encodeURIComponent(card.slug)}`}>View prompt</Link>
          </Button>
        ) : (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/builder/${card.id}`}>Open in builder</Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="bg-card/50 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-md">
        <Bot className="h-5 w-5" />
      </div>
      <div>
        <div className="text-sm font-medium">No agents yet</div>
        <div className="text-muted-foreground text-xs">
          The built-in roles materialize on first tenant write. Create a custom one from a JD or in
          the builder.
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <NewAgentMenu />
      </div>
    </div>
  );
}
