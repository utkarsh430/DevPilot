"use client";

// Runner-connection view over the system-health snapshot. Both the onboarding
// "Connect your runner" step and the "New ticket" CTA need the same question
// answered — "is a runner actually heartbeating for this tenant right now?" —
// so we derive it from the SAME polled snapshot the topbar dot uses (via
// `useSystemHealth`) instead of inventing a second liveness mechanism. The
// runner service is "ok" exactly when at least one runner has beaten inside the
// watchdog window (see `readRunnerHealth`).

import { useSystemHealth } from "@/lib/realtime/use-system-health";
import type { ServiceHealth, SystemHealthSnapshot } from "@/lib/health/types";

// Tri-state so callers can distinguish "still loading the first probe" from a
// confirmed "no runner" — a UI must not flash a scary warning before the first
// poll has actually resolved the runner's state.
export type RunnerConnection = "checking" | "connected" | "disconnected";

// Seed for consumers that have no server-rendered snapshot to hand (e.g. the
// board's New-ticket button). Empty services → the first derived status is
// "checking", never a false "disconnected". The client hook fills in real state
// on its first poll a moment later. The epoch `checkedAt` is only a placeholder;
// nothing keys off it before the first fetch replaces the whole snapshot.
export const PENDING_HEALTH_SNAPSHOT: SystemHealthSnapshot = {
  checkedAt: "1970-01-01T00:00:00.000Z",
  llmPinged: false,
  // Inert placeholder — the runner-not-connected warning is also gated on
  // status, which is "checking" until the first real poll replaces this whole
  // snapshot, so this value is never the deciding factor.
  expectsLocalRunner: true,
  services: [],
};

export function useRunnerConnection(
  initial: SystemHealthSnapshot,
  // When false, the underlying poll is suspended and the seeded snapshot is
  // returned as-is. Lets a consumer poll only while it needs live state (e.g.
  // the New-ticket button, which polls only while its dialog is open).
  opts?: { enabled?: boolean },
): {
  status: RunnerConnection;
  runner: ServiceHealth | undefined;
  // True when this tenant runs on the local runner and therefore needs one
  // heartbeating; false for an API-runner tenant (no local runner required).
  // Callers gate the "runner not connected" nudge on this so API-runner tenants
  // never see a warning about a runner they don't use.
  expectsLocalRunner: boolean;
  loading: boolean;
  refresh: () => void;
} {
  // deep:false — this never needs the paid LLM ping, only the free runner read.
  // pollMs 15s (vs the topbar dot's 60s): consumers of this hook are actively
  // WAITING for a runner to appear (onboarding step, setup wizard, open
  // New-ticket dialog), so they keep the old snappy feedback. Cheap on the
  // server — shallow polls share the ~20s Redis-cached snapshot, so extra
  // polls are cache hits, and every consumer suspends via `enabled` when not
  // visible.
  const { snapshot, loading, refresh } = useSystemHealth({
    initial,
    deep: false,
    pollMs: 15_000,
    enabled: opts?.enabled,
  });
  const runner = snapshot.services.find((s) => s.id === "runner");
  const status: RunnerConnection =
    !runner || runner.state === "unknown"
      ? "checking"
      : runner.state === "ok"
        ? "connected"
        : "disconnected";
  return { status, runner, expectsLocalRunner: snapshot.expectsLocalRunner, loading, refresh };
}
