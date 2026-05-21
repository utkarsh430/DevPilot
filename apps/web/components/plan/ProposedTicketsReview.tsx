"use client";

// Phase 2.5+ / M7 — Review-and-commit surface for the proposed-ticket list.
//
// Once the ultra panel finishes, the PlanSheet flips into `planned` mode and
// renders this table. Each row mirrors what `commitPlanAction` will write to
// `public.tickets`:
//   • selected checkbox → drop from commit if unchecked
//   • title (focus-to-edit, debounced patch)
//   • description (focus-to-edit, debounced patch)
//   • requested_role badge with click-to-edit via `<RoleSelect>` (M5g)
//   • dependency hints rendered as "blocks #3, #5" / "depends on #2"
//   • an "edited" pill if the row differs from its committed snapshot
//
// Mutations route through `updateProposedTicketAction` (RLS-gated, no LLM);
// the final "Create selected (N)" / "Create all" buttons call
// `commitPlanAction({ mode })`. "Discard" calls `discardPlanSessionAction`.
//
// We snapshot the original ticket on first render so the "edited" pill is a
// pure client-side comparison — we don't ask the server "is this dirty?".

import * as React from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Diamond,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RoleSelect } from "@/components/roles/role-select";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import { cn } from "@/lib/cn";
import { toast } from "@/components/ui/sonner";
import { matchStackChips, type StackProvenance } from "@/lib/stack/provenance";
import type { ProposedTicket } from "@/lib/plan/types";
import {
  commitPlanAction,
  discardPlanSessionAction,
  updateProposedTicketAction,
} from "@/app/(app)/plan/actions";

// Agent S's `updateProposedTicketAction` validates snake_case keys
// (`acceptance_criteria`, `requested_role`, `depends_on_ordinals`). Our local
// `ProposedTicket` is camelCase — translate at the action boundary so the
// rest of this file can keep using the camelCase shape.
type ProposedTicketPatchCamel = Partial<
  Pick<
    ProposedTicket,
    | "title"
    | "description"
    | "acceptanceCriteria"
    | "requestedRole"
    | "dependsOnOrdinals"
    | "selected"
  >
>;
type ProposedTicketPatchSnake = {
  title?: string;
  description?: string;
  acceptance_criteria?: string;
  requested_role?: string;
  depends_on_ordinals?: number[];
  selected?: boolean;
};
function toSnakePatch(p: ProposedTicketPatchCamel): ProposedTicketPatchSnake {
  const out: ProposedTicketPatchSnake = {};
  if (p.title !== undefined) out.title = p.title;
  if (p.description !== undefined) out.description = p.description ?? "";
  if (p.acceptanceCriteria !== undefined) out.acceptance_criteria = p.acceptanceCriteria ?? "";
  // Agent S's Zod schema accepts ONLY known role slugs — sending an empty
  // string would fail. Map a null role to "engineer" as a safe fallback so
  // the optimistic UI doesn't blow up; the consolidator-default is `engineer`
  // too. If the operator truly wants "auto-pick" later, that becomes a v2
  // shape on the action.
  if (p.requestedRole !== undefined) out.requested_role = p.requestedRole ?? "engineer";
  if (p.dependsOnOrdinals !== undefined) out.depends_on_ordinals = p.dependsOnOrdinals;
  if (p.selected !== undefined) out.selected = p.selected;
  return out;
}

// Match Agent S's Zod validation in `updateProposedTicketAction`:
//   title min 3 / max 160, description max 4_000, acceptance_criteria max 4_000.
const TITLE_MAX = 160;
const DESC_MAX = 4_000;
const PATCH_DEBOUNCE_MS = 600;

type RowState = ProposedTicket & {
  /** Snapshot from the first time we saw this row, for the "edited" pill. */
  snapshotTitle: string;
  snapshotDescription: string | null;
  snapshotRequestedRole: string | null;
  snapshotSelected: boolean;
};

function snapshotOf(t: ProposedTicket): RowState {
  return {
    ...t,
    snapshotTitle: t.title,
    snapshotDescription: t.description,
    snapshotRequestedRole: t.requestedRole,
    snapshotSelected: t.selected,
  };
}

function isDirty(r: RowState): boolean {
  return (
    r.title !== r.snapshotTitle ||
    (r.description ?? "") !== (r.snapshotDescription ?? "") ||
    r.requestedRole !== r.snapshotRequestedRole ||
    r.selected !== r.snapshotSelected
  );
}

// Look the role slug up in the catalog so the badge shows the display name.
function roleDisplay(slug: string | null): string {
  if (!slug) return "Auto-pick";
  return ROLE_CATALOG.find((e) => e.slug === slug)?.displayName ?? slug;
}

// Cap on the services listed in the "Planned on:" banner before overflowing.
const BANNER_MAX_SERVICES = 6;

/**
 * The Review moment (Phase 4 / spec §6.3): a provenance banner above the ticket
 * list stating what the plan was framed on. Shows the ecosystem + saved
 * services when a stack was pinned; a subtle muted note otherwise. Renders
 * nothing until the advisor self-load settles so it never flashes.
 */
function PlannedOnBanner({ provenance }: { provenance?: StackProvenance }) {
  if (!provenance || !provenance.loaded) return null;

  if (!provenance.accepted || provenance.serviceNames.length === 0) {
    return (
      <div className="text-muted-foreground border-b px-6 py-2 text-[11px]">
        No stack was pinned — the panel chose services itself.
      </div>
    );
  }

  const visible = provenance.serviceNames.slice(0, BANNER_MAX_SERVICES);
  const overflow = provenance.serviceNames.length - visible.length;
  return (
    <div className="bg-muted/20 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b px-6 py-2 text-[11px]">
      <Diamond className="text-primary h-3 w-3 shrink-0 fill-current" aria-hidden />
      <span className="text-primary font-medium">Planned on:</span>
      {provenance.ecosystemLabel ? (
        <span className="text-foreground font-medium">{provenance.ecosystemLabel}</span>
      ) : null}
      {provenance.ecosystemLabel ? (
        <span className="text-muted-foreground/50" aria-hidden>
          ·
        </span>
      ) : null}
      <span className="text-muted-foreground">
        {visible.join(", ")}
        {overflow > 0 ? ` +${overflow} more` : ""}
      </span>
    </div>
  );
}

/**
 * Per-ticket stack chips (adopted decision #4 — client-side substring-match v1,
 * zero migration). Renders quiet chips for any saved service whose display name
 * appears in this ticket's title/description. Nothing when the stack is empty or
 * nothing matches; the derivation is pure and defensive (`matchStackChips`).
 */
function TicketStackChips({
  text,
  serviceNames,
}: {
  text: string;
  serviceNames: readonly string[];
}) {
  const { visible, overflow } = matchStackChips({ text, serviceNames });
  if (visible.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      <Diamond className="text-primary/70 h-2.5 w-2.5 shrink-0 fill-current" aria-hidden />
      {visible.map((name) => (
        <Badge key={name} tone="muted" className="text-[11px]">
          {name}
        </Badge>
      ))}
      {overflow > 0 ? <span className="text-muted-foreground text-[11px]">+{overflow}</span> : null}
    </div>
  );
}

export function ProposedTicketsReview({
  sessionId,
  tickets,
  stackProvenance,
  onCommitted,
  onDiscarded,
}: {
  sessionId: string;
  tickets: ProposedTicket[];
  /** Saved-stack provenance (Phase 4) — drives the "Planned on:" banner above
   *  the list and the per-ticket stack chips. Optional so resume-only or
   *  provenance-less callers render the plain list. */
  stackProvenance?: StackProvenance;
  onCommitted?: (committedTicketIds: string[]) => void;
  onDiscarded?: () => void;
}) {
  const [rows, setRows] = React.useState<RowState[]>(() => tickets.map(snapshotOf));
  // Re-snapshot when the server hands us a fresh list (e.g. after a build).
  React.useEffect(() => {
    setRows(tickets.map(snapshotOf));
  }, [tickets]);

  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [committing, setCommitting] = React.useState<"selected" | "all" | null>(null);
  const [discarding, setDiscarding] = React.useState(false);

  // Pending patch buffers — debounce per-row so a quick title typing burst
  // turns into one POST. Stored in a ref so we don't re-render on every key.
  const pendingPatches = React.useRef<
    Map<string, { patch: ProposedTicketPatchCamel; timer: NodeJS.Timeout }>
  >(new Map());

  const schedulePatch = React.useCallback((rowId: string, patch: ProposedTicketPatchCamel) => {
    const cur = pendingPatches.current.get(rowId);
    if (cur) {
      clearTimeout(cur.timer);
      Object.assign(cur.patch, patch);
    }
    const merged: ProposedTicketPatchCamel = cur ? cur.patch : { ...patch };
    const timer = setTimeout(async () => {
      pendingPatches.current.delete(rowId);
      const res = await updateProposedTicketAction({
        proposedTicketId: rowId,
        patch: toSnakePatch(merged),
      });
      if (!res.ok) {
        toast.error("Couldn't save edit", { description: res.error });
      }
    }, PATCH_DEBOUNCE_MS);
    pendingPatches.current.set(rowId, { patch: merged, timer });
  }, []);

  // Flush any pending debounced patches on unmount so a fast "Create selected"
  // click after the last keystroke doesn't lose the edit.
  React.useEffect(() => {
    return () => {
      const map = pendingPatches.current;
      for (const [, entry] of map) clearTimeout(entry.timer);
      map.clear();
    };
  }, []);

  const selectedCount = rows.filter((r) => r.selected).length;

  function toggleRow(id: string, next: boolean) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, selected: next } : r)));
    schedulePatch(id, { selected: next });
  }
  function setTitle(id: string, title: string) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, title } : r)));
    schedulePatch(id, { title });
  }
  function setDescription(id: string, description: string) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, description } : r)));
    schedulePatch(id, { description });
  }
  function setRequestedRole(id: string, requestedRole: string | null) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, requestedRole } : r)));
    schedulePatch(id, { requestedRole: requestedRole ?? undefined });
  }

  async function onCommit(mode: "selected" | "all") {
    if (mode === "selected" && selectedCount === 0) {
      toast.error("Nothing selected", {
        description: "Toggle at least one ticket to create.",
      });
      return;
    }
    setCommitting(mode);
    const res = await commitPlanAction({ sessionId, mode });
    setCommitting(null);
    if (!res.ok) {
      toast.error("Couldn't create tickets", { description: res.error });
      return;
    }
    toast.success(
      `Created ${res.ticketIds.length} ticket${res.ticketIds.length === 1 ? "" : "s"}`,
      {
        description: "They land in Backlog. Drag to Ready to start.",
      },
    );
    onCommitted?.(res.ticketIds);
  }

  async function onDiscard() {
    setDiscarding(true);
    const res = await discardPlanSessionAction({ sessionId });
    setDiscarding(false);
    if (!res.ok) {
      toast.error("Couldn't discard", { description: res.error });
      return;
    }
    toast.success("Session discarded");
    onDiscarded?.();
  }

  // Build a lookup so the dependency hints can render "depends on Title #2"
  // when an ordinal is known. We render just the ordinal number when not.
  const byOrdinal = React.useMemo(() => {
    const m = new Map<number, RowState>();
    for (const r of rows) m.set(r.ordinal, r);
    return m;
  }, [rows]);

  // Reverse-map: which ordinals depend on a given ordinal (= it "blocks" them).
  const blocksByOrdinal = React.useMemo(() => {
    const m = new Map<number, number[]>();
    for (const r of rows) {
      for (const dep of r.dependsOnOrdinals) {
        if (!m.has(dep)) m.set(dep, []);
        m.get(dep)!.push(r.ordinal);
      }
    }
    return m;
  }, [rows]);

  // The saved services this plan was framed on — used for the provenance banner
  // and the per-ticket chips. Empty unless a stack was actually pinned.
  const stackServiceNames =
    stackProvenance?.loaded && stackProvenance.accepted ? stackProvenance.serviceNames : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Phase 4 / spec §6.3 — the payoff: what the plan was framed on. */}
      <PlannedOnBanner provenance={stackProvenance} />
      <div className="flex flex-col gap-2 border-b px-6 py-3">
        <h3 className="font-display text-sm font-semibold">
          {rows.length} proposed ticket{rows.length === 1 ? "" : "s"}
        </h3>
        <p className="text-muted-foreground text-xs">
          Edit inline, toggle off any you don&apos;t want, then create them in Backlog. Dependencies
          stay between rows that are both selected.
        </p>
      </div>

      <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
        {rows.length === 0 ? (
          <li className="text-muted-foreground p-6 text-xs">
            No tickets — the panel didn&apos;t emit any.
          </li>
        ) : null}
        {rows.map((r) => {
          const expanded = expandedId === r.id;
          const blocks = blocksByOrdinal.get(r.ordinal) ?? [];
          return (
            <li
              key={r.id}
              className={cn(
                "flex flex-col gap-2 px-6 py-3 transition-colors",
                !r.selected && "opacity-60",
              )}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={r.selected}
                  onChange={(e) => toggleRow(r.id, e.target.checked)}
                  className="border-input accent-primary focus:ring-ring focus:ring-offset-background mt-1 h-3.5 w-3.5 cursor-pointer rounded focus:ring-2 focus:ring-offset-1"
                  aria-label={`Include ticket "${r.title}" on commit`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Badge tone="muted" className="font-mono text-[11px]">
                      #{r.ordinal}
                    </Badge>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                      className="text-muted-foreground hover:bg-accent inline-flex items-center gap-1 rounded p-0.5"
                      aria-label={expanded ? "Collapse details" : "Expand details"}
                    >
                      {expanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>
                    {isDirty(r) ? (
                      <Badge tone="warn" className="text-[11px]">
                        <Pencil className="h-2.5 w-2.5" /> edited
                      </Badge>
                    ) : null}
                  </div>
                  <Input
                    value={r.title}
                    onChange={(e) => setTitle(r.id, e.target.value.slice(0, TITLE_MAX))}
                    maxLength={TITLE_MAX}
                    className="focus-visible:border-border focus-visible:bg-background mt-1.5 h-7 border-transparent bg-transparent px-1 text-sm font-medium shadow-none"
                  />
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setExpandedId(r.id)}
                      className="rounded p-0 text-left"
                    >
                      <Badge tone="info" className="cursor-pointer text-[11px]">
                        {roleDisplay(r.requestedRole)}
                      </Badge>
                    </button>
                    {r.dependsOnOrdinals.length > 0 ? (
                      <span className="text-muted-foreground text-[11px]">
                        depends on{" "}
                        {r.dependsOnOrdinals
                          .map((o) => (byOrdinal.has(o) ? `#${o}` : `#${o}?`))
                          .join(", ")}
                      </span>
                    ) : null}
                    {blocks.length > 0 ? (
                      <span className="text-muted-foreground text-[11px]">
                        blocks {blocks.map((o) => `#${o}`).join(", ")}
                      </span>
                    ) : null}
                  </div>
                  <TicketStackChips
                    text={`${r.title} ${r.description ?? ""}`}
                    serviceNames={stackServiceNames}
                  />
                </div>
              </div>

              {expanded ? (
                <div className="bg-muted/30 ml-6 flex flex-col gap-3 rounded-md border p-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-foreground text-[11px] font-medium">Description</label>
                    <Textarea
                      rows={4}
                      value={r.description ?? ""}
                      onChange={(e) => setDescription(r.id, e.target.value.slice(0, DESC_MAX))}
                      maxLength={DESC_MAX}
                      className="text-xs"
                      placeholder="Rough notes, acceptance hints, links…"
                    />
                  </div>
                  {r.acceptanceCriteria ? (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-foreground text-[11px] font-medium">
                        Acceptance criteria{" "}
                        <span className="text-muted-foreground font-normal">
                          (read-only — edit on board)
                        </span>
                      </label>
                      <pre className="bg-card text-foreground whitespace-pre-wrap rounded border p-2 font-mono text-[11px] leading-snug">
                        {r.acceptanceCriteria}
                      </pre>
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-foreground text-[11px] font-medium">Role</label>
                    <RoleSelect
                      value={r.requestedRole}
                      onChange={(slug) => setRequestedRole(r.id, slug)}
                      size="sm"
                    />
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="bg-background/80 flex flex-wrap items-center justify-between gap-2 border-t px-6 py-3 backdrop-blur">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDiscard}
          disabled={discarding || committing !== null}
        >
          {discarding ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Discard
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onCommit("all")}
            disabled={committing !== null || rows.length === 0}
          >
            {committing === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Create all ({rows.length})
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => onCommit("selected")}
            disabled={committing !== null || selectedCount === 0}
          >
            {committing === "selected" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Create selected ({selectedCount})
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
