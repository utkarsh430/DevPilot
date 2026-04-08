"use client";

// Phase 2 / M5c — Sidebar/topbar badge for pending pushes.
//
// Driven entirely by `useLivePendingPushes`, scoped to the caller's tenant and
// (optionally) the active project. Returns `null` when there's nothing to
// surface so the sidebar item renders unadorned; otherwise an `info`-toned
// badge with the pending count.
//
// A8 wires this onto the "Changes" nav item in `nav-config.ts` / `sidebar.tsx`.
// The component is intentionally tiny — all logic lives in the hook, all
// styling matches the existing `Sidebar` badge layout (h-4, ml-auto, etc.).

import { Badge } from "@/components/ui/badge";
import { useLivePendingPushes } from "@/lib/realtime/use-pending-pushes";

export function ChangesBadge({
  tenantId,
  activeProjectId,
}: {
  tenantId: string;
  activeProjectId: string | null;
}) {
  const { items } = useLivePendingPushes({
    tenantId,
    projectId: activeProjectId,
  });
  const count = items.length;
  if (count === 0) return null;
  return (
    <Badge tone="info" className="ml-auto h-4 px-1.5 text-[10px] font-medium">
      {count}
    </Badge>
  );
}
