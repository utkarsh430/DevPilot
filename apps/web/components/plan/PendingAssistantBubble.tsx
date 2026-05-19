"use client";

// "Lead is thinking…" affordance shown at the tail of the message list while
// the discussing-mode chat is waiting on the next assistant reply. Derived
// state — PlanSheet computes `showPendingLead` from the messages tail (last
// role === 'user' + status === 'discussing') and toggles `stale` after 60s.
// Survives mid-conversation refresh because the trigger is derived, not a
// DB flag.

import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DotsLoader } from "@/components/plan/DotsLoader";

export function PendingAssistantBubble({ stale }: { stale: boolean }) {
  return (
    <div className="mr-auto flex max-w-full flex-row gap-2">
      <div className="border-border bg-muted text-muted-foreground mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border">
        <Bot className="h-3 w-3" />
      </div>
      <div className="border-border bg-card flex max-w-[80%] flex-col gap-1.5 rounded-lg border p-3 text-sm leading-relaxed">
        <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <Badge tone="info" className="text-[11px]">
            Planner Lead
          </Badge>
        </div>
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <DotsLoader />
          <span>{stale ? "Still thinking…" : "Thinking…"}</span>
        </div>
        {stale ? (
          <p className="text-muted-foreground text-[11px]">
            Heavy turns can take up to 2 minutes on the subscription runner.
          </p>
        ) : null}
      </div>
    </div>
  );
}
