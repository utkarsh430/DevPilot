import "server-only";

// One-shot LLM invocation through the local-cc Claude Code runner
// (subscription) — the synchronous sibling of lib/plan/runner-bridge.ts.
//
// Extracted from lib/engine/classifier-bridge.ts (which now delegates here)
// so every server-side feature that needs a single subscription-backed LLM
// call — dispatch classifiers, ticket enrichment, the JD role synthesizer,
// suggestion rankers — shares ONE mechanism instead of each inventing a
// parallel queue/poll loop. CLAUDE.md #1: no vendor SDK outside the
// runner/adapter layer.
//
// How it works:
//   1. Insert a synthetic `runs` row with `runner_kind='local-cc'` so the
//      runner's job-pull loop recognises the entry. `ticket_id` is null or an
//      audit-only pointer for a caller's own attribution — never a signal that
//      workspace prep should run. The job payload's `ticketId` mirrors this
//      row's exactly (see `invokeLocalCcOneShot`'s doc below); prep itself is
//      suppressed independently via `workspacePrepEligible: false`, so this is
//      pure chat, no git, regardless of whether a ticket is attached.
//   2. LPUSH a job to `devpilot:jobs:local-cc:ready`. The runner pops it, strips
//      ANTHROPIC_API_KEY, spawns `claude -p`, and POSTs the result to
//      /api/runs/[id]/step-result.
//   3. That endpoint caches the outcome in Redis under
//      `devpilot:run-result:<runId>` (5-min TTL) — success as `{text}` and, since
//      the auth-mode routing work, failure as `{error}`. We poll that key
//      instead of Inngest's `step.waitForEvent` because callers are plain
//      server actions / `step.run` bodies where nested step ops are illegal.
//   4. Poll every 500 ms up to the timeout. `{ok: true, text}` on success,
//      `{ok: false, reason}` on runner failure or timeout.
//
// Trade-off: latency is ~6–15 s (claude -p over subscription) vs ~2 s for the
// direct API. Acceptable for routing/synthesis — and it's the operator's
// explicit choice via Settings → LLM auth.

import { randomUUID } from "node:crypto";
import { supabaseService } from "@/lib/db/server";
import { redis } from "@/lib/cache/redis";
import { env } from "@/lib/env";
import type { ModelTier } from "@/lib/llm/models";
import { buildOneShotJobPayload } from "@/lib/runners/local-cc-oneshot-job";

const LOCAL_CC_QUEUE = "devpilot:jobs:local-cc:ready";
const RESULT_KEY_PREFIX = "devpilot:run-result:";
const POLL_INTERVAL_MS = 500;
/** 2 min — covers cold-start claude -p. Exported so a caller that budgets its
 *  OWN wall clock across more than one invocation (generate.server.ts's bounded
 *  JSON retry) can do the arithmetic against the same number this file uses,
 *  rather than guessing what `undefined` means. */
export const LOCAL_CC_DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = LOCAL_CC_DEFAULT_TIMEOUT_MS;

export type LocalCcOneShotResult =
  | { ok: true; text: string; runId: string }
  | { ok: false; reason: string };

export async function invokeLocalCcOneShot(args: {
  tenantId: string;
  systemPrompt: string;
  prompt: string;
  /** Optional ticket pointer for audit-trail joins. Threaded into BOTH the
   *  `runs` row and the runner job payload (below) so a direct DB query and
   *  the job the runner actually receives can never disagree about which
   *  ticket this run belongs to — an incident measured 2026-08-06: `runs`
   *  carried a real `ticket_id` while the enqueued job hardcoded `null`,
   *  which the runner logged as `ticketId=<none>` and which made a lost/
   *  garbled ticket reference undetectable (see the AGENTS.md incident
   *  entry and `workspace-precondition.ts`'s header on why facts are
   *  stamped explicitly rather than re-derived downstream).
   *
   *  This is STILL never used for workspace prep — every caller of this
   *  bridge (dispatch classifiers, ticket enrichment, suggestion rankers,
   *  …) is a pure text call with no role and no resolved project repo, so
   *  `workspacePrepEligible: false` below tells the runner to skip prep for
   *  this job UNCONDITIONALLY, even when `ticketId` is a real ticket and
   *  even when the runner host has a legacy `ENGINEER_REPO_URL` fallback
   *  configured — attempting prep here would race a concurrent producer's
   *  live workspace for the SAME ticket. */
  ticketId?: string;
  /** Forwarded in the job payload for parity with the plan bridge. The
   *  runner currently ignores it (claude -p runs its configured default),
   *  so this is forward-compat, not behaviour. */
  modelTier?: ModelTier;
  timeoutMs?: number;
}): Promise<LocalCcOneShotResult> {
  const runId = randomUUID();
  const jobId = randomUUID();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const supabase = supabaseService();

  // 1. Insert synthetic run row. The runner doesn't strictly read this — it
  //    works off the Redis job — but the row gives the operator a record
  //    in the runs table + lets the budget gate count the spend.
  const { error: insertErr } = await supabase.from("runs").insert({
    id: runId,
    tenant_id: args.tenantId,
    ticket_id: args.ticketId ?? null,
    agent_id: null,
    budget_cents: 100,
    spent_cents: 0,
    status: "running",
    depth: 0,
    runner_kind: "local-cc",
    last_event_at: new Date().toISOString(),
  });
  if (insertErr) {
    return { ok: false, reason: `synthetic-run-insert: ${insertErr.message}` };
  }

  // 2. Enqueue job for the runner. `ticketId` matches the run row above
  //    (audit-truthful — the runner log and a direct `runs` query must agree
  //    on which ticket this job belongs to). Workspace prep is suppressed
  //    independently via `workspacePrepEligible: false`, NOT by lying about
  //    the ticketId (see apps/runner/src/index.ts: prep gates on
  //    `job.ticketId && haveRepoUrl && job.workspacePrepEligible !== false`).
  //    Shape decided by the pure, unit-tested `buildOneShotJobPayload` so the
  //    ticketId/workspacePrepEligible pairing can't silently drift apart again.
  const jobPayload = JSON.stringify(
    buildOneShotJobPayload(
      {
        tenantId: args.tenantId,
        prompt: args.prompt,
        systemPrompt: args.systemPrompt,
        ticketId: args.ticketId,
        modelTier: args.modelTier,
      },
      { jobId, runId, engineUrl: env.LOCAL_CC_ENGINE_URL },
    ),
  );
  try {
    await redis().lpush(LOCAL_CC_QUEUE, jobPayload);
  } catch (err) {
    await markEnded(runId, "failed", "enqueue-failed");
    return {
      ok: false,
      reason: `enqueue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Poll the Redis result-cache that /api/runs/[id]/step-result writes
  //    when the runner POSTs back. The cache wraps the outcome in an envelope
  //    (`{text}` on success, `{error}` on failure) to defeat @upstash/redis's
  //    auto-JSON-parse behaviour on JSON-shaped payloads.
  const resultKey = `${RESULT_KEY_PREFIX}${runId}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);
    let text: string | null = null;
    let runnerError: string | null = null;
    try {
      const raw = (await redis().get<{ text?: string; error?: string } | string | null>(
        resultKey,
      )) as { text?: string; error?: string } | string | null;
      if (raw == null) {
        text = null;
      } else if (typeof raw === "string") {
        // Legacy plain-string entries from a pre-envelope write.
        text = raw;
      } else if (typeof raw === "object" && typeof raw.text === "string") {
        text = raw.text;
      } else if (typeof raw === "object" && typeof raw.error === "string") {
        runnerError = raw.error;
      } else {
        text = null;
      }
    } catch (err) {
      // Redis transient — log and keep polling.
      console.warn(
        `[local-cc-oneshot] redis.get failed for ${resultKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (runnerError != null) {
      await markEnded(runId, "failed", "runner-error");
      void redis()
        .del(resultKey)
        .catch(() => undefined);
      return { ok: false, reason: `runner: ${runnerError.slice(0, 300)}` };
    }
    if (text != null) {
      // Mark synthetic run done + tidy the cache (TTL would catch it
      // either way; explicit cleanup is just polite).
      await supabase
        .from("runs")
        .update({
          status: "done",
          last_event_at: new Date().toISOString(),
        })
        .eq("id", runId);
      void redis()
        .del(resultKey)
        .catch(() => undefined);
      return { ok: true, text, runId };
    }
  }

  // 4. Timeout — surface as a soft failure so callers can fall back
  //    without throwing. Best-effort dequeue of the orphaned job so a runner
  //    that hasn't picked it up yet doesn't later burn subscription tokens on
  //    a result nobody reads. The pop race is acceptable: if the runner
  //    already popped the job, LREM matches nothing and the runner's eventual
  //    result just sits in the cache until its TTL expires.
  try {
    await redis().lrem(LOCAL_CC_QUEUE, 1, jobPayload);
  } catch (err) {
    console.warn(
      `[local-cc-oneshot] timeout dequeue failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await markEnded(runId, "cancelled", "timeout");
  return { ok: false, reason: "timeout" };
}

async function markEnded(
  runId: string,
  status: "failed" | "cancelled",
  reason: string,
): Promise<void> {
  try {
    // `reason` was previously accepted and silently discarded — every call
    // site below ("enqueue-failed", "runner-error", "timeout") already names
    // a distinct, specific cause; only the write into `status_reason` was
    // missing.
    await supabaseService()
      .from("runs")
      .update({
        status,
        status_reason: reason,
        last_event_at: new Date().toISOString(),
      })
      .eq("id", runId);
  } catch (err) {
    console.warn(
      `[local-cc-oneshot] markEnded(${runId}, ${status}, ${reason}) bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
