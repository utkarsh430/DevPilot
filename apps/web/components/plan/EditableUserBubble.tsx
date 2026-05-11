"use client";

// User-message bubble with edit-and-resend. Hover reveals a pencil; click
// swaps content for a textarea + Save / Cancel. Save opens a confirm dialog
// noting how many follow-up messages will be deleted, then calls
// editPlanMessageAction which truncates the transcript and re-fires
// plan/lead-reply.requested. The realtime UPDATE + DELETE stream handle
// the other-tab convergence.

import * as React from "react";
import { Loader2, Pencil, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageMarkdown } from "@/components/plan/MessageMarkdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import { editPlanMessageAction } from "@/app/(app)/plan/actions";

export function EditableUserBubble({
  messageId,
  content,
  createdAt,
  followUpCount,
  isLatest,
  edited,
}: {
  messageId: string;
  content: string;
  createdAt: string;
  followUpCount: number;
  isLatest: boolean;
  edited: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(content);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Keep the draft in sync with the underlying content when not editing
  // (Realtime UPDATE arrives → draft stays current for the next Edit click).
  React.useEffect(() => {
    if (!editing) setDraft(content);
  }, [content, editing]);

  function onStartEdit() {
    setDraft(content);
    setEditing(true);
  }

  function onCancel() {
    setEditing(false);
    setDraft(content);
  }

  function onAttemptSave() {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      toast.error("Empty message");
      return;
    }
    if (trimmed === content.trim()) {
      // No-op — just exit edit mode.
      setEditing(false);
      return;
    }
    if (followUpCount > 0) {
      setConfirmOpen(true);
      return;
    }
    void doSave();
  }

  async function doSave() {
    setSaving(true);
    setConfirmOpen(false);
    const res = await editPlanMessageAction({
      messageId,
      content: draft.trim(),
    });
    setSaving(false);
    if (!res.ok) {
      toast.error("Couldn't save edit", { description: res.error });
      return;
    }
    setEditing(false);
    toast.success(
      res.deletedFollowUps > 0
        ? `Edited and regenerated. ${res.deletedFollowUps} follow-up message${res.deletedFollowUps === 1 ? "" : "s"} cleared.`
        : "Edited and regenerated.",
    );
  }

  return (
    <div className="group ml-auto flex max-w-full flex-row-reverse gap-2">
      <div
        className={cn(
          "mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
          "border-chart-1/30 bg-chart-1/10 text-chart-1",
        )}
      >
        <User className="h-3 w-3" />
      </div>
      <div className="border-chart-1/30 bg-chart-1/5 relative flex max-w-[80%] flex-col gap-1 rounded-lg border p-3 text-sm leading-relaxed">
        <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <span className="text-foreground font-medium">You</span>
          <span className="font-mono">{relativeTime(createdAt)}</span>
          {edited ? (
            <Badge tone="muted" className="text-[11px] uppercase tracking-wider">
              edited
            </Badge>
          ) : null}
        </div>

        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              autoFocus
              rows={Math.min(8, Math.max(3, draft.split("\n").length + 1))}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onCancel();
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onAttemptSave();
                }
              }}
              className="min-h-[64px] text-sm"
              disabled={saving}
            />
            <div className="flex items-center justify-end gap-1.5">
              <Button type="button" variant="ghost" size="xs" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="xs"
                onClick={onAttemptSave}
                disabled={saving || draft.trim().length === 0}
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {saving ? "Saving…" : "Save & regenerate"}
              </Button>
            </div>
          </div>
        ) : (
          <MessageMarkdown content={content} />
        )}

        {/* Pencil — visible on hover, only on the latest user message so we
            don't tempt the operator to rewrite ancient history (the truncate
            semantics still apply, but the latest turn is the obvious
            ergonomic affordance). */}
        {!editing && isLatest ? (
          <button
            type="button"
            onClick={onStartEdit}
            aria-label="Edit message"
            title="Edit and regenerate"
            className={cn(
              "text-muted-foreground hover:bg-muted hover:text-foreground absolute -left-1 top-1.5 inline-flex h-6 w-6 -translate-x-full items-center justify-center rounded-md opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
            )}
          >
            <Pencil className="h-3 w-3" />
          </button>
        ) : null}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>
            Discard {followUpCount} follow-up message{followUpCount === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            Editing this message will hard-delete every message that came after it in the
            transcript, then regenerate the planner&apos;s reply against your new wording. This
            can&apos;t be undone.
          </DialogDescription>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={doSave}
              disabled={saving}
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Discard & regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
