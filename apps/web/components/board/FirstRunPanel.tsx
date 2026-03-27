"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import { seedStarterTicketAction } from "@/app/(app)/board/actions";
import { STARTER_TICKETS, type StarterTicket } from "@/components/board/starter-tickets";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";

/**
 * First-run activation panel. Rendered in place of the (all-empty) Kanban
 * columns when a project has zero tickets, so a brand-new board offers a
 * one-click way into the ticket → run → trace loop instead of bare columns.
 *
 * Each starter routes through `seedStarterTicketAction`, which reuses the same
 * validated create + promote-to-Ready path a hand-typed ticket uses - so the
 * ticket dispatches like any other.
 */
export function FirstRunPanel({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  async function onPick(t: StarterTicket) {
    if (disabled || pendingId) return;
    setPendingId(t.id);
    const res = await seedStarterTicketAction({ title: t.title, description: t.description });
    setPendingId(null);
    if (!res.ok) {
      toast.error("Couldn't start that ticket", { description: res.error });
      return;
    }
    toast.success("Ticket created in Ready", {
      description: "The agent loop is kicking off now - watch it move across the board.",
    });
    // Realtime should fold the new row in, but refresh to reseed the server
    // snapshot so the board flips out of the first-run state deterministically.
    router.refresh();
  }

  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-2xl">
        <div className="text-foreground flex items-center gap-2">
          <span className="bg-chart-1/10 text-chart-1 flex h-8 w-8 items-center justify-center rounded-lg">
            <Sparkles className="h-4 w-4" />
          </span>
          <h2 className="text-lg font-semibold">Run your first ticket</h2>
        </div>
        <p className="text-muted-foreground mt-2 text-sm">
          File a ticket → an agent runs it end-to-end → every step lands in the trace. Pick a
          starter below and DevPilot drops it straight into{" "}
          <span className="text-foreground font-medium">Ready</span> so the loop kicks off
          immediately.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {STARTER_TICKETS.map((t) => {
            const isPending = pendingId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                disabled={disabled || pendingId !== null}
                onClick={() => void onPick(t)}
                className={cn(
                  "bg-muted/30 group flex flex-col rounded-xl border p-4 text-left transition-colors",
                  "hover:border-ring hover:bg-accent/50",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-foreground text-sm font-medium">{t.title}</span>
                  {isPending ? (
                    <Loader2 className="text-muted-foreground h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <ArrowRight className="text-muted-foreground h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </span>
                <span className="text-muted-foreground mt-1.5 text-xs">{t.summary}</span>
                <span className="text-chart-1 mt-3 text-[11px] font-medium">
                  {isPending ? "Creating…" : "Run this →"}
                </span>
              </button>
            );
          })}
        </div>

        {disabled ? (
          <p className="text-muted-foreground mt-4 text-[11px]">
            Create a project before filing tickets.
          </p>
        ) : (
          <p className="text-muted-foreground mt-4 text-[11px]">
            Prefer to write your own? Use{" "}
            <span className="text-foreground font-medium">New ticket</span> in the top-right - the
            same starters are there as presets.
          </p>
        )}
      </div>
    </div>
  );
}
