// Server-only: does this tenant actually need a live LOCAL runner?
//
// A tenant needs a local runner exactly when it runs on the Claude Code
// subscription path — i.e. when its LLM auth-mode is `claude_code` (the
// default). Under `api_key` mode tickets run through the per-token API path and
// need NO local runner at all, so the "runner not connected" onboarding UI must
// not nag those tenants.
//
// This reads the SAME `getLlmAuthMode` resolver that decidePolicy() in
// lib/plan/runner-bridge.ts and probeLlm() in lib/health/probes.ts use, so
// onboarding/board runner-mode detection and the actual routing decision stay
// in lockstep. Never import this from a client component.

import "server-only";

import { getLlmAuthMode } from "@/lib/llm/auth-mode.server";
import type { LlmAuthMode } from "@/lib/llm/auth-mode";

/** Pure mapping: does a given auth-mode imply a local runner is expected?
 *  Use this when the caller has already resolved the tenant's mode (e.g. the
 *  system-health route resolves it once and shares it with probeLlm) so the
 *  `tenants.config` row isn't read twice in one request. */
export function localRunnerExpectedForMode(mode: LlmAuthMode): boolean {
  return mode === "claude_code";
}

export async function tenantExpectsLocalRunner(tenantId: string | null): Promise<boolean> {
  return localRunnerExpectedForMode(await getLlmAuthMode(tenantId));
}
