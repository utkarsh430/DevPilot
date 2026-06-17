// Onboarding readiness — the four checks a new tenant walks through before
// DevPilot is fully wired: GitHub connected, a project created, a runner
// heartbeating (or not needed), and a first run finished.
//
// This is the ONE owner of the readiness derivation rules. The welcome screen,
// the topbar checklist, and /api/onboarding/readiness all derive their state
// through these helpers so the surfaces can never disagree on what "ready"
// means. Client-safe: pure functions only, no server imports.

import type { SystemHealthSnapshot } from "@/lib/health/types";

export type ReadinessSnapshot = {
  githubConnected: boolean;
  hasProject: boolean;
  /** A local runner is online and heartbeating. */
  runnerConnected: boolean;
  /** False for API-runner tenants — they never register a local runner, so
   *  the runner step is satisfied by default (same rule as welcome). */
  expectsLocalRunner: boolean;
  /** At least one run reached status `done` in this tenant. */
  firstRunDone: boolean;
};

/** Same probe the welcome screen uses: the runner service reads "ok" only
 *  while a runner heartbeats inside the watchdog threshold. */
export function runnerConnectedFromHealth(health: SystemHealthSnapshot): boolean {
  return health.services.some((s) => s.id === "runner" && s.state === "ok");
}

/** The runner step counts as done with a live runner OR for an API-runner
 *  tenant that needs none. */
export function runnerSatisfied(
  s: Pick<ReadinessSnapshot, "runnerConnected" | "expectsLocalRunner">,
): boolean {
  return s.runnerConnected || !s.expectsLocalRunner;
}

/** The four checks in journey order, as booleans. */
export function readinessChecks(s: ReadinessSnapshot): [boolean, boolean, boolean, boolean] {
  return [s.githubConnected, s.hasProject, runnerSatisfied(s), s.firstRunDone];
}

export function readinessDoneCount(s: ReadinessSnapshot): number {
  return readinessChecks(s).filter(Boolean).length;
}

export function readinessComplete(s: ReadinessSnapshot): boolean {
  return readinessDoneCount(s) === 4;
}
