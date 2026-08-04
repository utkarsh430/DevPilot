// Phase 1 / M11 — Skill + Tool marketplace.
//
// Read-only verified bundles only (Phase 1 governance lock — see
// docs/DEVPILOT_PHASE1_PLAN.md "Locked decisions"). Operators browse public skills
// + tool packages and install them into the current tenant. Installation
// creates a tenant-scoped clone via `installSkillAction`; the clone is what
// the runtime selector sees.
//
// The page itself stays a server component so auth + DB reads happen at the
// RSC boundary; all interactivity (filters, search, install/uninstall, tabs,
// toasts) is driven by <MarketplaceCatalog> in `catalog.tsx`.

import { Suspense } from "react";
import Link from "next/link";
import { Sparkles, ShieldAlert, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { loadMarketplaceListings, type ListingsClient } from "@/lib/marketplace/listings";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import { MarketplaceCatalog } from "./catalog";
import { MarketplaceSkeleton } from "./marketplace-skeleton";

// Catalog-sourced role labels so the skill role-target chips show the same
// friendly names as the Agents gallery — the two surfaces read as one system.
// Passed as plain strings (no server-only chain into the client bundle).
const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  ROLE_CATALOG.map((entry) => [entry.slug, entry.displayName]),
);

export const dynamic = "force-dynamic";

// The (app) shell paints first; this page keeps its header static (eyebrow,
// title, blurb, security note) and streams only the catalog under <Suspense>,
// so the header lands with the shell while the listings query resolves (S1).
// The page component stays synchronous so nothing blocks that flush.
export default function MarketplacePage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wider">
              <Sparkles className="h-3.5 w-3.5" />
              Marketplace
            </div>
            <h1 className="font-display mt-1 text-3xl font-bold tracking-tight">
              Skills &amp; tool packages
            </h1>
          </div>
          {/*
            Entry point into the authoring routes. Those routes and their
            actions belong to a sibling crew; this page only links to them.
          */}
          <Button variant="primary" size="sm" asChild className="shrink-0">
            <Link href="/marketplace/new">
              <Plus className="h-3.5 w-3.5" />
              Publish a skill
            </Link>
          </Button>
        </div>
        <p className="text-muted-foreground mt-3 max-w-2xl text-sm">
          Verified first-party bundles. Installing a skill adds it to this tenant&apos;s catalog —
          the dispatcher merges relevant skill bodies into the role&apos;s system prompt when a
          matching ticket arrives.
        </p>

        <div
          role="note"
          className="border-warning/30 bg-warning/10 mt-5 flex items-start gap-3 rounded-lg border p-3 text-xs"
        >
          <ShieldAlert className="text-warning mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="text-foreground/90">
            <strong className="font-semibold">Skills are prompt content.</strong> Even verified
            bundles are data, not executable code — they cannot grant new tools or override the
            ticket state machine. Read the body before installing:{" "}
            <strong className="font-semibold">Review</strong> on any card opens the full text
            alongside the roles it attaches to and the words that make it fire.
          </div>
        </div>
      </header>

      <Suspense fallback={<MarketplaceSkeleton />}>
        <MarketplaceListings />
      </Suspense>
    </div>
  );
}

async function MarketplaceListings() {
  await requireUser();
  const tenantId = await requireTenantId();
  const listings = await loadMarketplaceListings(
    supabaseService() as unknown as ListingsClient,
    tenantId,
  );

  return <MarketplaceCatalog {...listings} tenantId={tenantId} roleLabels={ROLE_LABELS} />;
}
