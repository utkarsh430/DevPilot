"use client";

// The lessons TABLE view — the scan-everything-at-once counterpart to the card
// review stack. With dozens of candidates, one-card-at-a-time is too slow to be
// usable: this view exists so an operator can see the whole queue, sweep the
// obviously-safe grades in one action, and hand-decide only what genuinely needs
// it.
//
// ── Where the logic lives ──
// Nothing here decides WHICH rows an action touches. Filtering, sorting,
// searching, select-all-matching and (critically) the confidence-driven bulk
// targets are all the pure `lib/learning/table-view.ts`, unit-tested under node.
// This file is presentation + wiring only, so the safety rule — an UNGRADED row
// (confidence null) is never swept into a confidence-based approval — has one
// home and one test, not a second copy drifting in JSX.
//
// ── URL as the source of truth for the query ──
// The active filter/sort/search round-trips through the query string, so a
// filtered view is shareable and survives a refresh. `router.replace` with
// `scroll: false` keeps it out of the back-stack noise.

import * as React from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ListFilter,
  Search,
  X,
} from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { bulkApproveLearningsAction, bulkRejectLearningsAction } from "@/lib/learning/actions";
import {
  applyLessonQuery,
  CONFIDENCE_FILTER_VALUES,
  confidenceBulkTargets,
  DEFAULT_LESSON_QUERY,
  facetOptions,
  LEARNING_STATUSES,
  type LessonQuery,
  type LessonTableRow,
  nextSort,
  pruneSelection,
  selectAllMatchingIds,
  type SortKey,
  toggleFacet,
} from "@/lib/learning/table-view";
import { LESSON_SCOPES } from "@/lib/learning/extract";
import { ConfidenceBadge, ConfidenceReason } from "./confidence-badge";
import { humanizeSlug, MISTAKE_LABEL, SCOPE_TONE } from "./shared-meta";

/** A pending bulk confirmation. `label` is the human phrase for the dialog. */
type PendingBulk = {
  kind: "approve" | "reject";
  ids: string[];
  label: string;
};

export function LessonsTable({
  rows,
  query,
  onQueryChange,
  onMutated,
}: {
  rows: LessonTableRow[];
  query: LessonQuery;
  onQueryChange: (next: LessonQuery) => void;
  onMutated: () => void;
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState<PendingBulk | null>(null);
  const [busy, setBusy] = React.useState(false);

  const visible = React.useMemo(() => applyLessonQuery(rows, query), [rows, query]);
  const options = React.useMemo(() => facetOptions(rows), [rows]);

  // A narrowed filter must not leave invisible rows armed for a bulk action.
  React.useEffect(() => {
    setSelected((prev) => {
      const next = pruneSelection(prev, visible);
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);

  const highTargets = React.useMemo(
    () => confidenceBulkTargets(rows, ["high"], query),
    [rows, query],
  );
  const highMediumTargets = React.useMemo(
    () => confidenceBulkTargets(rows, ["high", "medium"], query),
    [rows, query],
  );

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));

  const patch = React.useCallback(
    (over: Partial<LessonQuery>) => onQueryChange({ ...query, ...over }),
    [onQueryChange, query],
  );

  const toggleRow = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleExpand = React.useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // One id or many, the write is the same action — the ONLY difference is
  // whether a confirm dialog gates it (see `runRowAction` below).
  async function apply(kind: "approve" | "reject", ids: string[]) {
    setBusy(true);
    const res =
      kind === "approve"
        ? await bulkApproveLearningsAction({ ids })
        : await bulkRejectLearningsAction({ ids });
    setBusy(false);
    setPending(null);
    if (!res.ok) {
      toast.error(res.error || "Action failed");
      return;
    }
    const n = "approved" in res ? res.approved : res.rejected;
    toast.success(
      kind === "approve"
        ? `${n} ${n === 1 ? "lesson" : "lessons"} activated`
        : `${n} ${n === 1 ? "lesson" : "lessons"} rejected`,
    );
    setSelected(new Set());
    onMutated();
  }

  // A single-row ✓/✕ is one deliberate click on one visible row — the same
  // weight as Accept/Reject in the card view, which has no confirm either. Only
  // the MULTI-row paths (which can settle dozens at once, some off-screen) are
  // gated by the dialog.
  const runRowAction = (kind: "approve" | "reject", id: string) => void apply(kind, [id]);

  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        query={query}
        patch={patch}
        options={options}
        visibleCount={visible.length}
        totalCount={rows.length}
      />

      <BulkBar
        selectedCount={selected.size}
        highCount={highTargets.length}
        highMediumCount={highMediumTargets.length}
        busy={busy}
        onAcceptHigh={() =>
          setPending({ kind: "approve", ids: highTargets, label: "high confidence" })
        }
        onAcceptHighMedium={() =>
          setPending({
            kind: "approve",
            ids: highMediumTargets,
            label: "high and medium confidence",
          })
        }
        onAcceptSelected={() =>
          setPending({ kind: "approve", ids: [...selected], label: "selected" })
        }
        onRejectSelected={() =>
          setPending({ kind: "reject", ids: [...selected], label: "selected" })
        }
        onSelectAllMatching={() => setSelected(new Set(selectAllMatchingIds(rows, query)))}
        onClearSelection={() => setSelected(new Set())}
        matchingCount={visible.length}
        allMatchingSelected={allVisibleSelected}
      />

      <div className="bg-card overflow-hidden rounded-xl border">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-10 pl-4">
                <Checkbox
                  checked={allVisibleSelected}
                  indeterminate={!allVisibleSelected && visible.some((r) => selected.has(r.id))}
                  disabled={visible.length === 0}
                  ariaLabel="Select all rows on screen"
                  onChange={() =>
                    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((r) => r.id)))
                  }
                />
              </TableHead>
              <TableHead className="w-8" />
              <SortableHead query={query} patch={patch} sortKey="confidence" className="w-32">
                Confidence
              </SortableHead>
              <SortableHead query={query} patch={patch} sortKey="scope" className="w-24">
                Scope
              </SortableHead>
              <SortableHead
                query={query}
                patch={patch}
                sortKey="role"
                className="hidden w-32 lg:table-cell"
              >
                Role
              </SortableHead>
              <SortableHead
                query={query}
                patch={patch}
                sortKey="category"
                className="hidden w-32 xl:table-cell"
              >
                Category
              </SortableHead>
              <SortableHead query={query} patch={patch} sortKey="body">
                Lesson
              </SortableHead>
              <SortableHead
                query={query}
                patch={patch}
                sortKey="mistake"
                className="hidden w-36 xl:table-cell"
              >
                Source
              </SortableHead>
              <SortableHead
                query={query}
                patch={patch}
                sortKey="status"
                className="hidden w-24 lg:table-cell"
              >
                Status
              </SortableHead>
              <SortableHead
                query={query}
                patch={patch}
                sortKey="created"
                className="hidden w-24 lg:table-cell"
              >
                Created
              </SortableHead>
              <TableHead className="w-24 pr-4 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={11} className="text-muted-foreground py-16 text-center text-sm">
                  {rows.length === 0
                    ? "No lessons yet — they appear here as agents make (and the system learns from) mistakes."
                    : "No lessons match these filters."}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => (
                <LessonRow
                  key={row.id}
                  row={row}
                  selected={selected.has(row.id)}
                  expanded={expanded.has(row.id)}
                  busy={busy}
                  onToggleSelect={() => toggleRow(row.id)}
                  onToggleExpand={() => toggleExpand(row.id)}
                  onAccept={() => runRowAction("approve", row.id)}
                  onReject={() => runRowAction("reject", row.id)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <ConfirmBulkDialog
        pending={pending}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => pending && void apply(pending.kind, pending.ids)}
      />
    </div>
  );
}

/* ─────────────────────────────── toolbar ──────────────────────────────── */

function Toolbar({
  query,
  patch,
  options,
  visibleCount,
  totalCount,
}: {
  query: LessonQuery;
  patch: (over: Partial<LessonQuery>) => void;
  options: { roles: string[]; categories: string[] };
  visibleCount: number;
  totalCount: number;
}) {
  const narrowed =
    query.search.trim().length > 0 ||
    query.confidence.length > 0 ||
    query.scope.length > 0 ||
    query.role.length > 0 ||
    query.category.length > 0 ||
    query.status.join(",") !== DEFAULT_LESSON_QUERY.status.join(",");

  return (
    <div className="bg-card flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
          <Input
            value={query.search}
            placeholder="Search lesson text, category, role or grading reason…"
            aria-label="Search lessons"
            className="pl-9"
            onChange={(e) => patch({ search: e.target.value })}
          />
        </div>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {visibleCount} of {totalCount}
        </span>
        {narrowed && (
          <Button size="sm" variant="ghost" onClick={() => patch(DEFAULT_LESSON_QUERY)}>
            <X /> Clear filters
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t pt-3">
        <div className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider">
          <ListFilter className="h-3 w-3" /> Filters
        </div>
        <div className="flex flex-col gap-2">
          <FacetRow label="Confidence">
            {CONFIDENCE_FILTER_VALUES.map((v) => (
              <FilterChip
                key={v}
                active={query.confidence.includes(v)}
                onClick={() => patch({ confidence: toggleFacet(query.confidence, v) })}
              >
                {v}
              </FilterChip>
            ))}
          </FacetRow>
          <FacetRow label="Status">
            {LEARNING_STATUSES.map((s) => (
              <FilterChip
                key={s}
                active={query.status.includes(s)}
                onClick={() => patch({ status: toggleFacet(query.status, s) })}
              >
                {s}
              </FilterChip>
            ))}
          </FacetRow>
          <FacetRow label="Scope">
            {LESSON_SCOPES.map((s) => (
              <FilterChip
                key={s}
                active={query.scope.includes(s)}
                onClick={() => patch({ scope: toggleFacet(query.scope, s) })}
              >
                {s}
              </FilterChip>
            ))}
          </FacetRow>
          {options.roles.length > 0 && (
            <FacetRow label="Role">
              {options.roles.map((r) => (
                <FilterChip
                  key={r}
                  active={query.role.includes(r)}
                  onClick={() => patch({ role: toggleFacet(query.role, r) })}
                >
                  {humanizeSlug(r)}
                </FilterChip>
              ))}
            </FacetRow>
          )}
          {options.categories.length > 0 && (
            <FacetRow label="Category">
              {options.categories.map((c) => (
                <FilterChip
                  key={c}
                  active={query.category.includes(c)}
                  onClick={() => patch({ category: toggleFacet(query.category, c) })}
                >
                  {humanizeSlug(c)}
                </FilterChip>
              ))}
            </FacetRow>
          )}
        </div>
      </div>
    </div>
  );
}

function FacetRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
      <span className="text-muted-foreground w-20 shrink-0 text-xs">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2 py-0.5 text-xs font-medium capitalize transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────── bulk bar ─────────────────────────────── */

function BulkBar({
  selectedCount,
  highCount,
  highMediumCount,
  matchingCount,
  allMatchingSelected,
  busy,
  onAcceptHigh,
  onAcceptHighMedium,
  onAcceptSelected,
  onRejectSelected,
  onSelectAllMatching,
  onClearSelection,
}: {
  selectedCount: number;
  highCount: number;
  highMediumCount: number;
  matchingCount: number;
  allMatchingSelected: boolean;
  busy: boolean;
  onAcceptHigh: () => void;
  onAcceptHighMedium: () => void;
  onAcceptSelected: () => void;
  onRejectSelected: () => void;
  onSelectAllMatching: () => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="bg-card flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || highCount === 0}
          onClick={onAcceptHigh}
        >
          <Check /> Accept all high confidence ({highCount})
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || highMediumCount === 0}
          onClick={onAcceptHighMedium}
        >
          <Check /> Accept all high + medium ({highMediumCount})
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {selectedCount > 0 ? (
          <>
            <span className="text-muted-foreground text-xs tabular-nums">
              {selectedCount} selected
            </span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={onAcceptSelected}>
              <Check /> Accept selected
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onRejectSelected}>
              <X /> Reject selected
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClearSelection}>
              Clear
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || matchingCount === 0 || allMatchingSelected}
            onClick={onSelectAllMatching}
          >
            Select all {matchingCount} matching
          </Button>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────── the rows ────────────────────────────── */

function LessonRow({
  row,
  selected,
  expanded,
  busy,
  onToggleSelect,
  onToggleExpand,
  onAccept,
  onReject,
}: {
  row: LessonTableRow;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <>
      <TableRow data-state={selected ? "selected" : undefined} className="align-top">
        <TableCell className="pl-4">
          <Checkbox
            checked={selected}
            onChange={onToggleSelect}
            ariaLabel={`Select lesson: ${row.body.slice(0, 60)}`}
          />
        </TableCell>
        <TableCell className="px-0">
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse details" : "Expand details"}
            className="text-muted-foreground hover:text-foreground rounded p-1"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </TableCell>
        <TableCell>
          <ConfidenceBadge confidence={row.confidence} />
        </TableCell>
        <TableCell>
          <Badge tone={SCOPE_TONE[row.scope]}>{row.scope}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground hidden truncate font-mono text-xs lg:table-cell">
          {row.roleSlug ?? "—"}
        </TableCell>
        <TableCell className="text-muted-foreground hidden text-xs xl:table-cell">
          {humanizeSlug(row.category)}
        </TableCell>
        <TableCell>
          <button
            type="button"
            onClick={onToggleExpand}
            className="text-foreground line-clamp-2 max-w-[52ch] text-left text-sm leading-snug hover:underline"
            title={row.body}
          >
            {row.body}
          </button>
        </TableCell>
        <TableCell className="hidden xl:table-cell">
          {row.mistake ? (
            <Badge tone="muted">{MISTAKE_LABEL[row.mistake.type] ?? row.mistake.type}</Badge>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
        <TableCell className="hidden lg:table-cell">
          <StatusBadge status={row.status} />
        </TableCell>
        <TableCell className="text-muted-foreground hidden whitespace-nowrap text-xs tabular-nums lg:table-cell">
          {formatDate(row.createdAt)}
        </TableCell>
        <TableCell className="pr-4">
          <div className="flex items-center justify-end gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy || row.status === "active"}
              onClick={onAccept}
              title="Accept"
              aria-label="Accept lesson"
            >
              <Check className="text-success" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy || row.status === "rejected"}
              onClick={onReject}
              title="Reject"
              aria-label="Reject lesson"
            >
              <X className="text-destructive" />
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={11} className="bg-muted/30 px-4 py-4">
            <ExpandedDetail row={row} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ExpandedDetail({ row }: { row: LessonTableRow }) {
  const m = row.mistake;
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <Section title="Lesson">
          <p className="text-foreground text-sm leading-relaxed">{row.body}</p>
        </Section>
        <Section title="Confidence">
          <div className="flex flex-col gap-1.5">
            <ConfidenceBadge confidence={row.confidence} className="w-fit" />
            {row.confidence ? (
              <ConfidenceReason reason={row.confidenceReason} />
            ) : (
              <p className="text-muted-foreground text-xs">
                Not graded yet — bulk approval by confidence skips this lesson, so it stays here for
                your call.
              </p>
            )}
          </div>
        </Section>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Section title="Extracted from">
          {m ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="warn">{MISTAKE_LABEL[m.type] ?? m.type}</Badge>
                <span className="text-muted-foreground text-xs">
                  by <span className="text-foreground font-medium">{m.role}</span>
                </span>
              </div>
              {m.evidenceSummary && (
                <pre className="bg-background text-muted-foreground max-h-40 overflow-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-xs">
                  {m.evidenceSummary}
                </pre>
              )}
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {m.runId && (
                  <Link
                    href={`/runs/${m.runId}`}
                    className="text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" /> Run {m.runId.slice(0, 8)}
                  </Link>
                )}
                {m.ticketId && (
                  <Link
                    href={`/board?ticket=${m.ticketId}`}
                    className="text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" /> {m.ticketKey ?? "Ticket"}
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm italic">
              Source mistake no longer available.
            </p>
          )}
        </Section>
        <Section title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Scope</dt>
            <dd className="text-foreground">
              {row.scope === "role" && row.roleSlug ? `role · ${row.roleSlug}` : row.scope}
            </dd>
            <dt className="text-muted-foreground">Category</dt>
            <dd className="text-foreground">{humanizeSlug(row.category)}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd className="text-foreground">{row.status}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd className="text-foreground tabular-nums">{formatDate(row.createdAt)}</dd>
          </dl>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wider">
        {title}
      </div>
      {children}
    </div>
  );
}

/* ───────────────────────────── confirm dialog ─────────────────────────── */

function ConfirmBulkDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingBulk | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = pending?.ids.length ?? 0;
  const noun = n === 1 ? "lesson" : "lessons";
  const approving = pending?.kind === "approve";

  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {approving ? "Approve" : "Reject"} {n} {noun}?
          </DialogTitle>
          <DialogDescription>
            {approving ? (
              <>
                This activates <strong className="text-foreground">{n}</strong> {pending?.label}{" "}
                {noun}. Approved lessons become standing guidance and are injected into{" "}
                <strong className="text-foreground">every future agent run</strong> in this
                workspace until you archive them.
              </>
            ) : (
              <>
                This rejects <strong className="text-foreground">{n}</strong> {pending?.label}{" "}
                {noun}. Rejected lessons are never fed to an agent, and they stop future
                near-duplicates of themselves from being re-proposed.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {approving && (
          <p className="text-muted-foreground text-xs">
            Ungraded lessons are never included in a confidence-based approval — they stay in the
            queue for your review.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={approving ? "primary" : "destructive"}
            disabled={busy || n === 0}
            onClick={onConfirm}
          >
            {busy ? "Working…" : approving ? `Approve ${n} ${noun}` : `Reject ${n} ${noun}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────── bits ────────────────────────────────── */

function SortableHead({
  query,
  patch,
  sortKey,
  className,
  children,
}: {
  query: LessonQuery;
  patch: (over: Partial<LessonQuery>) => void;
  sortKey: SortKey;
  className?: string;
  children: React.ReactNode;
}) {
  const active = query.sortKey === sortKey;
  return (
    <TableHead
      className={className}
      aria-sort={active ? (query.sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => patch(nextSort(query, sortKey))}
        className={cn(
          "hover:text-foreground inline-flex items-center gap-1 uppercase tracking-wide transition-colors",
          active && "text-foreground",
        )}
      >
        {children}
        {active &&
          (query.sortDir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          ))}
      </button>
    </TableHead>
  );
}

function StatusBadge({ status }: { status: LessonTableRow["status"] }) {
  const tone = status === "active" ? "ok" : status === "candidate" ? "info" : ("muted" as const);
  return (
    <Badge tone={tone} className="capitalize">
      {status}
    </Badge>
  );
}

function Checkbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={onChange}
      className="accent-primary size-4 cursor-pointer align-middle disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

/** Stable, locale-independent date so server and client markup agree. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}
