"use client";

// The lesson review queue — a full-screen card stack over the tenant's
// `status='candidate'` lessons. Each card shows one candidate + the mistake it
// was extracted from (with run/ticket deep-links), and an operator walks them
// with Accept / Reject / Skip / Edit + auto-advance.
//
// Interaction model follows the repo's optimistic-action pattern
// (agent-autonomy-card.tsx): call the server action, advance on `ok`, roll the
// card back + toast on failure. Skip is PURELY client-side (no DB write) — the
// row stays `candidate` for a later pass. The inline auto-approve toggle wires
// the tenant flag so future extractions can skip the queue entirely.

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, ExternalLink, GraduationCap, Pencil, SkipForward, X } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";
import {
  approveLearningAction,
  editLearningAction,
  rejectLearningAction,
  setLearningAutoApproveAction,
} from "@/lib/learning/actions";
import { removeFromQueue } from "@/lib/learning/queue-nav";
import type { LessonTableMistake, LessonTableRow } from "@/lib/learning/table-view";
import { ConfidenceBadge, ConfidenceReason } from "./confidence-badge";
import { MISTAKE_LABEL, SCOPE_TONE } from "./shared-meta";

// One row shape across both views (`LessonTableRow`), so a lesson carries the
// same fields — including the nullable `confidence` — whichever way it is shown.
export type QueueMistake = LessonTableMistake;
export type QueueCandidate = LessonTableRow;

export function ReviewQueue({
  candidates,
  autoApprove,
}: {
  candidates: QueueCandidate[];
  autoApprove: boolean;
}) {
  const router = useRouter();
  // Working set: settled rows are removed optimistically. `index` points at the
  // current card within the remaining set.
  const [remaining, setRemaining] = React.useState<QueueCandidate[]>(candidates);
  const [index, setIndex] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const [editing, setEditing] = React.useState<{ body: string } | null>(null);
  // Mirror `index` so the removal callback can read the live pointer without
  // re-creating itself on every navigation.
  const indexRef = React.useRef(index);
  React.useEffect(() => {
    indexRef.current = index;
  }, [index]);

  React.useEffect(() => {
    setRemaining(candidates);
    setIndex(0);
    setEditing(null);
  }, [candidates]);

  const total = candidates.length;
  const settled = total - remaining.length;
  const current = remaining[index] ?? null;

  // Remove a card from the working set (settled OR deferred) and re-clamp the
  // pointer. The pure `removeFromQueue` is the single navigation rule shared by
  // Accept/Reject and Skip, so the batch always shrinks toward the empty state.
  const removeCard = React.useCallback((id: string) => {
    setEditing(null);
    setRemaining((prev) => {
      const { items, index: nextIndex } = removeFromQueue(prev, indexRef.current, id);
      setIndex(nextIndex);
      return items;
    });
  }, []);

  const runAction = React.useCallback(
    async (
      c: QueueCandidate,
      action: () => Promise<{ ok: true } | { ok: false; error: string }>,
      successMsg: string,
    ) => {
      setSaving(true);
      const res = await action();
      setSaving(false);
      if (!res.ok) {
        toast.error(res.error || "Action failed");
        return;
      }
      toast.success(successMsg);
      removeCard(c.id);
      router.refresh();
    },
    [removeCard, router],
  );

  const onAccept = React.useCallback(
    (c: QueueCandidate) =>
      runAction(c, () => approveLearningAction({ id: c.id }), "Lesson activated"),
    [runAction],
  );
  const onReject = React.useCallback(
    (c: QueueCandidate) =>
      runAction(c, () => rejectLearningAction({ id: c.id }), "Lesson rejected"),
    [runAction],
  );
  const onSkip = React.useCallback(
    (c: QueueCandidate) => {
      // Defer, don't settle: no DB write, so the row stays a `candidate` for a
      // later pass (a refresh reloads it). It still leaves the in-session working
      // set via the SAME removal rule as Accept/Reject, so skipping the last card
      // reaches the empty "all caught up" state instead of dead-ending on it.
      removeCard(c.id);
    },
    [removeCard],
  );

  const onSaveEdit = React.useCallback(
    async (c: QueueCandidate, body: string) => {
      setSaving(true);
      const res = await editLearningAction({ id: c.id, body });
      setSaving(false);
      if (!res.ok) {
        toast.error(res.error || "Edit failed");
        return;
      }
      // Reflect the edit in the working set without re-fetching; keep the card.
      setRemaining((prev) => prev.map((x) => (x.id === c.id ? { ...x, body } : x)));
      setEditing(null);
      toast.success("Lesson updated");
      router.refresh();
    },
    [router],
  );

  // Keyboard shortcuts (nice-to-have): A accept, R reject, S skip — but not
  // while editing (the textarea owns the keys then).
  React.useEffect(() => {
    if (!current || editing) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (saving) return;
      if (e.key === "a" || e.key === "A") void onAccept(current!);
      else if (e.key === "r" || e.key === "R") void onReject(current!);
      else if (e.key === "s" || e.key === "S") onSkip(current!);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, editing, saving, onAccept, onReject, onSkip]);

  return (
    <div className="flex flex-col gap-6">
      <AutoApproveToggle initial={autoApprove} />

      {current ? (
        <>
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span>
              Reviewing {Math.min(settled + index + 1, total)} of {total} · {remaining.length}{" "}
              remaining
            </span>
            <span className="hidden sm:inline">
              Shortcuts: <kbd className="font-mono">A</kbd> accept ·{" "}
              <kbd className="font-mono">R</kbd> reject · <kbd className="font-mono">S</kbd> skip
            </span>
          </div>

          <CandidateCard
            key={current.id}
            candidate={current}
            editing={editing}
            saving={saving}
            onAccept={() => void onAccept(current)}
            onReject={() => void onReject(current)}
            onSkip={() => onSkip(current)}
            onStartEdit={() => setEditing({ body: current.body })}
            onCancelEdit={() => setEditing(null)}
            onChangeEdit={(body) => setEditing({ body })}
            onSaveEdit={(body) => void onSaveEdit(current, body)}
          />
        </>
      ) : (
        <div className="bg-card/50 text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center text-sm">
          <GraduationCap className="h-6 w-6" />
          {total === 0 ? (
            <p>No candidate lessons to review right now.</p>
          ) : (
            <p>All caught up — you reviewed every candidate in this batch.</p>
          )}
        </div>
      )}
    </div>
  );
}

function CandidateCard({
  candidate,
  editing,
  saving,
  onAccept,
  onReject,
  onSkip,
  onStartEdit,
  onCancelEdit,
  onChangeEdit,
  onSaveEdit,
}: {
  candidate: QueueCandidate;
  editing: { body: string } | null;
  saving: boolean;
  onAccept: () => void;
  onReject: () => void;
  onSkip: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeEdit: (body: string) => void;
  onSaveEdit: (body: string) => void;
}) {
  const m = candidate.mistake;
  return (
    <div className="bg-card rounded-xl border shadow-sm">
      {/* Lesson */}
      <div className="border-b px-6 py-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {/* Confidence leads the row: it is the first thing that should shape
              how hard the operator looks at this lesson. Nullable — an ungraded
              lesson renders as such, never as a grade. */}
          <ConfidenceBadge confidence={candidate.confidence} />
          <Badge tone={SCOPE_TONE[candidate.scope]}>
            {candidate.scope === "role" && candidate.roleSlug
              ? `role · ${candidate.roleSlug}`
              : candidate.scope}
          </Badge>
          <Badge tone="muted">{candidate.category}</Badge>
        </div>

        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              autoFocus
              value={editing.body}
              disabled={saving}
              onChange={(e) => onChangeEdit(e.target.value)}
              className="min-h-[72px]"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={saving || editing.body.trim().length === 0}
                onClick={() => onSaveEdit(editing.body)}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" disabled={saving} onClick={onCancelEdit}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-foreground text-lg font-medium leading-snug">{candidate.body}</p>
            <ConfidenceReason reason={candidate.confidenceReason} />
          </div>
        )}
      </div>

      {/* Source-mistake context */}
      <div className="px-6 py-4">
        <div className="text-muted-foreground mb-2 text-[11px] font-medium uppercase tracking-wider">
          Extracted from
        </div>
        {m ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="warn">{MISTAKE_LABEL[m.type] ?? m.type}</Badge>
              <span className="text-muted-foreground">
                by <span className="text-foreground font-medium">{m.role}</span>
              </span>
            </div>
            {m.evidenceSummary && (
              <pre className="bg-muted/50 text-muted-foreground max-h-40 overflow-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-xs">
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
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-t px-6 py-4">
        <Button variant="primary" disabled={saving || !!editing} onClick={onAccept}>
          <Check className="h-4 w-4" /> Accept
        </Button>
        <Button variant="outline" disabled={saving || !!editing} onClick={onReject}>
          <X className="h-4 w-4" /> Reject
        </Button>
        <Button variant="ghost" disabled={saving || !!editing} onClick={onSkip}>
          <SkipForward className="h-4 w-4" /> Skip
        </Button>
        {!editing && (
          <Button variant="ghost" disabled={saving} onClick={onStartEdit} className="ml-auto">
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        )}
      </div>
    </div>
  );
}

function AutoApproveToggle({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => setEnabled(initial), [initial]);

  async function onToggle(next: boolean) {
    setSaving(true);
    setEnabled(next);
    const res = await setLearningAutoApproveAction({ enabled: next });
    setSaving(false);
    if (!res.ok) {
      setEnabled(!next);
      toast.error(res.error || "Couldn't save");
      return;
    }
    toast.success(
      next
        ? "Auto-approve on — new lessons activate without review."
        : "Auto-approve off — new lessons wait for your review here.",
    );
    router.refresh();
  }

  return (
    <div className="bg-card flex flex-col gap-2 rounded-xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-foreground text-sm font-medium">Auto-approve new lessons</div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          When on, lessons extracted from future mistakes become active immediately, skipping this
          queue. Off by default — the review gate is the safety story, so leave it off unless you
          trust the extractor unattended.
        </p>
      </div>
      <Toggle
        checked={enabled}
        disabled={saving}
        onChange={(c) => void onToggle(c)}
        ariaLabel="Auto-approve new lessons"
      />
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors",
        checked ? "bg-foreground border-transparent" : "border-border bg-muted",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "bg-background inline-block h-3.5 w-3.5 transform rounded-full shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}
