"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  Check,
  Clock,
  ExternalLink,
  FileDown,
  GitBranch,
  ImageIcon,
  GitMerge,
  Loader2,
  Lock,
  PauseCircle,
  Pencil,
  PlayCircle,
  RotateCcw,
  RotateCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SkipForward,
  Trash2,
  User,
  Wrench,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/sonner";
import { useTicketExport } from "@/components/export/use-ticket-export";
import type { BoardComment, BoardTicket } from "@/components/board/types";
import { COLUMNS } from "@/components/board/types";
import type { TicketAttachmentDTO } from "@/app/api/board/tickets/[id]/attachments/route";
import { formatTicketKey } from "@/lib/board/ticket-key";
import {
  addLabelToTicketAction,
  addRelationAction,
  createLabelAction,
  deleteTicketAction,
  listLabelsAction,
  moveTicketAction,
  pauseTicketAction,
  postCommentAction,
  removeLabelFromTicketAction,
  removeRelationAction,
  resumeTicketAction,
  setTicketDueAtAction,
  setTicketEstimateAction,
  setTicketPriorityAction,
  setTicketSafetyCriticalAction,
  updateTicketAction,
} from "@/app/(app)/board/actions";
import { PriorityPicker } from "@/components/board/PriorityPicker";
import { LabelPicker, type LabelOption } from "@/components/board/LabelPicker";
import { DueDatePicker } from "@/components/board/DueDatePicker";
import type { RelationsResponse } from "@/app/api/board/tickets/[id]/relations/route";
// MessageMarkdown lives under components/plan/ but is rendering-agnostic —
// it just wraps react-markdown + remark-gfm with our prose tokens. Reusing
// it here so ticket descriptions / acceptance criteria / comments render
// the same headings + tables + fenced code that the plan chat does.
import { MessageMarkdown } from "@/components/plan/MessageMarkdown";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/cn";
import { useLiveComments } from "@/lib/realtime/use-comments";
// Slice A — structured `devpilot_request_secret` comments render an inline
// masked-input form instead of plain markdown.
import { SecretRequestCard } from "@/components/board/SecretRequestCard";
// Slice C — Open the agent's workspace in VS Code (server-side path resolve).
import { getVscodeOpenUrlAction } from "@/lib/workspace/open-actions";
import { Code2 } from "lucide-react";
// Ticket recovery — land a done ticket's branch into dev / restart it from dev /
// deliberately discard a partial ticket's work and restart it from dev.
import {
  landTicketNowAction,
  reopenFromDevAction,
  discardAndRestartFromDevAction,
} from "@/app/(app)/projects/[projectId]/integration-actions";

type DrawerRun = {
  id: string;
  status: "running" | "awaiting_human" | "done" | "failed" | "cancelled";
  runnerKind: "api" | "local-cc" | null;
  spentCents: number;
  createdAt: string;
  agentRole: string | null;
  // Highest productive step idx for the "Resume from step N" Replay button.
  // -1 means the run produced nothing useful (e.g. cancelled pre-iteration).
  lastGoodStepIdx: number;
};

const RUN_STATUS_TONE: Record<DrawerRun["status"], "info" | "warn" | "ok" | "danger" | "muted"> = {
  running: "info",
  awaiting_human: "warn",
  done: "ok",
  failed: "danger",
  cancelled: "muted",
};

// Statuses where the drawer's delete button is rendered. Must match the
// server-side `DELETABLE_STATUSES` in app/(app)/board/actions.ts.
const DRAWER_DELETABLE_STATUSES: ReadonlySet<BoardTicket["status"]> = new Set([
  "backlog",
  "done",
  "failed",
]);

// Non-done, partially-completed statuses where "Discard & restart from dev" is
// offered. Must match the server-side `DISCARDABLE_STATUSES` in
// lib/board/reopen-policy.ts.
const DRAWER_DISCARDABLE_STATUSES: ReadonlySet<BoardTicket["status"]> = new Set([
  "in_progress",
  "paused",
  "blocked",
  "input_required",
]);

// The exact word the operator must type to arm the destructive discard. A
// type-to-confirm guard so a stray click can never throw away unrecoverable work.
const DISCARD_CONFIRM_WORD = "discard";

const BLOCKER_STATUS_TONE: Record<
  BoardTicket["status"],
  "default" | "info" | "warn" | "ok" | "danger" | "muted"
> = {
  backlog: "muted",
  ready: "info",
  assigned: "info",
  in_progress: "info",
  input_required: "warn",
  blocked: "warn",
  in_review: "info",
  paused: "muted",
  done: "ok",
  failed: "danger",
};

function fmtCents(c: number): string {
  if (c === 0) return "$0";
  if (c < 100) return `${c}¢`;
  return `$${(c / 100).toFixed(2)}`;
}

// ─── Inline edit affordances (C3) ──────────────────────────────────────────
// Three small editors share the same pencil-toggle pattern. Editing is only
// allowed while the ticket sits in Backlog; once it transitions, the pencil
// renders disabled with a tooltip and the server gate refuses the write.

function EditPencil({
  onClick,
  locked,
  label,
}: {
  onClick: () => void;
  locked: boolean;
  label: string;
}) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={locked ? undefined : onClick}
      disabled={locked}
      aria-label={label}
      className="h-6 w-6"
    >
      {locked ? <Lock className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
    </Button>
  );
  if (!locked) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Span so the Tooltip anchors to the disabled button. */}
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>Locked once a run has started.</TooltipContent>
    </Tooltip>
  );
}

// G1 — title is editable in ANY column (including done/failed). No `locked`
// prop here: operators can rename a card after the fact for clarity, and
// the title isn't consumed by downstream agent prompts. Description + AC
// stay backlog-only via EditableDescription's existing gate.
function EditableTitle({ ticketId, value }: { ticketId: string; value: string }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  async function save() {
    const trimmed = draft.trim();
    if (trimmed.length < 3) {
      toast.error("Title must be at least 3 characters");
      return;
    }
    if (trimmed === value.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const res = await updateTicketAction({
      ticketId,
      patch: { title: trimmed },
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Couldn't save title", { description: res.error });
      return;
    }
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2 pr-2">
        <SheetTitle
          className="line-clamp-3 break-words text-base font-semibold leading-snug"
          title={value}
        >
          {value}
        </SheetTitle>
        <EditPencil onClick={() => setEditing(true)} locked={false} label="Edit title" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 pr-2">
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
            setDraft(value);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        disabled={saving}
        className="text-base font-semibold"
        maxLength={500}
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            setEditing(false);
            setDraft(value);
          }}
          disabled={saving}
        >
          <X className="h-3 w-3" />
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="xs"
          onClick={() => void save()}
          disabled={saving || draft.trim().length < 3}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save
        </Button>
      </div>
    </div>
  );
}

function EditableDescription({
  ticketId,
  value,
  locked,
  field,
  emptyLabel,
  renderAs,
}: {
  ticketId: string;
  value: string | null;
  locked: boolean;
  field: "description" | "acceptance_criteria";
  emptyLabel: string;
  renderAs: "prose" | "code";
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? "");
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  async function save() {
    const next = draft.trim().length === 0 ? null : draft;
    if ((next ?? "") === (value ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const res = await updateTicketAction({
      ticketId,
      patch: { [field]: next } as
        | { description: string | null }
        | { acceptance_criteria: string | null },
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Couldn't save", { description: res.error });
      return;
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          autoFocus
          rows={renderAs === "code" ? 8 : 6}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
              setDraft(value ?? "");
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void save();
            }
          }}
          disabled={saving}
          className={cn("min-h-[120px] text-sm", renderAs === "code" && "font-mono text-xs")}
          maxLength={8_000}
          placeholder={
            field === "acceptance_criteria"
              ? "What does done look like? One bullet per line…"
              : "Describe the ticket — context, scope, links…"
          }
        />
        <div className="flex items-center justify-end gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setEditing(false);
              setDraft(value ?? "");
            }}
            disabled={saving}
          >
            <X className="h-3 w-3" />
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="xs"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {value ? (
        renderAs === "code" ? (
          // AC: subtle bg so it visually reads as a "spec" block, but the
          // body still renders markdown (operators often paste `- bullet`
          // lists or fenced code; we don't want to leak the syntax).
          <div className="bg-muted/40 rounded-md border p-3">
            <MessageMarkdown content={value} className="text-xs" />
          </div>
        ) : (
          <MessageMarkdown content={value} />
        )
      ) : (
        <p className="text-muted-foreground text-sm">{emptyLabel}</p>
      )}
      <div className="flex justify-end">
        <EditPencil
          onClick={() => setEditing(true)}
          locked={locked}
          label={field === "acceptance_criteria" ? "Edit acceptance criteria" : "Edit description"}
        />
      </div>
    </div>
  );
}

// Inline live-connection dot for the Comments tab heading.
function LiveDot({ isLive, title }: { isLive: boolean; title: string }) {
  return (
    <span
      className="relative inline-flex h-1.5 w-1.5"
      title={title}
      aria-label={title}
      aria-live="polite"
    >
      {isLive ? (
        <span className="bg-success absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
      ) : null}
      <span
        className={cn(
          "relative inline-flex h-1.5 w-1.5 rounded-full",
          isLive ? "bg-success" : "bg-warning",
        )}
      />
    </span>
  );
}

export function TicketDrawer({
  ticket,
  open,
  onOpenChange,
}: {
  ticket: BoardTicket | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const ticketExport = useTicketExport(ticket?.id ?? null);
  const [initialComments, setInitialComments] = React.useState<BoardComment[]>([]);
  const [runs, setRuns] = React.useState<DrawerRun[]>([]);
  const [blockers, setBlockers] = React.useState<BoardTicket[]>([]);
  const [attachments, setAttachments] = React.useState<TicketAttachmentDTO[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [reply, setReply] = React.useState("");
  const [posting, setPosting] = React.useState(false);
  // Pause/Resume button busy flag. Shared between the header buttons and the
  // per-run Replay buttons in the Runs tab so a single in-flight server call
  // disables them all at once.
  const [pauseResumeBusy, setPauseResumeBusy] = React.useState(false);
  // SME safety gate — one busy flag shared by the flag toggle and the
  // approve-to-Done action so a single in-flight call disables both.
  const [safetyBusy, setSafetyBusy] = React.useState(false);
  // Ticket recovery — "Land into dev", "Restart from dev" and the deliberate
  // "Discard & restart from dev". One busy flag each; the restart flows gate
  // behind confirm dialogs (the discard one is a type-to-confirm — it destroys
  // work irreversibly).
  const [landBusy, setLandBusy] = React.useState(false);
  const [restartBusy, setRestartBusy] = React.useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = React.useState(false);
  const [discardBusy, setDiscardBusy] = React.useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = React.useState(false);
  // Type-to-confirm guard for the destructive discard: the operator must type
  // this exact word to arm the button, so a stray click can never discard work.
  const [discardConfirmText, setDiscardConfirmText] = React.useState("");
  const [tab, setTab] = React.useState<"description" | "comments" | "runs">("description");
  // M1/M2 — Properties + Relations panel state.
  const [labelCatalog, setLabelCatalog] = React.useState<LabelOption[]>([]);
  const [relations, setRelations] = React.useState<RelationsResponse | null>(null);
  const [estimateDraft, setEstimateDraft] = React.useState("");
  // M6 — picker open signals. Each picker watches its own counter and opens
  // when it increments. Keyboard shortcuts bump these.
  const [priorityOpenSignal, setPriorityOpenSignal] = React.useState(0);
  const [labelOpenSignal, setLabelOpenSignal] = React.useState(0);
  const [dueOpenSignal, setDueOpenSignal] = React.useState(0);
  const estimateInputRef = React.useRef<HTMLInputElement>(null);

  // Sync the estimate draft with whichever ticket is open. Keeping it in
  // local state lets the operator type freely without firing a server action
  // on every keystroke; we commit on blur / enter.
  React.useEffect(() => {
    if (!ticket) {
      setEstimateDraft("");
      return;
    }
    setEstimateDraft(
      typeof ticket.estimateCents === "number" ? (ticket.estimateCents / 100).toString() : "",
    );
  }, [ticket?.id, ticket?.estimateCents]);

  // M6 — keyboard shortcuts. Only active while the drawer is open and the
  // user isn't typing into an input/textarea. Mirrors Linear's per-card map
  // but scoped to the open drawer (drawers replace per-card focus in our IA).
  React.useEffect(() => {
    if (!open || !ticket) return;
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      if (t.isContentEditable) return true;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // Direct priority assignment: 0/1/2/3/4 — Linear convention.
      if (["0", "1", "2", "3", "4"].includes(e.key)) {
        const n = Number(e.key) as 0 | 1 | 2 | 3 | 4;
        e.preventDefault();
        void onPriorityChange(n);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "p") {
        e.preventDefault();
        setPriorityOpenSignal((c) => c + 1);
      } else if (k === "l") {
        e.preventDefault();
        setLabelOpenSignal((c) => c + 1);
      } else if (k === "d") {
        e.preventDefault();
        setDueOpenSignal((c) => c + 1);
      } else if (k === "e") {
        e.preventDefault();
        estimateInputRef.current?.focus();
        estimateInputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ticket?.id]);

  async function onPriorityChange(next: 0 | 1 | 2 | 3 | 4) {
    if (!ticket) return;
    const res = await setTicketPriorityAction({ ticketId: ticket.id, priority: next });
    if (!res.ok) {
      toast.error("Couldn't update priority", { description: res.error });
      return;
    }
    router.refresh();
  }
  async function onDueChange(nextIso: string | null) {
    if (!ticket) return;
    const res = await setTicketDueAtAction({ ticketId: ticket.id, dueAt: nextIso });
    if (!res.ok) {
      toast.error("Couldn't update due date", { description: res.error });
      return;
    }
    router.refresh();
  }
  // SME safety gate — arm/disarm the flag. Once armed, only a human board
  // approval may complete this ticket to Done; agents/system are blocked and
  // parked. Disarming is itself an operator-only edit (this drawer requires an
  // authenticated user), so the gate can't be turned off by an agent.
  async function onSafetyToggle(next: boolean) {
    if (!ticket || safetyBusy) return;
    setSafetyBusy(true);
    try {
      const res = await setTicketSafetyCriticalAction({
        ticketId: ticket.id,
        safetyCritical: next,
      });
      if (!res.ok) {
        toast.error("Couldn't update safety-critical flag", { description: res.error });
        return;
      }
      router.refresh();
    } finally {
      setSafetyBusy(false);
    }
  }
  // The human safety approval: complete the ticket to Done as `actor: "human"`,
  // the one move the safety gate lets through. Works from wherever the gate
  // parked it (blocked) or wherever it currently sits, as long as the FSM edge
  // is legal — the state machine allows blocked/in_review/in_progress → done.
  async function onApproveSafety() {
    if (!ticket || safetyBusy) return;
    setSafetyBusy(true);
    try {
      const res = await moveTicketAction({ ticketId: ticket.id, toStatus: "done" });
      if (!res.ok) {
        toast.error("Couldn't approve to Done", { description: res.error });
        return;
      }
      toast.success("Safety-critical ticket approved to Done");
      router.refresh();
    } finally {
      setSafetyBusy(false);
    }
  }
  // "Land into dev" — drive the existing land pipeline for a done ticket whose
  // committed work never landed. Async on the engine side; we just enqueue.
  async function onLandNow() {
    if (!ticket || landBusy) return;
    setLandBusy(true);
    try {
      const res = await landTicketNowAction({ ticketId: ticket.id });
      if (!res.ok) {
        toast.error("Couldn't land into dev", { description: res.error });
        return;
      }
      if (res.enqueued) {
        toast.success(`Landing into ${res.integrationBranch}`, {
          description: "The land worker is squash-merging this ticket's branch. Give it a moment.",
        });
      } else {
        toast.info("Nothing to land", {
          description: res.reason ?? "This ticket has no branch with work to land.",
        });
      }
      router.refresh();
    } finally {
      setLandBusy(false);
    }
  }

  // "Restart from dev" — reopen the ticket and force its next run to fresh-clone
  // the integration branch. Refuses (server-side) when unpushed work is at risk.
  async function onRestartFromDev() {
    if (!ticket || restartBusy) return;
    setRestartBusy(true);
    try {
      const res = await reopenFromDevAction({ ticketId: ticket.id });
      if (!res.ok) {
        const desc =
          res.unpushed && res.unpushed.length > 0
            ? `${res.error} Unpushed: ${res.unpushed
                .map((u) => `${u.branch} (${u.count})`)
                .join(", ")}`
            : res.error;
        toast.error("Couldn't restart from dev", { description: desc });
        return;
      }
      setRestartConfirmOpen(false);
      // Three outcomes, not two - see `WorkspaceResetOutcome`. `failed` means the
      // wipe was NOT queued, so the stale workspace is still on disk and the next
      // run will re-enter it: telling the operator "it will clone dev fresh"
      // there would be a promise we can't keep.
      if (res.workspaceReset === "failed") {
        toast.warning("Restarted from dev - workspace wipe not queued", {
          description:
            "Moved to Backlog, but the cleanup event could not be queued (the event service " +
            "didn't respond). The old workspace is still on disk, so the next run would re-enter " +
            "it. Restart again once Inngest is healthy.",
          duration: 30_000,
        });
      } else {
        toast.success("Restarted from dev", {
          description:
            res.workspaceReset === "queued"
              ? "Moved to Backlog and queued a fresh clone. Move it to Ready to rebuild on dev."
              : "Moved to Backlog. It has no workspace on disk, so the next run clones dev fresh.",
        });
      }
      router.refresh();
    } finally {
      setRestartBusy(false);
    }
  }

  // "Discard & restart from dev" — the DELIBERATE, irreversible sibling. Throws
  // away the ticket's uncommitted + unpushed work and resets it to Backlog to
  // re-run fresh off dev. Gated behind a type-to-confirm dialog (below).
  async function onDiscardAndRestart() {
    if (!ticket || discardBusy) return;
    setDiscardBusy(true);
    try {
      const res = await discardAndRestartFromDevAction({ ticketId: ticket.id });
      if (!res.ok) {
        toast.error("Couldn't discard & restart", { description: res.error });
        return;
      }
      setDiscardConfirmOpen(false);
      setDiscardConfirmText("");
      // `failed` is the case the operator most needs told: the pending pushes ARE
      // discarded and the ticket IS back in Backlog, but the workspace is still
      // there holding the work we just stopped tracking.
      if (res.workspaceReset === "failed") {
        toast.warning("Discarded & restarted - workspace wipe not queued", {
          description:
            "Moved to Backlog and dropped the tracked changes, but the wipe could not be queued " +
            "(the event service didn't respond). The old workspace is still on disk, so the next " +
            "run would re-enter it. Discard & restart again once Inngest is healthy.",
          duration: 30_000,
        });
      } else {
        toast.success("Discarded & restarted", {
          description:
            res.workspaceReset === "queued"
              ? "Moved to Backlog and queued a workspace wipe. Move it to Ready to rebuild on a fresh clone of dev."
              : "Moved to Backlog. It has no workspace on disk, so the next run clones dev fresh.",
        });
      }
      router.refresh();
    } finally {
      setDiscardBusy(false);
    }
  }

  async function commitEstimate() {
    if (!ticket) return;
    const trimmed = estimateDraft.trim();
    let cents: number | null = null;
    if (trimmed.length > 0) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        toast.error("Estimate must be a positive number");
        return;
      }
      cents = Math.round(n * 100);
    }
    const res = await setTicketEstimateAction({
      ticketId: ticket.id,
      estimateCents: cents,
    });
    if (!res.ok) {
      toast.error("Couldn't update estimate", { description: res.error });
      return;
    }
    router.refresh();
  }
  async function onLabelToggle(lbl: LabelOption) {
    if (!ticket) return;
    const attached = ticket.labels.some((l) => l.id === lbl.id);
    const res = attached
      ? await removeLabelFromTicketAction({ ticketId: ticket.id, labelId: lbl.id })
      : await addLabelToTicketAction({ ticketId: ticket.id, labelId: lbl.id });
    if (!res.ok) {
      toast.error("Couldn't update labels", { description: res.error });
      return;
    }
    router.refresh();
  }
  async function onLabelCreate(name: string) {
    if (!ticket) return;
    const created = await createLabelAction({ name, color: "muted" });
    if (!created.ok) {
      toast.error("Couldn't create label", { description: created.error });
      return;
    }
    setLabelCatalog((cur) =>
      cur.some((l) => l.id === created.value.id) ? cur : [...cur, created.value],
    );
    // Auto-attach the new label to the current ticket — Linear behaviour.
    const attach = await addLabelToTicketAction({
      ticketId: ticket.id,
      labelId: created.value.id,
    });
    if (!attach.ok) {
      toast.error("Couldn't attach label", { description: attach.error });
      return;
    }
    router.refresh();
  }
  async function onRemoveRelation(
    otherId: string,
    type: "blocked_by" | "related" | "duplicate" | "builds_on",
    direction: "own" | "inverse",
  ) {
    if (!ticket) return;
    // For inverse-direction rows (e.g. "blocks" entries) the stored row lives
    // on the other ticket; reverse the arguments before deleting.
    const args =
      direction === "own"
        ? { ticketId: ticket.id, otherTicketId: otherId, relationType: type }
        : { ticketId: otherId, otherTicketId: ticket.id, relationType: type };
    const res = await removeRelationAction(args);
    if (!res.ok) {
      toast.error("Couldn't remove relation", { description: res.error });
      return;
    }
    // Refresh the relations payload locally; router.refresh handles boards.
    const r = await fetch(`/api/board/tickets/${ticket.id}/relations`, { cache: "no-store" });
    if (r.ok) setRelations((await r.json()) as RelationsResponse);
    router.refresh();
  }
  // Delete confirmation state. The Trash button only renders when
  // ticket.status === 'backlog' (mirrors the server gate) so leaving these
  // booleans here is safe even when the affordance is hidden.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // Initial seed on drawer open: fetch comments + runs once. Comments then
  // stream via `useLiveComments` (Realtime); runs poll on a 5s tick because
  // runs aren't on the publication yet.
  React.useEffect(() => {
    if (!ticket?.id || !open) return;
    let canceled = false;
    const ticketId = ticket.id;

    async function loadCommentsSeed() {
      const res = await fetch(`/api/board/tickets/${ticketId}/comments`, {
        cache: "no-store",
      });
      if (!canceled && res.ok) {
        const j = (await res.json()) as { comments: BoardComment[] };
        setInitialComments(j.comments);
      }
    }
    async function loadRuns() {
      const res = await fetch(`/api/board/tickets/${ticketId}/runs`, {
        cache: "no-store",
      });
      if (!canceled && res.ok) {
        const j = (await res.json()) as { runs: DrawerRun[] };
        setRuns(j.runs);
      }
    }
    async function loadBlockers() {
      const res = await fetch(`/api/board/tickets/${ticketId}/blockers`, {
        cache: "no-store",
      });
      if (!canceled && res.ok) {
        const j = (await res.json()) as { blockers: BoardTicket[] };
        setBlockers(j.blockers);
      }
    }
    async function loadRelations() {
      const res = await fetch(`/api/board/tickets/${ticketId}/relations`, {
        cache: "no-store",
      });
      if (!canceled && res.ok) {
        const j = (await res.json()) as RelationsResponse;
        setRelations(j);
      }
    }
    async function loadLabels() {
      const res = await listLabelsAction();
      if (!canceled && res.ok) {
        setLabelCatalog(res.value);
      }
    }
    async function loadAttachments() {
      const res = await fetch(`/api/board/tickets/${ticketId}/attachments`, {
        cache: "no-store",
      });
      if (!canceled && res.ok) {
        const j = (await res.json()) as { attachments: TicketAttachmentDTO[] };
        setAttachments(j.attachments);
      }
    }
    async function loadAll() {
      setLoading(true);
      await Promise.all([
        loadCommentsSeed(),
        loadRuns(),
        loadBlockers(),
        loadRelations(),
        loadLabels(),
        loadAttachments(),
      ]);
      if (!canceled) setLoading(false);
    }
    void loadAll();
    const t = setInterval(() => {
      void loadRuns();
      void loadBlockers();
      void loadRelations();
    }, 5_000);
    return () => {
      canceled = true;
      clearInterval(t);
    };
  }, [ticket?.id, open]);

  // Reset the active tab when switching tickets so a fresh open lands on
  // Description regardless of what the last drawer left active.
  React.useEffect(() => {
    if (ticket?.id) setTab("description");
  }, [ticket?.id]);

  const { comments, isLive: commentsLive } = useLiveComments(
    open ? (ticket?.id ?? null) : null,
    initialComments,
  );

  if (!ticket) return null;
  const colMeta = COLUMNS.find((c) => c.id === ticket.status);
  // WI-5 — a blocker is open when its work isn't on the integration branch yet,
  // not merely when it isn't `done`. The server classifies it (`landOpenness`);
  // the `status !== "done"` fallback covers a blocker fetched before this shipped.
  const openBlockerCount = blockers.filter((b) =>
    b.landOpenness ? b.landOpenness !== "closed" : b.status !== "done",
  ).length;
  const isInputRequired = ticket.status === "input_required";

  async function onReply(e: React.FormEvent) {
    e.preventDefault();
    if (!ticket || reply.trim().length === 0) return;
    setPosting(true);
    const res = await postCommentAction({
      ticketId: ticket.id,
      body: reply.trim(),
    });
    setPosting(false);
    if (!res.ok) {
      toast.error("Couldn't post comment", { description: res.error });
      return;
    }
    setReply("");
    if (isInputRequired) {
      toast.success("Reply sent", { description: "Resuming the agent run." });
    }
    router.refresh();
  }

  async function onPause() {
    if (!ticket || pauseResumeBusy) return;
    setPauseResumeBusy(true);
    const res = await pauseTicketAction({ ticketId: ticket.id });
    setPauseResumeBusy(false);
    if (!res.ok) {
      toast.error("Couldn't pause ticket", { description: res.error });
      return;
    }
    if ("alreadyAtState" in res) {
      toast.info("Already paused");
      return;
    }
    const n = res.cancelledRunIds.length;
    toast.success("Ticket paused", {
      description:
        n === 0
          ? "No in-flight runs to cancel."
          : `Cancelled ${n} in-flight run${n === 1 ? "" : "s"}.`,
    });
    router.refresh();
  }

  async function onResume() {
    if (!ticket || pauseResumeBusy) return;
    setPauseResumeBusy(true);
    const res = await resumeTicketAction({ ticketId: ticket.id });
    setPauseResumeBusy(false);
    if (!res.ok) {
      toast.error("Couldn't resume ticket", { description: res.error });
      return;
    }
    if ("alreadyAtState" in res) {
      toast.info("Already resumed");
      return;
    }
    if (res.mode === "replay") {
      toast.success("Resumed", {
        description: `Replaying from step ${res.fromStepIdx}.`,
      });
    } else {
      toast.success("Resumed", {
        description: "Dispatching the next role.",
      });
    }
    router.refresh();
  }

  async function onReplayRun(runId: string, fromStepIdx: number) {
    if (pauseResumeBusy) return;
    // If the ticket is paused, the per-run operator replay would dispatch the
    // role against a still-`paused` ticket and the role's terminal
    // `devpilot_move_ticket` call would fail with `paused → <target>`. Route
    // through resumeTicketAction so the ticket un-pauses first; that path
    // picks the latest run on the ticket, which is the right thing to resume
    // from regardless of which run row the operator clicked.
    if (ticket?.status === "paused") {
      setPauseResumeBusy(true);
      const res = await resumeTicketAction({ ticketId: ticket.id });
      setPauseResumeBusy(false);
      if (!res.ok) {
        toast.error("Couldn't resume ticket", { description: res.error });
        return;
      }
      if ("alreadyAtState" in res) {
        toast.info("Already resumed");
      } else if (res.mode === "replay") {
        toast.success("Resumed", {
          description: `Unpaused and replaying from step ${res.fromStepIdx}.`,
        });
      } else {
        toast.success("Resumed", {
          description: "Unpaused and dispatching the next role.",
        });
      }
      router.refresh();
      return;
    }
    setPauseResumeBusy(true);
    let resp: Response;
    try {
      resp = await fetch(`/api/runs/${runId}/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromStepIdx }),
      });
    } catch (err) {
      setPauseResumeBusy(false);
      toast.error("Couldn't start replay", {
        description: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    setPauseResumeBusy(false);
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      toast.error("Replay refused", {
        description: body.error ?? `HTTP ${resp.status}`,
      });
      return;
    }
    toast.success("Replay started", {
      description: `Resuming from step ${fromStepIdx}.`,
    });
    router.refresh();
  }

  async function onConfirmDelete() {
    if (!ticket || deleting) return;
    setDeleting(true);
    const res = await deleteTicketAction({ ticketId: ticket.id });
    setDeleting(false);
    if (!res.ok) {
      toast.error("Couldn't delete ticket", { description: res.error });
      return;
    }
    setConfirmDeleteOpen(false);
    toast.success("Ticket deleted");
    // Close the drawer + force a server-side re-fetch. Realtime DELETE
    // alone is unreliable: Supabase ships only the primary key in
    // `payload.old` by default and the tenant-filtered channel can miss
    // some DELETE events, so the card would visually stick around until
    // the next manual refresh. router.refresh() re-runs loadBoardTickets
    // and the `useEffect` on `initial` in useLiveTickets reseeds the list.
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        {/* Header */}
        <div className="flex flex-col gap-2 border-b px-6 py-4 pr-12">
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            {/* Same identity the card shows, so opening a ticket doesn't swap
                one id for a different-looking one. */}
            <span className="font-mono tracking-wider" title={ticket.id}>
              {formatTicketKey(ticket.ticketNumber, ticket.id)}
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" /> updated {relativeTime(ticket.updatedAt)}
            </span>
          </div>
          <EditableTitle ticketId={ticket.id} value={ticket.title} />
          <SheetDescription className="sr-only">
            Ticket details, comment thread, and run history.
          </SheetDescription>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {colMeta ? <Badge tone={colMeta.tone}>{colMeta.label}</Badge> : null}
            {openBlockerCount > 0 ? (
              <Badge tone="warn">
                <Wrench className="h-3 w-3" /> Blocked ({openBlockerCount})
              </Badge>
            ) : null}
            {ticket.retryCount > 0 ? (
              <Badge tone="warn">
                <RotateCw className="h-3 w-3" /> retry {ticket.retryCount}
              </Badge>
            ) : null}
            {isInputRequired ? (
              <Badge tone="warn">
                <Sparkles className="h-3 w-3" /> Awaiting your reply
              </Badge>
            ) : null}
            {/* Pause / Resume. Header-level affordance for the operator-
                initiated soft-cancel + checkpoint resume. Hidden in states
                where neither makes sense (terminal: done/failed; pre-flight:
                backlog/ready). PR1 + PR2 of the pause/resume work. */}
            {ticket.status === "paused" ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onResume}
                disabled={pauseResumeBusy}
                title="Resume from the last good step"
              >
                <PlayCircle className="h-3 w-3" />
                Resume
              </Button>
            ) : ticket.status === "in_progress" ||
              ticket.status === "input_required" ||
              ticket.status === "blocked" ||
              ticket.status === "in_review" ||
              ticket.status === "assigned" ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onPause}
                disabled={pauseResumeBusy}
                title="Pause this ticket (soft-cancels in-flight runs)"
              >
                <PauseCircle className="h-3 w-3" />
                Pause
              </Button>
            ) : null}
            {/* Audit-grade PDF export. A fetch, NOT a plain `<a download>`:
                the route can legitimately 500 (the aggregator fails loud on
                land-state / verification reads), and an anchor ignores the
                status code — the browser happily saved the JSON error body as
                a .pdf. See `useTicketExport`, which checks the response before
                committing to a download and toasts on failure. */}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={ticketExport.busy}
              onClick={() => void ticketExport.start()}
              title="Download an audit PDF: narration, cost, evidence and the full thread"
            >
              <FileDown className="h-3 w-3" />
              {ticketExport.busy ? "Building PDF…" : "Export PDF"}
            </Button>
            {/* Slice C — Open this ticket's workspace folder in VS Code.
                Only meaningful once the ticket has a workspace (i.e. at
                least one run has cwd'd into it). The server action 404s
                gracefully when none exists. We show the button for any
                non-backlog state since the runner creates the workspace
                on first dispatch. */}
            {ticket.status !== "backlog" ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={async () => {
                  const res = await getVscodeOpenUrlAction({
                    kind: "ticket",
                    ticketId: ticket.id,
                  });
                  if (!res.ok) {
                    toast.error("Couldn't open in VS Code", {
                      description: res.error,
                    });
                    return;
                  }
                  window.location.href = res.value.url;
                }}
                title="Open workspace in VS Code"
              >
                <Code2 className="h-3 w-3" />
                VS Code
              </Button>
            ) : null}
            {/* M5i — jump directly into the /changes review flow when the
                ticket has unpushed agent work. Drawer-level affordance pairs
                with the amber chip on TicketCard so the CTA is reachable from
                both the board glance view and inside the drawer. */}
            {ticket.pendingPush ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                asChild
                title={`Review ${ticket.pendingPush.unpushedCount} unpushed commit${ticket.pendingPush.unpushedCount === 1 ? "" : "s"} on ${ticket.pendingPush.branch}`}
              >
                <Link href={`/changes/${ticket.pendingPush.id}`}>
                  <GitBranch className="h-3 w-3" />
                  Review changes
                </Link>
              </Button>
            ) : null}
            {/* Ticket recovery — "Land into dev". Shown for a done ticket that
                still has committed-but-unlanded work (a pending_pushes row).
                Drives the existing land pipeline; the server action validates
                the integration branch / auto-land / branch presence and
                surfaces any refusal as a toast. */}
            {ticket.status === "done" && ticket.pendingPush ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onLandNow}
                disabled={landBusy}
                title="Land this ticket's branch into the integration branch (dev)"
              >
                {landBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <GitMerge className="h-3 w-3" />
                )}
                Land into dev
              </Button>
            ) : null}
            {/* Ticket recovery — "Restart from dev". Reopens a done/paused
                ticket and forces its next run to fresh-clone the integration
                branch. Human-only (server action). Confirmed via a dialog that
                warns when unpushed work would be at risk. */}
            {ticket.status === "done" || ticket.status === "paused" ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setRestartConfirmOpen(true)}
                disabled={restartBusy}
                title="Reopen this ticket and rebuild it on the latest dev"
              >
                {restartBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Restart from dev
              </Button>
            ) : null}
            {/* Ticket recovery — "Discard & restart from dev". The DELIBERATE,
                irreversible discard of a NON-done, partially-completed ticket:
                throws away its uncommitted/unpushed work and resets it to
                Backlog to re-run fresh off dev. Human-only (server action) and
                visually distinct (destructive) from the safe "Restart from dev".
                Confirmed via a type-to-confirm dialog below. */}
            {DRAWER_DISCARDABLE_STATUSES.has(ticket.status) ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  setDiscardConfirmText("");
                  setDiscardConfirmOpen(true);
                }}
                disabled={discardBusy}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                title="Permanently discard this ticket's uncommitted/unpushed work and restart it from dev"
              >
                {discardBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                Discard &amp; restart
              </Button>
            ) : null}
            {/* Delete: allowed in any state with no in-flight run —
                backlog (pre-flight cleanup), done + failed (terminal).
                Active states (in_progress, assigned, etc.) stay protected
                because the engine still has a live dispatch / running run
                that assumes the ticket row exists. Same gate as the server
                action. */}
            {DRAWER_DELETABLE_STATUSES.has(ticket.status) ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setConfirmDeleteOpen(true)}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive ml-auto"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </Button>
            ) : null}
          </div>
        </div>

        {/* Delete confirmation. Kept inside the SheetContent so it sits
            above the sheet's overlay correctly. */}
        <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
          <DialogContent className="max-w-md">
            <DialogTitle>Delete this ticket?</DialogTitle>
            <DialogDescription>
              {ticket.status === "backlog" ? (
                <>
                  This permanently removes the ticket and any dependency edges touching it. Comments
                  and run history go with it. This can&apos;t be undone.
                </>
              ) : (
                <>
                  This permanently removes the ticket, its comments, sub-issues, and dependency
                  edges. Completed run records stay in the runs list for cost auditing (with the
                  ticket reference cleared). This can&apos;t be undone.
                </>
              )}
            </DialogDescription>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDeleteOpen(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onConfirmDelete}
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Restart-from-dev confirmation. When the ticket carries unpushed work
            the safe restart would be refused server-side, so we never present it
            as an enabled button that dead-ends — instead we surface only the
            actions that actually work for THIS ticket: Review changes (always),
            Land into dev (done tickets only — it is done-only), and Discard &
            restart (the deliberate throw-away, for a non-done ticket). With no
            unpushed work, the plain restart proceeds exactly as before. */}
        <Dialog open={restartConfirmOpen} onOpenChange={setRestartConfirmOpen}>
          <DialogContent className="max-w-md">
            <DialogTitle>Restart this ticket from dev?</DialogTitle>
            <DialogDescription>
              {ticket.pendingPush ? (
                <>
                  This ticket has {ticket.pendingPush.unpushedCount} unpushed commit
                  {ticket.pendingPush.unpushedCount === 1 ? "" : "s"} on{" "}
                  <span className="font-mono">{ticket.pendingPush.branch}</span> that exist only in
                  its workspace. A plain restart would abandon them, so it is not offered here.
                  {ticket.status === "done" ? (
                    <>
                      {" "}
                      Use <strong>Land into dev</strong> or <strong>Review changes</strong> to keep
                      that work first.
                    </>
                  ) : (
                    <>
                      {" "}
                      Use <strong>Review changes</strong> to keep that work first, or{" "}
                      <strong>Discard &amp; restart</strong> to deliberately throw it away and
                      rebuild from dev.
                    </>
                  )}
                </>
              ) : (
                <>
                  This reopens the ticket to Backlog and clears its old workspace so the next run
                  fresh-clones the latest <span className="font-mono">dev</span> and rebuilds on top
                  of the accumulated work. Move it to Ready afterwards to run it.
                </>
              )}
            </DialogDescription>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRestartConfirmOpen(false)}
                disabled={restartBusy}
              >
                Cancel
              </Button>
              {ticket.pendingPush ? (
                <>
                  <Button type="button" variant="ghost" size="sm" asChild>
                    <Link href={`/changes/${ticket.pendingPush.id}`}>
                      <GitBranch className="h-3 w-3" />
                      Review changes
                    </Link>
                  </Button>
                  {ticket.status === "done" ? (
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={onLandNow}
                      disabled={landBusy}
                    >
                      {landBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <GitMerge className="h-3 w-3" />
                      )}
                      Land into dev
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setRestartConfirmOpen(false);
                        setDiscardConfirmText("");
                        setDiscardConfirmOpen(true);
                      }}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      Discard &amp; restart
                    </Button>
                  )}
                </>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={onRestartFromDev}
                  disabled={restartBusy}
                >
                  {restartBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3" />
                  )}
                  {restartBusy ? "Restarting…" : "Restart from dev"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Discard-&-restart confirmation. This DESTROYS the ticket's
            uncommitted + unpushed work irreversibly, so it is a type-to-confirm:
            the operator must type the exact word to arm the destructive button.
            A stray click can never reach it. */}
        <Dialog
          open={discardConfirmOpen}
          onOpenChange={(o) => {
            setDiscardConfirmOpen(o);
            if (!o) setDiscardConfirmText("");
          }}
        >
          <DialogContent className="max-w-md">
            <DialogTitle className="text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Discard this ticket&apos;s work and restart?
            </DialogTitle>
            <DialogDescription className="text-destructive font-medium opacity-100">
              {ticket.pendingPush ? (
                <>
                  This permanently discards {ticket.pendingPush.unpushedCount} unpushed commit
                  {ticket.pendingPush.unpushedCount === 1 ? "" : "s"} on{" "}
                  <span className="font-mono">{ticket.pendingPush.branch}</span> — they exist only
                  in this workspace and cannot be recovered.
                </>
              ) : (
                <>
                  This permanently discards any uncommitted changes and local-only commits in this
                  ticket&apos;s workspace — they exist only here and cannot be recovered.
                </>
              )}
            </DialogDescription>
            <p className="text-sm opacity-70">
              The ticket is reset to Backlog and its workspace is wiped, so the next run
              fresh-clones the latest <span className="font-mono">dev</span> and rebuilds from
              scratch. Move it to Ready afterwards to run it.
            </p>
            <div className="space-y-1.5">
              <label htmlFor="discard-confirm" className="text-muted-foreground text-xs">
                Type <span className="text-foreground font-mono">{DISCARD_CONFIRM_WORD}</span> to
                confirm.
              </label>
              <Input
                id="discard-confirm"
                autoComplete="off"
                value={discardConfirmText}
                onChange={(e) => setDiscardConfirmText(e.target.value)}
                placeholder={DISCARD_CONFIRM_WORD}
                disabled={discardBusy}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDiscardConfirmOpen(false);
                  setDiscardConfirmText("");
                }}
                disabled={discardBusy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onDiscardAndRestart}
                disabled={
                  discardBusy || discardConfirmText.trim().toLowerCase() !== DISCARD_CONFIRM_WORD
                }
              >
                {discardBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                {discardBusy ? "Discarding…" : "Discard & restart"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Tabs */}
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-b px-6 py-2">
            <TabsList className="w-full">
              <TabsTrigger value="description" className="flex-1">
                Description
              </TabsTrigger>
              <TabsTrigger value="comments" className="flex-1">
                Thread
                {comments.length > 0 ? (
                  <span className="bg-muted-foreground/15 ml-1.5 rounded px-1 text-[10px] tabular-nums">
                    {comments.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="runs" className="flex-1">
                Runs
                {runs.length > 0 ? (
                  <span className="bg-muted-foreground/15 ml-1.5 rounded px-1 text-[10px] tabular-nums">
                    {runs.length}
                  </span>
                ) : null}
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {/* Description tab */}
            <TabsContent value="description" className="mt-0 flex flex-col gap-5">
              {/* M1 — Properties strip. Priority + Labels + Due + Estimate */}
              <Section title="Properties">
                <div className="flex flex-wrap items-center gap-2">
                  <PropertyRow label="Priority">
                    <PriorityPicker
                      value={ticket.priority}
                      onChange={(p) => void onPriorityChange(p)}
                      openSignal={priorityOpenSignal}
                    />
                  </PropertyRow>
                  <PropertyRow label="Due">
                    <DueDatePicker
                      value={ticket.dueAt}
                      onChange={(iso) => void onDueChange(iso)}
                      openSignal={dueOpenSignal}
                    />
                  </PropertyRow>
                  <PropertyRow label="Estimate ($)">
                    <Input
                      ref={estimateInputRef}
                      value={estimateDraft}
                      onChange={(e) => setEstimateDraft(e.target.value)}
                      onBlur={() => void commitEstimate()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitEstimate();
                        }
                      }}
                      placeholder="0.00"
                      inputMode="decimal"
                      className="h-7 w-20 text-xs"
                    />
                  </PropertyRow>
                  <PropertyRow label="Labels">
                    <LabelPicker
                      options={labelCatalog}
                      selectedIds={ticket.labels.map((l) => l.id)}
                      onToggle={onLabelToggle}
                      onCreate={onLabelCreate}
                      openSignal={labelOpenSignal}
                    />
                  </PropertyRow>
                </div>
                {ticket.labels.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {ticket.labels.map((lbl) => (
                      <Badge
                        key={lbl.id}
                        tone={lbl.color as never}
                        className="h-5 gap-1 px-1.5 text-[10px]"
                      >
                        {lbl.name}
                        <button
                          type="button"
                          onClick={() => void onLabelToggle(lbl)}
                          aria-label={`Remove label ${lbl.name}`}
                          className="text-current/70 rounded hover:text-current"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </Section>

              {/* SME safety gate — arm the human-approval requirement and, when
                  the gate has parked the ticket, offer the captain the one move
                  that completes it. Rendered as its own section (not a chip in
                  Properties) so a safety-relevant control reads unmistakably. */}
              <Section title="Safety">
                <div
                  className={cn(
                    "flex flex-col gap-2 rounded-md border p-3",
                    ticket.safetyCritical
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-border bg-muted/30",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2">
                      {ticket.safetyCritical ? (
                        <ShieldAlert className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
                      ) : (
                        <ShieldCheck className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Safety-critical</p>
                        <p className="text-muted-foreground text-xs">
                          {ticket.safetyCritical
                            ? "Only a human can approve this ticket to Done. Agent or system attempts to complete it are blocked and parked here for review."
                            : "Flag this when the work needs a qualified human to sign off before it can reach Done."}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant={ticket.safetyCritical ? "outline" : "secondary"}
                      size="sm"
                      disabled={safetyBusy}
                      onClick={() => void onSafetyToggle(!ticket.safetyCritical)}
                      className="shrink-0"
                    >
                      {safetyBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : ticket.safetyCritical ? (
                        "Remove flag"
                      ) : (
                        "Mark safety-critical"
                      )}
                    </Button>
                  </div>

                  {ticket.safetyCritical && ticket.status === "blocked" ? (
                    <div className="border-destructive/30 flex flex-col gap-2 border-t pt-2">
                      <p className="text-xs font-medium">
                        Awaiting human safety approval — review the work below, then approve.
                      </p>
                      <Button
                        size="sm"
                        disabled={safetyBusy}
                        onClick={() => void onApproveSafety()}
                        className="self-start"
                      >
                        {safetyBusy ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                        )}
                        Approve &amp; mark Done
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Section>

              <Section title="Description">
                <EditableDescription
                  ticketId={ticket.id}
                  value={ticket.description}
                  field="description"
                  emptyLabel="No description yet — PM will refine on first pickup."
                  renderAs="prose"
                  locked={ticket.status !== "backlog"}
                />
              </Section>

              <Section title="Acceptance criteria">
                <EditableDescription
                  ticketId={ticket.id}
                  value={ticket.acceptanceCriteria}
                  field="acceptance_criteria"
                  emptyLabel="No acceptance criteria yet — add bullets for what 'done' looks like."
                  renderAs="code"
                  locked={ticket.status !== "backlog"}
                />
              </Section>

              {attachments.length > 0 ? (
                <Section title={`Screenshots (${attachments.length})`}>
                  {/* Read-only. Thumbnails open the full-size image via the
                      short-lived signed URL (private bucket). A pasted image is
                      UNTRUSTED content — Phase 3 (delivering it to a working
                      agent) must fence it as data; displaying it here is fine. */}
                  <div className="flex flex-wrap gap-2">
                    {attachments.map((a) =>
                      a.signedUrl ? (
                        <a
                          key={a.id}
                          href={a.signedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="border-border bg-background hover:border-ring/60 group relative block h-20 w-20 overflow-hidden rounded-md border transition-colors"
                          title="Open full size"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={a.signedUrl}
                            alt="ticket screenshot"
                            className="h-full w-full object-cover"
                          />
                          <span className="bg-background/80 text-muted-foreground absolute bottom-0.5 right-0.5 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <ExternalLink className="h-3 w-3" />
                          </span>
                        </a>
                      ) : (
                        <div
                          key={a.id}
                          className="border-border bg-muted/30 text-muted-foreground flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border text-[9px]"
                          title="Preview unavailable"
                        >
                          <ImageIcon className="h-4 w-4" aria-hidden />
                          unavailable
                        </div>
                      ),
                    )}
                  </div>
                </Section>
              ) : null}

              {blockers.length > 0 ? (
                <Section title={`Dependencies (${blockers.length})`}>
                  <ul className="flex flex-col gap-1.5">
                    {blockers.map((b) => (
                      <li key={b.id}>
                        <Link
                          href={`/board?ticket=${b.id}`}
                          className="bg-card hover:border-ring/40 hover:bg-accent flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <Badge tone={BLOCKER_STATUS_TONE[b.status]}>{b.status}</Badge>
                            {/* WI-5 — without this, a blocker reading `done` that
                                is STILL holding the ticket back looks like a bug.
                                Say what it is actually waiting for: the landing. */}
                            {b.landOpenness === "awaiting_land" ? (
                              <Badge
                                tone="warn"
                                title="Done, but its work isn't on the integration branch yet. It unblocks automatically once it lands."
                              >
                                waiting to land
                              </Badge>
                            ) : null}
                            <span className="text-foreground truncate">{b.title}</span>
                          </div>
                          <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {relations && relations.subIssues.length > 0 ? (
                <Section
                  title={`Sub-issues (${relations.subIssues.filter((s) => s.status === "done").length}/${relations.subIssues.length})`}
                >
                  <RelationList rows={relations.subIssues} />
                </Section>
              ) : null}

              {relations &&
              (relations.blocks.length > 0 ||
                relations.related.length > 0 ||
                relations.duplicate.length > 0 ||
                relations.buildsOn.length > 0 ||
                relations.builtOnBy.length > 0) ? (
                <Section title="Relations">
                  {relations.buildsOn.length > 0 ? (
                    <RelationGroup
                      heading="Builds on"
                      tone="info"
                      rows={relations.buildsOn}
                      onRemove={(id) => void onRemoveRelation(id, "builds_on", "own")}
                    />
                  ) : null}
                  {relations.builtOnBy.length > 0 ? (
                    <RelationGroup
                      heading="Built on by"
                      tone="info"
                      rows={relations.builtOnBy}
                      onRemove={(id) => void onRemoveRelation(id, "builds_on", "inverse")}
                    />
                  ) : null}
                  {relations.blocks.length > 0 ? (
                    <RelationGroup
                      heading="Blocks"
                      tone="warn"
                      rows={relations.blocks}
                      onRemove={(id) => void onRemoveRelation(id, "blocked_by", "inverse")}
                    />
                  ) : null}
                  {relations.related.length > 0 ? (
                    <RelationGroup
                      heading="Related"
                      tone="info"
                      rows={relations.related}
                      onRemove={(id) => void onRemoveRelation(id, "related", "own")}
                    />
                  ) : null}
                  {relations.duplicate.length > 0 ? (
                    <RelationGroup
                      heading="Duplicate"
                      tone="muted"
                      rows={relations.duplicate}
                      onRemove={(id) => void onRemoveRelation(id, "duplicate", "own")}
                    />
                  ) : null}
                </Section>
              ) : null}
            </TabsContent>

            {/* Thread tab */}
            <TabsContent value="comments" className="mt-0">
              <div className="text-muted-foreground mb-3 flex items-center gap-2 text-xs">
                <LiveDot
                  isLive={commentsLive}
                  title={commentsLive ? "Comments stream subscribed" : "Comments stream connecting"}
                />
                <span>{commentsLive ? "Live" : "Connecting…"}</span>
              </div>
              {loading && comments.length === 0 ? (
                <p className="text-muted-foreground text-xs">Loading comments…</p>
              ) : comments.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No comments yet. Be the first to chime in below.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {comments.map((c) => (
                    <li
                      key={c.id}
                      className={cn(
                        "rounded-lg border p-3",
                        c.authorType === "human"
                          ? "border-chart-1/30 bg-chart-1/5"
                          : c.authorType === "system"
                            ? "border-destructive/30 bg-destructive/5"
                            : "bg-card",
                      )}
                    >
                      <div className="mb-1 flex items-center gap-2 text-xs">
                        {c.authorType === "human" ? (
                          <User className="text-chart-1 h-3 w-3" />
                        ) : c.authorType === "system" ? (
                          <Sparkles className="text-destructive h-3 w-3" />
                        ) : (
                          <Bot className="text-muted-foreground h-3 w-3" />
                        )}
                        <span className="text-foreground font-medium">{c.authorId}</span>
                        <span className="text-muted-foreground font-mono text-[11px]">
                          {relativeTime(c.createdAt)}
                        </span>
                      </div>
                      {(() => {
                        // Slice A — render the structured `devpilot_request_secret`
                        // payload as an inline masked-input form. Falls
                        // through to the plain markdown body for all other
                        // comments. The metadata is server-trusted; we still
                        // narrow defensively so a malformed row doesn't crash
                        // the drawer.
                        const meta = c.metadata as Record<string, unknown> | null | undefined;
                        if (
                          meta &&
                          meta.kind === "secret_request" &&
                          Array.isArray(meta.keys) &&
                          meta.keys.every((k) => typeof k === "string")
                        ) {
                          return (
                            <SecretRequestCard
                              ticketId={ticket.id}
                              projectId={
                                typeof meta.project_id === "string" ? meta.project_id : null
                              }
                              keys={meta.keys as string[]}
                              rationale={c.body}
                            />
                          );
                        }
                        return <MessageMarkdown content={c.body} />;
                      })()}
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>

            {/* Runs tab */}
            <TabsContent value="runs" className="mt-0">
              {runs.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No runs yet. Move the ticket to Ready to kick one off.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {runs.map((r) => {
                    // Recoverable runs surface a "Resume from step N" button.
                    // 'done' runs don't (the next-role dispatch is handled at
                    // ticket level). lastGoodStepIdx===-1 means the run
                    // produced nothing useful — replay from idx=0 is the
                    // clean restart.
                    const canReplay = r.status === "failed" || r.status === "cancelled";
                    const fromStep = r.lastGoodStepIdx >= 0 ? r.lastGoodStepIdx + 1 : 0;
                    return (
                      <li key={r.id} className="flex items-stretch gap-1.5">
                        <Link
                          href={`/runs/${r.id}`}
                          className="bg-card hover:border-ring/40 hover:bg-accent flex flex-1 items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <Badge tone={RUN_STATUS_TONE[r.status]}>{r.status}</Badge>
                            {r.agentRole ? <Badge tone="info">{r.agentRole}</Badge> : null}
                            {r.runnerKind ? <Badge tone="muted">{r.runnerKind}</Badge> : null}
                            <span className="text-muted-foreground font-mono">
                              {r.id.slice(0, 8)}
                            </span>
                          </div>
                          <div className="text-muted-foreground flex shrink-0 items-center gap-2">
                            <span className="font-mono tabular-nums">{fmtCents(r.spentCents)}</span>
                            <span className="font-mono">{relativeTime(r.createdAt)}</span>
                            <ExternalLink className="h-3 w-3" />
                          </div>
                        </Link>
                        {canReplay ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={pauseResumeBusy}
                            onClick={() => onReplayRun(r.id, fromStep)}
                            title={`Resume this run from step ${fromStep}`}
                            className="shrink-0"
                          >
                            <SkipForward className="h-3 w-3" />
                            {fromStep === 0 ? "Replay" : `Resume @${fromStep}`}
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </TabsContent>
          </div>
        </Tabs>

        {/* Sticky composer */}
        <form
          onSubmit={onReply}
          className="bg-background/80 flex flex-col gap-2 border-t px-6 py-3 backdrop-blur"
        >
          <Textarea
            placeholder={
              isInputRequired
                ? "The agent is waiting on you. Reply to resume the run."
                : "Add a comment…"
            }
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void onReply(e as unknown as React.FormEvent);
              }
            }}
            rows={3}
            className={cn(isInputRequired && "border-warning/40 focus-visible:ring-warning/40")}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-[11px]">
              <kbd className="bg-muted rounded border px-1 font-mono text-[10px]">
                {typeof navigator !== "undefined" &&
                navigator.platform.toLowerCase().includes("mac")
                  ? "⌘"
                  : "Ctrl"}
              </kbd>{" "}
              + <kbd className="bg-muted rounded border px-1 font-mono text-[10px]">Enter</kbd> to
              send
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={posting || reply.trim().length === 0}
              >
                <Send className="h-3.5 w-3.5" />
                {posting ? "Posting…" : "Post"}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wider">
        {title}
      </h3>
      {children}
    </section>
  );
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-[10px] uppercase tracking-wider">{label}</span>
      {children}
    </div>
  );
}

function RelationList({
  rows,
}: {
  rows: ReadonlyArray<{ id: string; title: string; status: string }>;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <li key={r.id}>
          <Link
            href={`/board?ticket=${r.id}`}
            className="bg-card hover:border-ring/40 hover:bg-accent flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Badge tone={statusToTone(r.status)}>{r.status}</Badge>
              <span className="text-foreground truncate">{r.title}</span>
            </div>
            <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function RelationGroup({
  heading,
  tone,
  rows,
  onRemove,
}: {
  heading: string;
  tone: "info" | "warn" | "ok" | "danger" | "muted";
  rows: ReadonlyArray<{ id: string; title: string; status: string }>;
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center gap-1.5">
        <Badge tone={tone} className="h-4 px-1.5 text-[10px]">
          {heading}
        </Badge>
        <span className="text-muted-foreground text-[10px] tabular-nums">{rows.length}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-1">
            <Link
              href={`/board?ticket=${r.id}`}
              className="bg-card hover:border-ring/40 hover:bg-accent flex flex-1 items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Badge tone={statusToTone(r.status)}>{r.status}</Badge>
                <span className="text-foreground truncate">{r.title}</span>
              </div>
              <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0" />
            </Link>
            {onRemove ? (
              <button
                type="button"
                onClick={() => onRemove(r.id)}
                aria-label="Remove relation"
                className="text-muted-foreground hover:bg-muted hover:text-destructive rounded p-1"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusToTone(status: string): "info" | "warn" | "ok" | "danger" | "muted" {
  if (status === "done") return "ok";
  if (status === "failed") return "danger";
  if (status === "blocked" || status === "input_required") return "warn";
  if (status === "backlog") return "muted";
  return "info";
}
