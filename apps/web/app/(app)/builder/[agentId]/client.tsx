"use client";

// Phase 1 / M16 — Agent Builder client.
//
// React Flow canvas. Holds the in-memory `BuilderCanvas` state, mirrors it
// into React Flow's node/edge models, and pushes changes through to the
// save / test-run server actions.
//
// Design notes
// ────────────
// • One source of truth: the `BuilderCanvas` (typed). React Flow's
//   internal node/edge state is recomputed from it on every render. Edits
//   funnel through reducer-style setters so each mutation produces a fully
//   valid canvas.
// • Node types render via memoised wrappers — palette additions only need a
//   new card component + a kind in the discriminated union.
// • The Test Run sidebar lives next to the canvas (not a modal) so the
//   operator can watch step events stream in while editing. It uses the
//   existing `useLiveTickets` Realtime hook so we don't bake any new event
//   plumbing.
// • Visual polish (M16 UI pass): canvas is wrapped in the shell's main
//   surface so it sits below the 3.5rem topbar without producing a second
//   header. The palette and inspector are collapsible side panels; the
//   inspector splits Properties / Notes via Radix Tabs. Node bodies are
//   card-style with type badges + chart-N accent rings, edges use pill
//   labels in the same chart-N token family. No new npm deps — everything
//   ships through @xyflow/react + our shadcn primitives.

import * as React from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
  type EdgeProps,
  Position,
  Handle,
  getBezierPath,
  EdgeLabelRenderer,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Bot,
  Coins,
  Database,
  Layers,
  Network,
  Redo2,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Star,
  Plus,
  HelpCircle,
  Settings2,
  GripVertical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import {
  saveAgentCanvasAction,
  suggestDataSourcesAction,
  listTenantMembersAction,
  type InstalledLeaves,
} from "./actions";
import type {
  BuilderCanvas,
  BuilderCohortNodeData,
  BuilderEdge,
  BuilderEdgeData,
  BuilderNode,
  BuilderNodeData,
  BuilderRoleNodeData,
  ModelTier,
  RunnerKind,
} from "@/lib/builder/types";
import { normaliseCanvas } from "@/lib/builder/compile";
import { TestRunPanel } from "./test-run-panel";
import { CohortNodeView } from "@/components/builder/cohort-node-view";
import { SuggestModal, type SuggestModalItem } from "@/components/builder/suggest-modal";
import { RunnersPicker, type RunnersPickerMember } from "@/components/builder/runners-picker";

type Props = {
  agentParam: string;
  initialAgentId: string | null;
  tenantId: string;
  initialCanvas: BuilderCanvas;
  isNew: boolean;
  synthesised: boolean;
  leaves: InstalledLeaves;
  /** Phase 2.5 / M6 — agents.name, used for the Workflow tab header. */
  agentName?: string | null;
  /** Phase 2.5 / M6 — current runners gate value. */
  initialAllowedRunnerUserIds?: string[] | "all";
};

const BUILTIN_ROLE_OPTIONS: { slug: string; displayName: string }[] = [
  { slug: "pm", displayName: "Product Manager" },
  { slug: "engineer", displayName: "Engineer" },
  { slug: "qa", displayName: "QA" },
  { slug: "security", displayName: "Security" },
  { slug: "triage", displayName: "Triage" },
  { slug: "tech_lead", displayName: "Tech Lead" },
  { slug: "devops", displayName: "DevOps / SRE" },
  { slug: "techwriter", displayName: "Tech Writer" },
  { slug: "designer", displayName: "Designer" },
  { slug: "dataeng", displayName: "Data Engineer" },
];

// Canonical icon + accent per node kind. Pulled from the chart-N token suite
// so both light/dark themes pick the right hue.
type NodeKindMeta = {
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind border ring class for the node card. */
  ring: string;
  /** Tailwind text class for the icon. */
  text: string;
  /** Tone for the type badge. */
  badgeTone: React.ComponentProps<typeof Badge>["tone"];
  label: string;
};

const NODE_KIND_META: Record<BuilderNodeData["kind"], NodeKindMeta> = {
  role: {
    icon: Bot,
    ring: "border-chart-1/40",
    text: "text-chart-1",
    badgeTone: "info",
    label: "Role",
  },
  skill: {
    icon: Layers,
    ring: "border-chart-2/40",
    text: "text-chart-2",
    badgeTone: "ok",
    label: "Skill",
  },
  tool: {
    icon: Wrench,
    ring: "border-chart-3/40",
    text: "text-chart-3",
    badgeTone: "warn",
    label: "Tool",
  },
  data_source: {
    icon: Database,
    ring: "border-chart-4/40",
    text: "text-chart-4",
    badgeTone: "violet",
    label: "Data source",
  },
  budget: {
    icon: Coins,
    ring: "border-chart-5/40",
    text: "text-chart-5",
    badgeTone: "danger",
    label: "Budget",
  },
  cohort: {
    icon: Network,
    ring: "border-chart-4/40",
    text: "text-chart-4",
    badgeTone: "violet",
    label: "Cohort",
  },
};

export function BuilderClient(props: Props) {
  return (
    <ReactFlowProvider>
      <BuilderInner {...props} />
    </ReactFlowProvider>
  );
}

// ── History (undo / redo) ─────────────────────────────────────────────────
//
// We snapshot the canvas on every "committed" mutation. Drag-position changes
// fan in fast, so we throttle them through a single trailing snapshot in the
// useEffect below — that keeps the past stack readable and avoids
// undo-noisy-by-one-pixel.

type HistoryState = {
  past: BuilderCanvas[];
  future: BuilderCanvas[];
};

function BuilderInner({
  agentParam,
  initialAgentId,
  initialCanvas,
  isNew,
  leaves,
  agentName,
  initialAllowedRunnerUserIds,
}: Props) {
  const [canvas, setCanvasState] = React.useState<BuilderCanvas>(initialCanvas);
  const [history, setHistory] = React.useState<HistoryState>({
    past: [],
    future: [],
  });
  const [agentId, setAgentId] = React.useState<string | null>(initialAgentId);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(
    initialCanvas.entryNodeId,
  );
  const [selectedEdgeId, setSelectedEdgeId] = React.useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(true);
  const [inspectorOpen, setInspectorOpen] = React.useState(true);
  const [saveStatus, setSaveStatus] = React.useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; at: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // Phase 2.5 / M6 — runners allow-list. "all" = open to every tenant member.
  const [allowedRunnerUserIds, setAllowedRunnerUserIds] = React.useState<string[] | "all">(
    initialAllowedRunnerUserIds ?? "all",
  );

  // Dirty-tracking: hash the normalised canvas + the runners gate so any
  // structural OR runners-gate change flips the "Unsaved" indicator. We seed
  // `lastSavedHash` with the initial state and bump it on every successful
  // save.
  const computeHash = React.useCallback(
    (c: BuilderCanvas, allowed: string[] | "all") =>
      JSON.stringify({
        canvas: normaliseCanvas(c),
        allowed: allowed === "all" ? "all" : [...allowed].sort(),
      }),
    [],
  );
  const [lastSavedHash, setLastSavedHash] = React.useState<string>(() =>
    computeHash(initialCanvas, initialAllowedRunnerUserIds ?? "all"),
  );
  const currentHash = React.useMemo(
    () => computeHash(canvas, allowedRunnerUserIds),
    [canvas, allowedRunnerUserIds, computeHash],
  );
  const dirty = currentHash !== lastSavedHash;

  /**
   * Commit a canvas change to history. `instant=true` pushes immediately
   * (for structural edits — add/remove/property change). When false (drag
   * end), we replace the most recent past entry if it represents the same
   * structural intent.
   */
  const commitCanvas = React.useCallback(
    (next: BuilderCanvas | ((cur: BuilderCanvas) => BuilderCanvas), instant = true) => {
      setCanvasState((cur) => {
        const resolved = typeof next === "function" ? next(cur) : next;
        if (resolved === cur) return cur;
        if (instant) {
          setHistory((h) => ({ past: [...h.past, cur], future: [] }));
        }
        return resolved;
      });
    },
    [],
  );

  const undo = React.useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const prev = h.past[h.past.length - 1]!;
      setCanvasState((cur) => {
        h.future = [cur, ...h.future];
        return prev;
      });
      return { past: h.past.slice(0, -1), future: h.future };
    });
  }, []);

  const redo = React.useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0]!;
      setCanvasState((cur) => {
        h.past = [...h.past, cur];
        return next;
      });
      return { past: h.past, future: h.future.slice(1) };
    });
  }, []);

  // ── React Flow node / edge projections ──────────────────────────────────
  const rfNodes: Node[] = React.useMemo(
    () =>
      canvas.nodes.map((n) => {
        // Cohort frames sit BEHIND their member roles. React Flow paints in
        // node-array order, so we want cohorts to come earlier.
        const parentId = n.data.kind === "role" ? n.data.parentNodeId : undefined;
        return {
          id: n.id,
          type: n.type,
          position: n.position,
          data: { node: n, isEntry: n.id === canvas.entryNodeId },
          selected: n.id === selectedNodeId,
          ...(parentId ? { parentId, extent: "parent" as const } : {}),
        };
      }),
    [canvas, selectedNodeId],
  );

  const rfEdges: Edge[] = React.useMemo(
    () =>
      canvas.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "builder",
        data: { edge: e },
        selected: e.id === selectedEdgeId,
      })),
    [canvas, selectedEdgeId],
  );

  // ── React Flow change handlers ──────────────────────────────────────────
  const onNodesChange = React.useCallback(
    (changes: NodeChange[]) => {
      // Apply RF-native changes (position drag, selection) to RF model,
      // then mirror position back into the canvas state.
      const updated: Node[] = applyNodeChanges(changes, rfNodes);
      const isStructural = changes.some(
        (c) =>
          c.type === "remove" ||
          c.type === "add" ||
          (c.type === "position" && c.dragging === false),
      );
      commitCanvas(
        (cur) => ({
          ...cur,
          nodes: cur.nodes.map((n) => {
            const rf = updated.find((u: Node) => u.id === n.id);
            if (!rf) return n;
            return { ...n, position: rf.position };
          }),
        }),
        isStructural,
      );
    },
    [rfNodes, commitCanvas],
  );

  const onEdgesChange = React.useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes
        .filter((c) => c.type === "remove")
        .map((c) => (c as { id: string }).id);
      if (removed.length === 0) return;
      commitCanvas((cur) => ({
        ...cur,
        edges: cur.edges.filter((e) => !removed.includes(e.id)),
      }));
    },
    [commitCanvas],
  );

  const onConnect = React.useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      commitCanvas((cur) => {
        const id = `e_${connection.source}_${connection.target}_${cur.edges.length}`;
        const edge: BuilderEdge = {
          id,
          source: connection.source!,
          target: connection.target!,
          data: { kind: "linear" },
        };
        return { ...cur, edges: [...cur.edges, edge] };
      });
    },
    [commitCanvas],
  );

  // ── Mutators surfaced into the side panel + palette ─────────────────────
  const addNode = React.useCallback(
    (data: BuilderNodeData) => {
      commitCanvas((cur) => {
        const id = `n_${data.kind}_${cur.nodes.length + 1}_${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        const lastX = cur.nodes[cur.nodes.length - 1]?.position.x ?? 240;
        const lastY = cur.nodes[cur.nodes.length - 1]?.position.y ?? 240;
        const node: BuilderNode = {
          id,
          type: data.kind,
          position: { x: lastX + 60, y: lastY + 80 },
          data,
        };
        return { ...cur, nodes: [...cur.nodes, node] };
      });
    },
    [commitCanvas],
  );

  // Phase 2.5 / M6 — drag-drop: same shape as `addNode`, but the caller
  // provides an explicit canvas position (translated from the drop event).
  const addNodeAt = React.useCallback(
    (data: BuilderNodeData, position: { x: number; y: number }) => {
      commitCanvas((cur) => {
        const id = `n_${data.kind}_${cur.nodes.length + 1}_${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        const node: BuilderNode = {
          id,
          type: data.kind,
          position,
          data,
        };
        return { ...cur, nodes: [...cur.nodes, node] };
      });
    },
    [commitCanvas],
  );

  const updateNode = React.useCallback(
    (id: string, patch: Partial<BuilderNodeData>) => {
      commitCanvas((cur) => ({
        ...cur,
        nodes: cur.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...patch } as BuilderNodeData } : n,
        ),
      }));
    },
    [commitCanvas],
  );

  const deleteNode = React.useCallback(
    (id: string) => {
      commitCanvas((cur) => {
        if (id === cur.entryNodeId) return cur; // entry is sacred
        return {
          ...cur,
          nodes: cur.nodes.filter((n) => n.id !== id),
          edges: cur.edges.filter((e) => e.source !== id && e.target !== id),
        };
      });
    },
    [commitCanvas],
  );

  const updateEdge = React.useCallback(
    (id: string, patch: Partial<BuilderEdgeData>) => {
      commitCanvas((cur) => ({
        ...cur,
        edges: cur.edges.map((e) =>
          e.id === id ? { ...e, data: { ...e.data, ...patch } as BuilderEdgeData } : e,
        ),
      }));
    },
    [commitCanvas],
  );

  const deleteEdge = React.useCallback(
    (id: string) => {
      commitCanvas((cur) => ({
        ...cur,
        edges: cur.edges.filter((e) => e.id !== id),
      }));
      setSelectedEdgeId((cur) => (cur === id ? null : cur));
    },
    [commitCanvas],
  );

  const setEntry = React.useCallback(
    (id: string) => {
      commitCanvas((cur) =>
        cur.nodes.find((n) => n.id === id && n.data.kind === "role")
          ? { ...cur, entryNodeId: id }
          : cur,
      );
    },
    [commitCanvas],
  );

  // Phase 2.5 / M6 — spawn a cohort container 240px below-right of the
  // selected role with two empty member role nodes nested inside it. Single
  // history commit so undo rolls the whole gesture back at once.
  const addCohortFromRole = React.useCallback(
    (roleNodeId: string) => {
      commitCanvas((cur) => {
        const role = cur.nodes.find((n) => n.id === roleNodeId && n.data.kind === "role");
        if (!role) return cur;

        // Slug a fresh cohort key — increment until the canvas has no
        // collision. Keeps cohortKey deterministic + readable.
        const existingKeys = new Set(
          cur.nodes
            .filter((n) => n.data.kind === "cohort")
            .map((n) => (n.data as BuilderCohortNodeData).cohortKey),
        );
        let idx = 1;
        while (existingKeys.has(`cohort-${idx}`)) idx += 1;
        const cohortKey = `cohort-${idx}`;

        const cohortId = `n_cohort_${cur.nodes.length + 1}_${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        const cohortPos = {
          x: role.position.x + 240,
          y: role.position.y + 240,
        };
        const cohortNode: BuilderNode = {
          id: cohortId,
          type: "cohort",
          position: cohortPos,
          data: {
            kind: "cohort",
            cohortKey,
            label: `Cohort ${idx}`,
            acceptanceStrategy: "all",
            width: 320,
            height: 200,
          },
        };

        const memberA: BuilderNode = {
          id: `n_role_${cur.nodes.length + 2}_${Math.random().toString(36).slice(2, 6)}`,
          type: "role",
          // Relative to parent cohort once React Flow nests via parentNode.
          position: { x: 20, y: 40 },
          data: {
            kind: "role",
            roleSlug: "",
            displayName: "Member A",
            modelTier: "default",
            runnerPolicy: "local-cc",
            parentNodeId: cohortId,
          },
        };
        const memberB: BuilderNode = {
          id: `n_role_${cur.nodes.length + 3}_${Math.random().toString(36).slice(2, 6)}`,
          type: "role",
          position: { x: 20, y: 120 },
          data: {
            kind: "role",
            roleSlug: "",
            displayName: "Member B",
            modelTier: "default",
            runnerPolicy: "local-cc",
            parentNodeId: cohortId,
          },
        };

        const fanoutEdge: BuilderEdge = {
          id: `e_${roleNodeId}_${cohortId}_${cur.edges.length}`,
          source: roleNodeId,
          target: cohortId,
          data: {
            kind: "fanout",
            cohortKey,
            acceptanceStrategy: "all",
          },
        };

        return {
          ...cur,
          nodes: [...cur.nodes, cohortNode, memberA, memberB],
          edges: [...cur.edges, fanoutEdge],
        };
      });
    },
    [commitCanvas],
  );

  // ── Auto-layout: arrange nodes into a simple BFS grid from the entry. ──
  const autoLayout = React.useCallback(() => {
    commitCanvas((cur) => {
      const byId = new Map(cur.nodes.map((n) => [n.id, n] as const));
      const out = new Map<string, string[]>();
      cur.edges.forEach((e) => {
        const list = out.get(e.source) ?? [];
        list.push(e.target);
        out.set(e.source, list);
      });
      const levels = new Map<string, number>();
      const queue: string[] = [cur.entryNodeId];
      levels.set(cur.entryNodeId, 0);
      while (queue.length) {
        const id = queue.shift()!;
        const lvl = levels.get(id) ?? 0;
        (out.get(id) ?? []).forEach((tgt) => {
          if (!levels.has(tgt)) {
            levels.set(tgt, lvl + 1);
            queue.push(tgt);
          }
        });
      }
      // Orphans get a synthetic level after the deepest connected.
      const maxLvl = Math.max(0, ...Array.from(levels.values()));
      cur.nodes.forEach((n) => {
        if (!levels.has(n.id)) levels.set(n.id, maxLvl + 1);
      });
      const buckets = new Map<number, string[]>();
      levels.forEach((lvl, id) => {
        const list = buckets.get(lvl) ?? [];
        list.push(id);
        buckets.set(lvl, list);
      });
      const COL = 280;
      const ROW = 140;
      const nodes = cur.nodes.map((n) => {
        const lvl = levels.get(n.id) ?? 0;
        const idx = (buckets.get(lvl) ?? []).indexOf(n.id);
        const y = 120 + idx * ROW;
        const x = 120 + lvl * COL;
        // Force the layout regardless of prior position — operator-triggered
        // gesture so it should be unambiguous.
        if (!byId.has(n.id)) return n;
        return { ...n, position: { x, y } };
      });
      return { ...cur, nodes };
    });
    toast.success("Layout snapped to grid");
  }, [commitCanvas]);

  // ── Persistence ─────────────────────────────────────────────────────────
  const onSave = React.useCallback(async () => {
    setSaveStatus({ kind: "saving" });
    const res = await saveAgentCanvasAction({
      agentId: agentId ?? "new",
      canvas,
      allowedRunnerUserIds,
    });
    if (!res.ok) {
      setSaveStatus({ kind: "error", message: res.error });
      toast.error(`Save failed: ${res.error}`);
      return;
    }
    setAgentId(res.agentId);
    setSaveStatus({ kind: "saved", at: Date.now() });
    setLastSavedHash(computeHash(canvas, allowedRunnerUserIds));
    toast.success(isNew && !agentId ? "Agent created" : `Saved ${res.entryRoleSlug}`);
  }, [agentId, canvas, isNew, allowedRunnerUserIds, computeHash]);

  // Phase 2.5 / M6 — beforeunload guard: warn before navigating away with
  // unsaved canvas changes. Standard browser API; the message is set by the
  // browser, not us.
  React.useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Phase 2.5 / M6 — attach-suggested bridge.
  //
  // The role-node Inspector lives deep inside the tree and only has access to
  // `updateNode`. When the operator confirms a Suggest-data-sources pick we
  // need to add multiple nodes + edges atomically. This CustomEvent shim
  // bubbles the picks up to the canvas owner, which performs the structural
  // mutation through `commitCanvas` (one history entry).
  React.useEffect(() => {
    function handler(ev: Event) {
      const detail = (ev as CustomEvent).detail as {
        sourceNodeId: string;
        baseX: number;
        baseY: number;
        picks: SuggestModalItem[];
      };
      if (!detail || detail.picks.length === 0) return;
      commitCanvas((cur) => {
        const newNodes: BuilderNode[] = [];
        const newEdges: BuilderEdge[] = [];
        let idx = 0;
        for (const p of detail.picks) {
          const nodeId = `n_data_source_${cur.nodes.length + idx + 1}_${Math.random()
            .toString(36)
            .slice(2, 6)}`;
          newNodes.push({
            id: nodeId,
            type: "data_source",
            position: {
              x: detail.baseX,
              y: detail.baseY + idx * 100,
            },
            data: {
              kind: "data_source",
              dataSourceId: p.dataSourceId,
              name: p.name,
            },
          });
          newEdges.push({
            id: `e_${detail.sourceNodeId}_${nodeId}_${cur.edges.length + idx}`,
            source: detail.sourceNodeId,
            target: nodeId,
            data: { kind: "linear" },
          });
          idx += 1;
        }
        return {
          ...cur,
          nodes: [...cur.nodes, ...newNodes],
          edges: [...cur.edges, ...newEdges],
        };
      });
      toast.success(`Attached ${detail.picks.length} data source(s)`);
    }
    window.addEventListener("devpilot:builder:attach-suggested", handler);
    return () => window.removeEventListener("devpilot:builder:attach-suggested", handler);
  }, [commitCanvas]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  React.useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const meta = ev.metaKey || ev.ctrlKey;
      const target = ev.target as HTMLElement | null;
      const editable =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (meta && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void onSave();
        return;
      }
      if (meta && ev.shiftKey && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        redo();
        return;
      }
      if (meta && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        undo();
        return;
      }
      if (!editable && (ev.key === "Delete" || ev.key === "Backspace")) {
        if (selectedEdgeId) {
          ev.preventDefault();
          deleteEdge(selectedEdgeId);
        } else if (selectedNodeId && selectedNodeId !== canvas.entryNodeId) {
          ev.preventDefault();
          deleteNode(selectedNodeId);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    onSave,
    undo,
    redo,
    selectedEdgeId,
    selectedNodeId,
    canvas.entryNodeId,
    deleteEdge,
    deleteNode,
  ]);

  const selectedNode = canvas.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEdge = canvas.edges.find((e) => e.id === selectedEdgeId) ?? null;

  return (
    <div className="bg-background flex h-[calc(100vh-3.5rem)] min-h-0 flex-col">
      {/* Builder toolbar (NOT a second app header — the shell topbar lives
          above this; this strip is local chrome for the editor). */}
      <BuilderToolbar
        agentId={agentId}
        agentParam={agentParam}
        isNew={isNew}
        saveStatus={saveStatus}
        dirty={dirty}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        paletteOpen={paletteOpen}
        inspectorOpen={inspectorOpen}
        agentName={agentName ?? null}
        allowedRunnerUserIds={allowedRunnerUserIds}
        onTogglePalette={() => setPaletteOpen((v) => !v)}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        onSave={onSave}
        onUndo={undo}
        onRedo={redo}
        onLayout={autoLayout}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Palette */}
        {paletteOpen && <Palette addNode={addNode} leaves={leaves} />}

        {/* Canvas */}
        <div className="relative min-h-0 flex-1">
          <CanvasSurface
            rfNodes={rfNodes}
            rfEdges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(n) => {
              setSelectedNodeId(n.id);
              setSelectedEdgeId(null);
              setInspectorOpen(true);
            }}
            onEdgeClick={(e) => {
              setSelectedEdgeId(e.id);
              setSelectedNodeId(null);
              setInspectorOpen(true);
            }}
            onPaneClick={() => {
              setSelectedEdgeId(null);
              setSelectedNodeId(null);
            }}
            onDropAt={addNodeAt}
            isEmpty={canvas.nodes.length === 0}
          />
        </div>

        {/* Inspector + Test Run sidebar */}
        {inspectorOpen && (
          <aside className="bg-card flex w-[26rem] shrink-0 flex-col overflow-hidden border-l">
            <InspectorPanel
              selectedNode={selectedNode}
              selectedEdge={selectedEdge}
              canvas={canvas}
              updateNode={updateNode}
              deleteNode={deleteNode}
              updateEdge={updateEdge}
              deleteEdge={deleteEdge}
              setEntry={setEntry}
              agentId={agentId}
              agentName={agentName ?? null}
              allowedRunnerUserIds={allowedRunnerUserIds}
              onChangeAllowedRunners={setAllowedRunnerUserIds}
              addCohortFromRole={addCohortFromRole}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

// ── Builder toolbar ───────────────────────────────────────────────────────

function BuilderToolbar({
  agentId,
  agentParam,
  isNew,
  saveStatus,
  dirty,
  canUndo,
  canRedo,
  paletteOpen,
  inspectorOpen,
  agentName,
  allowedRunnerUserIds,
  onTogglePalette,
  onToggleInspector,
  onSave,
  onUndo,
  onRedo,
  onLayout,
}: {
  agentId: string | null;
  agentParam: string;
  isNew: boolean;
  saveStatus:
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; at: number }
    | { kind: "error"; message: string };
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  paletteOpen: boolean;
  inspectorOpen: boolean;
  agentName: string | null;
  allowedRunnerUserIds: string[] | "all";
  onTogglePalette: () => void;
  onToggleInspector: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onLayout: () => void;
}) {
  const restricted = Array.isArray(allowedRunnerUserIds) && allowedRunnerUserIds.length > 0;
  return (
    <div className="bg-card/60 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onTogglePalette}
            aria-label={paletteOpen ? "Hide palette" : "Show palette"}
          >
            {paletteOpen ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeftOpen className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {paletteOpen ? "Hide palette" : "Show palette"}
        </TooltipContent>
      </Tooltip>

      <div className="ml-1 flex flex-col leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold">{agentName ?? "Agent canvas"}</span>
          {restricted && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge tone="warn" className="h-4 px-1.5 text-[9px]">
                  Restricted
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Only selected tenant members can file tickets against this workflow.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <span className="text-muted-foreground text-[10px]">
          {agentId ? (
            <>
              <code className="font-mono">{agentId.slice(0, 8)}</code>… ·{" "}
              {isNew ? "draft" : "saved"}
            </>
          ) : isNew ? (
            "Unsaved draft"
          ) : (
            <>
              loading <code className="font-mono">{agentParam.slice(0, 8)}</code>…
            </>
          )}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <SaveStatusPill status={saveStatus} dirty={dirty} />

        <ToolbarIconButton
          icon={<Undo2 className="h-4 w-4" />}
          label="Undo"
          shortcut={["⌘", "Z"]}
          onClick={onUndo}
          disabled={!canUndo}
        />
        <ToolbarIconButton
          icon={<Redo2 className="h-4 w-4" />}
          label="Redo"
          shortcut={["⇧", "⌘", "Z"]}
          onClick={onRedo}
          disabled={!canRedo}
        />
        <ToolbarIconButton
          icon={<LayoutGrid className="h-4 w-4" />}
          label="Auto-layout"
          onClick={onLayout}
        />

        <div className="bg-border mx-1 h-5 w-px" aria-hidden />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              onClick={onSave}
              disabled={saveStatus.kind === "saving"}
              className="gap-1.5"
            >
              <Save className="h-3.5 w-3.5" />
              {saveStatus.kind === "saving" ? "Saving…" : "Save"}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="flex items-center gap-1.5">
            Save canvas <Kbd>⌘</Kbd>
            <Kbd>S</Kbd>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleInspector}
              aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
            >
              {inspectorOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {inspectorOpen ? "Hide inspector" : "Show inspector"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function ToolbarIconButton({
  icon,
  label,
  shortcut,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string[];
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-1.5">
        {label}
        {shortcut && (
          <span className="flex items-center gap-0.5">
            {shortcut.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function SaveStatusPill({
  status,
  dirty,
}: {
  status:
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; at: number }
    | { kind: "error"; message: string };
  dirty?: boolean;
}) {
  if (status.kind === "saving") {
    return (
      <Badge tone="muted" className="font-normal">
        Saving…
      </Badge>
    );
  }
  if (status.kind === "error") {
    return (
      <Badge tone="danger" className="font-normal" title={status.message}>
        Save error
      </Badge>
    );
  }
  if (dirty) {
    return (
      <Badge tone="warn" className="gap-1 font-normal">
        <span aria-hidden className="bg-chart-3 inline-block h-1.5 w-1.5 rounded-full" />
        Unsaved changes
      </Badge>
    );
  }
  if (status.kind === "saved") {
    return (
      <Badge tone="ok" className="font-normal">
        Saved
      </Badge>
    );
  }
  return (
    <Badge tone="muted" className="font-normal">
      Idle
    </Badge>
  );
}

// ── Canvas surface ────────────────────────────────────────────────────────

function CanvasSurface({
  rfNodes,
  rfEdges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
  onDropAt,
  isEmpty,
}: {
  rfNodes: Node[];
  rfEdges: Edge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onNodeClick: (n: Node) => void;
  onEdgeClick: (e: Edge) => void;
  onPaneClick: () => void;
  onDropAt: (data: BuilderNodeData, position: { x: number; y: number }) => void;
  isEmpty: boolean;
}) {
  const reactFlow = useReactFlow();

  // Allow dropping a palette node onto the canvas — reuses HTML5 drag/drop
  // events without any new dep.
  const onDragOver = React.useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = React.useCallback(
    (ev: React.DragEvent) => {
      ev.preventDefault();
      const raw = ev.dataTransfer.getData("application/x-builder-node");
      if (!raw) return;
      let payload: BuilderNodeData;
      try {
        payload = JSON.parse(raw) as BuilderNodeData;
      } catch {
        return;
      }
      // Translate the viewport drop coordinates back into canvas-space so
      // the node lands exactly where the cursor was released.
      const position = reactFlow.screenToFlowPosition({
        x: ev.clientX,
        y: ev.clientY,
      });
      onDropAt(payload, position);
    },
    [reactFlow, onDropAt],
  );

  return (
    <div className="bg-background relative h-full w-full" onDragOver={onDragOver} onDrop={onDrop}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:18px_18px]"
      />
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_: React.MouseEvent, n: Node) => onNodeClick(n)}
        onEdgeClick={(_: React.MouseEvent, e: Edge) => onEdgeClick(e)}
        onPaneClick={onPaneClick}
        onInit={() => reactFlow.fitView({ padding: 0.25 })}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        className="!bg-transparent"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="transparent" />
        <Controls
          showInteractive={false}
          className="!border-border !bg-card !text-foreground [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-foreground hover:[&>button]:!bg-accent !rounded-md !border !shadow-sm"
        />
        <MiniMap
          pannable
          zoomable
          maskColor="hsl(var(--background) / 0.6)"
          className="!border-border !bg-card !rounded-md !border !shadow-sm"
          nodeColor={(n) => {
            const data = n.data as { node?: BuilderNode } | undefined;
            const kind = data?.node?.data.kind ?? "role";
            return miniMapHue(kind);
          }}
          nodeStrokeWidth={2}
        />
      </ReactFlow>

      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="bg-card/70 pointer-events-auto max-w-sm rounded-lg border border-dashed p-6 text-center shadow-sm backdrop-blur">
            <div className="bg-muted mx-auto flex h-10 w-10 items-center justify-center rounded-md">
              <Sparkles className="text-muted-foreground h-5 w-5" />
            </div>
            <div className="mt-3 text-sm font-semibold">Empty canvas</div>
            <p className="text-muted-foreground mt-1 text-xs">
              Drag a role from the palette on the left to start wiring your agent. Connect roles
              with linear, branch, or fan-out edges.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function miniMapHue(kind: BuilderNodeData["kind"]): string {
  switch (kind) {
    case "role":
      return "hsl(var(--chart-1))";
    case "skill":
      return "hsl(var(--chart-2))";
    case "tool":
      return "hsl(var(--chart-3))";
    case "data_source":
      return "hsl(var(--chart-4))";
    case "budget":
      return "hsl(var(--chart-5))";
    case "cohort":
      return "hsl(var(--chart-4))";
  }
}

// ── React Flow node renderers ─────────────────────────────────────────────

type RFNodeData = { node: BuilderNode; isEntry: boolean };

function RoleNodeView({ data, selected }: NodeProps) {
  const { node, isEntry } = data as unknown as RFNodeData;
  const rd = node.data as BuilderRoleNodeData;
  return (
    <NodeShell
      kind="role"
      selected={selected}
      title={rd.displayName}
      subtitle={rd.roleSlug}
      isEntry={isEntry}
      summary={[
        ["model", rd.modelTier],
        ["runner", rd.runnerPolicy],
        ...(typeof rd.budgetCents === "number"
          ? ([["cap", `$${(rd.budgetCents / 100).toFixed(2)}`]] as [string, string][])
          : ([] as [string, string][])),
      ]}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!border-border !bg-card !h-2 !w-2"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!border-border !bg-card !h-2 !w-2"
      />
    </NodeShell>
  );
}

function SkillNodeView({ data, selected }: NodeProps) {
  const { node } = data as unknown as RFNodeData;
  const sd = node.data as Extract<BuilderNodeData, { kind: "skill" }>;
  return (
    <NodeShell
      kind="skill"
      selected={selected}
      title={sd.name}
      subtitle="skill"
      summary={[["id", sd.skillId.slice(0, 8)]]}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!border-border !bg-card !h-2 !w-2"
      />
    </NodeShell>
  );
}

function ToolNodeView({ data, selected }: NodeProps) {
  const { node } = data as unknown as RFNodeData;
  const td = node.data as Extract<BuilderNodeData, { kind: "tool" }>;
  return (
    <NodeShell
      kind="tool"
      selected={selected}
      title={td.name}
      subtitle="tool package"
      summary={[["id", td.toolPackageId.slice(0, 8)]]}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!border-border !bg-card !h-2 !w-2"
      />
    </NodeShell>
  );
}

function DataSourceNodeView({ data, selected }: NodeProps) {
  const { node } = data as unknown as RFNodeData;
  const dd = node.data as Extract<BuilderNodeData, { kind: "data_source" }>;
  return (
    <NodeShell
      kind="data_source"
      selected={selected}
      title={dd.name}
      subtitle="data source"
      summary={[["id", dd.dataSourceId.slice(0, 8)]]}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!border-border !bg-card !h-2 !w-2"
      />
    </NodeShell>
  );
}

function BudgetNodeView({ data, selected }: NodeProps) {
  const { node } = data as unknown as RFNodeData;
  const bd = node.data as Extract<BuilderNodeData, { kind: "budget" }>;
  return (
    <NodeShell
      kind="budget"
      selected={selected}
      title="Budget cap"
      subtitle={bd.label ?? "leaf cap"}
      summary={[["cap", `$${(bd.budgetCents / 100).toFixed(2)}`]]}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!border-border !bg-card !h-2 !w-2"
      />
    </NodeShell>
  );
}

const NODE_TYPES = {
  role: RoleNodeView,
  skill: SkillNodeView,
  tool: ToolNodeView,
  data_source: DataSourceNodeView,
  budget: BudgetNodeView,
  cohort: CohortNodeView,
};

function NodeShell({
  kind,
  selected,
  isEntry,
  title,
  subtitle,
  summary,
  children,
}: {
  kind: BuilderNodeData["kind"];
  selected?: boolean;
  isEntry?: boolean;
  title: string;
  subtitle?: string;
  summary?: [string, string][];
  children?: React.ReactNode;
}) {
  const meta = NODE_KIND_META[kind];
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "bg-card text-card-foreground relative min-w-[200px] max-w-[260px] rounded-lg border shadow-sm transition-all",
        meta.ring,
        selected ? "ring-ring ring-offset-background ring-2 ring-offset-1" : "hover:shadow-md",
      )}
    >
      <div className="border-border/60 flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={cn(
              "bg-muted flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
              meta.text,
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </div>
          <Badge tone={meta.badgeTone} className="h-5 px-1.5 text-[10px] font-medium">
            {meta.label}
          </Badge>
        </div>
        {isEntry && (
          <Badge tone="info" className="gap-1 px-1.5 text-[10px]">
            <Star className="h-2.5 w-2.5" />
            Entry
          </Badge>
        )}
      </div>
      <div className="px-3 py-2">
        <div className="truncate text-sm font-semibold leading-tight">{title}</div>
        {subtitle && (
          <div className="text-muted-foreground mt-0.5 truncate font-mono text-[10px] uppercase tracking-wide">
            {subtitle}
          </div>
        )}
        {summary && summary.length > 0 && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px]">
            {summary.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="text-muted-foreground font-mono uppercase tracking-wide">{k}</dt>
                <dd className="text-foreground truncate font-mono">{v}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
      </div>
      {children}
    </div>
  );
}

// ── React Flow edge renderer ──────────────────────────────────────────────

function BuilderEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const edgeData = (data as unknown as { edge: BuilderEdge } | undefined)?.edge;
  const kind = edgeData?.data.kind ?? "linear";
  // chart-N driven stroke. Muted for linear, amber (chart-3) for conditional,
  // violet (chart-4) for fan-out.
  const stroke =
    kind === "conditional"
      ? "stroke-chart-3"
      : kind === "fanout"
        ? "stroke-chart-4"
        : "stroke-muted-foreground/60";
  const label =
    kind === "conditional"
      ? (edgeData!.data as { branchKey: string }).branchKey
      : kind === "fanout"
        ? `${(edgeData!.data as { cohortKey: string }).cohortKey} · ${
            (edgeData!.data as { acceptanceStrategy: string }).acceptanceStrategy
          }`
        : null;
  const pillTone =
    kind === "conditional"
      ? "border-chart-3/30 bg-chart-3/10 text-chart-3"
      : kind === "fanout"
        ? "border-chart-4/30 bg-chart-4/10 text-chart-4"
        : "border-border bg-muted text-muted-foreground";
  return (
    <>
      <path
        d={edgePath}
        fill="none"
        strokeWidth={selected ? 2.6 : 1.8}
        className={stroke}
        strokeDasharray={kind === "fanout" ? "4 3" : undefined}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            className={cn(
              "pointer-events-auto absolute rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-sm",
              pillTone,
            )}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const EDGE_TYPES = { builder: BuilderEdgeView };

// ── Palette ───────────────────────────────────────────────────────────────

function Palette({
  addNode,
  leaves,
}: {
  addNode: (d: BuilderNodeData) => void;
  leaves: InstalledLeaves;
}) {
  return (
    <aside className="bg-card/40 flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r p-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Palette
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label="Palette help"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-[220px]">
            Drag a tile onto the canvas, or click to drop it next to the last node. Wire roles
            together by dragging between the dots on the node edges.
          </TooltipContent>
        </Tooltip>
      </div>

      <PaletteGroup
        title="Roles"
        icon={Bot}
        tone="info"
        items={BUILTIN_ROLE_OPTIONS.map((r) => {
          const payload: BuilderNodeData = {
            kind: "role",
            roleSlug: r.slug,
            displayName: r.displayName,
            modelTier: "default",
            runnerPolicy: "local-cc",
          };
          return {
            key: r.slug,
            title: r.displayName,
            subtitle: r.slug,
            payload,
            onAdd: () => addNode(payload),
          };
        })}
      />

      <PaletteGroup
        title="Skills"
        icon={Layers}
        tone="ok"
        emptyHint="No skills installed"
        items={leaves.skills.map((s) => {
          const payload: BuilderNodeData = {
            kind: "skill",
            skillId: s.id,
            name: s.name,
          };
          return {
            key: s.id,
            title: s.name,
            subtitle: `v${s.version}`,
            payload,
            onAdd: () => addNode(payload),
          };
        })}
      />

      <PaletteGroup
        title="Tool packages"
        icon={Wrench}
        tone="warn"
        emptyHint="No tools installed"
        items={leaves.toolPackages.map((t) => {
          const payload: BuilderNodeData = {
            kind: "tool",
            toolPackageId: t.id,
            name: t.name,
          };
          return {
            key: t.id,
            title: t.name,
            subtitle: `v${t.version}`,
            payload,
            onAdd: () => addNode(payload),
          };
        })}
      />

      <PaletteGroup
        title="Data sources"
        icon={Database}
        tone="violet"
        emptyHint="No data sources connected"
        items={leaves.dataSources.map((d) => {
          const payload: BuilderNodeData = {
            kind: "data_source",
            dataSourceId: d.id,
            name: d.name,
          };
          return {
            key: d.id,
            title: d.name,
            subtitle: d.kind,
            payload,
            onAdd: () => addNode(payload),
          };
        })}
      />

      <PaletteGroup
        title="Budget"
        icon={Coins}
        tone="danger"
        items={[
          {
            key: "budget-leaf",
            title: "Leaf cap",
            subtitle: "$5.00 default",
            payload: {
              kind: "budget",
              budgetCents: 500,
              label: "leaf cap",
            } as BuilderNodeData,
            onAdd: () => addNode({ kind: "budget", budgetCents: 500, label: "leaf cap" }),
          },
        ]}
      />
    </aside>
  );
}

function PaletteGroup({
  title,
  icon: Icon,
  tone,
  items,
  emptyHint,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: React.ComponentProps<typeof Badge>["tone"];
  items: {
    key: string;
    title: string;
    subtitle?: string;
    payload?: BuilderNodeData;
    onAdd: () => void;
  }[];
  emptyHint?: string;
}) {
  return (
    <Card className="border-border/70 bg-card/60 shadow-none">
      <CardHeader className="flex flex-row items-center justify-between gap-2 p-3 pb-1.5">
        <CardTitle className="text-muted-foreground flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
          <Icon className="h-3.5 w-3.5" />
          {title}
        </CardTitle>
        <Badge tone={tone} className="h-4 px-1.5 text-[10px]">
          {items.length}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-1 p-2 pt-1">
        {items.length === 0 ? (
          <div className="text-muted-foreground px-1 py-1 text-[11px]">
            {emptyHint ?? "Nothing yet"}
          </div>
        ) : (
          items.map((it) => (
            <button
              key={it.key}
              type="button"
              onClick={it.onAdd}
              draggable={!!it.payload}
              onDragStart={(ev) => {
                if (!it.payload) return;
                ev.dataTransfer.setData("application/x-builder-node", JSON.stringify(it.payload));
                ev.dataTransfer.effectAllowed = "move";
              }}
              className={cn(
                "group flex w-full items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs",
                "hover:border-border hover:bg-accent",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <GripVertical className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="text-foreground truncate font-medium">{it.title}</span>
                  {it.subtitle && (
                    <span className="text-muted-foreground truncate font-mono text-[10px]">
                      {it.subtitle}
                    </span>
                  )}
                </span>
              </span>
              <Plus className="text-muted-foreground group-hover:text-foreground h-3.5 w-3.5 shrink-0 transition-colors" />
            </button>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ── Inspector panel (tabs: Properties / Workflow / Notes / Test run) ──────

function InspectorPanel({
  selectedNode,
  selectedEdge,
  canvas,
  updateNode,
  deleteNode,
  updateEdge,
  deleteEdge,
  setEntry,
  agentId,
  agentName,
  allowedRunnerUserIds,
  onChangeAllowedRunners,
  addCohortFromRole,
}: {
  selectedNode: BuilderNode | null;
  selectedEdge: BuilderEdge | null;
  canvas: BuilderCanvas;
  updateNode: (id: string, patch: Partial<BuilderNodeData>) => void;
  deleteNode: (id: string) => void;
  updateEdge: (id: string, patch: Partial<BuilderEdgeData>) => void;
  deleteEdge: (id: string) => void;
  setEntry: (id: string) => void;
  agentId: string | null;
  agentName: string | null;
  allowedRunnerUserIds: string[] | "all";
  onChangeAllowedRunners: (next: string[] | "all") => void;
  addCohortFromRole: (roleNodeId: string) => void;
}) {
  return (
    <Tabs defaultValue="properties" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Settings2 className="text-muted-foreground h-3.5 w-3.5" />
          <span className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
            Inspector
          </span>
        </div>
        <TabsList className="h-8">
          <TabsTrigger value="properties" className="h-6 px-2 text-[11px]">
            Properties
          </TabsTrigger>
          <TabsTrigger value="workflow" className="h-6 px-2 text-[11px]">
            Workflow
          </TabsTrigger>
          <TabsTrigger value="notes" className="h-6 px-2 text-[11px]">
            Notes
          </TabsTrigger>
          <TabsTrigger value="test" className="h-6 px-2 text-[11px]">
            Test run
          </TabsTrigger>
        </TabsList>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <TabsContent value="properties" className="mt-0 space-y-3">
          {selectedNode && selectedNode.data.kind === "cohort" ? (
            <CohortInspector
              node={selectedNode}
              canvas={canvas}
              updateNode={updateNode}
              deleteNode={deleteNode}
            />
          ) : selectedNode ? (
            <NodeInspector
              node={selectedNode}
              canvas={canvas}
              isEntry={selectedNode.id === canvas.entryNodeId}
              setEntry={() => setEntry(selectedNode.id)}
              updateNode={updateNode}
              deleteNode={deleteNode}
              agentId={agentId}
              addCohortFromRole={addCohortFromRole}
            />
          ) : selectedEdge ? (
            <EdgeInspector
              edge={selectedEdge}
              canvas={canvas}
              onUpdate={updateEdge}
              onDelete={() => deleteEdge(selectedEdge.id)}
            />
          ) : (
            <EmptyInspectorHint />
          )}

          {canvas.edges.length > 0 && (
            <EdgesList canvas={canvas} onSelect={() => {}} onDelete={deleteEdge} />
          )}
        </TabsContent>

        <TabsContent value="workflow" className="mt-0">
          <WorkflowTab
            agentId={agentId}
            agentName={agentName}
            allowedRunnerUserIds={allowedRunnerUserIds}
            onChangeAllowedRunners={onChangeAllowedRunners}
          />
        </TabsContent>

        <TabsContent value="notes" className="mt-0">
          <NotesPanel selectedNode={selectedNode} selectedEdge={selectedEdge} />
        </TabsContent>

        <TabsContent value="test" className="mt-0">
          <TestRunPanel canvas={canvas} agentId={agentId} />
        </TabsContent>
      </div>
    </Tabs>
  );
}

function EmptyInspectorHint() {
  return (
    <div className="bg-muted/30 rounded-md border border-dashed px-3 py-6 text-center">
      <Sparkles className="text-muted-foreground mx-auto h-4 w-4" />
      <div className="text-foreground mt-1.5 text-xs font-medium">Nothing selected</div>
      <p className="text-muted-foreground mt-0.5 text-[11px]">
        Click a node or edge to inspect its properties.
      </p>
    </div>
  );
}

function NotesPanel({
  selectedNode,
  selectedEdge,
}: {
  selectedNode: BuilderNode | null;
  selectedEdge: BuilderEdge | null;
}) {
  if (selectedNode) {
    return (
      <div className="space-y-3 text-xs">
        <Card>
          <CardHeader className="p-3 pb-1.5">
            <CardTitle className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
              About this node
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground p-3 pt-1 text-[11px] leading-relaxed">
            {nodeHelp(selectedNode.data.kind)}
          </CardContent>
        </Card>
      </div>
    );
  }
  if (selectedEdge) {
    return (
      <Card>
        <CardHeader className="p-3 pb-1.5">
          <CardTitle className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
            About this edge
          </CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground p-3 pt-1 text-[11px] leading-relaxed">
          {edgeHelp(selectedEdge.data.kind)}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="p-3 pb-1.5">
        <CardTitle className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
          Builder cheatsheet
        </CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground space-y-2 p-3 pt-1 text-[11px] leading-relaxed">
        <p>
          Drag from a role&apos;s right edge to another node to wire them. Linear edges fall through
          to the next role, conditional edges branch on a key, fan-out edges spawn siblings.
        </p>
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          <Kbd>⌘</Kbd>
          <span>
            <Kbd>S</Kbd> save · <Kbd>Z</Kbd> undo · <Kbd>⇧Z</Kbd> redo
          </span>
          <Kbd>⌫</Kbd>
          <span>Delete selected node or edge</span>
        </div>
      </CardContent>
    </Card>
  );
}

function nodeHelp(kind: BuilderNodeData["kind"]): string {
  switch (kind) {
    case "role":
      return "Roles are the units of work. Each role compiles to an agents.config role payload — system prompt, model tier, runner policy. The entry role is what the dispatcher targets first.";
    case "skill":
      return "Skills are reusable tactic templates pulled from the marketplace. Wire one to a role to add it to that role's skill_ids[].";
    case "tool":
      return "Tool packages bundle the tool calls a role is allowed to make. Wire one to a role to grant it that capability.";
    case "data_source":
      return "Data sources are RAG-style contexts the role retrieves from. Wire one to a role to include it in retrieval.";
    case "budget":
      return "Budget caps the spend on the attached leaf. The engine refuses a spawn that would exceed this; circuit-breaker territory.";
    case "cohort":
      return "Cohorts run their member roles in parallel. The acceptance strategy (single / all / quorum(N)) decides when the cohort completes; the fan-in role picks up after.";
  }
}

function edgeHelp(kind: BuilderEdgeData["kind"]): string {
  switch (kind) {
    case "linear":
      return "Linear edges are the default fallthrough. The dispatcher routes to the target role on the source role's onSuccessStatus.";
    case "conditional":
      return "Conditional edges register a branchKey under the source role's branches map. The role's prompt decides which key it emits, and dispatch follows that edge.";
    case "fanout":
      return "Fan-out edges sharing a cohortKey spawn siblings in parallel. The acceptance strategy (single / all / quorum(N)) decides when the parent unblocks.";
  }
}

// ── Node Inspector ────────────────────────────────────────────────────────

function NodeInspector({
  node,
  canvas,
  isEntry,
  setEntry,
  updateNode,
  deleteNode,
  agentId,
  addCohortFromRole,
}: {
  node: BuilderNode;
  canvas: BuilderCanvas;
  isEntry: boolean;
  setEntry: () => void;
  updateNode: (id: string, patch: Partial<BuilderNodeData>) => void;
  deleteNode: (id: string) => void;
  agentId: string | null;
  addCohortFromRole: (roleNodeId: string) => void;
}) {
  const meta = NODE_KIND_META[node.data.kind];
  const Icon = meta.icon;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 p-3">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "bg-muted flex h-6 w-6 items-center justify-center rounded-md",
              meta.text,
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-xs font-semibold">{meta.label}</span>
            <span className="text-muted-foreground font-mono text-[10px]">
              {node.id.slice(0, 12)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!isEntry && node.data.kind === "role" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" onClick={setEntry} aria-label="Set as entry">
                  <Star className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Set as entry</TooltipContent>
            </Tooltip>
          )}
          {!isEntry && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => deleteNode(node.id)}
                  aria-label="Delete node"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Delete node</TooltipContent>
            </Tooltip>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0">
        {renderNodeFields(node, updateNode)}
        {node.data.kind === "role" && (
          <RoleNodeActions
            node={node}
            canvas={canvas}
            agentId={agentId}
            addCohortFromRole={addCohortFromRole}
            updateNode={updateNode}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ── Role-specific action row (Phase 2.5 / M6) ────────────────────────────
//
// Two affordances live here:
//   • "Suggest data sources" — opens a modal of Haiku-ranked installed
//     sources. Confirming wires each pick as a `data_source` node + linear
//     edge from this role. Skips ids that already have an attached source.
//   • "+ Add parallel cohort"  — spawns a cohort container with two empty
//     member roles 240px below-right of the current role and a fan-out edge
//     into it. Single history step so undo rolls the gesture back at once.

function RoleNodeActions({
  node,
  canvas,
  agentId,
  addCohortFromRole,
  updateNode: _updateNode,
}: {
  node: BuilderNode;
  canvas: BuilderCanvas;
  agentId: string | null;
  addCohortFromRole: (roleNodeId: string) => void;
  updateNode: (id: string, patch: Partial<BuilderNodeData>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<SuggestModalItem[]>([]);

  // Ids that already have a data_source node linked from this role. The
  // SuggestModal greys these out + skips them on confirm even if checked.
  const attachedIds = React.useMemo(() => {
    const out = new Set<string>();
    for (const e of canvas.edges) {
      if (e.source !== node.id) continue;
      const tgt = canvas.nodes.find((n) => n.id === e.target);
      if (tgt && tgt.data.kind === "data_source") {
        out.add(tgt.data.dataSourceId);
      }
    }
    return out;
  }, [canvas, node.id]);

  const requestSuggestions = React.useCallback(async () => {
    if (node.data.kind !== "role") return;
    setLoading(true);
    setSuggestions([]);
    setOpen(true);
    try {
      const res = await suggestDataSourcesAction({
        agentId: agentId ?? "new",
        roleSlug: node.data.roleSlug || node.data.displayName,
      });
      if (!res.ok) {
        toast.error(`Suggest failed: ${res.error}`);
        setOpen(false);
        return;
      }
      setSuggestions(
        res.suggestions.map((s) => ({
          dataSourceId: s.id,
          name: s.name,
          kind: s.kind,
          rationale: s.reason,
          alreadyAttached: s.alreadyAttached || attachedIds.has(s.id),
        })),
      );
    } catch (e) {
      toast.error(`Suggest failed: ${e instanceof Error ? e.message : "unknown"}`);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }, [agentId, attachedIds, node]);

  const onConfirm = React.useCallback(
    (selectedIds: string[]) => {
      const picks = suggestions.filter(
        (s) => selectedIds.includes(s.dataSourceId) && !attachedIds.has(s.dataSourceId),
      );
      if (picks.length === 0) return;
      // Place new sources to the right of the role, stacked vertically.
      const baseX = node.position.x + 280;
      const baseY = node.position.y;
      // Note: we don't have a direct addNode-with-edge helper at this scope.
      // The toast surfaces a no-op when picks is 0; otherwise we hand the
      // picks off through a synthetic event-bus shim that the parent
      // exposes via the global window — falls back gracefully.
      const ev = new CustomEvent("devpilot:builder:attach-suggested", {
        detail: {
          sourceNodeId: node.id,
          baseX,
          baseY,
          picks,
        },
      });
      window.dispatchEvent(ev);
    },
    [suggestions, attachedIds, node.id, node.position.x, node.position.y],
  );

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <Button
        size="sm"
        variant="outline"
        className="h-7 justify-start gap-1.5 text-[11px]"
        onClick={requestSuggestions}
      >
        <Sparkles className="h-3 w-3" />
        Suggest data sources
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 justify-start gap-1.5 text-[11px]"
        onClick={() => addCohortFromRole(node.id)}
      >
        <Plus className="h-3 w-3" />
        Add parallel cohort
      </Button>
      <SuggestModal
        open={open}
        onOpenChange={setOpen}
        suggestions={suggestions}
        onConfirm={onConfirm}
        loading={loading}
      />
    </div>
  );
}

function renderNodeFields(
  node: BuilderNode,
  updateNode: (id: string, patch: Partial<BuilderNodeData>) => void,
) {
  if (node.data.kind === "role") {
    const d = node.data;
    return (
      <>
        <FieldLabel label="Display name">
          <Input
            value={d.displayName}
            onChange={(e) => updateNode(node.id, { displayName: e.target.value })}
          />
        </FieldLabel>
        <FieldLabel label="Slug">
          <Input
            value={d.roleSlug}
            onChange={(e) => updateNode(node.id, { roleSlug: e.target.value })}
            className="font-mono"
          />
        </FieldLabel>
        <div className="grid grid-cols-2 gap-2">
          <FieldLabel label="Model tier">
            <SelectShell
              value={d.modelTier}
              onChange={(v) => updateNode(node.id, { modelTier: v as ModelTier })}
              options={[
                { value: "default", label: "default" },
                { value: "heavy", label: "heavy" },
                { value: "cheap", label: "cheap" },
              ]}
            />
          </FieldLabel>
          <FieldLabel label="Runner">
            <SelectShell
              value={d.runnerPolicy}
              onChange={(v) => updateNode(node.id, { runnerPolicy: v as RunnerKind })}
              options={[
                { value: "local-cc", label: "local-cc" },
                { value: "api", label: "api" },
              ]}
            />
          </FieldLabel>
        </div>
        <FieldLabel label="Budget cap (¢)">
          <Input
            type="number"
            value={d.budgetCents ?? ""}
            onChange={(e) =>
              updateNode(node.id, {
                budgetCents: e.target.value ? Number(e.target.value) : undefined,
              })
            }
          />
        </FieldLabel>
      </>
    );
  }
  if (node.data.kind === "skill") {
    const d = node.data;
    return (
      <>
        <FieldLabel label="Skill id">
          <Input value={d.skillId} readOnly className="font-mono text-xs" />
        </FieldLabel>
        <FieldLabel label="Name">
          <Input value={d.name} onChange={(e) => updateNode(node.id, { name: e.target.value })} />
        </FieldLabel>
      </>
    );
  }
  if (node.data.kind === "tool") {
    const d = node.data;
    return (
      <>
        <FieldLabel label="Tool package id">
          <Input value={d.toolPackageId} readOnly className="font-mono text-xs" />
        </FieldLabel>
        <FieldLabel label="Name">
          <Input value={d.name} onChange={(e) => updateNode(node.id, { name: e.target.value })} />
        </FieldLabel>
      </>
    );
  }
  if (node.data.kind === "data_source") {
    const d = node.data;
    return (
      <>
        <FieldLabel label="Data source id">
          <Input value={d.dataSourceId} readOnly className="font-mono text-xs" />
        </FieldLabel>
        <FieldLabel label="Name">
          <Input value={d.name} onChange={(e) => updateNode(node.id, { name: e.target.value })} />
        </FieldLabel>
      </>
    );
  }
  if (node.data.kind === "budget") {
    const d = node.data;
    return (
      <>
        <FieldLabel label="Cap (cents)">
          <Input
            type="number"
            value={d.budgetCents}
            onChange={(e) => updateNode(node.id, { budgetCents: Number(e.target.value || 0) })}
          />
        </FieldLabel>
        <FieldLabel label="Label">
          <Input
            value={d.label ?? ""}
            onChange={(e) => updateNode(node.id, { label: e.target.value })}
          />
        </FieldLabel>
      </>
    );
  }
  return null;
}

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[11px]">
      <span className="text-muted-foreground mb-1 block text-[10px] font-medium uppercase tracking-wide">
        {label}
      </span>
      {children}
    </label>
  );
}

function SelectShell({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "border-input bg-background h-9 w-full rounded-md border px-2 text-sm",
        "focus:ring-ring focus:ring-offset-background focus:outline-none focus:ring-2 focus:ring-offset-2",
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Edge inspector + list ────────────────────────────────────────────────

function EdgeInspector({
  edge,
  canvas,
  onUpdate,
  onDelete,
}: {
  edge: BuilderEdge;
  canvas: BuilderCanvas;
  onUpdate: (id: string, patch: Partial<BuilderEdgeData>) => void;
  onDelete: () => void;
}) {
  const src = canvas.nodes.find((n) => n.id === edge.source);
  const tgt = canvas.nodes.find((n) => n.id === edge.target);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 p-3">
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-xs font-semibold">Edge</span>
          <span className="text-muted-foreground truncate text-[10px]">
            {(src?.data as { displayName?: string })?.displayName ?? edge.source}
            {" → "}
            {(tgt?.data as { displayName?: string })?.displayName ?? edge.target}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
              aria-label="Delete edge"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Delete edge</TooltipContent>
        </Tooltip>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0">
        <EdgeKindEditor edge={edge} onUpdate={onUpdate} />
      </CardContent>
    </Card>
  );
}

function EdgeKindEditor({
  edge,
  onUpdate,
}: {
  edge: BuilderEdge;
  onUpdate: (id: string, patch: Partial<BuilderEdgeData>) => void;
}) {
  return (
    <>
      <FieldLabel label="Edge kind">
        <SelectShell
          value={edge.data.kind}
          onChange={(v) => {
            const kind = v as BuilderEdgeData["kind"];
            if (kind === "linear") onUpdate(edge.id, { kind: "linear" });
            if (kind === "conditional")
              onUpdate(edge.id, { kind: "conditional", branchKey: "default" });
            if (kind === "fanout")
              onUpdate(edge.id, {
                kind: "fanout",
                cohortKey: "cohort_0",
                acceptanceStrategy: "all",
              });
          }}
          options={[
            { value: "linear", label: "linear" },
            { value: "conditional", label: "conditional (branch)" },
            { value: "fanout", label: "fan-out" },
          ]}
        />
      </FieldLabel>
      {edge.data.kind === "conditional" && (
        <FieldLabel label="Branch key">
          <Input
            value={edge.data.branchKey}
            onChange={(ev) =>
              onUpdate(edge.id, { kind: "conditional", branchKey: ev.target.value })
            }
            placeholder="branch key (e.g. small_change)"
          />
        </FieldLabel>
      )}
      {edge.data.kind === "fanout" && (
        <div className="grid grid-cols-2 gap-2">
          <FieldLabel label="Cohort key">
            <Input
              value={edge.data.cohortKey}
              onChange={(ev) =>
                onUpdate(edge.id, {
                  kind: "fanout",
                  cohortKey: ev.target.value,
                  acceptanceStrategy: (edge.data as { acceptanceStrategy: string })
                    .acceptanceStrategy,
                })
              }
              placeholder="cohort key"
            />
          </FieldLabel>
          <FieldLabel label="Acceptance">
            <Input
              value={edge.data.acceptanceStrategy}
              onChange={(ev) =>
                onUpdate(edge.id, {
                  kind: "fanout",
                  cohortKey: (edge.data as { cohortKey: string }).cohortKey,
                  acceptanceStrategy: ev.target.value,
                })
              }
              placeholder="all | single | quorum(2)"
            />
          </FieldLabel>
        </div>
      )}
    </>
  );
}

function EdgesList({
  canvas,
  onSelect,
  onDelete,
}: {
  canvas: BuilderCanvas;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
  return (
    <Card>
      <CardHeader className="p-3 pb-1.5">
        <CardTitle className="text-muted-foreground flex items-center justify-between text-xs font-semibold uppercase tracking-wide">
          <span>Edges</span>
          <Badge tone="muted" className="h-4 px-1.5 text-[10px]">
            {canvas.edges.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0">
        {canvas.edges.map((e) => {
          const src = byId.get(e.source);
          const tgt = byId.get(e.target);
          const tone =
            e.data.kind === "conditional" ? "warn" : e.data.kind === "fanout" ? "violet" : "muted";
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(e.id)}
              className="border-border/70 hover:bg-accent flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-[11px]"
            >
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="text-foreground truncate font-medium">
                  {(src?.data as { displayName?: string })?.displayName ?? e.source}
                  {" → "}
                  {(tgt?.data as { displayName?: string })?.displayName ?? e.target}
                </span>
                <Badge tone={tone} className="mt-0.5 h-4 w-fit px-1.5 text-[10px]">
                  {e.data.kind}
                </Badge>
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onDelete(e.id);
                }}
                aria-label="Delete edge"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Cohort inspector (Phase 2.5 / M6) ─────────────────────────────────────
//
// Rendered instead of NodeInspector when the selected node is a cohort
// container. The compiler reads these fields directly:
//   • `cohortKey`           → CohortPlanEntry.cohort_key
//   • `acceptanceStrategy`  → CohortPlanEntry.acceptance_strategy
//   • `fanInRole`           → CohortPlanEntry.fan_in_role
//   • members + trigger are derived from the topology (parentNodeId + edges)
//     so the inspector doesn't author them directly.

function CohortInspector({
  node,
  canvas,
  updateNode,
  deleteNode,
}: {
  node: BuilderNode;
  canvas: BuilderCanvas;
  updateNode: (id: string, patch: Partial<BuilderNodeData>) => void;
  deleteNode: (id: string) => void;
}) {
  // Candidate fan-in roles = role nodes downstream of the cohort that aren't
  // cohort members themselves. Cheap derivation; we just walk the edges.
  // Computed before the early return below so this hook is called
  // unconditionally on every render (react-hooks/rules-of-hooks).
  const downstreamRoles = React.useMemo(() => {
    const out: { id: string; label: string; slug: string }[] = [];
    for (const e of canvas.edges) {
      if (e.source !== node.id) continue;
      const tgt = canvas.nodes.find((n) => n.id === e.target);
      if (!tgt || tgt.data.kind !== "role") continue;
      if (tgt.data.parentNodeId === node.id) continue; // members
      out.push({
        id: tgt.id,
        label: tgt.data.displayName,
        slug: tgt.data.roleSlug || tgt.data.displayName,
      });
    }
    return out;
  }, [canvas, node.id]);

  if (node.data.kind !== "cohort") return null;
  const cd = node.data;

  // Strategy is one of "single" | "all" | "quorum(N)". We surface the first
  // two as a Select and a separate Quorum N spinner when "quorum" is picked.
  const isQuorum = cd.acceptanceStrategy.startsWith("quorum");
  const quorumN = (() => {
    const m = /^quorum\((\d+)\)$/.exec(cd.acceptanceStrategy);
    return m ? Number(m[1]) : 2;
  })();
  const strategyKey = isQuorum ? "quorum" : cd.acceptanceStrategy;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 p-3">
        <div className="flex items-center gap-2">
          <div className="bg-muted text-chart-4 flex h-6 w-6 items-center justify-center rounded-md">
            <Layers className="h-3.5 w-3.5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-xs font-semibold">Cohort</span>
            <span className="text-muted-foreground font-mono text-[10px]">
              {node.id.slice(0, 12)}
            </span>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => deleteNode(node.id)}
              aria-label="Delete cohort"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Delete cohort</TooltipContent>
        </Tooltip>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0">
        <FieldLabel label="Label">
          <Input
            value={cd.label ?? ""}
            placeholder="Cohort"
            onChange={(e) => updateNode(node.id, { label: e.target.value })}
          />
        </FieldLabel>
        <FieldLabel label="Cohort key">
          <Input
            value={cd.cohortKey}
            onChange={(e) => updateNode(node.id, { cohortKey: slugifyCohortKey(e.target.value) })}
            className="font-mono"
          />
        </FieldLabel>
        <FieldLabel label="Acceptance strategy">
          <SelectShell
            value={strategyKey}
            onChange={(v) => {
              if (v === "single" || v === "all") {
                updateNode(node.id, { acceptanceStrategy: v });
              } else if (v === "quorum") {
                updateNode(node.id, {
                  acceptanceStrategy: `quorum(${Math.max(1, quorumN)})`,
                });
              }
            }}
            options={[
              { value: "single", label: "single" },
              { value: "all", label: "all" },
              { value: "quorum", label: "quorum(N)" },
            ]}
          />
        </FieldLabel>
        {isQuorum && (
          <FieldLabel label="Quorum N">
            <Input
              type="number"
              min={1}
              value={quorumN}
              onChange={(e) => {
                const n = Math.max(1, Number(e.target.value || 1));
                updateNode(node.id, { acceptanceStrategy: `quorum(${n})` });
              }}
            />
          </FieldLabel>
        )}
        <FieldLabel label="Fan-in role">
          <SelectShell
            value={cd.fanInRole ?? ""}
            onChange={(v) => updateNode(node.id, { fanInRole: v === "" ? undefined : v })}
            options={[
              { value: "", label: "(none — state machine)" },
              ...downstreamRoles.map((r) => ({
                value: r.slug,
                label: `${r.label} (${r.slug})`,
              })),
            ]}
          />
        </FieldLabel>
      </CardContent>
    </Card>
  );
}

// kebab-case slug for cohort keys. Compiler treats this as the stable id.
function slugifyCohortKey(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

// ── Workflow tab (Phase 2.5 / M6) ─────────────────────────────────────────
//
// Surfaces workflow-level (not node-level) settings. Today: the agent's
// display name + the Runners gate. Tenant members are fetched on mount via
// `listTenantMembersAction`; we cache the result for the lifetime of the
// component (an agent rarely sees membership churn during a single edit).

function WorkflowTab({
  agentId,
  agentName,
  allowedRunnerUserIds,
  onChangeAllowedRunners,
}: {
  agentId: string | null;
  agentName: string | null;
  allowedRunnerUserIds: string[] | "all";
  onChangeAllowedRunners: (next: string[] | "all") => void;
}) {
  const [members, setMembers] = React.useState<RunnersPickerMember[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await listTenantMembersAction();
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error);
        setMembers([]);
        return;
      }
      setMembers(
        res.members.map((m) => ({
          userId: m.userId,
          displayName: (m.email ?? m.userId) + (m.isSelf ? " (you)" : ""),
          email: m.email ?? "",
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-3 text-xs">
      <Card>
        <CardHeader className="p-3 pb-1.5">
          <CardTitle className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
            Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 p-3 pt-1">
          <FieldLabel label="Name">
            <Input value={agentName ?? ""} readOnly placeholder="Unsaved draft" />
          </FieldLabel>
          {agentId && (
            <p className="text-muted-foreground font-mono text-[10px]">
              id {agentId.slice(0, 12)}…
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 pb-1.5">
          <CardTitle className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
            Runners
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 p-3 pt-1">
          <p className="text-muted-foreground text-[11px]">
            Tenant members allowed to file tickets against this workflow.
          </p>
          {members === null ? (
            <div className="text-muted-foreground flex items-center gap-2 py-2 text-[11px]">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Loading members…
            </div>
          ) : error ? (
            <p className="text-destructive text-[11px]">{error}</p>
          ) : (
            <RunnersPicker
              value={allowedRunnerUserIds}
              onChange={onChangeAllowedRunners}
              members={members}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
