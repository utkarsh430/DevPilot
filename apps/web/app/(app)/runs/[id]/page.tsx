import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireTenantId, requireUser } from "@/lib/auth";
import { loadReplayChain, loadRunHeader, loadRunSiblings, loadRunSteps } from "@/lib/runs/queries";
import { RunInspector } from "@/components/runs/RunInspector";
import { langfuseTraceUrl } from "@/lib/tracing/url";
import { ensurePlatformSecretsLoaded } from "@/lib/platform-secrets/resolver";
import { resolveLangfuseLinkConfig } from "@/lib/tracing/langfuse";
import { RunInspectorSkeleton } from "./run-inspector-skeleton";
import { supabaseServer } from "@/lib/db/server";
import { loadRunArtifacts } from "@/lib/runs/artifacts-store";

export const dynamic = "force-dynamic";

// The (app) shell paints first; the inspector's data (header, steps, replay
// chain) streams in under <Suspense> so the skeleton lands with the shell
// instead of blocking first paint on the slowest run query (S1). The page
// component stays synchronous so nothing blocks that flush.
export default function RunInspectorPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<RunInspectorSkeleton />}>
      <RunInspectorContent params={params} />
    </Suspense>
  );
}

async function RunInspectorContent({ params }: { params: Promise<{ id: string }> }) {
  // Auth + tenant are independent round trips — resolve them together (same
  // pattern as the board page).
  const [, tenantId] = await Promise.all([requireUser(), requireTenantId()]);
  const { id } = await params;

  // Header, steps, and the M13 replay chain only need the run id — load all
  // three in parallel (the replay chain resolves to [] when this run isn't
  // part of a chain, so the Inspector hides the navigator on standalone runs).
  const [header, steps, replayChain] = await Promise.all([
    loadRunHeader(id),
    loadRunSteps(id),
    loadReplayChain(id),
    ensurePlatformSecretsLoaded(tenantId),
  ]);
  if (!header) notFound();

  // Browser screenshots the agent captured during this run, with fresh signed
  // URLs. Loaded through the RLS-bound server client AND explicitly scoped to
  // the caller's tenant: RLS already restricts the rows, and the co-located
  // predicate is what keeps the query correct if this ever moves to a service
  // client. Loaded after the header so a run the caller cannot see 404s before
  // any storage URL is minted.
  const artifacts = await loadRunArtifacts(await supabaseServer(), { runId: id, tenantId });

  // Phase 1 / M6 — pull the cohort siblings only when this run belongs to a
  // fan-out group. For Phase 0 / single-emit runs this is a no-op.
  const siblings = header.fanOutGroup ? await loadRunSiblings(id, header.fanOutGroup) : [];
  // Resolve trace-link config through the same tenant-aware resolver the
  // Langfuse client keys use, so a base URL / project id set in Settings
  // (platform-secrets) is honored here too, not just by the span-emitting
  // client.
  const { baseUrl: langfuseBaseUrl, projectId: langfuseProjectId } =
    resolveLangfuseLinkConfig(tenantId);
  const traceUrl = langfuseTraceUrl(langfuseBaseUrl, langfuseProjectId, id);

  return (
    <RunInspector
      header={header}
      steps={steps}
      siblings={siblings}
      replayChain={replayChain}
      traceUrl={traceUrl}
      langfuseBaseUrl={langfuseBaseUrl}
      langfuseProjectId={langfuseProjectId || null}
      artifacts={artifacts}
    />
  );
}
