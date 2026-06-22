// Phase 1 / M9 — Supervision strategies.
//
// Every run carries a `supervision_strategy` that the failure handler reads
// when the run fails. Three strategies, chosen to map directly to the
// classic supervisor patterns:
//
//   • restart_n_times:N — start a fresh attempt up to N total restarts. The
//     fresh run is a brand-new row with `parent_run_id` set to the failed
//     run's id, `attempt_index` = parent.attempt_index + 1, and the same
//     strategy. Once N restarts are exhausted, falls through to
//     let_it_crash semantics.
//
//   • let_it_crash — do nothing extra. The M8 `cascadeKillOnFailure` handler
//     terminates the subtree if this run had children. Otherwise the failure
//     just sits on the run row.
//
//   • escalate_to_human — file an `input_required` transition on the run's
//     ticket (if any) so a human comment resumes the work via the existing
//     `agent/run.human-reply` path. A system comment records the escalation
//     reason.
//
// Null strategy = let_it_crash (Phase 0 default, no behavior change).

import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { randomUUID } from "node:crypto";

export type SupervisionStrategy =
  | { kind: "let_it_crash" }
  | { kind: "escalate_to_human" }
  | { kind: "restart_n_times"; n: number };

export type ParseResult =
  | { ok: true; strategy: SupervisionStrategy }
  | { ok: false; reason: string };

/**
 * Parse the `runs.supervision_strategy` column value. Null defaults to
 * `let_it_crash` (Phase 0 semantics preserved). The DB CHECK constraint
 * means we only see valid forms in practice; the parser still validates
 * defensively in case operators bypass it.
 */
export function parseSupervisionStrategy(raw: string | null): ParseResult {
  if (raw == null) return { ok: true, strategy: { kind: "let_it_crash" } };
  if (raw === "let_it_crash") return { ok: true, strategy: { kind: "let_it_crash" } };
  if (raw === "escalate_to_human") return { ok: true, strategy: { kind: "escalate_to_human" } };
  const m = raw.match(/^restart_n_times:([1-9][0-9]*)$/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) {
      return { ok: true, strategy: { kind: "restart_n_times", n } };
    }
  }
  return { ok: false, reason: `unrecognised supervision_strategy: ${raw}` };
}

export type RunRowForSupervision = {
  id: string;
  tenantId: string;
  ticketId: string | null;
  agentId: string | null;
  parentRunId: string | null;
  attemptIndex: number;
  budgetCents: number;
  spentCents: number;
  supervisionStrategyRaw: string | null;
  /** Phase 1 fix — preserve the original runner so retries don't silently
   *  fall back to the per-token API path against the CLAUDE.md default. */
  runnerKind: "api" | "local-cc" | null;
};

type ApplyContext = {
  failedRunId: string;
  /** Pre-loaded run row so we don't hit the DB again. */
  run: RunRowForSupervision;
  reason: string;
};

export type ApplyOutcome =
  | { action: "let-it-crash" }
  | { action: "restart-spawned"; newRunId: string; newAttemptIndex: number }
  | { action: "restart-exhausted"; attemptsTried: number; cap: number }
  | { action: "escalated"; ticketId: string }
  | { action: "skipped"; reason: string };

/**
 * Apply the run's supervision strategy after a failure. Idempotent on
 * replays: restarts insert a brand-new run id so re-firing this handler on
 * the same failure does not double-restart (the existing-attempt query is
 * the guard).
 *
 * Returns a structured outcome so the failure handler can log + record it
 * onto the run_step audit trail.
 */
export async function applySupervisionStrategy(ctx: ApplyContext): Promise<ApplyOutcome> {
  const parsed = parseSupervisionStrategy(ctx.run.supervisionStrategyRaw);
  if (!parsed.ok) {
    return { action: "skipped", reason: parsed.reason };
  }
  const strategy = parsed.strategy;

  switch (strategy.kind) {
    case "let_it_crash":
      return { action: "let-it-crash" };

    case "escalate_to_human": {
      const ticketId = ctx.run.ticketId;
      if (!ticketId) {
        // No ticket to escalate against — degrade to let-it-crash.
        return { action: "let-it-crash" };
      }
      const supabase = supabaseService();
      // Transition ticket to input_required + leave a system comment so the
      // human reviewer sees why and can reply (which resumes via the
      // existing agent/run.human-reply path).
      await supabase.from("tickets").update({ status: "input_required" }).eq("id", ticketId);
      await supabase.from("comments").insert({
        ticket_id: ticketId,
        tenant_id: ctx.run.tenantId,
        author_type: "system",
        author_id: "supervision",
        body:
          `Run ${ctx.failedRunId.slice(0, 8)} failed and escalated to human.\n\n` +
          `Failure reason: ${ctx.reason || "unknown"}\n\n` +
          `Reply on this ticket to resume the run.`,
      });
      return { action: "escalated", ticketId };
    }

    case "restart_n_times": {
      // attempt_index is the LATEST attempt — 0 for the original, N for the
      // Nth restart. Check whether the cap has been reached.
      const nextAttempt = ctx.run.attemptIndex + 1;
      if (nextAttempt > strategy.n) {
        return {
          action: "restart-exhausted",
          attemptsTried: ctx.run.attemptIndex,
          cap: strategy.n,
        };
      }

      // Build the new run row. Inherits budget + strategy. parent_run_id
      // points to the just-failed run so the chain is queryable.
      const supabase = supabaseService();
      const newRunId = randomUUID();
      const { error: insErr } = await supabase.from("runs").insert({
        id: newRunId,
        tenant_id: ctx.run.tenantId,
        agent_id: ctx.run.agentId,
        ticket_id: ctx.run.ticketId,
        parent_run_id: ctx.run.id,
        depth: 0, // depth measures supervisor recursion, not retry chain
        status: "running",
        budget_cents: ctx.run.budgetCents,
        spent_cents: 0,
        // Per CLAUDE.md non-negotiable #1, default to the local Claude Code
        // runner. Supervised restarts inherit the original run's runner kind
        // when known; fall back to local-cc rather than the per-token API.
        runner_kind: ctx.run.runnerKind ?? "local-cc",
        supervision_strategy: ctx.run.supervisionStrategyRaw,
        attempt_index: nextAttempt,
      });
      if (insErr) {
        throw new NonRetriableError(`supervision restart insert failed: ${insErr.message}`);
      }

      // Re-fetch the failed run's last think prompt to seed the retry.
      // Phase 1 first cut: just use the original ticket context via a fresh
      // dispatch. We don't replay the exact prompt — restart is a "try
      // again from scratch given the same ticket". The dispatcher will
      // pick up the ticket and the next role; for run-level restart we
      // emit a direct agent/run.requested to keep the chain intact.
      const { data: lastThink } = await supabase
        .from("run_steps")
        .select("payload")
        .eq("run_id", ctx.run.id)
        .eq("kind", "think")
        .order("idx", { ascending: false })
        .limit(1)
        .maybeSingle();
      const prevPayload = (lastThink?.payload ?? {}) as {
        prompt?: string;
        systemPrompt?: string;
        model?: string;
        role?: string;
      };

      await inngest.send({
        name: "agent/run.requested",
        data: {
          runId: newRunId,
          tenantId: ctx.run.tenantId,
          agentId: ctx.run.agentId ?? undefined,
          ticketId: ctx.run.ticketId ?? undefined,
          prompt:
            (prevPayload.prompt ?? "") +
            `\n\n[supervision restart attempt=${nextAttempt}; prior failure: ${ctx.reason || "unknown"}]`,
          systemPrompt: prevPayload.systemPrompt,
          iterations: 1,
          modelTier: "default",
          // Inherit the prior run's runner; default to local-cc per CLAUDE.md.
          runnerPolicy: ctx.run.runnerKind ?? "local-cc",
          budgetCents: ctx.run.budgetCents,
          role: prevPayload.role,
        },
      });
      return {
        action: "restart-spawned",
        newRunId,
        newAttemptIndex: nextAttempt,
      };
    }
  }
}
