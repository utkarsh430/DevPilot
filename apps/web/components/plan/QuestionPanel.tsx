"use client";

// Plan-mode interactive question panel. Renders below the assistant's prose
// preamble when `parseAssistantReply` extracted at least one question from
// the lead's fenced JSON block. Buttons + "Other" inline textarea + keyboard
// shortcuts (1–9 / Arrow / Enter / Escape / `o`) match Claude Code's
// AskUserQuestion shape.

import * as React from "react";
import { Check, Loader2, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/cn";
import type { ParsedQuestion } from "@/lib/plan/parse-assistant-reply";

export type PendingAnswerChoice =
  | { kind: "option"; label: string }
  | { kind: "options"; labels: string[] }
  | { kind: "other"; text: string };

export type PendingAnswer = {
  questionIdx: number;
  q: string;
  choice: PendingAnswerChoice;
};

type LockedAnswerView = {
  questionIdx: number;
  primary: string;
  other?: string;
};

export type QuestionPanelProps = {
  messageId: string;
  questions: ParsedQuestion[];
  truncatedCount: number;
  isLatestAssistant: boolean;
  answered: boolean;
  /** Pre-computed view of what was answered (when `answered === true`). */
  lockedAnswers?: LockedAnswerView[];
  onSubmit: (answers: PendingAnswer[]) => Promise<void>;
};

type Selection = {
  // For single-choice: at most one label.
  // For allowMultiple: any number of labels.
  labels: string[];
  otherText: string | null; // null while not editing Other
};

const EMPTY_SELECTION: Selection = { labels: [], otherText: null };

export function QuestionPanel(props: QuestionPanelProps) {
  const {
    messageId,
    questions,
    truncatedCount,
    isLatestAssistant,
    answered,
    lockedAnswers = [],
    onSubmit,
  } = props;

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [selections, setSelections] = React.useState<Selection[]>(() =>
    questions.map(() => ({ ...EMPTY_SELECTION })),
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Reset selections if the questions array swaps under us (rare —
  // assistant edits would land on a new message id, but defensive).
  React.useEffect(() => {
    setSelections(questions.map(() => ({ ...EMPTY_SELECTION })));
    setSubmitting(false);
    setSubmitError(null);
  }, [messageId, questions]);

  // Focus the panel on mount when it's the latest assistant turn so
  // keyboard shortcuts work without a mouse hand-off.
  React.useEffect(() => {
    if (!isLatestAssistant || answered) return;
    rootRef.current?.focus();
  }, [isLatestAssistant, answered]);

  const singleQuestion = questions.length === 1;
  const interactive = isLatestAssistant && !answered && !submitting;

  // ── Selection mutators ───────────────────────────────────────────────────
  function selectOption(qIdx: number, label: string, allowMultiple: boolean) {
    setSelections((cur) => {
      const next = cur.slice();
      const sel = { ...next[qIdx]! };
      if (allowMultiple) {
        if (sel.labels.includes(label)) {
          sel.labels = sel.labels.filter((l) => l !== label);
        } else {
          sel.labels = [...sel.labels, label];
        }
      } else {
        sel.labels = [label];
        // Picking an option implicitly cancels an in-flight Other on
        // single-choice questions.
        sel.otherText = null;
      }
      next[qIdx] = sel;
      return next;
    });
  }

  function openOther(qIdx: number) {
    setSelections((cur) => {
      const next = cur.slice();
      const sel = { ...next[qIdx]! };
      sel.otherText = sel.otherText ?? "";
      // For single-choice, clear option selection when opening Other.
      const allowMultiple = questions[qIdx]!.allowMultiple;
      if (!allowMultiple) sel.labels = [];
      next[qIdx] = sel;
      return next;
    });
  }

  function setOtherText(qIdx: number, text: string) {
    setSelections((cur) => {
      const next = cur.slice();
      next[qIdx] = { ...next[qIdx]!, otherText: text };
      return next;
    });
  }

  function cancelOther(qIdx: number) {
    setSelections((cur) => {
      const next = cur.slice();
      next[qIdx] = { ...next[qIdx]!, otherText: null };
      return next;
    });
  }

  function isAnswered(qIdx: number): boolean {
    const sel = selections[qIdx];
    if (!sel) return false;
    if (sel.otherText !== null && sel.otherText.trim().length > 0) return true;
    return sel.labels.length > 0;
  }

  function canSubmit(): boolean {
    if (!interactive) return false;
    return questions.every((_, i) => isAnswered(i));
  }

  function buildPayload(): PendingAnswer[] {
    return questions.map((q, qIdx): PendingAnswer => {
      const sel = selections[qIdx]!;
      if (sel.otherText !== null && sel.otherText.trim().length > 0) {
        return {
          questionIdx: qIdx,
          q: q.q,
          choice: { kind: "other", text: sel.otherText.trim() },
        };
      }
      if (q.allowMultiple) {
        return {
          questionIdx: qIdx,
          q: q.q,
          choice: { kind: "options", labels: sel.labels.slice() },
        };
      }
      return {
        questionIdx: qIdx,
        q: q.q,
        choice: { kind: "option", label: sel.labels[0] ?? "" },
      };
    });
  }

  async function doSubmit() {
    if (!canSubmit()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(buildPayload());
    } catch (err) {
      setSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
    // On success the parent flips `answered=true` via realtime; we don't
    // reset locally — the rerender shows the locked view.
  }

  // ── Keyboard shortcuts (root onKeyDown) ──────────────────────────────────
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    // Let the Other textarea (or any nested input) handle its own keys —
    // we only want to claim shortcuts when focus is on the panel itself or
    // an option button.
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      return;
    }
    // 1–9 select option N on the FIRST unanswered question (snappy
    // single-question UX). For multi-question turns the operator is
    // expected to click the specific question, but digits still work on
    // whichever question is the next unanswered one.
    if (/^[1-9]$/.test(e.key)) {
      const num = parseInt(e.key, 10);
      const targetQ = questions.findIndex((_, i) => !isAnswered(i));
      const qIdx = targetQ === -1 ? questions.length - 1 : targetQ;
      const q = questions[qIdx];
      if (!q) return;
      const opt = q.options[num - 1];
      if (!opt) return;
      e.preventDefault();
      selectOption(qIdx, opt.label, q.allowMultiple);
      if (singleQuestion && !q.allowMultiple) {
        // Auto-submit
        setTimeout(() => void doSubmit(), 0);
      }
      return;
    }
    // `o` opens Other for the next-unanswered question.
    if (e.key.toLowerCase() === "o" && !e.metaKey && !e.ctrlKey) {
      const qIdx = questions.findIndex((_, i) => !isAnswered(i));
      if (qIdx === -1) return;
      e.preventDefault();
      openOther(qIdx);
      return;
    }
    // Enter submits when ready (multi-question only — single-question
    // already auto-submitted on selection).
    if (e.key === "Enter" && !e.shiftKey && canSubmit() && !singleQuestion) {
      e.preventDefault();
      void doSubmit();
      return;
    }
  }

  // ── Locked / answered view ───────────────────────────────────────────────
  if (answered) {
    return (
      <div className="border-success/30 bg-success/5 mt-1 flex flex-col gap-2 rounded-md border p-2.5">
        {lockedAnswers.length === 0 ? (
          <p className="text-muted-foreground text-[11px]">Answered.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {lockedAnswers.map((a) => (
              <li key={a.questionIdx} className="text-xs">
                <span className="inline-flex items-start gap-1.5">
                  <Check className="text-success mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    <span className="text-muted-foreground">
                      {questions[a.questionIdx]?.q ?? `Q${a.questionIdx + 1}`} →{" "}
                    </span>
                    <span className="text-foreground font-medium">{a.primary}</span>
                    {a.other ? <span className="text-muted-foreground"> · {a.other}</span> : null}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ── Interactive view ─────────────────────────────────────────────────────
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        "border-border bg-background/60 mt-2 flex flex-col gap-2 rounded-md border p-2.5 outline-none",
        !interactive && "opacity-70",
      )}
    >
      {questions.map((q, qIdx) => {
        const sel = selections[qIdx]!;
        const otherOpen = sel.otherText !== null;
        const showCheckboxes = q.allowMultiple;
        return (
          <div key={qIdx} className="flex flex-col gap-1.5">
            <p className="text-foreground text-xs font-medium">
              {questions.length > 1 ? (
                <span className="text-muted-foreground mr-1 font-mono">Q{qIdx + 1}.</span>
              ) : null}
              {q.q}
              {showCheckboxes ? (
                <Badge tone="muted" className="ml-2 text-[11px] uppercase tracking-wider">
                  multi
                </Badge>
              ) : null}
            </p>
            <div className="flex flex-col gap-1">
              {q.options.map((opt, oIdx) => {
                const selected = sel.labels.includes(opt.label);
                return (
                  <button
                    key={oIdx}
                    type="button"
                    disabled={!interactive}
                    onClick={() => {
                      selectOption(qIdx, opt.label, q.allowMultiple);
                      if (singleQuestion && !q.allowMultiple) {
                        setTimeout(() => void doSubmit(), 0);
                      }
                    }}
                    className={cn(
                      "group/option border-border bg-card flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                      "hover:border-primary/40 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
                      opt.recommended && !selected && "border-success/40 bg-success/5",
                      selected && "border-primary/50 bg-primary/5",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        showCheckboxes ? "rounded-sm" : "rounded-full",
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background",
                      )}
                    >
                      {selected ? <Check className="h-2.5 w-2.5" /> : null}
                    </span>
                    <span className="flex flex-1 flex-col">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-foreground font-medium">{opt.label}</span>
                        {opt.recommended ? (
                          <Badge tone="ok" className="text-[11px] uppercase tracking-wider">
                            Recommended
                          </Badge>
                        ) : null}
                      </span>
                      {opt.description ? (
                        <span className="text-muted-foreground text-[11px]">{opt.description}</span>
                      ) : null}
                    </span>
                    <Kbd className="ml-auto h-4 self-start text-[11px] opacity-60 group-hover/option:opacity-100">
                      {oIdx + 1}
                    </Kbd>
                  </button>
                );
              })}
              {!otherOpen ? (
                <button
                  type="button"
                  disabled={!interactive}
                  onClick={() => openOther(qIdx)}
                  className={cn(
                    "border-border text-muted-foreground flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-left text-xs transition-colors",
                    "hover:border-primary/40 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
                  )}
                >
                  <PencilLine className="h-3 w-3" />
                  Other (write your own)
                  <Kbd className="ml-auto h-4 text-[11px] opacity-60">o</Kbd>
                </button>
              ) : (
                <div className="border-primary/40 bg-primary/5 flex flex-col gap-1.5 rounded-md border p-2">
                  <Textarea
                    autoFocus
                    rows={2}
                    placeholder="Type your answer…"
                    value={sel.otherText ?? ""}
                    onChange={(e) => setOtherText(qIdx, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelOther(qIdx);
                      } else if (
                        e.key === "Enter" &&
                        (e.metaKey || e.ctrlKey) &&
                        sel.otherText &&
                        sel.otherText.trim().length > 0
                      ) {
                        e.preventDefault();
                        if (singleQuestion) {
                          void doSubmit();
                        }
                      }
                    }}
                    className="min-h-[48px] resize-none text-xs"
                    disabled={!interactive}
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => cancelOther(qIdx)}
                      disabled={!interactive}
                    >
                      Cancel
                    </Button>
                    {singleQuestion ? (
                      <Button
                        type="button"
                        variant="primary"
                        size="xs"
                        onClick={() => void doSubmit()}
                        disabled={
                          !interactive || !sel.otherText || sel.otherText.trim().length === 0
                        }
                      >
                        {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        Send
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {truncatedCount > 0 ? (
        <p className="text-muted-foreground text-[11px]">
          …and {truncatedCount} more — answer the above first.
        </p>
      ) : null}

      {!singleQuestion ? (
        <div className="mt-1 flex items-center justify-end gap-2">
          {submitError ? (
            <p className="text-destructive mr-auto text-[11px]">{submitError}</p>
          ) : null}
          <p className="text-muted-foreground text-[11px]">
            <Kbd className="h-4 text-[11px]">⏎</Kbd> submit
          </p>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canSubmit()}
            onClick={() => void doSubmit()}
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Submit answers
          </Button>
        </div>
      ) : submitError ? (
        <p className="text-destructive text-[11px]">{submitError}</p>
      ) : null}
    </div>
  );
}
