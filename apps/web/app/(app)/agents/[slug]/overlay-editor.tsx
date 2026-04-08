"use client";

// "Your instructions" — the operator's overlay editor, beneath the read-only
// shipped prompt.
//
// The whole affordance is add-only by construction: there is no control here
// that edits the prompt above, because there is no such control anywhere. Save
// writes the operator's own block; Clear deletes it and the agent is back to
// exactly its shipped instructions, with nothing to reconstruct.
//
// Clear is a real destructive action (it discards typed work), so it confirms —
// but only once, inline, with the consequence stated. No type-to-confirm: this
// deletes the operator's own text and restores a known-good default, which is
// nothing like the irreversible-work-loss class that earns a typed confirmation
// (`discardAndRestartFromDevAction`).
//
// Validation runs here for live feedback AND again in the action. The server's
// copy is the rule — a forged POST never executes this file.

import * as React from "react";
import { Info, Loader2, RotateCcw, Save, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { checkOverlayBody, OVERLAY_MAX_CHARS, type OverlayViolation } from "@/lib/roles/overlay";
import { ASSIST_REQUEST_MAX_CHARS } from "@/lib/roles/overlay-assist";
import { OVERLAY_DISCLOSURE } from "@/lib/roles/prompt-inspection";
import {
  clearAgentOverlayAction,
  improveAgentOverlayAction,
  saveAgentOverlayAction,
} from "@/lib/roles/overlay-actions";

const PLACEHOLDER =
  "e.g. Prefer small, reviewable changes over one large one. Always say which " +
  "files you touched and why. When you are unsure between two approaches, say so " +
  "rather than picking silently.";

const ASSIST_PLACEHOLDER =
  "e.g. I want this agent to always check the staging URL loads before it reports success.";

/**
 * A proposal, held in browser state only. It is never applied on arrival: the
 * operator reads it, may edit it in place, and then explicitly puts it into the
 * editor — after which it is still just typed text until he presses Save. There
 * is no auto-apply path and no setting that adds one.
 */
type Proposal = { body: string; summary: string; removed: string[] };

export function OverlayEditor({
  roleSlug,
  initialBody,
  updatedAt,
}: {
  roleSlug: string;
  initialBody: string | null;
  updatedAt: string | null;
}) {
  const [body, setBody] = React.useState(initialBody ?? "");
  const [saved, setSaved] = React.useState(initialBody ?? "");
  const [pending, startTransition] = React.useTransition();
  const [confirmingClear, setConfirmingClear] = React.useState(false);
  const [violations, setViolations] = React.useState<OverlayViolation[]>([]);

  // ── Assist state ─────────────────────────────────────────────────────────
  const [request, setRequest] = React.useState("");
  const [improving, startImproving] = React.useTransition();
  const [proposal, setProposal] = React.useState<Proposal | null>(null);
  /** The "an overlay can't do that" answer. Information, not an error. */
  const [refusal, setRefusal] = React.useState<string | null>(null);

  function onImprove() {
    setProposal(null);
    setRefusal(null);
    setViolations([]);
    startImproving(async () => {
      const res = await improveAgentOverlayAction({
        roleSlug,
        request,
        // The editor's LIVE text, including anything unsaved: the proposal has
        // to be relative to what he is looking at, or `removedFromOverlay` would
        // report against a version he cannot see.
        currentOverlay: body,
      });
      if (!res.ok) {
        setViolations(res.violations ?? []);
        toast.error("Couldn't suggest a change", { description: res.error });
        return;
      }
      if (res.kind === "refused") {
        setRefusal(res.summary);
        return;
      }
      setProposal({
        body: res.proposedOverlay,
        summary: res.summary,
        removed: res.removedFromOverlay,
      });
    });
  }

  function onUseProposal() {
    if (!proposal) return;
    setBody(proposal.body);
    setProposal(null);
    setRefusal(null);
    setRequest("");
    toast.message("Suggestion moved into your instructions", {
      description: "Nothing is stored until you press Save.",
    });
  }

  const dirty = body !== saved;
  const over = body.length > OVERLAY_MAX_CHARS;
  const hasSaved = saved.trim().length > 0;

  function onSave() {
    // Same pure check the action re-runs. Surfacing it before the round trip
    // means the operator sees WHICH phrase is the problem while it is still in
    // front of him.
    const checked = checkOverlayBody(body);
    if (!checked.ok) {
      setViolations(checked.violations);
      return;
    }
    setViolations([]);
    startTransition(async () => {
      const res = await saveAgentOverlayAction({ roleSlug, body });
      if (!res.ok) {
        setViolations(res.violations ?? []);
        toast.error("Couldn't save", { description: res.error });
        return;
      }
      // Store what the SERVER accepted, not what was typed: the action redacts
      // and trims, so echoing the raw input would leave the box showing
      // something different from what runs.
      setSaved(checked.body);
      setBody(checked.body);
      toast.success("Instructions saved", {
        description: "They apply from this agent's next run.",
      });
    });
  }

  function onClear() {
    startTransition(async () => {
      const res = await clearAgentOverlayAction({ roleSlug });
      if (!res.ok) {
        toast.error("Couldn't clear", { description: res.error });
        return;
      }
      setBody("");
      setSaved("");
      setViolations([]);
      setConfirmingClear(false);
      toast.success("Instructions cleared", {
        description: "This agent is back to its shipped prompt.",
      });
    });
  }

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Your instructions</h2>
        {updatedAt && !dirty && hasSaved && (
          <span className="text-muted-foreground text-[11px]">
            Last saved {new Date(updatedAt).toLocaleDateString()}
          </span>
        )}
      </div>
      <p className="text-muted-foreground mb-3 text-xs leading-relaxed">{OVERLAY_DISCLOSURE}</p>

      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          if (violations.length > 0) setViolations([]);
        }}
        placeholder={PLACEHOLDER}
        rows={8}
        spellCheck
        disabled={pending}
        aria-label="Your instructions for this agent"
        aria-invalid={violations.length > 0 || over}
        className="border-input bg-background focus-visible:ring-ring w-full resize-y rounded-lg border p-3 font-mono text-[11px] leading-relaxed focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60"
      />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span
          className={`text-[11px] tabular-nums ${over ? "text-destructive font-medium" : "text-muted-foreground"}`}
        >
          {body.length.toLocaleString()} / {OVERLAY_MAX_CHARS.toLocaleString()} characters
          {over ? " — too long to save" : ""}
        </span>
        <div className="flex items-center gap-2">
          {hasSaved &&
            (confirmingClear ? (
              <>
                <span className="text-muted-foreground text-[11px]">Clear these instructions?</span>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={onClear}
                  disabled={pending}
                >
                  {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Yes, clear
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmingClear(false)}
                  disabled={pending}
                >
                  Keep
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirmingClear(true)}
                disabled={pending}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Clear
              </Button>
            ))}
          <Button type="button" size="sm" onClick={onSave} disabled={pending || !dirty}>
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>

      {violations.length > 0 && (
        <ul className="border-destructive/40 bg-destructive/5 mt-3 flex flex-col gap-1.5 rounded-lg border p-3">
          {violations.map((v, i) => (
            <li key={`${v.kind}-${i}`} className="text-destructive text-xs leading-relaxed">
              {v.message}
            </li>
          ))}
        </ul>
      )}

      {/* ── The plain-English assist ─────────────────────────────────────── */}
      <div className="bg-muted/30 mt-4 rounded-lg border p-4">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-tight">
          <Sparkles className="h-3.5 w-3.5" />
          Describe it instead
        </h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Say what you want this agent to do differently and DevPilot will draft the instructions.
          You see the suggestion before anything changes, you can edit it, and nothing is stored
          until you press Save.
        </p>

        <textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder={ASSIST_PLACEHOLDER}
          rows={2}
          spellCheck
          disabled={improving || pending}
          maxLength={ASSIST_REQUEST_MAX_CHARS}
          aria-label="Describe what you want this agent to do differently"
          className="border-input bg-background focus-visible:ring-ring mt-3 w-full resize-y rounded-lg border p-3 text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60"
        />
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onImprove}
            disabled={improving || pending || request.trim().length < 8}
          >
            {improving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {improving ? "Thinking…" : "Improve"}
          </Button>
        </div>

        {/* A refusal is a USEFUL ANSWER — it tells him something true about what
            his own instructions can and cannot reach — so it renders as
            information, never as a red failure. */}
        {refusal && (
          <div className="bg-background mt-3 flex gap-2 rounded-lg border p-3">
            <Info className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium">No change suggested</p>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{refusal}</p>
            </div>
          </div>
        )}

        {proposal && (
          <div className="mt-3 rounded-lg border">
            <div className="flex items-start justify-between gap-2 border-b p-3">
              <div className="min-w-0">
                <p className="text-xs font-medium">Suggested instructions</p>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  {proposal.summary}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Dismiss suggestion"
                onClick={() => setProposal(null)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Anything dropped from his OWN prior text is called out before the
                bodies, not left for him to spot in the diff. A proposal that
                quietly deletes something he wrote is the failure mode here. */}
            {proposal.removed.length > 0 && (
              <div className="border-destructive/30 bg-destructive/5 border-b p-3">
                <p className="text-destructive text-xs font-medium">
                  {proposal.removed.length === 1
                    ? "1 line of your instructions is not in the suggestion"
                    : `${proposal.removed.length} lines of your instructions are not in the suggestion`}
                </p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {proposal.removed.map((line, i) => (
                    <li
                      key={`${i}-${line.slice(0, 24)}`}
                      className="text-destructive/90 font-mono text-[11px] leading-relaxed line-through"
                    >
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid gap-3 p-3 md:grid-cols-2">
              <div className="min-w-0">
                <p className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wide">
                  Now
                </p>
                <pre className="bg-muted/40 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border p-2.5 font-mono text-[11px] leading-relaxed">
                  {body.trim().length > 0 ? body : "— no instructions yet —"}
                </pre>
              </div>
              <div className="min-w-0">
                <p className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wide">
                  Suggested — edit before you use it
                </p>
                {/* Editable in place: he is not choosing between the model's
                    words and starting over. */}
                <textarea
                  value={proposal.body}
                  onChange={(e) => setProposal({ ...proposal, body: e.target.value })}
                  rows={10}
                  spellCheck
                  aria-label="Suggested instructions, editable"
                  className="border-input bg-background focus-visible:ring-ring max-h-64 w-full resize-y rounded-md border p-2.5 font-mono text-[11px] leading-relaxed focus-visible:outline-none focus-visible:ring-2"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t p-3">
              <span className="text-muted-foreground mr-auto text-[11px]">
                Using this only fills the box above — you still press Save.
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setProposal(null)}>
                Discard
              </Button>
              <Button type="button" size="sm" onClick={onUseProposal}>
                Use this
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
