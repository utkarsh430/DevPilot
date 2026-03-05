"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  AlignJustify,
  CalendarClock,
  FileDown,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  Rows3,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useProjectExport } from "@/components/export/use-project-export";
import { COLUMNS, NEEDS_ATTENTION_STATUSES, type BoardTicket } from "@/components/board/types";
import { Column } from "@/components/board/Column";
import { BoardSwimlanes, statusFromDropId } from "@/components/board/BoardSwimlanes";
import { computeLanes } from "@/components/board/roles";
import {
  DEFAULT_DENSITY,
  usePrefersReducedMotion,
  type BoardDensity,
} from "@/components/board/board-prefs";
import { FirstRunPanel } from "@/components/board/FirstRunPanel";
import { TicketCard } from "@/components/board/TicketCard";
import { TicketDrawer } from "@/components/board/TicketDrawer";
import { NewTicketButton } from "@/components/board/NewTicketDialog";
import { PollingIndicator } from "@/components/board/PollingIndicator";
import { PlanSheetButton } from "@/components/plan/PlanSheetButton";
import { SupervisorConsoleButton } from "@/components/supervisor/SupervisorConsoleButton";
import { ScheduleButton } from "@/components/board/ScheduleButton";
import { canTransition, TERMINAL_STATUSES, type TicketStatus } from "@/lib/board/state";
import { compareTicketsForColumn } from "@/lib/board/column-sort";
import {
  bulkAddLabelAction,
  bulkDeleteTicketsAction,
  bulkMoveToReadyAction,
  bulkSetPriorityAction,
  moveTicketAction,
  pauseTicketAction,
  reorderTicketsAction,
  resumeTicketAction,
} from "@/app/(app)/board/actions";
import { useLiveTickets } from "@/lib/realtime/use-tickets";
import { useLivePendingPushes } from "@/lib/realtime/use-pending-pushes";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { EffectiveCatalogEntry } from "@/lib/roles/effective-catalog";
import type { TicketDependencyEdge } from "@/lib/board/queries";
import { listLabelsAction } from "@/app/(app)/board/actions";
import {
  BoardFilters,
  NeedsAttentionChip,
  readFiltersFromParams,
  type BoardFilterState,
} from "@/components/board/BoardFilters";
import type { LabelOption } from "@/components/board/LabelPicker";
import { AutomationToggle } from "@/components/shell/automation-toggle";
import { FirstDispatchNudge } from "@/components/board/FirstDispatchNudge";

// BoardGraph pulls in @xyflow/react (+ its CSS) but the board defaults to
// Kanban and most sessions never open Graph view — dynamic + ssr:false keeps
// that dependency out of the initial bundle, same pattern as xterm.js in
// RunTerminalPanel.
const BoardGraph = dynamic(
  () => import("@/components/board/BoardGraph").then((m) => m.BoardGraph),
  {
    ssr: false,
    loading: () => (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        Loading graph view…
      </div>
    ),
  },
);

export function BoardClient({
  tickets,
  tenantId,
  activeProjectId,
  activeProjectName,
  roleCatalog,
  dependencies,
  automationState = "running",
  automationPausedAt = null,
  tenantPaused = false,
}: {
  tickets: BoardTicket[];
  /** M5i — required for the pending_pushes realtime channel filter. */
  tenantId: string;
  activeProjectId: string | null;
  /** Display name for the planner sheet header. Null when no project is active. */
  activeProjectName: string | null;
  /** Effective role catalog (built-ins + tenant custom agents) for the new-ticket picker. */
  roleCatalog?: ReadonlyArray<EffectiveCatalogEntry>;
  /**
   * G2 — ticket-dependency edges for the graph view. Defaults to [] so the
   * empty graph still renders the orphan-nodes state without the page
   * crashing on a missing prop during a partial deploy.
   */
  dependencies?: ReadonlyArray<TicketDependencyEdge>;
  /** Project-scoped automation state for the board's Pause/Resume toggle. */
  automationState?: "running" | "paused";
  automationPausedAt?: string | null;
  /** Tenant pause masters project pause — disables the board toggle. */
  tenantPaused?: boolean;
}) {
  // Realtime: Supabase publication folds INSERT/UPDATE/DELETE on tickets and
  // INSERT on comments into the local list. The hook seeds from `tickets`
  // (server-rendered) so the first paint is unchanged.
  const { tickets: liveTickets, status: liveStatus, reconnect } = useLiveTickets(tickets);

  // Audit PDF for the whole board. Async job → poll → signed-URL download; the
  // hook owns all three steps and its own toasts.
  const projectExport = useProjectExport(activeProjectId);

  // M5i — second realtime channel for `pending_pushes`. The hook drops a row
  // the instant `pushed_at` flips, so the "Review N changes" chip disappears
  // without a refresh when the operator pushes from another tab. We overlay
  // the result onto each ticket below so consumers only see one source of
  // truth (the merged `BoardTicket`).
  const { items: livePushes } = useLivePendingPushes({
    tenantId,
    projectId: activeProjectId,
  });
  const pushByTicketId = React.useMemo(() => {
    const map = new Map<
      string,
      { id: string; branch: string; unpushedCount: number; updatedAt: string }
    >();
    // useLivePendingPushes already returns rows sorted newest-first; first hit
    // per ticket wins so multi-branch tickets surface the most recent push.
    for (const p of livePushes) {
      if (!p.ticketId) continue;
      if (map.has(p.ticketId)) continue;
      map.set(p.ticketId, {
        id: p.id,
        branch: p.branch,
        unpushedCount: p.unpushedCount,
        updatedAt: p.updatedAt,
      });
    }
    return map;
  }, [livePushes]);

  // When a project is active, drop tickets from other projects that the
  // realtime channel may have folded in (the channel is tenant-scoped, not
  // project-scoped). Initial server load is already filtered.
  // The pendingPush overlay also happens here so downstream consumers
  // (Column → TicketCard, Drawer) read a single merged BoardTicket.
  const scopedTickets = React.useMemo(() => {
    const filtered = activeProjectId
      ? liveTickets.filter((t) => t.projectId === activeProjectId)
      : liveTickets;
    if (pushByTicketId.size === 0) {
      // Most boards have zero pending pushes at any moment — short-circuit so
      // we don't allocate a new array.
      return filtered.map((t) => (t.pendingPush ? { ...t, pendingPush: null } : t));
    }
    return filtered.map((t) => {
      const live = pushByTicketId.get(t.id) ?? null;
      // Identity-preserving short-circuit so React's reference equality
      // doesn't churn for the (common) ticket whose push state didn't move.
      if (
        live === t.pendingPush ||
        (live &&
          t.pendingPush &&
          live.id === t.pendingPush.id &&
          live.unpushedCount === t.pendingPush.unpushedCount &&
          live.updatedAt === t.pendingPush.updatedAt)
      ) {
        return t;
      }
      return { ...t, pendingPush: live };
    });
  }, [liveTickets, activeProjectId, pushByTicketId]);

  const [openTicketId, setOpenTicketId] = React.useState<string | null>(null);
  const [optimistic, setOptimistic] = React.useState<BoardTicket[]>(scopedTickets);
  const [pendingMove, setPendingMove] = React.useState<{ id: string; to: TicketStatus } | null>(
    null,
  );
  const [activeId, setActiveId] = React.useState<string | null>(null);
  // G2 — Kanban (default) vs Graph view. Toggle lives in the header.
  const [viewMode, setViewMode] = React.useState<"kanban" | "graph">("kanban");
  // Secondary board actions (Schedule / Plan) live behind the "•••" menu; their
  // dialogs are controlled here so a menu item can open them.
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [planOpen, setPlanOpen] = React.useState(false);
  // Bulk selection mode is per-column: at most one column can be in
  // selection mode at any time. Tracks which status owns selection mode,
  // or null when nobody's in selection mode. Originally Backlog-only; now
  // Done and Failed also support selection mode for bulk delete.
  const [selectionMode, setSelectionMode] = React.useState<TicketStatus | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(() => new Set());

  // Columns where bulk-select is allowed. Must mirror the server-side
  // DELETABLE_STATUSES in app/(app)/board/actions.ts plus Backlog's
  // promote-to-Ready affordance.
  const SELECTABLE_COLUMNS: ReadonlySet<TicketStatus> = React.useMemo(
    () => new Set<TicketStatus>(["backlog", "done", "failed"]),
    [],
  );

  // Per-column collapse overrides. localStorage-persisted so the choice
  // round-trips reloads. Effective collapse state per column is:
  //   override[col] ?? (ticketCount === 0)
  // — i.e. empty columns auto-collapse, non-empty stay expanded, and any
  // explicit user toggle beats both forever (per column). When a ticket
  // flows into an empty collapsed column the count flips 0→1, the auto
  // rule flips to false, and the column auto-expands without any extra
  // logic — handles the "where did my ticket go?" footgun for free.
  const COLLAPSE_STORAGE_KEY = `devpilot:board:collapsed:${tenantId}`;
  const [collapseOverrides, setCollapseOverrides] = React.useState<
    Partial<Record<TicketStatus, boolean>>
  >({});
  // Hydrate from localStorage once on mount. Guarded for SSR/no-window.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Trust shape loosely — only carry over boolean values keyed by
        // known statuses. Anything else is dropped.
        const next: Partial<Record<TicketStatus, boolean>> = {};
        for (const col of COLUMNS) {
          const v = (parsed as Record<string, unknown>)[col.id];
          if (typeof v === "boolean") next[col.id] = v;
        }
        setCollapseOverrides(next);
      }
    } catch {
      // ignore corrupt entries
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleColumnCollapsed(col: TicketStatus, nextCollapsed: boolean): void {
    setCollapseOverrides((cur) => {
      const next = { ...cur, [col]: nextCollapsed };
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // quota / private mode — best-effort persistence, ignore.
        }
      }
      return next;
    });
  }

  // "Empty columns" mode — three-state control over what happens to columns
  // with zero tickets:
  //   • hide     — drop from the board entirely (default)
  //   • collapse — render as narrow vertical strips (defers to per-column
  //                override so the operator can still expand individual ones)
  //   • show     — render full-width like any other column
  // Persisted under the legacy key with a migration: old "1" → "hide",
  // old "0" → "show", new values stored as their string form.
  type EmptyMode = "hide" | "collapse" | "show";
  const HIDE_EMPTY_STORAGE_KEY = `devpilot:board:hideEmpty:${tenantId}`;
  const [emptyMode, setEmptyMode] = React.useState<EmptyMode>("hide");
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(HIDE_EMPTY_STORAGE_KEY);
      if (raw === "hide" || raw === "1") setEmptyMode("hide");
      else if (raw === "collapse") setEmptyMode("collapse");
      else if (raw === "show" || raw === "0") setEmptyMode("show");
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function setEmptyModePersisted(next: EmptyMode): void {
    setEmptyMode(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(HIDE_EMPTY_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    }
  }
  const [bulkInFlight, setBulkInFlight] = React.useState(false);

  // Card density (compact ↔ comfortable) — persisted so the operator's choice
  // sticks across reloads. Hydrated from localStorage on mount like the other
  // board prefs above.
  const DENSITY_STORAGE_KEY = `devpilot:board:density:${tenantId}`;
  const [density, setDensity] = React.useState<BoardDensity>(DEFAULT_DENSITY);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(DENSITY_STORAGE_KEY);
      if (raw === "compact" || raw === "comfortable") setDensity(raw);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function setDensityPersisted(next: BoardDensity): void {
    setDensity(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    }
  }

  // Swimlane-by-role grouping. Off by default (flat columns); persisted.
  const GROUP_BY_ROLE_STORAGE_KEY = `devpilot:board:groupByRole:${tenantId}`;
  const [groupByRole, setGroupByRole] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(GROUP_BY_ROLE_STORAGE_KEY) === "1") setGroupByRole(true);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function setGroupByRolePersisted(next: boolean): void {
    setGroupByRole(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(GROUP_BY_ROLE_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
    }
  }

  // Respect the OS "reduce motion" setting across all board animation.
  const reducedMotion = usePrefersReducedMotion();

  const router = useRouter();
  const searchParams = useSearchParams();

  // M1 — derive the active filter state from the URL on every render so the
  // back/forward buttons restore filtered views without a manual re-write.
  const filters: BoardFilterState = React.useMemo(
    () => readFiltersFromParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  // Deep-link: `/board?ticket=<id>` opens that ticket's drawer on arrival (used
  // by the lessons review queue's source-mistake link). Handled once per distinct
  // param value so re-opening after the operator closes the drawer doesn't fight
  // them; a ticket not in the active project's set is a harmless no-op (the board
  // is project-scoped, so a cross-project link just won't open).
  const handledTicketParam = React.useRef<string | null>(null);
  React.useEffect(() => {
    const wanted = searchParams.get("ticket");
    if (!wanted || handledTicketParam.current === wanted) return;
    if (optimistic.some((t) => t.id === wanted)) {
      handledTicketParam.current = wanted;
      setOpenTicketId(wanted);
    }
  }, [searchParams, optimistic]);

  // Label catalog for the filter bar (read once on mount; refreshes via
  // router.refresh after createLabelAction in the drawer).
  const [labelCatalog, setLabelCatalog] = React.useState<LabelOption[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listLabelsAction();
      if (!cancelled && res.ok) setLabelCatalog(res.value);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resync optimistic state when the live (or server) snapshot changes.
  React.useEffect(() => {
    setOptimistic(scopedTickets);
    setPendingMove(null);
  }, [scopedTickets]);

  // Drop stale selections whenever the active column's content changes — a
  // ticket that left that column (or was deleted) shouldn't keep counting
  // toward "N selected". Scoped to the active column so selection drift on
  // Done doesn't get clobbered by Backlog churn.
  React.useEffect(() => {
    if (selectedIds.size === 0 || selectionMode === null) return;
    const activeIds = new Set(
      scopedTickets.filter((t) => t.status === selectionMode).map((t) => t.id),
    );
    let drift = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (activeIds.has(id)) next.add(id);
      else drift = true;
    }
    if (drift) setSelectedIds(next);
  }, [scopedTickets, selectedIds, selectionMode]);

  function exitSelectionMode() {
    setSelectionMode(null);
    setSelectedIds(new Set());
  }
  function toggleSelected(ticketId: string) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(ticketId)) next.delete(ticketId);
      else next.add(ticketId);
      return next;
    });
  }

  async function runBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkInFlight(true);
    const res = await bulkDeleteTicketsAction({ ticketIds: ids });
    setBulkInFlight(false);
    if (!res.ok) {
      toast.error("Bulk delete failed", { description: res.error });
      return;
    }
    const n = res.value.deletedCount;
    toast.success(`Deleted ${n} ticket${n === 1 ? "" : "s"}`);
    exitSelectionMode();
    // Realtime DELETE alone is unreliable (Supabase only ships the primary key
    // in payload.old by default, so the tenant_id channel filter drops the
    // event). Mirror TicketDrawer.onConfirmDelete: optimistically drop the
    // cards now, then router.refresh() to reseed loadBoardTickets.
    const dropped = new Set(ids);
    setOptimistic((cur) => cur.filter((t) => !dropped.has(t.id)));
    router.refresh();
  }
  async function runBulkSetPriority(priority: 0 | 1 | 2 | 3 | 4) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkInFlight(true);
    const res = await bulkSetPriorityAction({ ticketIds: ids, priority });
    setBulkInFlight(false);
    if (!res.ok) {
      toast.error("Bulk priority failed", { description: res.error });
      return;
    }
    toast.success(
      `Priority set on ${res.value.updatedCount} ticket${res.value.updatedCount === 1 ? "" : "s"}`,
    );
    // Optimistic local update — realtime UPDATE confirms.
    const set = new Set(ids);
    setOptimistic((cur) => cur.map((t) => (set.has(t.id) ? { ...t, priority } : t)));
    router.refresh();
  }
  async function runBulkAddLabel(labelId: string) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkInFlight(true);
    const res = await bulkAddLabelAction({ ticketIds: ids, labelId });
    setBulkInFlight(false);
    if (!res.ok) {
      toast.error("Bulk label failed", { description: res.error });
      return;
    }
    toast.success(
      `Label added to ${res.value.updatedCount} ticket${res.value.updatedCount === 1 ? "" : "s"}`,
    );
    // The loader carries label chips, not the realtime UPDATE — refresh to
    // pull the new ticket_labels rows.
    router.refresh();
  }
  async function runBulkMoveToReady() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkInFlight(true);
    const res = await bulkMoveToReadyAction({ ticketIds: ids });
    setBulkInFlight(false);
    if (!res.ok) {
      toast.error("Bulk move failed", { description: res.error });
      return;
    }
    const { promotedIds, queuedIds, skippedIds } = res.value;
    const parts: string[] = [];
    if (promotedIds.length > 0) {
      parts.push(`${promotedIds.length} → Ready`);
    }
    if (queuedIds.length > 0) {
      parts.push(`${queuedIds.length} queued to auto-promote when blockers complete`);
    }
    if (skippedIds.length > 0) {
      parts.push(`${skippedIds.length} skipped`);
    }
    toast.success("Bulk move complete", {
      description: parts.length > 0 ? parts.join(" · ") : "No changes.",
    });
    exitSelectionMode();
  }

  // Keyboard DnD (U6): tab to a card's grip button, Enter/Space lifts, arrow
  // keys move within and across columns, Enter drops, Esc cancels.
  //
  // MouseSensor (distance-based) + TouchSensor (delay-based) instead of a
  // single PointerSensor: PointerSensor unifies mouse/touch under one 6px
  // distance threshold, which is too eager on touch — a normal vertical
  // scroll swipe that starts on/near the grip handle crosses 6px almost
  // immediately and gets captured as a drag, killing the column's native
  // scroll mid-gesture. TouchSensor's delay+tolerance requires a genuine
  // press-and-hold before a touch counts as a drag, so a quick scroll swipe
  // is left alone. The grip handle already has `touch-none` so the browser
  // doesn't fight the sensor once a drag does start.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // M1 — apply URL-driven filters before splitting into columns. We do this
  // here (not at query time) so realtime deltas stay subscribed across filter
  // changes — flipping a chip is a client-only re-derive, not a re-fetch.
  const visibleTickets = React.useMemo(() => {
    const { priorities, labelIds, overdueOnly, needsAttention } = filters;
    const now = Date.now();
    return optimistic.filter((t) => {
      if (needsAttention && !NEEDS_ATTENTION_STATUSES.has(t.status)) return false;
      if (priorities.size > 0 && !priorities.has(t.priority)) return false;
      if (labelIds.size > 0) {
        const has = t.labels.some((l) => labelIds.has(l.id));
        if (!has) return false;
      }
      if (overdueOnly) {
        if (!t.dueAt) return false;
        if (t.status === "done" || t.status === "failed") return false;
        if (Date.parse(t.dueAt) >= now) return false;
      }
      return true;
    });
  }, [optimistic, filters]);

  // Live "needs a human" count for the chip badge — over the project-scoped
  // set, independent of the other active filters so it always reflects the
  // real backlog of human-blocked work.
  const attentionCount = React.useMemo(
    () => optimistic.filter((t) => NEEDS_ATTENTION_STATUSES.has(t.status)).length,
    [optimistic],
  );

  // Role lanes for the swimlane view (only computed when grouping is on).
  const lanes = React.useMemo(
    () => (groupByRole ? computeLanes(visibleTickets) : []),
    [groupByRole, visibleTickets],
  );

  const ticketsByColumn = React.useMemo(() => {
    const map = new Map<TicketStatus, BoardTicket[]>();
    for (const col of COLUMNS) map.set(col.id, []);
    for (const t of visibleTickets) {
      map.get(t.status)?.push(t);
    }
    // C3 — within each column, sort by column_position ASC (plan-driven DAG
    // order) with updated_at DESC as the tiebreak. Legacy tickets without
    // column_position fall to MAX_SAFE_INTEGER so they sit below DAG-ordered
    // rows, matching the server-side query. Terminal columns (Done/Failed)
    // are the one exception — column_position's dependency ordering is spent
    // once a ticket is finished, so those two sort by ticket_number DESC
    // instead (newest ticket on top). See lib/board/column-sort.ts.
    for (const col of COLUMNS) {
      const arr = map.get(col.id);
      if (!arr) continue;
      arr.sort((a, b) => compareTicketsForColumn(col.id, a, b));
    }
    return map;
  }, [visibleTickets]);

  // Empty-column mode applies only when the board has tickets AND no drag is
  // in flight (every column must remain a drop target mid-drag). The
  // selection-mode column is also exempt (handled in the render loop).
  const emptyModeActive: EmptyMode =
    optimistic.length > 0 && activeId === null ? emptyMode : "show";
  const hideEmptyColumns = emptyModeActive === "hide";
  const collapseEmptyColumns = emptyModeActive === "collapse";

  // First-run activation: a project with zero tickets gets the "Run your first
  // ticket" panel instead of bare empty columns. Keyed off the real ticket
  // count (not the filtered view) so an active filter that hides every ticket
  // doesn't masquerade as a fresh board.
  const isBoardEmpty = optimistic.length === 0;

  const openTicket = optimistic.find((t) => t.id === openTicketId) ?? null;
  const activeTicket = optimistic.find((t) => t.id === activeId) ?? null;

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const ticketId = String(e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const ticket = optimistic.find((t) => t.id === ticketId);
    if (!ticket) return;
    if (overId === ticketId) return; // dropped on self — no-op

    // over.id can be a flat column id, a swimlane cell id (`status@@lane`),
    // or a ticket id (drop on another card). Resolve which, plus the
    // destination column. `statusFromDropId` strips the swimlane lane suffix
    // so cross-status drags land correctly in either view.
    const overStatus = statusFromDropId(overId);
    const overIsColumn = COLUMNS.some((c) => c.id === overStatus);
    const overTicket = overIsColumn ? null : optimistic.find((t) => t.id === overId);
    const targetColumn: TicketStatus = overIsColumn
      ? (overStatus as TicketStatus)
      : (overTicket?.status ?? ticket.status);

    // Branch 1 — within-column reorder. Status unchanged; we only rewrite
    // column_position via the new sortable surface. Skips the transition
    // guard (status isn't moving) and skips the blocker check.
    //
    // Disabled in swimlane mode: `column_position` is a single per-status
    // order shared across lanes, so reordering a lane's subset would scramble
    // the flat view's ordering. Swimlanes are for cross-stage triage, not
    // manual within-column sorting.
    //
    // Disabled for terminal columns (Done/Failed): those sort by
    // ticket_number, not column_position (see compareTicketsForColumn), so a
    // manual drag reorder would write a column_position the sort ignores —
    // the card would just snap back to its ticket-number position, which
    // reads as a broken drag rather than a no-op.
    if (
      targetColumn === ticket.status &&
      overTicket &&
      !overIsColumn &&
      !groupByRole &&
      !TERMINAL_STATUSES.has(targetColumn)
    ) {
      const colTickets = ticketsByColumn.get(targetColumn) ?? [];
      const oldIdx = colTickets.findIndex((t) => t.id === ticketId);
      const newIdx = colTickets.findIndex((t) => t.id === overTicket.id);
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;

      const reordered = arrayMove(colTickets.slice(), oldIdx, newIdx);
      const orderedIds = reordered.map((t) => t.id);

      // Optimistic: write new column_position (1..N) into the affected
      // column's tickets so the local sort flips immediately.
      const positionById = new Map<string, number>();
      orderedIds.forEach((id, i) => positionById.set(id, i + 1));
      setOptimistic((cur) =>
        cur.map((t) =>
          positionById.has(t.id) ? { ...t, columnPosition: positionById.get(t.id) ?? null } : t,
        ),
      );

      const res = await reorderTicketsAction({ ticketIds: orderedIds });
      if (!res.ok) {
        // Revert — restore old column_positions from the snapshot.
        const snapshot = new Map(colTickets.map((t) => [t.id, t.columnPosition]));
        setOptimistic((cur) =>
          cur.map((t) =>
            snapshot.has(t.id) ? { ...t, columnPosition: snapshot.get(t.id) ?? null } : t,
          ),
        );
        toast.error("Reorder failed", { description: res.error });
      }
      return;
    }

    // Branch 2 — cross-column status move (original flow). Whether the over
    // target was a card or the column shell doesn't matter; targetColumn
    // captures the destination.
    if (targetColumn === ticket.status) return;
    if (!canTransition(ticket.status, targetColumn)) {
      const fromLabel = COLUMNS.find((c) => c.id === ticket.status)?.label ?? ticket.status;
      const toLabel = COLUMNS.find((c) => c.id === targetColumn)?.label ?? targetColumn;
      toast.error("Invalid move", {
        description: `${fromLabel} → ${toLabel} isn't allowed by the workflow.`,
      });
      return;
    }
    // Optimistic move.
    setPendingMove({ id: ticketId, to: targetColumn });
    setOptimistic((cur) =>
      cur.map((t) => (t.id === ticketId ? { ...t, status: targetColumn } : t)),
    );

    // Route through the right server action so pause/resume side effects
    // (in-flight run cancel, replay dispatch) actually run. moveTicketAction
    // only flips the ticket status — it doesn't talk to the engine's
    // pause-resume module.
    //   • drag INTO paused → pauseTicketAction (soft-cancel in-flight runs)
    //   • drag OUT of paused → resumeTicketAction (decides replay vs dispatch)
    //   • everything else  → moveTicketAction (existing flow)
    let res: Awaited<ReturnType<typeof moveTicketAction>>;
    if (targetColumn === "paused") {
      const pauseRes = await pauseTicketAction({ ticketId });
      res = pauseRes.ok ? { ok: true, value: undefined } : { ok: false, error: pauseRes.error };
    } else if (ticket.status === "paused") {
      const resumeRes = await resumeTicketAction({ ticketId });
      // Resume always lands the ticket in 'in_progress'. If the user dragged
      // to a non-in_progress column (e.g. directly to backlog/failed) we
      // re-route through moveTicketAction after resume succeeds. Cheap
      // double-write; resume is the primary state-restoring operation.
      if (!resumeRes.ok) {
        res = { ok: false, error: resumeRes.error };
      } else if (targetColumn !== "in_progress") {
        res = await moveTicketAction({ ticketId, toStatus: targetColumn });
      } else {
        res = { ok: true, value: undefined };
      }
    } else {
      res = await moveTicketAction({ ticketId, toStatus: targetColumn });
    }
    if (!res.ok) {
      // Revert.
      setOptimistic((cur) =>
        cur.map((t) => (t.id === ticketId ? { ...t, status: ticket.status } : t)),
      );
      setPendingMove(null);
      if (res.reason === "blocked" && res.blockers && res.blockers.length > 0) {
        toast.error("Blocked by dependencies", {
          description: res.blockers
            .map((b) => `• ${b.title}`)
            .slice(0, 4)
            .join("\n"),
        });
      } else {
        toast.error("Move failed", { description: res.error });
      }
      return;
    }
    // Realtime will deliver the canonical UPDATE; no router.refresh() needed.
    setPendingMove(null);
  }

  return (
    <>
      {/* A3 — invisible watcher that routes the tenant's first-ever dispatch
          to the live trace. Inert after its one-time localStorage flag sets. */}
      <FirstDispatchNudge tenantId={tenantId} tickets={liveTickets} />
      {/* Merged board toolbar — filters (left) + actions (right). The active
          "Board" tab already labels the page, so there's no title row here. */}
      <header className="bg-background/60 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-6 py-2 backdrop-blur">
        {/* View controls (filter + layout) grouped on the left. */}
        <div className="flex flex-wrap items-center gap-2">
          <BoardFilters state={filters} labelCatalog={labelCatalog} />
          <NeedsAttentionChip state={filters} count={attentionCount} />
          <div
            className="border-border inline-flex items-center rounded-md border p-0.5"
            role="tablist"
            aria-label="Board view"
          >
            <button
              type="button"
              onClick={() => setViewMode("kanban")}
              role="tab"
              aria-selected={viewMode === "kanban"}
              className={cn(
                "inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs transition-colors",
                viewMode === "kanban"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <LayoutGrid className="h-3 w-3" /> Kanban
            </button>
            <button
              type="button"
              onClick={() => setViewMode("graph")}
              role="tab"
              aria-selected={viewMode === "graph"}
              className={cn(
                "inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs transition-colors",
                viewMode === "graph"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Workflow className="h-3 w-3" /> Graph
            </button>
          </div>
        </div>

        {/* Status + actions grouped on the right (primary CTA last). */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground hidden text-xs sm:inline">
            {optimistic.length} ticket{optimistic.length === 1 ? "" : "s"}
            {pendingMove ? " · syncing…" : ""}
          </span>
          <PollingIndicator status={liveStatus} onRetry={reconnect} />
          {/* divider — separates status (count · Live) from the actions. */}
          <div className="bg-border mx-0.5 hidden h-5 w-px sm:block" aria-hidden />
          {/* The supervisor console — "what is this board doing, and why is
              nothing moving". First of the actions, and in the header rather
              than behind "More", because it is what an operator reaches for
              when the board has stopped and they do not yet know why. */}
          <SupervisorConsoleButton
            activeProjectId={activeProjectId}
            projectName={activeProjectName}
          />
          {activeProjectId ? (
            <AutomationToggle
              scope="project"
              scopeId={activeProjectId}
              initialState={automationState}
              initialPausedAt={automationPausedAt}
              disabled={tenantPaused}
              disabledReason="Workspace is paused (overrides project). Resume it from the ☰ menu first."
              compact
            />
          ) : null}

          {/* Density + swimlane toggles only shape the Kanban view, so they
              stay hidden in Graph view where they'd be dead controls (mirrors
              how the empty-columns switch is gated below). */}
          {viewMode === "kanban" ? (
            <>
              {/* Density toggle — compact ↔ comfortable card rhythm. Persisted
                  so the choice sticks across reloads. */}
              <Button
                type="button"
                variant={density === "compact" ? "primary" : "outline"}
                size="icon-sm"
                aria-pressed={density === "compact"}
                aria-label="Toggle card density"
                title={
                  density === "compact"
                    ? "Compact density — click for comfortable"
                    : "Comfortable density — click for compact"
                }
                onClick={() =>
                  setDensityPersisted(density === "compact" ? "comfortable" : "compact")
                }
              >
                <AlignJustify className="h-4 w-4" />
              </Button>

              {/* Swimlane-by-role toggle — off = today's flat columns. Persisted. */}
              <Button
                type="button"
                variant={groupByRole ? "primary" : "outline"}
                size="icon-sm"
                aria-pressed={groupByRole}
                aria-label="Group board by role"
                title={
                  groupByRole
                    ? "Grouped into role swimlanes — click for flat columns"
                    : "Group into role swimlanes"
                }
                onClick={() => setGroupByRolePersisted(!groupByRole)}
              >
                <Rows3 className="h-4 w-4" />
              </Button>
            </>
          ) : null}

          {/* Empty-columns switch — three-position segmented control matching
              the Kanban/Graph view switch. Active position is filled; clicking
              another position swaps it and persists immediately. Hidden in
              swimlane mode, where every (role, status) cell is always shown. */}
          <div
            className={cn(
              "border-border inline-flex items-center rounded-md border p-0.5",
              groupByRole && "hidden",
            )}
            role="radiogroup"
            aria-label="Empty columns"
          >
            {(
              [
                { id: "hide", label: "Hide" },
                { id: "collapse", label: "Collapse" },
                { id: "show", label: "Show" },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={emptyMode === m.id}
                title={`${m.label} empty columns`}
                onClick={() => setEmptyModePersisted(m.id)}
                className={cn(
                  "inline-flex items-center rounded-sm px-2.5 py-1 text-xs transition-colors",
                  emptyMode === m.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Secondary actions behind a "More" menu to keep the toolbar lean:
              schedule and plan tickets. Their dialogs are controlled by
              scheduleOpen/planOpen, opened from the items. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="More board actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!activeProjectId}
                onSelect={() => setTimeout(() => setScheduleOpen(true), 0)}
              >
                <CalendarClock className="h-3.5 w-3.5" /> Schedule…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!activeProjectId}
                onSelect={() => setTimeout(() => setPlanOpen(true), 0)}
              >
                <Sparkles className="h-3.5 w-3.5" /> Plan tickets…
              </DropdownMenuItem>
              {/* The project audit PDF. Async by nature (see useProjectExport),
                  so this fires a job and the hook toasts its way to the
                  download — unlike the per-ticket export, which is a plain
                  streamed link in the drawer. Needs a project: "All projects"
                  mode has no single board to export. */}
              <DropdownMenuItem
                disabled={!activeProjectId || projectExport.busy}
                onSelect={() => {
                  // Let the menu close before the fetch, same posture as the
                  // dialog items above.
                  setTimeout(() => void projectExport.start(), 0);
                }}
              >
                {projectExport.busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileDown className="h-3.5 w-3.5" />
                )}
                {projectExport.busy ? "Building PDF…" : "Export project PDF…"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Controlled dialogs for the "More" items above — render no button. */}
          <ScheduleButton
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
            activeProjectId={activeProjectId}
            activeProjectName={activeProjectName}
            backlogCount={optimistic.filter((t) => t.status === "backlog").length}
          />
          <PlanSheetButton
            open={planOpen}
            onOpenChange={setPlanOpen}
            activeProjectId={activeProjectId}
            projectName={activeProjectName}
          />
          <NewTicketButton catalog={roleCatalog} tenantId={tenantId} />
        </div>
      </header>

      {viewMode === "kanban" && isBoardEmpty ? (
        <FirstRunPanel disabled={!activeProjectId} />
      ) : viewMode === "kanban" && groupByRole ? (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <BoardSwimlanes
            columns={COLUMNS}
            lanes={lanes}
            ticketsByColumn={ticketsByColumn}
            onOpenTicket={setOpenTicketId}
            density={density}
            reducedMotion={reducedMotion}
          />
          <DragOverlay>
            {activeTicket ? (
              <TicketCard
                ticket={activeTicket}
                dragging
                density={density}
                reducedMotion={reducedMotion}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : viewMode === "kanban" ? (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="flex flex-1 gap-4 overflow-x-auto overflow-y-hidden px-6 py-5">
            {COLUMNS.map((col) => {
              const isBacklog = col.id === "backlog";
              const canSelect = SELECTABLE_COLUMNS.has(col.id);
              const colTickets = ticketsByColumn.get(col.id) ?? [];
              const isEmpty = colTickets.length === 0;
              // "Hide" mode: drop empties from the board entirely. The
              // selection-mode column is never hidden.
              if (hideEmptyColumns && isEmpty && selectionMode !== col.id) {
                return null;
              }
              // Resolved collapse state. Two rules in priority order:
              //   1. In "collapse" mode, empty columns ALWAYS collapse — the
              //      global switch is authoritative for empties, so legacy
              //      per-column overrides (incl. stored `false` from older
              //      UI iterations) can't leave one stuck expanded.
              //   2. Otherwise, the per-column override wins, defaulting to
              //      expanded when none is set.
              // Selection-mode column is force-expanded (you can't bulk-act
              // on a hidden list).
              const override = collapseOverrides[col.id];
              const raw = collapseEmptyColumns && isEmpty ? true : (override ?? false);
              const collapsed = raw && selectionMode !== col.id;
              return (
                <Column
                  key={col.id}
                  column={col}
                  tickets={colTickets}
                  onOpenTicket={setOpenTicketId}
                  density={density}
                  reducedMotion={reducedMotion}
                  collapsed={collapsed}
                  onToggleCollapse={() => toggleColumnCollapsed(col.id, !collapsed)}
                  selection={
                    canSelect
                      ? {
                          // Mode is true only for the column that currently
                          // owns selection; the other selectable columns
                          // still render the toggle (so the operator can
                          // switch into them) but with mode=false.
                          mode: selectionMode === col.id,
                          selectedIds: selectionMode === col.id ? selectedIds : new Set(),
                          inFlight: bulkInFlight,
                          onToggleMode: () => {
                            // Toggle: open if not on us, close if on us.
                            // Switching from one column to another exits
                            // the previous selection (clears selectedIds).
                            if (selectionMode === col.id) exitSelectionMode();
                            else {
                              setSelectedIds(new Set());
                              setSelectionMode(col.id);
                            }
                          },
                          onToggleTicket: toggleSelected,
                          onCancel: exitSelectionMode,
                          onDelete: runBulkDelete,
                          // Move-to-Ready only on Backlog. Terminal columns
                          // (Done, Failed) omit it — Column hides the
                          // button when this is undefined.
                          onMoveToReady: isBacklog ? runBulkMoveToReady : undefined,
                          onSetPriority: runBulkSetPriority,
                          onAddLabel: runBulkAddLabel,
                          labelCatalog,
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
          <DragOverlay>
            {activeTicket ? (
              <TicketCard
                ticket={activeTicket}
                dragging
                density={density}
                reducedMotion={reducedMotion}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <div className="flex-1 overflow-hidden">
          <BoardGraph
            tickets={optimistic}
            dependencies={[...(dependencies ?? [])]}
            onOpenTicket={setOpenTicketId}
          />
        </div>
      )}

      <TicketDrawer
        ticket={openTicket}
        open={openTicketId !== null}
        onOpenChange={(o) => !o && setOpenTicketId(null)}
      />
    </>
  );
}
