"use client";

import * as React from "react";
import { Plus, TriangleAlert, X, ImageIcon, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createTicketAction, listBuildsOnCandidatesAction } from "@/app/(app)/board/actions";
import { RoleSelect } from "@/components/roles/role-select";
import { STARTER_TICKETS } from "@/components/board/starter-tickets";
import type { EffectiveCatalogEntry } from "@/lib/roles/effective-catalog";
import { toast } from "@/components/ui/sonner";
import { useRunnerConnection, PENDING_HEALTH_SNAPSHOT } from "@/lib/health/use-runner-connected";
import { supabaseBrowser } from "@/lib/db/browser";
import {
  ATTACHMENT_BUCKET,
  ATTACHMENT_MAX_COUNT,
  buildAttachmentStorageKey,
  maxBytesLabel,
  validateAttachmentFile,
} from "@/lib/board/attachments";

const TITLE_MIN = 3;
const TITLE_MAX = 200;
const DESC_MAX = 8000;

// One in-flight/settled screenshot in the dialog. `storageKey` is the object's
// path in the private bucket (already tenant-scoped); the create action reads
// only the `ready` ones. `previewUrl` is a local object URL (revoked on removal
// / reset) so the thumbnail renders without a network round-trip.
type PendingAttachment = {
  fileId: string;
  storageKey: string;
  mime: string;
  bytes: number;
  previewUrl: string;
  status: "uploading" | "ready" | "error";
};

export type NewTicketButtonProps = {
  /**
   * Effective role catalog (built-ins ∪ tenant custom agents) loaded
   * server-side and threaded through the board page. When omitted, the
   * RoleSelect inside falls back to the built-in catalog only.
   */
  catalog?: ReadonlyArray<EffectiveCatalogEntry>;
  /**
   * The caller's tenant id, used to derive the tenant-scoped storage path for
   * pasted/dragged screenshots. When omitted, image attachment is disabled
   * (the bucket RLS would reject an unscoped upload anyway).
   */
  tenantId?: string;
};

export function NewTicketButton({ catalog, tenantId }: NewTicketButtonProps = {}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  // A1 — soft-warn when no runner is live for this tenant. A ticket created now
  // dispatches but sits idle until a runner comes online, so we surface that at
  // the moment of filing rather than letting it silently stall. Driven by the
  // same health snapshot as the topbar dot; "checking"/"connected" show nothing.
  // Only poll while the dialog is open so the board doesn't run a second
  // continuous system-health probe on top of the topbar dot's. `expectsLocalRunner`
  // gates the warn so an API-runner tenant (no local runner needed) never sees a
  // "runner not connected" nudge — their tickets run fine without one.
  const { status: runnerStatus, expectsLocalRunner } = useRunnerConnection(
    PENDING_HEALTH_SNAPSHOT,
    { enabled: open },
  );
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  // Phase 2 / M5g — operator-picked role slug, OPT-IN. null = "Auto-pick"
  // (the dispatcher's Haiku classifier decides at dispatch time).
  const [requestedRole, setRequestedRole] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  // Slice IB-C — optional `builds_on` parent. null = no stacking; the
  // workspace clones from the project's integration_branch / default_branch.
  const [buildsOnTicketId, setBuildsOnTicketId] = React.useState<string | null>(null);
  const [buildsOnCandidates, setBuildsOnCandidates] = React.useState<
    Array<{ id: string; title: string; status: string }>
  >([]);

  // Image attachments (screenshots). Uploaded to the private bucket as they're
  // pasted/dropped — before the ticket exists — under a stable per-dialog
  // "draft" folder, so no post-create move/reconcile is needed; the storage
  // keys are simply threaded into the create action, which writes the rows.
  const [attachments, setAttachments] = React.useState<PendingAttachment[]>([]);
  // Stable per-dialog folder id. The path is "<tenantId>/<draftId>/<fileId>.<ext>",
  // all uuids, so it's tenant-scoped and un-steerable. Regenerated on each fresh
  // open so a new ticket's uploads never share a folder with an abandoned draft.
  const draftIdRef = React.useRef<string>("");
  if (draftIdRef.current === "") draftIdRef.current = crypto.randomUUID();
  const attachmentsEnabled = Boolean(tenantId);
  const [dragActive, setDragActive] = React.useState(false);

  // Load builds_on candidates lazily when the dialog opens — they change
  // frequently (tickets move through statuses) and there's no point holding
  // a stale snapshot in component state.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const list = await listBuildsOnCandidatesAction();
      if (!cancelled) setBuildsOnCandidates(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);
  const titleTooShort = title.trim().length < TITLE_MIN;

  // Shared reset — clears the form and closes the dialog on a successful create.
  const resetForm = React.useCallback(() => {
    setTitle("");
    setDescription("");
    setRequestedRole(null);
    setBuildsOnTicketId(null);
    // Revoke the thumbnail object URLs and start a fresh draft folder so the
    // next ticket's uploads don't collide with this one's.
    setAttachments((prev) => {
      for (const a of prev) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
    draftIdRef.current = crypto.randomUUID();
    setOpen(false);
    router.refresh();
  }, [router]);

  // Upload one image file to the private bucket. Validates MIME/size client-side
  // first (the bucket enforces the same as the boundary), enforces the per-ticket
  // count cap, then uploads under the tenant-scoped draft path. Best-effort: an
  // upload failure marks the chip errored and toasts, but never blocks the
  // typed ticket — the operator can remove it and create anyway.
  const uploadFile = React.useCallback(
    async (file: File) => {
      if (!tenantId) return;
      const check = validateAttachmentFile({ type: file.type, size: file.size });
      if (!check.ok) {
        toast.error("Couldn't attach image", { description: check.refusal.reason });
        return;
      }
      const fileId = crypto.randomUUID();
      const storageKey = buildAttachmentStorageKey({
        tenantId,
        draftId: draftIdRef.current,
        fileId,
        mime: check.mime,
      });
      if (!storageKey) {
        toast.error("Couldn't attach image", { description: "Unsupported image type." });
        return;
      }
      // Enforce the count cap against what's already pending (uploading OR ready).
      let admitted = false;
      setAttachments((prev) => {
        if (prev.length >= ATTACHMENT_MAX_COUNT) return prev;
        admitted = true;
        return [
          ...prev,
          {
            fileId,
            storageKey,
            mime: check.mime,
            bytes: file.size,
            previewUrl: URL.createObjectURL(file),
            status: "uploading",
          },
        ];
      });
      if (!admitted) {
        toast.error("Attachment limit reached", {
          description: `Up to ${ATTACHMENT_MAX_COUNT} images per ticket.`,
        });
        return;
      }
      const supabase = supabaseBrowser();
      const { error } = await supabase.storage
        .from(ATTACHMENT_BUCKET)
        .upload(storageKey, file, { contentType: check.mime, upsert: false });
      setAttachments((prev) =>
        prev.map((a) => (a.fileId === fileId ? { ...a, status: error ? "error" : "ready" } : a)),
      );
      if (error) {
        toast.error("Image upload failed", { description: error.message });
      }
    },
    [tenantId],
  );

  // Extract image files from a paste/drop and upload each. Non-image items are
  // ignored (a paste of plain text still lands in the textarea normally).
  const ingestFiles = React.useCallback(
    (files: FileList | File[]) => {
      if (!attachmentsEnabled) return;
      const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
      for (const f of images) void uploadFile(f);
    },
    [attachmentsEnabled, uploadFile],
  );

  const onPaste = React.useCallback(
    (e: React.ClipboardEvent) => {
      if (!attachmentsEnabled) return;
      const items = e.clipboardData?.files;
      if (items && items.length > 0 && Array.from(items).some((f) => f.type.startsWith("image/"))) {
        ingestFiles(items);
      }
    },
    [attachmentsEnabled, ingestFiles],
  );

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (!attachmentsEnabled) return;
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) ingestFiles(files);
    },
    [attachmentsEnabled, ingestFiles],
  );

  // Remove a chip and best-effort delete the already-uploaded object so an
  // abandoned upload doesn't linger in the bucket.
  const removeAttachment = React.useCallback((fileId: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.fileId === fileId);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
        if (target.status !== "error") {
          void supabaseBrowser()
            .storage.from(ATTACHMENT_BUCKET)
            .remove([target.storageKey])
            .catch(() => {
              /* best-effort cleanup; a stray object is harmless and unreachable */
            });
        }
      }
      return prev.filter((a) => a.fileId !== fileId);
    });
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (titleTooShort) return;
    setSubmitting(true);
    // Only the successfully-uploaded (ready) screenshots are threaded through;
    // still-uploading or errored ones are simply left out so a slow/failed
    // upload never blocks or fails the create. The server re-validates every
    // key against the caller's tenant before writing a row.
    const readyAttachments = attachments
      .filter((a) => a.status === "ready")
      .map((a) => ({ storageKey: a.storageKey, mime: a.mime, bytes: a.bytes }));
    const res = await createTicketAction({
      title: title.trim(),
      description,
      requestedRole,
      buildsOnTicketId,
      ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error("Couldn't create ticket", { description: res.error });
      return;
    }
    // The create returns the instant the row is inserted — the dep-suggestion
    // rerank now runs in the background (suggestTicketDepsFn) and surfaces as a
    // "review suggested dependencies" chip on the card when it lands, opening
    // the same accept/skip modal. So we just confirm + close here; the button
    // no longer hangs on a synchronous Haiku call.
    toast.success("Ticket created", {
      description: "Drag it to Ready to kick off the agent loop.",
    });
    resetForm();
  }

  return (
    // modal={false} so the cmdk popover inside RoleSelect can receive mouse-
    // wheel scroll events. Radix Dialog in modal mode scroll-locks the body,
    // which eats wheel events on portaled popovers (the scrollbar drag still
    // works because that's pointer-driven, not wheel-driven). Escape and
    // click-outside still close the dialog.
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus className="h-3.5 w-3.5" /> New ticket
        </Button>
      </DialogTrigger>
      {/*
        `DialogContent` is a GRID container, and a grid item's `min-width` is
        `auto` - i.e. it refuses to shrink below its own min-content. One item
        wider than `max-w-md` therefore blows the single implicit column past
        the dialog's box, and because `overflow-y-auto` makes the CSS-computed
        `overflow-x` `auto` too, that surfaces as a horizontal scrollbar with
        every field's right-hand side drawn outside the panel.

        So every direct child of `DialogContent` carries `min-w-0`. It is a
        floor, never a force: content that already fits is untouched. Measured
        before the fix - a 108-character ticket title in the `Builds on`
        `<select>` gave a 798px content box inside a 448px dialog, at EVERY
        viewport width including 1920.
      */}
      <DialogContent className="max-w-md">
        <DialogHeader className="min-w-0">
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>
            Drops into Backlog. Drag to Ready to kick off the agent loop.
          </DialogDescription>
        </DialogHeader>

        {runnerStatus === "disconnected" && expectsLocalRunner ? (
          <div className="border-warning/40 bg-warning/10 text-foreground flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-[12px] leading-relaxed">
            <TriangleAlert className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Your runner isn&apos;t connected yet — this ticket won&apos;t run until it is. Finish{" "}
              <Link
                href="/welcome"
                className="font-medium underline underline-offset-2"
                onClick={() => setOpen(false)}
              >
                runner setup
              </Link>
              , then drag it to Ready.
            </span>
          </div>
        ) : null}

        <form
          onSubmit={onSubmit}
          className="flex min-w-0 flex-col gap-4"
          onPaste={onPaste}
          onDragOver={
            attachmentsEnabled
              ? (e) => {
                  if (Array.from(e.dataTransfer.types).includes("Files")) {
                    e.preventDefault();
                    setDragActive(true);
                  }
                }
              : undefined
          }
          onDragLeave={attachmentsEnabled ? () => setDragActive(false) : undefined}
          onDrop={attachmentsEnabled ? onDrop : undefined}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-foreground text-xs font-medium">
              Templates <span className="text-muted-foreground font-normal">(optional)</span>
            </span>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {STARTER_TICKETS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setTitle(t.title);
                    setDescription(t.description);
                  }}
                  // `max-w-full` + `break-words` so a long template title wraps
                  // inside its own pill rather than widening the row. Template
                  // titles are content, so the narrow viewport has to survive a
                  // longer one than the three shipped today.
                  className="border-border bg-muted/40 text-muted-foreground hover:border-ring hover:bg-accent hover:text-foreground max-w-full break-words rounded-full border px-2.5 py-1 text-[11px] transition-colors"
                >
                  {t.title}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-[11px]">
              Prefill a known-good starter, then tweak it.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="ticket-title" className="text-foreground text-xs font-medium">
              Title
            </label>
            <Input
              id="ticket-title"
              required
              autoFocus
              placeholder="add password reset"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
            />
            <p className="text-muted-foreground text-[11px]">
              A short, specific ask. The PM agent will refine it.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-foreground text-xs font-medium">
              Role <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <RoleSelect
              value={requestedRole}
              onChange={setRequestedRole}
              size="sm"
              catalog={catalog}
            />
            <p className="text-muted-foreground text-[11px]">
              Leave on Auto-pick to let DevPilot classify; choose explicitly to pin the role at
              dispatch.
            </p>
          </div>

          {buildsOnCandidates.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ticket-builds-on" className="text-foreground text-xs font-medium">
                Builds on <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              {/*
                THE OFFENDER. A `<select>` sized `auto` takes the width of its
                LONGEST OPTION, and these options are ticket titles - arbitrary
                operator text. That intrinsic width was the min-content that
                pushed the whole dialog past `max-w-md`. `w-full min-w-0` pins
                it to the form instead; the closed control then clips its own
                label, which is the native behaviour and costs nothing, because
                the open dropdown still renders every option in full.
              */}
              <select
                id="ticket-builds-on"
                value={buildsOnTicketId ?? ""}
                onChange={(e) => setBuildsOnTicketId(e.target.value || null)}
                className="border-input bg-background h-9 w-full min-w-0 rounded-md border px-2 text-sm"
              >
                <option value="">— none —</option>
                {buildsOnCandidates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.status === "in_review" ? "✓" : t.status === "in_progress" ? "▸" : "·"}{" "}
                    {t.title}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-[11px]">
                Stack this ticket on top of an in-flight one. The workspace clones from the
                parent&apos;s <code className="font-mono">devpilot/&lt;slug&gt;</code> branch
                instead of from the integration tip.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="ticket-desc"
              className="text-foreground flex items-center justify-between gap-2 text-xs font-medium"
            >
              <span className="min-w-0">
                Description <span className="text-muted-foreground font-normal">(optional)</span>
              </span>
              <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
                {description.length}/{DESC_MAX}
              </span>
            </label>
            <Textarea
              id="ticket-desc"
              placeholder="Rough notes, acceptance hints, links…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              maxLength={DESC_MAX}
            />
          </div>

          {attachmentsEnabled ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-foreground flex items-center justify-between gap-2 text-xs font-medium">
                <span className="min-w-0">
                  Screenshots <span className="text-muted-foreground font-normal">(optional)</span>
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
                  {attachments.length}/{ATTACHMENT_MAX_COUNT}
                </span>
              </span>
              <div
                className={`rounded-md border border-dashed px-3 py-3 transition-colors ${
                  dragActive ? "border-ring bg-accent/40" : "border-border bg-muted/20"
                }`}
              >
                {attachments.length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {attachments.map((a) => (
                      <div
                        key={a.fileId}
                        className="border-border bg-background group relative h-16 w-16 overflow-hidden rounded-md border"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={a.previewUrl}
                          alt="attachment preview"
                          className={`h-full w-full object-cover ${
                            a.status === "ready" ? "" : "opacity-50"
                          }`}
                        />
                        {a.status === "uploading" ? (
                          <span className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="text-foreground h-4 w-4 animate-spin" aria-hidden />
                          </span>
                        ) : null}
                        {a.status === "error" ? (
                          <span className="bg-destructive/70 absolute inset-0 flex items-center justify-center text-[9px] font-medium text-white">
                            failed
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => removeAttachment(a.fileId)}
                          aria-label="Remove attachment"
                          className="bg-background/90 text-foreground absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                  <ImageIcon className="h-3 w-3 shrink-0" aria-hidden />
                  Paste or drag an image here (PNG, JPEG, WebP, GIF · max {maxBytesLabel()} each).
                </p>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={submitting || titleTooShort}
            >
              {submitting ? "Creating…" : "Create ticket"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
