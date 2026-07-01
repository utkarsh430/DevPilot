// Shared types for the board UI. Kept tiny so the server page and client
// components agree without a circular import.

import type { TicketStatus } from "@/lib/board/state";
import type { BlockerOpenness } from "@/lib/integration/landed";
import type { LandingState } from "@/lib/integration/landing-state";
import type { DepSuggestion } from "@/lib/engine/dep-suggest";

// Shape of a row in `public.tickets` as it arrives via Supabase Realtime.
// snake_case mirrors the column names; only the fields the board needs.
export type RealtimeTicketRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  status: TicketStatus;
  retry_count: number;
  updated_at: string;
  // C3 — written by commitPlanAction's topo sort. NULL/0 for legacy and
  // operator-created tickets that pre-date the DAG ordering; secondary
  // ordering by `updated_at desc` keeps those rows in recency order.
  column_position: number | null;
  // The human-friendly `DevPilot-<N>` key: creation-order, per-project, assigned
  // once by the `assign_ticket_number` DB trigger and never rewritten. Null for
  // tickets with no project (nothing to count them against).
  ticket_number?: number | null;
  // Bulk Move-to-Ready follow-up flag. True when this backlog ticket was
  // part of a bulk-promote batch but had open blockers; the transition hook
  // auto-promotes it once every blocker reaches Done.
  auto_promote_when_unblocked?: boolean;
  // Linear-encoded priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low.
  priority?: number;
  estimate_cents?: number | null;
  due_at?: string | null;
  parent_ticket_id?: string | null;
  // SME safety gate — when true this ticket may reach `done` ONLY via a human
  // board approval; any agent/system completion is blocked and parked. Absent
  // on legacy realtime payloads (treated as false).
  safety_critical?: boolean;
  // Async dep-suggestion surface — the Haiku "which existing tickets block this
  // new one?" rerank, parked here by `suggestTicketDepsFn` for the operator to
  // accept/skip. NULL when none are pending; cleared to NULL on accept/skip.
  suggested_dependencies?: DepSuggestion[] | null;
  // Landing visibility — the moment the land worker stamps this, the card's
  // "not landed" chip should clear without a page load. The other two evidence
  // tables aren't in the board's realtime subscription, so a NEWLY-stranded
  // ticket only surfaces on the next load; a newly-LANDED one clears live.
  landed_sha?: string | null;
};

// Shape of a row in `public.comments` as it arrives via Supabase Realtime.
export type RealtimeCommentRow = {
  id: string;
  tenant_id: string;
  ticket_id: string;
  author_type: "agent" | "human" | "system";
  author_id: string;
  body: string;
  created_at: string;
  // Slice A — structured payload for tool-driven comments
  // (e.g. devpilot_request_secret writes metadata.kind='secret_request').
  // Null/missing for plain comments.
  metadata?: Record<string, unknown> | null;
};

// Discriminated change payload emitted by `useLiveTickets` consumers (e.g. tests).
export type RealtimeTicketChange =
  | { type: "ticket_insert"; row: RealtimeTicketRow }
  | { type: "ticket_update"; row: RealtimeTicketRow }
  | { type: "ticket_delete"; id: string }
  | { type: "comment_insert"; row: RealtimeCommentRow };

export type BoardTicket = {
  id: string;
  projectId: string | null;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: TicketStatus;
  retryCount: number;
  updatedAt: string;
  /** C3 — sort key written by commitPlanAction; null/0 for legacy tickets.
   *  Intra-column ORDERING only - never the ticket's identity (that's
   *  `ticketNumber`). */
  columnPosition: number | null;
  /** The `DevPilot-<N>` key. Per-project, creation-order, assigned once at
   *  insert by the `assign_ticket_number` DB trigger and stable for the life of
   *  the ticket (a column move never touches it). Null for project-less
   *  tickets, which fall back to the short hex id on the card. */
  ticketNumber: number | null;
  /** True iff this Backlog ticket was bulk-promoted while still blocked; the
   *  transition hook auto-promotes it on blocker completion. Always false for
   *  non-Backlog rows (cleared on transition out of Backlog). */
  autoPromoteWhenUnblocked: boolean;
  lastCommentAuthor: string | null;
  lastCommentBody: string | null;
  lastCommentAt: string | null;
  commentCount: number;
  /** M5i — the most recent `pending_pushes` row for this ticket where
   *  `pushed_at IS NULL`. Drives the "Review N changes →" chip on the card
   *  and the matching button in the drawer header. Null when there's no
   *  unpushed work — including after the operator pushes (the realtime hook
   *  drops the row the moment `pushed_at` flips). */
  pendingPush: BoardTicketPendingPush | null;
  /** Linear-encoded priority. 0 = none (sorts last), 1 = urgent, 2 = high,
   *  3 = medium, 4 = low. Default 0 for new tickets. Persisted on the
   *  `tickets.priority` column. */
  priority: TicketPriority;
  /** Dollar-cost budget hint (in cents). Null when not estimated. Surfaced
   *  on the card as `$x.xx` next to the comment count. */
  estimateCents: number | null;
  /** ISO timestamp of the due date, or null. Card chrome shows a red pill
   *  when overdue, amber within 48h. */
  dueAt: string | null;
  /** Multi-attach labels (tenant-scoped). Loaded eagerly with the board so
   *  cards can render chips without an extra round-trip. */
  labels: BoardTicketLabel[];
  /** Parent ticket id (when this ticket is a sub-issue). */
  parentTicketId: string | null;
  /** Counts of direct sub-issues for the progress chip on the parent card.
   *  `subIssueTotal === 0` ⇒ no sub-issues ⇒ chip hidden. */
  subIssueTotal: number;
  subIssueDone: number;
  /** SME safety gate. When true, this ticket may be completed to `done` ONLY by
   *  a human board approval — any agent/system `→ done` is blocked at the
   *  transition seam and the ticket is parked to `blocked` pending approval.
   *  Surfaced as a shield badge on the card and an approval affordance in the
   *  drawer. Persisted on the `tickets.safety_critical` column. */
  safetyCritical: boolean;

  /** Async dep-suggestions parked by `suggestTicketDepsFn` on
   *  `tickets.suggested_dependencies` — the Haiku "which existing tickets block
   *  this new one?" rerank, moved OFF the create request path. When non-empty,
   *  the card shows a "review suggested dependencies" chip that opens the
   *  accept/skip `SuggestedDepsModal`; cleared on accept/skip. Optional — only
   *  the main board query and the realtime hook populate it; blocker-reference
   *  and transition-built BoardTickets leave it undefined (read as none). */
  suggestedDependencies?: DepSuggestion[];

  /** WI-5 — the integration-branch commit that contains this ticket's work, or
   *  null when it isn't on the integration branch (yet, or ever — most tickets
   *  produce no code at all). Readiness gates on this, NOT on `status === done`.
   *  Populated on BLOCKER reference cards (`loadBlockers*`), where the distinction
   *  is load-bearing; the main board query leaves it undefined. */
  landedSha?: string | null;
  integratedAt?: string | null;
  /** Why this blocker is (or isn't) still holding its dependent back —
   *  `closed` | `working` | `awaiting_land`. Only a blocker card carries it: it
   *  is what lets the drawer say "done, waiting to land" instead of showing a
   *  done blocker that inexplicably blocks. See lib/integration/landed.ts. */
  landOpenness?: BlockerOpenness;

  /** Landing VISIBILITY — the derived "did this ticket's work actually reach the
   *  integration branch, and if not, why?" state. Distinct from `status`: a
   *  ticket can be Done with its commits stranded on an unpushed branch, which
   *  is exactly the failure this surfaces. Derived by `deriveLandingState` from
   *  `landed_sha` + `pending_pushes` + `integration_queue`; undefined when the
   *  loader had no tenant to scope its reads by (treated as "unknown", which
   *  renders nothing). See lib/integration/landing-state.ts. */
  landingState?: LandingState;
};

export type TicketPriority = 0 | 1 | 2 | 3 | 4;

export type BoardTicketLabel = {
  id: string;
  name: string;
  /** Color token: matches the Badge `tone` set (info/warn/ok/danger/muted/violet/default).
   *  Stored as text so we can extend without a migration. */
  color: string;
};

export type BoardTicketPendingPush = {
  id: string;
  branch: string;
  unpushedCount: number;
  updatedAt: string;
};

export type BoardComment = {
  id: string;
  authorType: "agent" | "human" | "system";
  authorId: string;
  body: string;
  createdAt: string;
  /** Slice A — structured payload for tool-driven comments. Today the UI
   *  recognises `metadata.kind === "secret_request"` and swaps the plain
   *  markdown body for a masked-input form. Null/unset for plain comments. */
  metadata?: Record<string, unknown> | null;
};

export type BoardColumn = {
  id: TicketStatus;
  label: string;
  tone: "default" | "info" | "warn" | "ok" | "danger" | "muted";
  /**
   * Soft work-in-progress ceiling for the column, surfaced as a subtle
   * `count / limit` affordance in the header that tips into a warning tone
   * when exceeded. This is a **frontend operator heuristic**, not a DB-backed
   * rule — there is no WIP column in the schema — so it only decorates the
   * stages where limiting throughput is standard Kanban practice. Columns
   * without a limit render a bare count exactly as before.
   *
   * `in_progress` tracks the subscription-runner concurrency boundary
   * documented in AGENTS.md ("~1-3 steady concurrent agents"); crossing it is
   * the operator's cue that the board is pulling more than the local runner
   * can steadily serve. `in_review` flags a review backlog piling up on humans.
   */
  wipLimit?: number;
};

export const COLUMNS: ReadonlyArray<BoardColumn> = [
  { id: "backlog", label: "Backlog", tone: "muted" },
  { id: "ready", label: "Ready", tone: "info" },
  { id: "assigned", label: "Assigned", tone: "info" },
  { id: "in_progress", label: "In progress", tone: "info", wipLimit: 3 },
  { id: "input_required", label: "Input required", tone: "warn" },
  { id: "blocked", label: "Blocked", tone: "warn" },
  { id: "paused", label: "Paused", tone: "muted" },
  { id: "in_review", label: "In review", tone: "info", wipLimit: 5 },
  { id: "done", label: "Done", tone: "ok" },
  { id: "failed", label: "Failed", tone: "danger" },
];

/**
 * Statuses that demand a human's attention per the ticket FSM — an agent has
 * either explicitly asked for input (`input_required`) or hit a dependency it
 * can't clear itself (`blocked`). The board's one-click "Needs you" chip and
 * the swimlane triage view both key off this set. Kept here (next to COLUMNS)
 * so the FSM's human-in-the-loop states have a single source of truth.
 */
export const NEEDS_ATTENTION_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "input_required",
  "blocked",
]);
