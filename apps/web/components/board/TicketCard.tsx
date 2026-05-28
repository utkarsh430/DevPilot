"use client";

import * as React from "react";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowRight,
  CalendarClock,
  Check,
  CircleDollarSign,
  Clock,
  GitBranch,
  GitMerge,
  GripVertical,
  Hourglass,
  ListTree,
  MessageSquare,
  RotateCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import { stripMarkdown } from "@/lib/strip-markdown";
import type { BoardTicket } from "@/components/board/types";
import { PRIORITY_META } from "@/lib/board/priority";
import { formatTicketKey } from "@/lib/board/ticket-key";
import type { BoardDensity } from "@/components/board/board-prefs";
import { SuggestedDepsModal } from "@/components/board/SuggestedDepsModal";
import {
  landingCardTreatment,
  landingStateDetail,
  landingStateLabel,
} from "@/lib/integration/landing-state";
import { toast } from "@/components/ui/sonner";

// Map an author label (e.g. "agent:engineer") to the badge tone that best
// communicates the role at a glance. Chart-N tokens give us role colors
// without requiring tone variants we don't have on Badge. Security uses
// "danger" (red, chart-5-adjacent) rather than "warn" (amber, chart-3) so it
// stays visually distinct from DevOps/SRE — matching the AGENTS.md role
// spectrum and the same danger↔chart-5 pairing the builder minimap uses for
// its "budget" node kind.
const ROLE_TONE: Record<string, "info" | "warn" | "danger" | "ok" | "muted" | "violet"> = {
  pm: "info",
  product_manager: "info",
  engineer: "violet",
  frontend_engineer: "violet",
  backend_engineer: "violet",
  fullstack_engineer: "violet",
  qa: "ok",
  security: "danger",
  security_engineer: "danger",
  designer: "info",
  dataeng: "violet",
  data_scientist: "violet",
  sre: "warn",
  devops: "warn",
  cloud_engineer: "warn",
  research: "info",
  human: "muted",
  system: "muted",
};

export function TicketCard({
  ticket,
  onOpen,
  dragging,
  selection,
  density = "comfortable",
  reducedMotion = false,
}: {
  ticket: BoardTicket;
  onOpen?: () => void;
  dragging?: boolean;
  /** When defined, the card is in bulk-select mode: drag is disabled,
   *  a checkbox replaces the drag handle, and the card body toggles select
   *  instead of opening the drawer. */
  selection?: { selected: boolean; onToggle: () => void };
  /** Card rhythm — "compact" tightens padding/gaps for dense triage. */
  density?: BoardDensity;
  /** When true (user prefers reduced motion), drop the drag-slide,
   *  hover-lift, and status-change transitions. */
  reducedMotion?: boolean;
}) {
  const inSelection = !!selection;
  const compact = density === "compact";
  // Async dep-suggestions parked by suggestTicketDepsFn. When present, the card
  // shows a chip that opens the accept/skip modal — the asynchronous
  // replacement for the old synchronous post-create suggestion flow. The modal
  // clears the column on accept/skip, which drops the chip via realtime. Only
  // offered while the ticket is pre-dispatch (backlog/ready): "which existing
  // tickets should be DONE BEFORE this one" is moot once the agent loop starts,
  // and it's the only state where wiring a blocker + re-placing makes sense.
  const suggestedDeps = ticket.suggestedDependencies ?? [];
  const canReviewSuggestedDeps =
    suggestedDeps.length > 0 && (ticket.status === "backlog" || ticket.status === "ready");
  const [showSuggestModal, setShowSuggestModal] = React.useState(false);
  // useSortable (vs useDraggable): adds `transition` so cards smoothly slide
  // out of the way when another is dragged over them, and gives BoardClient
  // a card-id `over.id` when dropped onto another card — the signal needed
  // for within-column reorder. Cross-column move still works because the
  // column itself remains a droppable + intersection tests still fire when
  // releasing on the column's empty area.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    disabled: inSelection,
  });
  const lastRoleKey = (ticket.lastCommentAuthor ?? "").split(":").pop()?.toLowerCase() ?? "";
  const roleTone = ROLE_TONE[lastRoleKey] ?? "muted";
  const roleLabel = labelFor(ticket.lastCommentAuthor);

  const style: React.CSSProperties = {
    // CSS.Transform (not Translate) so the slide-out animation produced by
    // SortableContext (which uses scaling intermediates) renders correctly.
    transform: CSS.Transform.toString(transform),
    // dnd-kit's `transition` is what slides neighbouring cards out of the way.
    // Honour prefers-reduced-motion by dropping it (the transform still applies
    // instantly, so drop targeting is unaffected — only the animation is gone).
    transition: reducedMotion ? undefined : transition,
    opacity: isDragging && !dragging ? 0.4 : 1,
  };

  // The ticket's identity: the human-friendly `DevPilot-<N>` key when it has one
  // (per-project, creation-order, stable across column moves), else the short
  // hex id for project-less tickets, which no per-project counter can number.
  const ticketKey = formatTicketKey(ticket.ticketNumber, ticket.id);

  const priorityMeta = PRIORITY_META[ticket.priority];
  const hasPriority = ticket.priority > 0;
  const dueMeta = ticket.dueAt ? classifyDue(ticket.dueAt) : null;
  const estimateLabel =
    typeof ticket.estimateCents === "number"
      ? `$${(ticket.estimateCents / 100).toFixed(ticket.estimateCents % 100 === 0 ? 0 : 2)}`
      : null;
  // A safety-critical ticket parked at `blocked` is (almost always) waiting on
  // the human safety approval the gate demands — surface that plainly.
  const awaitingSafetyApproval = ticket.safetyCritical && ticket.status === "blocked";
  const visibleLabels = ticket.labels.slice(0, 3);
  const overflowLabelCount = Math.max(0, ticket.labels.length - visibleLabels.length);
  const commentPreview = ticket.lastCommentBody ? stripMarkdown(ticket.lastCommentBody) : null;
  // Landing visibility. `landingCardTreatment` decides whether this card says
  // anything at all: `warn` for stranded work, `info` for the healthy "this
  // ticket had a branch and there was genuinely nothing to land" case, `none`
  // for the boring majority (landed, never had a branch, or still in flight).
  // Keeping that rule in the pure module means the card renders a decision it
  // does not re-derive — and a landed ticket can never pick up a warning tone.
  const landingTreatment = ticket.landingState
    ? landingCardTreatment(ticket.landingState, ticket.status)
    : "none";

  function handleTitleClick() {
    if (selection) selection.onToggle();
    else onOpen?.();
  }

  // In selection mode the entire <article> is the click target — clicking
  // anywhere on the card (not just the small title text) toggles selection.
  // Stop-propagation on the pending-push Link inside the footer protects
  // its own navigation. Outside selection mode we keep the previous
  // behaviour (title button opens the drawer; the rest of the card body is
  // inert) so click-to-open isn't surprising for casual reads.
  const selectionClickHandlers = inSelection
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-pressed": selection!.selected,
        onClick: () => selection!.onToggle(),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            selection!.onToggle();
          }
        },
      }
    : {};

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={cn(
        "bg-card text-card-foreground group rounded-lg border shadow-sm",
        // Motion (color/shadow/lift fades + drag rotation) is guarded behind
        // prefers-reduced-motion: with it on, the card changes state instantly.
        reducedMotion ? "transition-none" : "transition-all",
        !inSelection &&
          (reducedMotion
            ? "hover:border-ring/40 hover:shadow-md"
            : "hover:border-ring/40 hover:-translate-y-[1px] hover:shadow-md"),
        dragging &&
          (reducedMotion
            ? "ring-ring/40 shadow-xl ring-2"
            : "ring-ring/40 rotate-[0.5deg] shadow-xl ring-2"),
        inSelection &&
          "hover:border-chart-1/40 focus-visible:ring-chart-1/60 cursor-pointer focus-visible:outline-none focus-visible:ring-2",
        selection?.selected && "border-chart-1/70 ring-chart-1/30 ring-2",
      )}
      data-ticket-id={ticket.id}
      aria-label={`Ticket ${ticket.title}`}
      {...selectionClickHandlers}
    >
      <div className={cn("flex items-start gap-1.5", compact ? "p-2" : "p-3")}>
        {inSelection ? (
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
              selection!.selected
                ? "border-chart-1 bg-chart-1 text-primary-foreground"
                : "border-border bg-background",
            )}
          >
            {selection!.selected ? <Check className="h-2.5 w-2.5" /> : null}
          </span>
        ) : (
          <button
            type="button"
            // focus-visible:opacity-100 — the hover-reveal grip must also
            // appear when reached by keyboard, or keyboard DnD has an
            // invisible focus stop.
            className="text-muted-foreground hover:text-foreground hover:bg-muted -ml-1 mt-0.5 cursor-grab touch-none rounded p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 active:cursor-grabbing group-hover:opacity-100"
            aria-label={`Drag ticket: ${ticket.title}`}
            {...listeners}
            {...attributes}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
        {hasPriority ? (
          <span
            aria-label={`Priority: ${priorityMeta.label}`}
            title={priorityMeta.label}
            className={cn("mt-[7px] h-2 w-2 shrink-0 rounded-full", priorityMeta.dotClass)}
          />
        ) : null}
        {/* Title — outside selection mode it stays a real button so clicking
            it opens the drawer. In selection mode we collapse to a plain
            <div> so we don't nest a focusable button inside the article's
            role=button (a11y violation + double event handling). The card-
            level click target handles the toggle in that case. */}
        {inSelection ? (
          <div className="text-foreground min-w-0 flex-1 text-left text-sm font-medium leading-snug [overflow-wrap:anywhere]">
            {ticket.title}
          </div>
        ) : (
          <button
            type="button"
            // min-w-0 + [overflow-wrap:anywhere] lets long unbreakable tokens
            // (URLs, JWTs, base64 blobs pasted as titles) wrap inside the
            // card instead of pushing the flex parent wider than its column.
            // The DragOverlay clone otherwise renders a card that spans
            // multiple columns visually.
            className="text-foreground min-w-0 flex-1 cursor-pointer text-left text-sm font-medium leading-snug underline-offset-2 [overflow-wrap:anywhere] hover:underline"
            onClick={handleTitleClick}
          >
            {ticket.title}
          </button>
        )}
        <span
          className="text-muted-foreground ml-1 mt-0.5 select-none whitespace-nowrap font-mono text-[10px] tracking-wider"
          aria-label="Ticket key"
        >
          {ticketKey}
        </span>
      </div>

      {visibleLabels.length > 0 ? (
        <div
          className={cn("flex flex-wrap items-center gap-1", compact ? "px-2 pb-1.5" : "px-3 pb-2")}
        >
          {visibleLabels.map((lbl) => (
            <Badge
              key={lbl.id}
              tone={lbl.color as never}
              className="h-4 px-1.5 text-[10px] font-medium"
            >
              {lbl.name}
            </Badge>
          ))}
          {overflowLabelCount > 0 ? (
            <span className="text-muted-foreground text-[10px]">+{overflowLabelCount}</span>
          ) : null}
        </div>
      ) : null}

      {commentPreview ? (
        // THE PADDING IS ON THE WRAPPER, NOT ON THE CLAMPED PARAGRAPH, and that
        // is load-bearing rather than tidiness. `overflow: hidden` clips at the
        // PADDING edge, so bottom padding on the clamped element itself leaves a
        // band the overflowing next line paints into — the clamp's ellipsis
        // appeared at the end of line 2 and a half-height line 3 showed below
        // it, cut through the middle of the glyphs. It reads as a rendering
        // fault rather than as a truncation, on every card carrying a comment
        // longer than the clamp. Verified in the browser: zeroing the
        // paragraph's `padding-bottom` takes its client height from 40px to
        // 32px (exactly two 16px lines) and the sliver disappears.
        //
        // [overflow-wrap:anywhere] handles long unbroken tokens (JWTs,
        // URLs) in the preview — line-clamp alone doesn't break those
        // mid-token, so a single long line would push the card past its
        // column boundary (visible most painfully in the DragOverlay
        // clone during drag-to-move). stripMarkdown keeps this a plain-text
        // one-liner instead of leaking literal "## " / "**" / backtick syntax.
        <div className={cn(compact ? "px-2 pb-1.5" : "px-3 pb-2")}>
          <p
            className={cn(
              "text-muted-foreground text-xs [overflow-wrap:anywhere]",
              compact ? "line-clamp-1" : "line-clamp-2",
            )}
          >
            {roleLabel ? (
              <span className="text-foreground/80 font-medium">{roleLabel}: </span>
            ) : null}
            {commentPreview}
          </p>
        </div>
      ) : null}

      <footer
        className={cn(
          "bg-muted/30 flex flex-wrap items-center gap-1.5 border-t text-[11px]",
          compact ? "px-2 py-1.5" : "px-3 py-2",
        )}
      >
        {ticket.safetyCritical ? (
          <Badge
            tone="danger"
            className="gap-1 px-1.5 py-0 text-[10px]"
            title={
              awaitingSafetyApproval
                ? "Parked awaiting a human safety approval before it can reach Done"
                : "Safety-critical: only a human can approve this ticket to Done"
            }
          >
            <ShieldAlert className="h-2.5 w-2.5" />
            {awaitingSafetyApproval ? "Awaiting safety approval" : "Safety-critical"}
          </Badge>
        ) : null}
        {/* "Nothing to land" — a healthy outcome, so a NEUTRAL chip and never a
            warning tone. It only appears when the ticket actually had a branch
            (DevPilot-7: reviewed, changed nothing, correctly Done); a spec-only
            ticket that never produced one says nothing at all. */}
        {landingTreatment === "info" && ticket.landingState ? (
          <Badge
            tone="muted"
            className="gap-1 px-1.5 py-0 text-[10px]"
            title={landingStateDetail(ticket.landingState)}
          >
            <GitMerge className="h-2.5 w-2.5" />
            {landingStateLabel(ticket.landingState)}
          </Badge>
        ) : null}
        {lastRoleKey && roleLabel ? (
          <Badge tone={roleTone} className="px-1.5 py-0 text-[10px]">
            {roleLabel}
          </Badge>
        ) : null}
        {ticket.retryCount > 0 ? (
          <Badge tone="warn" className="gap-1 px-1.5 py-0 text-[10px]">
            <RotateCw className="h-2.5 w-2.5" /> retry {ticket.retryCount}
          </Badge>
        ) : null}
        {ticket.autoPromoteWhenUnblocked ? (
          <Badge
            tone="ok"
            className="gap-1 px-1.5 py-0 text-[10px]"
            title="Auto-promotes to Ready when blocking tickets complete"
          >
            <Hourglass className="h-2.5 w-2.5" /> Queued
          </Badge>
        ) : null}
        {ticket.commentCount > 0 ? (
          <span className="text-muted-foreground flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            <span className="tabular-nums">{ticket.commentCount}</span>
          </span>
        ) : null}
        {ticket.subIssueTotal > 0 ? (
          <span
            className="text-muted-foreground flex items-center gap-1"
            title={`${ticket.subIssueDone} of ${ticket.subIssueTotal} sub-issues done`}
          >
            <ListTree className="h-3 w-3" />
            <span className="tabular-nums">
              {ticket.subIssueDone}/{ticket.subIssueTotal}
            </span>
          </span>
        ) : null}
        {estimateLabel ? (
          <span
            className="text-muted-foreground flex items-center gap-1"
            title="Estimated cost budget"
          >
            <CircleDollarSign className="h-3 w-3" />
            <span className="tabular-nums">{estimateLabel}</span>
          </span>
        ) : null}
        {dueMeta ? (
          <Badge
            tone={dueMeta.tone}
            className="gap-1 px-1.5 py-0 text-[10px]"
            title={`Due ${new Date(ticket.dueAt!).toLocaleString()}`}
          >
            <CalendarClock className="h-2.5 w-2.5" />
            {dueMeta.label}
          </Badge>
        ) : null}
        <span className="text-muted-foreground ml-auto flex items-center gap-1 font-mono">
          <Clock className="h-3 w-3" />
          {/* Seconds-granularity text drifts between SSR and hydration on
              fresh tickets; the client value wins silently. */}
          <span suppressHydrationWarning>{relativeTime(ticket.updatedAt)}</span>
        </span>
      </footer>

      {/* M5i — pending-push CTA. Rendered as a separate row below the meta
          footer so the existing badges don't reflow on cards that gain push
          state mid-session. The `warning` semantic token matches the "needs
          action" framing used elsewhere (statusDot warning) and tracks every
          palette; a chevron + "Review" framing
          beats a passive "Pushable" badge because the user's complaint was
          discoverability — they need to know to click. */}
      {/* Stranded work. A dedicated row rather than a footer badge because the
          REASON is the whole value — "Not landed" alone sends the operator
          hunting through the database, which is precisely what happened. The
          detail text is rendered, not hidden behind a tooltip, for the same
          reason. Deliberately NOT a link: this PR observes landing, it does not
          offer to retry it. */}
      {landingTreatment === "warn" && ticket.landingState ? (
        <div
          className={cn(
            "bg-warning/10 text-warning flex items-start gap-1.5 border-t text-[11px] font-medium",
            compact ? "px-2 py-1.5" : "px-3 py-2",
          )}
          title={landingStateDetail(ticket.landingState)}
        >
          <GitMerge className="mt-[1px] h-3 w-3 shrink-0" />
          <span>
            <span className="font-semibold">{landingStateLabel(ticket.landingState)}</span>
            {ticket.landingState.kind === "not_landed" ? (
              <span className="font-normal"> · {ticket.landingState.detail}</span>
            ) : null}
          </span>
        </div>
      ) : null}

      {ticket.pendingPush ? (
        <Link
          href={`/changes/${ticket.pendingPush.id}`}
          // Stop propagation so clicking the chip doesn't ALSO open the
          // drawer (the card's title button is the drawer-open trigger).
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "bg-warning/10 text-warning hover:bg-warning/20 flex items-center gap-1.5 border-t text-[11px] font-medium",
            compact ? "px-2 py-1.5" : "px-3 py-2",
            reducedMotion ? "transition-none" : "transition-colors",
          )}
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          <span>
            Review {ticket.pendingPush.unpushedCount} change
            {ticket.pendingPush.unpushedCount === 1 ? "" : "s"} on{" "}
            <code className="font-mono text-[10px]">{ticket.pendingPush.branch}</code>
          </span>
          <ArrowRight className="ml-auto h-3 w-3 shrink-0" />
        </Link>
      ) : null}

      {/* Async dep-suggestions chip — the background suggestTicketDepsFn parked
          a ranked set of likely blockers on this ticket. Opens the SAME
          accept/skip modal the old synchronous create flow showed, just later.
          A separate row below the footer, mirroring the pending-push CTA, so
          it doesn't reflow the meta badges. stopPropagation so the click opens
          the modal, not the drawer / a drag. */}
      {canReviewSuggestedDeps ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowSuggestModal(true);
          }}
          className={cn(
            "text-chart-4 bg-chart-4/5 hover:bg-chart-4/10 flex w-full items-center gap-1.5 border-t text-left text-[11px] font-medium",
            compact ? "px-2 py-1.5" : "px-3 py-2",
            reducedMotion ? "transition-none" : "transition-colors",
          )}
        >
          <Sparkles className="h-3 w-3 shrink-0" />
          <span>
            Review {suggestedDeps.length} suggested dependenc
            {suggestedDeps.length === 1 ? "y" : "ies"}
          </span>
          <ArrowRight className="ml-auto h-3 w-3 shrink-0" />
        </button>
      ) : null}

      {showSuggestModal ? (
        <SuggestedDepsModal
          open={showSuggestModal}
          onOpenChange={(o) => setShowSuggestModal(o)}
          newTicketId={ticket.id}
          suggestions={suggestedDeps}
          onComplete={() => {
            setShowSuggestModal(false);
            toast.success("Dependencies updated");
          }}
        />
      ) : null}
    </article>
  );
}

function labelFor(raw: string | null): string {
  if (!raw) return "";
  const [, name] = raw.split(":");
  return name ?? raw;
}

// Map a due-at timestamp to a short label + badge tone for the card pill.
// Overdue → danger; within 48h → warn; otherwise → muted (informational only).
function classifyDue(iso: string): {
  label: string;
  tone: "danger" | "warn" | "muted";
} {
  const due = new Date(iso).getTime();
  if (!Number.isFinite(due)) return { label: "due", tone: "muted" };
  const now = Date.now();
  const diffMs = due - now;
  const oneDay = 86_400_000;
  const within48h = diffMs >= 0 && diffMs <= 2 * oneDay;
  const short = new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  if (diffMs < 0) return { label: `${short} (overdue)`, tone: "danger" };
  if (within48h) return { label: short, tone: "warn" };
  return { label: short, tone: "muted" };
}
