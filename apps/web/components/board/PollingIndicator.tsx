"use client";

// Phase 1 M2 (Wave 1): the 5s `setInterval(() => router.refresh())` this
// component used to drive is gone — Supabase Realtime
// (`lib/realtime/use-tickets.ts`) is the delta channel now. The name stayed
// to avoid import churn; visually it's a connection status pill in the
// board header.
//
// Three states (aligned with changes-list-client.tsx's Live/Loading/Offline):
//   • live       → green "Live", the channel is subscribed and carrying deltas.
//   • connecting → amber "Connecting…", the initial/retry join is in flight.
//   • offline    → red "Offline", the channel errored or timed out. Supabase
//     auto-retries, but a permanent failure (auth expiry, CHANNEL_ERROR that
//     never recovers) would otherwise sit forever, so we surface a manual
//     Retry that tears the channel down and re-subscribes.

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import type { RealtimeStatus } from "@/lib/realtime/connection";

export function PollingIndicator({
  status,
  onRetry,
}: {
  status: RealtimeStatus;
  onRetry?: () => void;
}) {
  const isLive = status === "live";
  const isOffline = status === "offline";

  const label = isLive ? "Live" : isOffline ? "Offline" : "Connecting…";
  const title = isLive
    ? "Realtime channel subscribed"
    : isOffline
      ? "Realtime channel disconnected — click Retry to reconnect"
      : "Realtime channel connecting";

  return (
    <span
      className={cn(
        "bg-card inline-flex select-none items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium",
        isLive ? "text-success" : isOffline ? "text-destructive" : "text-warning",
      )}
      title={title}
      aria-live="polite"
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        {isLive ? (
          <span className="bg-success absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
        ) : null}
        <span
          className={cn(
            "relative inline-flex h-1.5 w-1.5 rounded-full",
            isLive ? "bg-success" : isOffline ? "bg-destructive" : "bg-warning",
          )}
        />
      </span>
      {label}
      {isOffline && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="text-destructive/80 hover:text-destructive -my-1 -mr-1 ml-0.5 inline-flex items-center gap-0.5 rounded px-1 py-1 underline-offset-2 hover:underline"
          aria-label="Retry realtime connection"
        >
          <RotateCcw className="h-3 w-3" />
          Retry
        </button>
      ) : null}
    </span>
  );
}
