"use client";

// Phase 2.5 / M6 — Visual container for a cohort node in the Agent Builder.
//
// Renders the cohort's frame: a dashed-border card with a header pill
// showing the acceptance strategy (single / all / quorum(N)) and the fan-in
// role (if set). Member role nodes are NOT rendered by this component —
// React Flow places them inside this frame via the `parentNode` field on
// each member's `data`. The cohort node owns the size; the parent client
// recomputes width/height when members are added/removed so the frame stays
// snug.
//
// The handles on the left / right edges let the operator wire a trigger edge
// in (predecessor → cohort) and a fan-in edge out (cohort → downstream).
// The compiler derives `trigger_role` from the predecessor edge and
// `fan_in_role` from the cohort node's inspector field (not from the
// outbound edge target, which is purely visual).

import * as React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { Layers, Sparkles } from "lucide-react";
import type { BuilderCohortNodeData, BuilderNode } from "@/lib/builder/types";

type CohortNodeViewProps = NodeProps;

/**
 * The wrapped data shape the builder passes to React Flow nodes:
 *   data: { node: BuilderNode, isEntry: boolean }
 */
type CohortNodeWrappedData = { node: BuilderNode; isEntry: boolean };

export function CohortNodeView(props: CohortNodeViewProps) {
  const wrapped = props.data as unknown as CohortNodeWrappedData;
  const node = wrapped.node;
  const cd = node.data as BuilderCohortNodeData;
  const selected = props.selected;

  const width = cd.width ?? 320;
  const height = cd.height ?? 200;

  return (
    <div
      style={{ width, height }}
      className={cn(
        "bg-chart-4/5 relative rounded-xl border-2 border-dashed backdrop-blur-sm transition-all",
        "border-chart-4/40",
        selected ? "ring-ring ring-offset-background ring-2 ring-offset-1" : "hover:bg-chart-4/10",
      )}
    >
      {/* Header ribbon. */}
      <div className="border-chart-4/30 bg-chart-4/10 flex items-center justify-between gap-2 rounded-t-xl border-b px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="bg-chart-4/20 text-chart-4 flex h-5 w-5 shrink-0 items-center justify-center rounded-md">
            <Layers className="h-3 w-3" />
          </div>
          <span className="text-chart-4 truncate text-[11px] font-semibold">
            {cd.label ?? cd.cohortKey}
          </span>
          <code className="bg-chart-4/15 text-chart-4 rounded px-1 py-0.5 font-mono text-[9px]">
            {cd.cohortKey}
          </code>
        </div>
        <Badge tone="violet" className="h-4 shrink-0 px-1.5 text-[9px]">
          {cd.acceptanceStrategy}
        </Badge>
      </div>

      {/* Hint when there are no members yet. Members are React Flow children;
          they paint OVER this div via parentNode — the empty hint disappears
          once at least one member node is parented to this id. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 px-3">
        {/* Fan-in role pill, when set. */}
        {cd.fanInRole && (
          <div className="border-chart-4/30 bg-chart-4/10 text-chart-4 pointer-events-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px]">
            <Sparkles className="h-2.5 w-2.5" />
            fan-in → <code className="font-mono">{cd.fanInRole}</code>
          </div>
        )}
      </div>

      {/* Connection handles. */}
      <Handle
        type="target"
        position={Position.Left}
        className="!border-chart-4/40 !bg-card !h-2 !w-2"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!border-chart-4/40 !bg-card !h-2 !w-2"
      />
    </div>
  );
}
