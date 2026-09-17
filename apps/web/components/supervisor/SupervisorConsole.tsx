"use client";

// The supervisor console - the surface an operator opens from the board and
// talks to. The STATEFUL half; everything it draws that is worth asserting
// lives in the hook-free `console-report.tsx` beside it.
//
// ── IT OPENS WITH AN ANSWER, NOT A PROMPT ─────────────────────────────────
// The deterministic brief loads on open, before anything is typed and without
// any model call. That ordering is the design: an operator opening this is
// usually mid-incident and does not want to compose a question first, and the
// facts that answer "why is nothing moving" are computed from the database
// either way. The chat is for the follow-up - "why is 86 blocked", "what do I
// do about it" - and for commanding.
//
// ── THE MODEL NEVER MOVES A TICKET ────────────────────────────────────────
// Actions and commands are BUTTONS, always, and the model can only mark one as
// recommended. See `console-actions.ts` and `console-commands.ts` for the full
// argument; the short version is that ticket titles and comments are
// agent-writable, they are the substance of what this shows a model, and
// principle 6 says that content is data. So there is no path from a model reply
// to a mutation - a recommendation is a button that appears higher in a list the
// operator reads and clicks, or does not.
//
// Do not "streamline" this into auto-running a recommended action when the
// operator's message was clearly a command. That single edge is the difference
// between a console an injected ticket title can influence and one it cannot.
//
// ── THE COMMAND LIST BELONGS TO A TURN, NOT TO THE SESSION ────────────────
// Ticket-scoped commands exist only for tickets named in ONE message, so they
// are attached to the turn that produced them and the question that produced
// them is sent back with the run. That is not bookkeeping: the server re-parses
// that question to re-derive the target, so a stale list cannot outlive the
// sentence that justified it, and the client never gets to name a ticket id.

import * as React from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy, Loader2, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { MessageMarkdown } from "@/components/plan/MessageMarkdown";
import { CommandList, ConsoleReport } from "@/components/supervisor/console-report";
import { cn } from "@/lib/cn";
import type { ConsoleAction } from "@/lib/supervisor/console-actions";
import { describeRefusedCapability, type ConsoleCommand } from "@/lib/supervisor/console-commands";
import {
  describeConsoleModelFailure,
  describeConsoleRunOutcome,
  describeMissingTicketKeys,
  type ConsoleBrief,
} from "@/lib/supervisor/console-view";
import {
  askSupervisorConsoleAction,
  loadSupervisorConsoleBriefAction,
  loadSupervisorConsoleThreadAction,
  runSupervisorConsoleAction,
  runSupervisorConsoleCommandAction,
} from "@/lib/supervisor/console-server-actions";

type Turn = {
  role: "operator" | "console";
  text: string;
  /** Actions and commands the console recommended for THIS turn. */
  recommended?: Array<ConsoleAction | ConsoleCommand>;
  outOfScope?: boolean;
};

type FieldValues = Record<string, string | string[] | number>;

/** Openers. Deliberately the three questions the board cannot answer for
 *  itself, rather than a generic "ask me anything" - a blank prompt on an
 *  unfamiliar surface is usually left blank. */
const SUGGESTIONS = [
  "Why is nothing moving?",
  "Which tickets are waiting on me rather than on the machine?",
  "What is blocking the oldest ticket, and what would unblock it?",
];

/** Seed a command's form from the field defaults so a control that is already
 *  correct does not have to be touched before Run becomes available. */
function seedValues(commands: readonly ConsoleCommand[]): Record<string, FieldValues> {
  const out: Record<string, FieldValues> = {};
  for (const c of commands) {
    const v: FieldValues = {};
    for (const f of c.fields) {
      if (f.kind === "select") v[f.name] = f.defaultValue ?? f.options[0]?.value ?? "";
      else if (f.kind === "number") v[f.name] = f.defaultValue;
      else if (f.kind === "multiselect") v[f.name] = [];
      else v[f.name] = "";
    }
    out[c.id] = v;
  }
  return out;
}

export function SupervisorConsole({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: string;
  projectName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [brief, setBrief] = React.useState<ConsoleBrief | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [question, setQuestion] = React.useState("");
  const [asking, setAsking] = React.useState(false);
  const [runningId, setRunningId] = React.useState<string | null>(null);
  // The commands unlocked by the LAST message, plus the message itself. The
  // question is sent back with a run so the server re-derives the target from
  // the operator's own words rather than from anything this client picked.
  const [commands, setCommands] = React.useState<ConsoleCommand[]>([]);
  const [commandQuestion, setCommandQuestion] = React.useState("");
  // The transcript row for the message that unlocked those commands, so the
  // ledger can record which turn caused a fix. Provenance only - the server
  // still derives the target by re-parsing `commandQuestion`, and refuses the
  // link outright if this id names a message that says something else.
  const [commandMessageId, setCommandMessageId] = React.useState<string | null>(null);
  const [fieldValues, setFieldValues] = React.useState<Record<string, FieldValues>>({});
  const [confirmations, setConfirmations] = React.useState<Record<string, string>>({});
  const bottomRef = React.useRef<HTMLDivElement | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    const res = await loadSupervisorConsoleBriefAction({ projectId });
    setLoading(false);
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    setLoadError(null);
    setBrief(res.brief);
  }, [projectId]);

  // Read the board on open, and on every re-open: the whole value of this
  // surface is that it is current, and a cached snapshot from an hour ago would
  // describe a board that has since moved.
  React.useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // ── THE THREAD IS RESTORED; THE BUTTONS ARE NOT ──────────────────────────
  // A restored turn carries TEXT ONLY. Recommended actions and commands are
  // deliberately dropped: they were derived from a board that has since moved,
  // and the surface's own rule is that a ticket named three questions ago must
  // not stay actionable after the operator moved on. A button restored from an
  // hour-old thread would be refused when clicked - worse than no button.
  //
  // Loaded independently of the brief so a slow board read never delays the
  // conversation, and vice versa.
  //
  // ⚠️ THE LOADED FLAG IS KEYED ON THE PROJECT, NOT A BARE BOOLEAN. A thread is
  // per project, and this component can be handed a new `projectId` without
  // unmounting (the operator switches board from the topbar). A plain
  // `threadLoaded` boolean would keep the previous board's conversation on
  // screen under the new board's name and never fetch the new one - which is
  // the same cross-board confusion the project-scoped table exists to prevent,
  // arriving through the client instead. `turns` is cleared for the same
  // reason: locally-appended turns belong to the board they were typed on.
  const [threadFor, setThreadFor] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (threadFor !== null && threadFor !== projectId) {
      setThreadFor(null);
      setTurns([]);
      setCommands([]);
      setCommandMessageId(null);
    }
  }, [projectId, threadFor]);

  React.useEffect(() => {
    if (!open || threadFor === projectId) return;
    let cancelled = false;
    void (async () => {
      const res = await loadSupervisorConsoleThreadAction({ projectId });
      if (cancelled || !res.ok) return;
      setThreadFor(projectId);
      if (res.messages.length === 0) return;
      // Prepend, never replace: a message sent while this was in flight is the
      // operator's own and must not be dropped by a load that started first.
      setTurns((prev) => [...res.messages.map((m) => ({ role: m.role, text: m.body })), ...prev]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, threadFor]);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, asking]);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || asking) return;
    setTurns((prev) => [...prev, { role: "operator", text: trimmed }]);
    setQuestion("");
    setAsking(true);
    // No `history` is sent. It used to be, which made the model's idea of the
    // conversation a client-supplied prompt input; the server now reads the
    // bounded window from the durable transcript instead.
    const res = await askSupervisorConsoleAction({ projectId, question: trimmed });
    setAsking(false);
    // The brief AND the commands come back even on failure - the deterministic
    // half of the console must keep working when the model cannot be reached,
    // and being unable to command a board exactly when the runner is down would
    // be useless at the only moment this surface exists for.
    if (res.brief) setBrief(res.brief);
    const nextCommands = res.commands ?? [];
    setCommands(nextCommands);
    setCommandQuestion(trimmed);
    setCommandMessageId(res.messageId ?? null);
    setFieldValues(seedValues(nextCommands));
    setConfirmations({});
    const missing = res.missingKeys ?? [];
    if (missing.length > 0) {
      // `describeMissingTicketKeys`, not a literal: the server writes this same
      // sentence into the transcript, and two copies of it is how a reloaded
      // thread starts disagreeing with what was on screen.
      setTurns((prev) => [...prev, { role: "console", text: describeMissingTicketKeys(missing) }]);
    }
    if (!res.ok) {
      // The SENTENCE is chosen by kind, not hardcoded. This branch used to open
      // "I could not reach the model" for every failure, including a reply that
      // arrived and would not parse - see `describeConsoleModelFailure`, which
      // owns the wording so it can be asserted (nothing in this file loads under
      // the repo's node-environment Vitest).
      setTurns((prev) => [
        ...prev,
        {
          role: "console",
          // `rawReply` is the model's own words when it answered and the answer
          // could not be used. Shown, labelled unverified, and carrying NO
          // `recommended` - nothing was grounded off it, so there is nothing to
          // click and the injection defence is not in play.
          text: describeConsoleModelFailure(res.failureKind ?? "", res.error, res.rawReply),
        },
      ]);
      return;
    }
    setTurns((prev) => [
      ...prev,
      {
        role: "console",
        text: res.answer,
        recommended: res.recommendedActions,
        outOfScope: res.outOfScope,
      },
    ]);
  }

  async function run(action: ConsoleAction) {
    setRunningId(action.id);
    const res = await runSupervisorConsoleAction({ projectId, actionId: action.id });
    setRunningId(null);
    if (!res.ok) {
      toast.error(res.error);
      setTurns((prev) => [...prev, { role: "console", text: `**Not run.** ${res.error}` }]);
      return;
    }
    setBrief(res.brief);
    // A refusal by the primitive is reported in full, in the transcript, rather
    // than swallowed into a toast. It is the safety mechanism working, and the
    // reason it gives is the answer to "should I wait or is something wrong?".
    setTurns((prev) => [
      ...prev,
      { role: "console", text: describeConsoleRunOutcome(res.applied, res.summary) },
    ]);
    if (res.applied) {
      toast.success(res.summary);
      // The board behind the sheet is now stale.
      router.refresh();
    }
  }

  async function runCommand(command: ConsoleCommand) {
    setRunningId(command.id);
    const res = await runSupervisorConsoleCommandAction({
      projectId,
      // The operator's own message, re-parsed server-side to re-derive the
      // target. Not a ticket id - see this file's header.
      question: commandQuestion,
      commandId: command.id,
      payload: fieldValues[command.id] ?? {},
      confirmation: confirmations[command.id] ?? "",
      // Provenance for the ledger. The server proves it names the message that
      // says `commandQuestion` before it records the link, and drops it
      // silently if not - it can never widen what may be commanded.
      consoleMessageId: commandMessageId,
    });
    setRunningId(null);
    if (!res.ok) {
      toast.error(res.error);
      setTurns((prev) => [...prev, { role: "console", text: `**Not run.** ${res.error}` }]);
      return;
    }
    setBrief(res.brief);
    setTurns((prev) => [
      ...prev,
      { role: "console", text: describeConsoleRunOutcome(res.applied, res.summary) },
    ]);
    if (res.applied) {
      toast.success(res.summary);
      // A command that changed the board invalidates its own offer - the ticket
      // is no longer in the state the list was computed from. Clearing beats
      // leaving a button that will now be refused.
      setCommands([]);
      setConfirmations({});
      router.refresh();
    }
  }

  const recommendedIds = React.useMemo(
    () => turns.flatMap((t) => (t.recommended ?? []).map((a) => a.id)),
    [turns],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        {/* `pr-12` clears `SheetContent`'s own absolutely-positioned close
            button (`right-4 top-4`), which otherwise sits on top of the
            re-read control. */}
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b py-3 pl-5 pr-12">
          <div className="flex min-w-0 items-center gap-2">
            <LifeBuoy className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
            <SheetTitle className="truncate text-sm font-medium">
              Supervisor console
              {projectName ? <span className="text-muted-foreground"> · {projectName}</span> : null}
            </SheetTitle>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Re-read the board"
            title="Re-read the board"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loadError ? (
            <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-xs">
              {loadError}
            </div>
          ) : brief ? (
            <ConsoleReport
              brief={brief}
              runningId={runningId}
              onRun={(a) => void run(a)}
              emphasisIds={recommendedIds}
            >
              <CommandList
                commands={commands}
                supervisorEnabled={brief.supervisorEnabled}
                runningId={runningId}
                values={fieldValues}
                confirmations={confirmations}
                onChangeField={(id, name, value) =>
                  setFieldValues((prev) => ({
                    ...prev,
                    [id]: { ...(prev[id] ?? {}), [name]: value },
                  }))
                }
                onChangeConfirmation={(id, value) =>
                  setConfirmations((prev) => ({ ...prev, [id]: value }))
                }
                onRun={(c) => void runCommand(c)}
                emphasisIds={recommendedIds}
              />
            </ConsoleReport>
          ) : (
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the board…
            </div>
          )}

          {turns.length > 0 ? (
            <div className="mt-5 flex flex-col gap-3 border-t pt-4">
              {turns.map((t, i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm",
                    t.role === "operator"
                      ? "bg-primary/10 ml-8 self-end"
                      : "bg-muted/50 mr-4 border",
                  )}
                >
                  {t.role === "operator" ? (
                    <p className="whitespace-pre-wrap">{t.text}</p>
                  ) : (
                    <MessageMarkdown content={t.text} />
                  )}
                  {t.outOfScope ? (
                    // The wording is `describeRefusedCapability`'s, not this
                    // file's. It used to be hardcoded here and drifted the
                    // moment the vocabulary widened - claiming the console
                    // could not mark anything done long after it could. A
                    // capability boundary that misdescribes itself is worse
                    // than none, so there is one sentence and it lives in the
                    // module that owns the vocabulary.
                    <p className="text-muted-foreground mt-2 whitespace-pre-line border-t pt-2 text-[11px] leading-snug">
                      {describeRefusedCapability()}
                    </p>
                  ) : null}
                  {t.recommended && t.recommended.length > 0 ? (
                    <p className="text-muted-foreground mt-2 text-[11px]">
                      Recommended above: {t.recommended.map((a) => a.label).join(", ")} — run it
                      from <span className="font-medium">What I can do about it</span>.
                    </p>
                  ) : null}
                </div>
              ))}
              {asking ? (
                <div className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the board and thinking…
                </div>
              ) : null}
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>

        <div className="border-t px-5 py-3">
          {turns.length === 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={asking || !brief}
                  onClick={() => void ask(s)}
                  className="border-border text-muted-foreground hover:text-foreground hover:bg-accent rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask(question);
                }
              }}
              rows={2}
              placeholder="Ask what the board is doing, or tell me what to unstick…"
              className="min-h-[52px] resize-none text-sm"
              disabled={asking}
            />
            <Button
              type="button"
              size="icon"
              aria-label="Ask"
              disabled={asking || !question.trim()}
              onClick={() => void ask(question)}
            >
              {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
