"use client";

// Phase 2.5+ / M7 — Chat transcript for the plan-mode discussion.
//
// Renders the message stream coming out of `useLivePlanMessages`. Three row
// shapes:
//   • role=user      — right-aligned bubble via <EditableUserBubble>. The
//                      latest user message exposes a hover-revealed pencil
//                      that opens an inline editor; Save truncates the
//                      transcript and regenerates the lead's reply.
//   • role=assistant — left-aligned bubble with the panel agent label
//                      (lead / pm / tech_lead / devops / consolidator) as a
//                      tiny badge above the text. Content rendered through
//                      <MessageMarkdown> (GFM, no rehype-raw). Hover reveals
//                      a small Copy button.
//   • role=system    — centered, subtle status pill ("PM panel started",
//                      "Consolidator finished").
//
// While the session is in `discussing` and the last message in the list is
// a user message, the parent passes `pendingLead=true` so we render a
// `<PendingAssistantBubble>` at the tail. After 60s of waiting, the parent
// flips `pendingLeadStale=true` and we swap to the softer copy.

import * as React from "react";
import { Bot, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import type { PlanAgentRole, PlanMessage } from "@/lib/plan/types";
import { MessageMarkdown } from "@/components/plan/MessageMarkdown";
import { CopyButton } from "@/components/plan/CopyButton";
import { EditableUserBubble } from "@/components/plan/EditableUserBubble";
import { PendingAssistantBubble } from "@/components/plan/PendingAssistantBubble";
import { QuestionPanel, type PendingAnswer } from "@/components/plan/QuestionPanel";
import { parseAssistantReply } from "@/lib/plan/parse-assistant-reply";
import { submitPlanAnswersAction } from "@/app/(app)/plan/actions";

const AGENT_LABEL: Record<PlanAgentRole, string> = {
  lead: "Planner Lead",
  pm: "PM",
  tech_lead: "Tech Lead",
  devops: "DevOps",
  consolidator: "Consolidator",
};

// Tone selection for the per-agent badge.
const AGENT_TONE: Record<PlanAgentRole, "info" | "warn" | "ok" | "violet" | "muted"> = {
  lead: "info",
  pm: "violet",
  tech_lead: "info",
  devops: "warn",
  consolidator: "ok",
};

function agentLabel(role: string | null | undefined): string {
  if (!role) return "Assistant";
  return (AGENT_LABEL as Record<string, string>)[role] ?? role;
}
function agentTone(role: string | null | undefined): "info" | "warn" | "ok" | "violet" | "muted" {
  if (!role) return "muted";
  return (
    (AGENT_TONE as Record<string, "info" | "warn" | "ok" | "violet" | "muted">)[role] ?? "muted"
  );
}

export function PlanMessageList({
  messages,
  loading,
  pendingLead = false,
  pendingLeadStale = false,
  sessionId,
  scrollContainerRef,
}: {
  messages: PlanMessage[];
  loading?: boolean;
  pendingLead?: boolean;
  pendingLeadStale?: boolean;
  /** Required to submit structured answers back to the lead. */
  sessionId: string | null;
  /**
   * Ref to the ancestor scroll region this list renders inside. PlanSheet
   * wraps the Stack advisor and this list in one shared scrollable
   * container (so advisor content and the transcript scroll together as a
   * single body, with the composer pinned below) - this list no longer owns
   * its own scroll/overflow, so auto-scroll-to-bottom targets that ancestor
   * instead of a root of its own.
   */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Auto-scroll on new messages OR when the pending indicator toggles in/out
  // so the operator's eye stays at the live edge.
  const lastLen = React.useRef(messages.length);
  const lastPending = React.useRef(pendingLead);
  React.useEffect(() => {
    if (messages.length === lastLen.current && pendingLead === lastPending.current) return;
    lastLen.current = messages.length;
    lastPending.current = pendingLead;
    const el = scrollContainerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length, pendingLead, scrollContainerRef]);

  // Index the last USER message in the array so EditableUserBubble can mark
  // itself as "latest" for the pencil-hover affordance. Counted by id so a
  // realtime UPDATE that swaps content doesn't reshuffle the picked id.
  const lastUserIdx = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") return i;
    }
    return -1;
  }, [messages]);

  // Index the last ASSISTANT message — QuestionPanel only accepts new input
  // on the most recent assistant turn (older question panels are locked).
  const lastAssistantIdx = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") return i;
    }
    return -1;
  }, [messages]);

  return (
    <div className="flex flex-1 flex-col gap-2.5 px-6 py-4">
      {loading && messages.length === 0 ? (
        <p className="text-muted-foreground text-xs">Loading transcript…</p>
      ) : null}

      {messages.length === 0 && !loading ? (
        <div className="text-muted-foreground m-auto flex max-w-sm flex-col items-center gap-2 text-center text-xs">
          <Sparkles className="text-muted-foreground h-5 w-5" />
          <p>
            Tell the planner what you want to build. The lead will clarify scope, then PM / Tech
            Lead / DevOps deliberate when you click &ldquo;Build plan&rdquo;.
          </p>
        </div>
      ) : null}

      {messages.map((m, idx) => {
        // Safety: never render an empty user/assistant bubble. An empty
        // assistant message is the symptom of a runner-side parser miss
        // (the server's planLeadReplyFn guard now upgrades empties into a
        // `system` pill instead, but a row that's already in the DB from
        // before the fix would otherwise render as a ghost bubble).
        if (m.role !== "system" && m.content.trim().length === 0) {
          return null;
        }
        if (m.role === "system") {
          return (
            <div key={m.id} className="my-1 flex justify-center">
              <span className="border-border bg-muted/60 text-muted-foreground rounded-full border px-2.5 py-0.5 text-[11px] uppercase tracking-wider">
                {m.content}
              </span>
            </div>
          );
        }
        if (m.role === "user") {
          const followUpCount = messages.length - idx - 1;
          const meta = (m.metadata ?? {}) as Record<string, unknown>;
          return (
            <EditableUserBubble
              key={m.id}
              messageId={m.id}
              content={m.content}
              createdAt={m.createdAt}
              followUpCount={followUpCount}
              isLatest={idx === lastUserIdx}
              edited={typeof meta.edited_at === "string"}
            />
          );
        }
        // Assistant
        // Parse out any structured question panel embedded in the content.
        // Parse failures gracefully degrade to plain prose (no panel).
        const parsed =
          m.agentRole === "lead" || m.agentRole === null
            ? parseAssistantReply(m.content)
            : {
                prose: m.content,
                summary: null,
                questions: [],
                truncatedCount: 0,
                parseError: null,
              };
        const isLatestAssistant = idx === lastAssistantIdx;

        // Detect whether the NEXT user message replied to THIS message's
        // question panel via metadata.in_reply_to. If so, lock the panel
        // and surface the chosen answers as a read-only summary.
        let answered = false;
        let lockedAnswers: Array<{
          questionIdx: number;
          primary: string;
          other?: string;
        }> = [];
        if (parsed.questions.length > 0) {
          for (let j = idx + 1; j < messages.length; j++) {
            const next = messages[j]!;
            if (next.role !== "user") continue;
            const meta = (next.metadata ?? {}) as Record<string, unknown>;
            if (meta.in_reply_to === m.id) {
              answered = true;
              const rawAnswers = Array.isArray(meta.answers) ? meta.answers : [];
              lockedAnswers = (
                rawAnswers as Array<{
                  questionIdx: number;
                  choice: { kind: string; label?: string; labels?: string[]; text?: string };
                }>
              ).map((a) => {
                const c = a.choice;
                if (c.kind === "option") {
                  return { questionIdx: a.questionIdx, primary: c.label ?? "" };
                }
                if (c.kind === "options") {
                  return {
                    questionIdx: a.questionIdx,
                    primary: (c.labels ?? []).join("; "),
                  };
                }
                return {
                  questionIdx: a.questionIdx,
                  primary: "Other",
                  other: c.text ?? "",
                };
              });
              break;
            }
            // The FIRST user message after this assistant turn that does not
            // reply to it counts as the user moving on — don't keep scanning.
            break;
          }
        }

        async function handleSubmitAnswers(answers: PendingAnswer[]) {
          if (!sessionId) {
            throw new Error("session not initialised");
          }
          const res = await submitPlanAnswersAction({
            sessionId,
            inReplyToMessageId: m.id,
            answers,
          });
          if (!res.ok) {
            toast.error("Couldn't submit", { description: res.error });
            throw new Error(res.error);
          }
        }

        return (
          <div key={m.id} className="group mr-auto flex max-w-full flex-row gap-2">
            <div
              className={cn(
                "border-border bg-muted text-muted-foreground mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
              )}
            >
              <Bot className="h-3 w-3" />
            </div>
            <div className="border-border bg-card relative flex max-w-[80%] flex-col gap-1 rounded-lg border p-3 leading-relaxed">
              <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                <Badge tone={agentTone(m.agentRole)} className="text-[11px]">
                  {agentLabel(m.agentRole)}
                </Badge>
                <span className="font-mono">{relativeTime(m.createdAt)}</span>
                <CopyButton text={m.content} className="ml-auto" />
              </div>
              <MessageMarkdown content={parsed.prose} />
              {parsed.questions.length > 0 && sessionId ? (
                <QuestionPanel
                  messageId={m.id}
                  questions={parsed.questions}
                  truncatedCount={parsed.truncatedCount}
                  isLatestAssistant={isLatestAssistant}
                  answered={answered}
                  lockedAnswers={lockedAnswers}
                  onSubmit={handleSubmitAnswers}
                />
              ) : null}
              {parsed.parseError ? (
                <p className="text-muted-foreground mt-1 text-[11px]">
                  (lead reply structure couldn&apos;t be parsed: {parsed.parseError})
                </p>
              ) : null}
            </div>
          </div>
        );
      })}

      {pendingLead ? <PendingAssistantBubble stale={pendingLeadStale} /> : null}
    </div>
  );
}
