"use client";

// Topbar system-health indicator. An always-visible status dot (green/amber/
// red) over an Activity icon, with a popover that lists every service. This is
// the surface that would have caught the silent runner-down: the dot turns red
// within ~30s of the runner going stale, no need to dispatch work first.
//
// Mirrors NotificationsBell (Popover + status dot) and PollingIndicator
// (animate-ping) for visual consistency. Background poll is deep=false, so the
// dot never spends LLM tokens.

import * as React from "react";
import Link from "next/link";
import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relative-time";
import { useSystemHealth } from "@/lib/realtime/use-system-health";
import type { ServiceState, SystemHealthSnapshot } from "@/lib/health/types";

const DOT: Record<ServiceState, string> = {
  ok: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground",
};

const STATE_LABEL: Record<ServiceState, string> = {
  ok: "All systems go",
  degraded: "Degraded",
  down: "Service down",
  unknown: "Checking…",
};

export function SystemStatus({ initial }: { initial: SystemHealthSnapshot }) {
  const { snapshot, overall, loading, refresh } = useSystemHealth({ initial, deep: false });
  const [open, setOpen] = React.useState(false);
  const attention = overall === "degraded" || overall === "down";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`System health: ${STATE_LABEL[overall]}`}
          className="relative"
        >
          <Activity className="h-4 w-4" />
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-2 w-2">
            {attention ? (
              <span
                className={cn(
                  "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                  DOT[overall],
                )}
                aria-hidden
              />
            ) : null}
            <span
              className={cn(
                "border-background relative inline-flex h-2 w-2 rounded-full border",
                DOT[overall],
              )}
              aria-hidden
            />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={cn("inline-block h-1.5 w-1.5 rounded-full", DOT[overall])}
              aria-hidden
            />
            <span className="font-medium">{STATE_LABEL[overall]}</span>
          </div>
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="text-muted-foreground hover:text-foreground text-[11px] disabled:opacity-60"
          >
            {loading ? "Checking…" : "Refresh"}
          </button>
        </div>

        <ul className="divide-y">
          {snapshot.services.map((s) => {
            return (
              <li key={s.id} className="flex items-center gap-2 px-3 py-2">
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[s.state])}
                  aria-hidden
                />
                <span className="text-xs">{s.label}</span>
                {s.optional ? (
                  <span className="text-muted-foreground text-[9px] lowercase">optional</span>
                ) : null}
                <span className="ml-auto flex min-w-0 items-center gap-2 pl-2">
                  {s.detail ? (
                    <span className="text-muted-foreground truncate text-[10px]">{s.detail}</span>
                  ) : null}
                  {s.remedy ? (
                    <Link
                      href={s.remedy.href}
                      onClick={() => setOpen(false)}
                      className="text-primary shrink-0 text-[10px] font-medium underline-offset-2 hover:underline"
                    >
                      {s.remedy.label} →
                    </Link>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between border-t px-3 py-2">
          <span className="text-muted-foreground text-[10px]">
            Checked {relativeTime(snapshot.checkedAt)}
          </span>
          <Link
            href="/settings/system-health"
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
          >
            Details →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
