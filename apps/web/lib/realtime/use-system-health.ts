"use client";

// System-health polling hook. Seeds from a server-rendered snapshot, then polls
// GET /api/system-health on an interval. Near-realtime by design (not a Supabase
// channel): the runner is only "down" past the 60s watchdog threshold, so a
// ~60s poll (over a ~20s server-side shared snapshot cache) detects it with
// acceptable added latency and zero schema/RLS work.
//
// Two cadences:
//   • deep=false (topbar dot): ~60s, free probes only — the LLM is reported as
//     "configured" without spending tokens.
//   • deep=true (settings page): ~10s + manual refresh, includes the paid LLM
//     ping (server-side cached ≤60s, so spend stays bounded).
//
// Polling is gated on document visibility — a hidden/background tab does no
// work (and, for deep, spends no tokens).

import * as React from "react";
import { overallState } from "@/lib/health/types";
import type { ServiceState, SystemHealthSnapshot } from "@/lib/health/types";

// Dot cadence: the runner-watchdog threshold is 60s and the server shares a
// ~20s Redis-cached shallow snapshot across tabs, so a 60s per-tab poll still
// detects a dead runner within ~1 threshold window while quartering the
// background request load per tab.
const DOT_POLL_MS = 60_000;
const PAGE_POLL_MS = 10_000;

export function useSystemHealth(opts: {
  initial: SystemHealthSnapshot;
  deep: boolean;
  pollMs?: number;
  // When false, skip all fetching/interval/visibility work and just return the
  // seeded snapshot. Lets a consumer (e.g. the New-ticket button) mount the hook
  // but only poll while it actually needs live state. Defaults to true.
  enabled?: boolean;
}): {
  snapshot: SystemHealthSnapshot;
  overall: ServiceState;
  loading: boolean;
  refresh: () => void;
} {
  const { initial, deep } = opts;
  const enabled = opts.enabled ?? true;
  const pollMs = opts.pollMs ?? (deep ? PAGE_POLL_MS : DOT_POLL_MS);
  const [snapshot, setSnapshot] = React.useState(initial);
  const [loading, setLoading] = React.useState(false);
  // Bumping `tick` re-runs the effect → an immediate fetch (manual refresh).
  const [tick, setTick] = React.useState(0);
  const refresh = React.useCallback(() => setTick((t) => t + 1), []);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function fetchOnce() {
      // Skip hidden tabs — saves work and (in deep mode) tokens.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setLoading(true);
      try {
        const res = await fetch(`/api/system-health?deep=${deep ? "1" : "0"}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as SystemHealthSnapshot;
        if (!cancelled) setSnapshot(data);
      } catch {
        // Keep the last good snapshot on a transient fetch failure.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchOnce();
    const timer = setInterval(() => void fetchOnce(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchOnce();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [deep, pollMs, tick, enabled]);

  return {
    snapshot,
    overall: overallState(snapshot.services),
    loading,
    refresh,
  };
}
