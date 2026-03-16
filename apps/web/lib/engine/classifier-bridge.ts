import "server-only";

// Classifier-bridge — invoke a single Haiku-style classification through the
// local-cc Claude Code runner (subscription) instead of `@ai-sdk/anthropic`.
//
// Why this exists:
//   CLAUDE.md #1 forbids hardwiring a vendor SDK outside the runner/adapter
//   layer. The original M5h / F2 classifiers in `ticket-role-classifier.ts`
//   called `@ai-sdk/anthropic`'s `generateObject` directly, which billed
//   against a per-token API key. That key has been revoked in dogfooding
//   environments (handoff §8b incident #12), so every classifier call has
//   been silently failing — the dispatcher then falls through to the
//   deterministic state-machine, which mechanically picks `pm` for every
//   `ready` ticket. The "only PM/Engineer/QA run" symptom traces back to
//   exactly this auth failure.
//
// The queue/poll mechanism itself now lives in
// `lib/runners/local-cc-oneshot.server.ts` (extracted so the JD role
// synthesizer and other auth-mode-routed features share it — see
// lib/llm/generate.server.ts). This module keeps the classifier-facing names
// so the dispatch classifiers and the ticket enricher are untouched.

import {
  invokeLocalCcOneShot,
  type LocalCcOneShotResult,
} from "@/lib/runners/local-cc-oneshot.server";
import { extractJsonBlock } from "@/lib/llm/routing";

export type ClassifierBridgeResult = LocalCcOneShotResult;

export async function classifyViaLocalCc(args: {
  tenantId: string;
  systemPrompt: string;
  prompt: string;
  /** Optional ticket pointer for audit-trail joins, forwarded verbatim to the
   *  runner job (see `invokeLocalCcOneShot`). Not used for workspace prep —
   *  classifier jobs are stamped `workspacePrepEligible: false` so the runner
   *  skips git clone/checkout regardless of whether a real ticket is
   *  attached. */
  ticketId?: string;
  timeoutMs?: number;
}): Promise<ClassifierBridgeResult> {
  return invokeLocalCcOneShot(args);
}

/**
 * Pull the first fenced JSON block (or a bare JSON object) out of a text
 * blob. The implementation moved to the framework-free `lib/llm/routing.ts`
 * (`extractJsonBlock`) so acceptance scripts can exercise it; this alias
 * keeps the classifier-facing name stable.
 *
 * Returns null when the text doesn't contain anything parseable as JSON.
 */
export function safeParseJsonBlock<T = unknown>(text: string): T | null {
  return extractJsonBlock<T>(text);
}
