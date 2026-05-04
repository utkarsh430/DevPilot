// Phase 1 / M16 — Agent Builder page (server entry).
//
// Resolves auth + tenant, loads or seeds the canvas, hydrates the React Flow
// client. The `agentId` URL param either references an existing agents row
// or the literal "new" sentinel for a fresh canvas. The client side handles
// all subsequent saves through server actions.

import { requireTenantId, requireUser } from "@/lib/auth";
import { installedLeavesAction, loadAgentCanvasAction } from "./actions";
import { BuilderClient } from "./client";

export const dynamic = "force-dynamic";

export default async function BuilderPage({ params }: { params: Promise<{ agentId: string }> }) {
  await requireUser();
  await requireTenantId();

  const { agentId } = await params;
  const loaded = await loadAgentCanvasAction(agentId);
  if (!loaded.ok) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="font-display text-xl font-bold">Agent Builder</h1>
        <p className="mt-3 text-sm text-red-600">{loaded.error}</p>
      </div>
    );
  }

  const leaves = await installedLeavesAction();

  return (
    <BuilderClient
      agentParam={agentId}
      initialAgentId={loaded.agentId}
      tenantId={loaded.tenantId}
      initialCanvas={loaded.canvas}
      isNew={loaded.isNew}
      synthesised={loaded.synthesised}
      leaves={leaves}
      agentName={loaded.agentName}
      initialAllowedRunnerUserIds={loaded.allowedRunnerUserIds}
    />
  );
}
