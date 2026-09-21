"use client";

// System-health detail cards. Uses the shared hook in deep mode (deep=true),
// so each poll / manual refresh runs the live LLM ping — which is still
// server-side cached to ≤1 real call per minute.

import * as React from "react";
import Link from "next/link";
import { Activity, RefreshCw, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

const TONE: Record<ServiceState, "ok" | "warn" | "danger" | "muted"> = {
  ok: "ok",
  degraded: "warn",
  down: "danger",
  unknown: "muted",
};

const STATE_LABEL: Record<ServiceState, string> = {
  ok: "Operational",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
};

export function SystemHealthClient({ initial }: { initial: SystemHealthSnapshot }) {
  const { snapshot, loading, refresh } = useSystemHealth({ initial, deep: true });

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="text-muted-foreground h-5 w-5" />
            <h1 className="font-display text-xl font-bold tracking-tight">System health</h1>
          </div>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            Live status of the local runner, dev servers, and the backend services DevPilot depends
            on. Checked {relativeTime(snapshot.checkedAt)}.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          {loading ? "Checking…" : "Refresh now"}
        </Button>
      </header>

      {snapshot.services.length === 0 ? (
        <Card className="text-muted-foreground px-6 py-10 text-center text-sm">
          No tenant context — sign in to view system health.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {snapshot.services.map((s) => {
            return (
              <Card key={s.id} className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className={cn("h-2 w-2 rounded-full", DOT[s.state])} aria-hidden />
                    {s.label}
                    {s.optional ? (
                      <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide">
                        Optional
                      </span>
                    ) : null}
                  </span>
                  <Badge tone={TONE[s.state]} className="text-[10px]">
                    {STATE_LABEL[s.state]}
                  </Badge>
                </div>
                <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{s.detail ?? "—"}</span>
                  {s.latencyMs != null ? (
                    <span className="shrink-0 font-mono">{s.latencyMs}ms</span>
                  ) : null}
                </div>
                {s.remedy ? (
                  <Link
                    href={s.remedy.href}
                    className="text-primary inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
                  >
                    <Wrench className="h-3 w-3" />
                    How to fix →
                  </Link>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-muted-foreground mt-6 text-xs">
        Services tagged <span className="font-medium">Optional</span> (LLM, tracing) are shown but
        don&apos;t affect overall status — the default local runner uses your Claude subscription,
        not the API key. The Anthropic LLM check makes a tiny live request, cached for ~60s to cap
        spend.{" "}
        {snapshot.llmPinged
          ? "This refresh performed a live ping."
          : "Showing the cached / most-recent result."}
      </p>
    </div>
  );
}
