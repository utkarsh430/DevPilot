// Phase 1 / M13 — Replay / time-travel from any step.
//
// What this does
// ──────────────
// On `agent/run.replay-requested`, clone a finished run as a NEW run that
// resumes execution from a specified step idx, with optional prompt /
// systemPrompt / modelTier / budget overrides. The original is immutable;
// the replay creates a brand-new run row whose lineage points back via
// `runs.replay_of_run_id`.
//
// Why a discriminator column and NOT `parent_run_id`
// ──────────────────────────────────────────────────
// `runs.parent_run_id` means "M8 supervisor parent". cascade-kill (parent
// fails → kill descendants) and walkSubtree (inspector tree + reaper) both
// walk parent_run_id. If we set parent_run_id on replays, then failing the
// original would cascade-kill every replay — the opposite of what
// time-travel debugging needs. So replays use ONLY `replay_of_run_id` (added
// by 20260603070000_m13_replay.sql). The Run Inspector renders two trees:
// the supervisor subtree (parent_run_id) and the replay chain (replay_of_run_id).
//
// Per-original replay cap
// ───────────────────────
// Each original gets at most `DEVPILOT_MAX_REPLAYS_PER_RUN` replay clones
// (default 5). The 6th request fails fast with a structured error so the
// operator sees "you've hit the cap" instead of a silent storage blowup.
// Counted by `select count(*) from runs where replay_of_run_id = $1`.
//
// Budget inheritance
// ──────────────────
// The replay inherits the original's budget unless `budgetCentsOverride` is
// provided. The standard per-run budget guard (`assertCanProceed`) still
// applies inside the resumed loop — runaway-by-replay is mathematically
// impossible because each replay needs a deliberate operator (or future
// agent-tool) action and is itself budget-bounded.
//
// Storage shape
// ─────────────
// We bulk-copy run_steps rows 0..fromStepIdx-1 from the original onto the
// clone so the timeline reads continuously. The `id` (bigserial PK) regen's
// on insert; everything else is a verbatim copy including the cloned
// `created_at` timestamps so the inspector shows the original cadence for
// the carried-over context. The migration header documents the worst-case
// storage multiplier.

import { randomUUID } from "node:crypto";
import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import {
  getEffectivePause,
  getEffectivePauseForTicket,
  pauseRefusalMessage,
} from "@/lib/engine/automation-state";
// Resume-context reconstruction. A replay used to re-enter runAgent with
// systemPrompt=undefined (the role's system prompt is built at dispatch time
// and was never persisted) and, for originals that failed before persisting a
// step, role=undefined and a placeholder prompt. Tool-driven roles replayed
// that way never call `devpilot_move_ticket`, stranding their ticket in
// `in_progress` — the stuck-ticket bug (865345ef). The helpers below rebuild
// role, system prompt, and prompt from the same sources the dispatcher uses.
import { deriveSeedFromSteps, pickResumePrompts } from "@/lib/engine/replay-prompts";
import { getBuiltinRoleConfig, loadCustomRoleConfig } from "@/lib/roles/load";
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";
import { loadOverlayForDispatch } from "@/lib/roles/overlay.server";
import { buildTicketContext, renderTicketPrompt } from "@/lib/roles/context";

export const MAX_REPLAYS_PER_RUN = Number(process.env.DEVPILOT_MAX_REPLAYS_PER_RUN ?? "5");

// Belt-and-suspenders cap on non-operator replays (user-Resume + auto-recover).
// The operator cap above is a "you're debugging in circles" guardrail; this
// one is a circuit breaker for a runaway flaky-machine recovery loop.
// Counted across replay_reason in ('resume','auto-recover').
export const MAX_NON_OPERATOR_REPLAYS_PER_RUN = Number(
  process.env.DEVPILOT_MAX_NON_OPERATOR_REPLAYS_PER_RUN ?? "50",
);

// Iterations the replayed loop is allowed to run for. The think-loop will
// produce steps [fromStepIdx, fromStepIdx + REPLAY_ITERATIONS). Keep this
// conservative — replays should converge fast; multi-iter replay chains
// inflate storage. Operator-tunable for power-user scenarios.
const REPLAY_ITERATIONS = Number(process.env.DEVPILOT_REPLAY_ITERATIONS ?? "1");

export type ReplayRefusalReason =
  | "original-not-found"
  | "original-not-terminal"
  | "from-step-out-of-range"
  | "replay-cap-exceeded"
  | "auto-recover-cap-exceeded"
  | "step-clone-failed"
  | "automation-paused";

export type ReplayReason = "operator" | "resume" | "auto-recover";

export class ReplayRefused extends NonRetriableError {
  readonly code: ReplayRefusalReason;
  constructor(code: ReplayRefusalReason, detail: string) {
    super(`replay refused (${code}): ${detail}`);
    this.code = code;
    this.name = "ReplayRefused";
  }
}

type OriginalRun = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  ticket_id: string | null;
  budget_cents: number;
  runner_kind: "api" | "local-cc" | null;
  status: string;
};

type OriginalStep = {
  run_id: string;
  idx: number;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
};

/**
 * Count existing replay clones for a given original, optionally filtered by
 * replay_reason. The cap is enforced BEFORE inserting the new clone row so a
 * failed-cap attempt leaves no residual storage.
 *
 * Filter semantics:
 *   - reason='operator'          → only operator-driven Inspector replays.
 *   - reasonIn=['resume','auto-recover'] → user-Resume + watchdog recoveries.
 *   - omit both → total count (legacy callers).
 */
async function countReplays(
  originalRunId: string,
  tenantId: string,
  filter?: { reason?: ReplayReason; reasonIn?: ReplayReason[] },
): Promise<number> {
  const supabase = supabaseService();
  // Tenant-scoped: this COUNT is a circuit breaker. `runs`' member write policy
  // pins only the row's own `tenant_id`, never the `replay_of_run_id` it names,
  // so unscoped a hostile tenant could plant rows pointing at our run, push the
  // count past the cap, and make every replay/resume of ours refuse forever.
  // `tenantId` is proven against the original run row by `planReplay`.
  let q = supabase
    .from("runs")
    .select("id", { count: "exact", head: true })
    .eq("replay_of_run_id", originalRunId)
    .eq("tenant_id", tenantId);
  if (filter?.reason !== undefined) {
    q = q.eq("replay_reason", filter.reason);
  } else if (filter?.reasonIn !== undefined) {
    q = q.in("replay_reason", filter.reasonIn);
  }
  const { count, error } = await q;
  if (error) throw new Error(`countReplays: ${error.message}`);
  return count ?? 0;
}

/**
 * Plan a replay without executing it. Exposed so the HTTP route can return
 * a clean 400/409 to the Inspector instead of an opaque Inngest failure.
 *
 * `replayReason` defaults to 'operator' for legacy callers (the Inspector
 * HTTP route). Operator-driven replays count against MAX_REPLAYS_PER_RUN;
 * 'resume'/'auto-recover' count against MAX_NON_OPERATOR_REPLAYS_PER_RUN —
 * the cap split is so flaky machines / runner restarts don't burn the
 * operator's 5-shot debugging budget.
 */
export async function planReplay(args: {
  originalRunId: string;
  tenantId: string;
  fromStepIdx: number;
  replayReason?: ReplayReason;
}): Promise<{
  original: OriginalRun;
  steps: OriginalStep[];
  existingReplays: number;
}> {
  const supabase = supabaseService();
  const { data: original, error } = await supabase
    .from("runs")
    .select("id, tenant_id, agent_id, ticket_id, budget_cents, runner_kind, status")
    .eq("id", args.originalRunId)
    .maybeSingle();
  if (error) {
    throw new ReplayRefused("original-not-found", `lookup error: ${error.message}`);
  }
  if (!original) {
    throw new ReplayRefused("original-not-found", `original run ${args.originalRunId} not found`);
  }
  if (original.tenant_id !== args.tenantId) {
    // Treat cross-tenant as "not found" so we don't leak run existence.
    throw new ReplayRefused(
      "original-not-found",
      `original run ${args.originalRunId} not in tenant`,
    );
  }
  // Replay is only meaningful for finished runs. A still-running original
  // could mutate underneath us; gate it.
  if (original.status !== "done" && original.status !== "failed") {
    throw new ReplayRefused(
      "original-not-terminal",
      `original run ${args.originalRunId} has status=${original.status}; wait for terminal`,
    );
  }

  const { data: stepRows, error: stepErr } = await supabase
    .from("run_steps")
    .select("run_id, idx, kind, payload, created_at")
    .eq("run_id", args.originalRunId)
    .order("idx", { ascending: true });
  if (stepErr) {
    throw new ReplayRefused("step-clone-failed", `read steps: ${stepErr.message}`);
  }
  const steps = (stepRows ?? []) as OriginalStep[];
  // Bound fromStepIdx by the highest emitted idx + 1 — replaying from past
  // the last step is meaningless (nothing to resume).
  const maxIdx = steps.reduce((m, s) => Math.max(m, s.idx), -1);
  if (args.fromStepIdx < 0 || args.fromStepIdx > maxIdx + 1) {
    throw new ReplayRefused(
      "from-step-out-of-range",
      `fromStepIdx=${args.fromStepIdx} not in [0, ${maxIdx + 1}]`,
    );
  }

  const reason: ReplayReason = args.replayReason ?? "operator";
  if (reason === "operator") {
    const operatorCount = await countReplays(args.originalRunId, args.tenantId, {
      reason: "operator",
    });
    if (operatorCount >= MAX_REPLAYS_PER_RUN) {
      throw new ReplayRefused(
        "replay-cap-exceeded",
        `original ${args.originalRunId} has ${operatorCount} operator replays; cap=${MAX_REPLAYS_PER_RUN} (DEVPILOT_MAX_REPLAYS_PER_RUN)`,
      );
    }
  } else {
    // resume + auto-recover share a separate, much larger cap. Runaway
    // recovery (e.g. a flapping runner) still trips this circuit breaker.
    const recoveryCount = await countReplays(args.originalRunId, args.tenantId, {
      reasonIn: ["resume", "auto-recover"],
    });
    if (recoveryCount >= MAX_NON_OPERATOR_REPLAYS_PER_RUN) {
      throw new ReplayRefused(
        "auto-recover-cap-exceeded",
        `original ${args.originalRunId} has ${recoveryCount} recovery replays; cap=${MAX_NON_OPERATOR_REPLAYS_PER_RUN} (DEVPILOT_MAX_NON_OPERATOR_REPLAYS_PER_RUN)`,
      );
    }
  }

  // Total count for callers that just want to report a number (existing
  // contract). Keeps the return shape stable.
  const existingReplays = await countReplays(args.originalRunId, args.tenantId);
  return { original: original as OriginalRun, steps, existingReplays };
}

export const replayRun = inngest.createFunction(
  {
    id: "replay-run",
    retries: 1,
    concurrency: { limit: 4, key: "event.data.tenantId" },
  },
  { event: "agent/run.replay-requested" },
  async ({ event, step }) => {
    const { originalRunId, tenantId, fromStepIdx, overrides, replayReason } = event.data;
    const reason: ReplayReason = replayReason ?? "operator";

    // ── 1. Validate + cap check ────────────────────────────────────────
    const plan = await step.run("plan", async () =>
      planReplay({ originalRunId, tenantId, fromStepIdx, replayReason: reason }),
    );

    // ── 1b. Automation pause gate ────────────────────────────────────
    // Refuse replays while paused so the operator doesn't burn LLM spend
    // on a run whose first devpilot_move_ticket call would immediately re-skip
    // at the dispatcher. The replay can be re-fired manually after resume.
    const automationGate = await step.run("automation-gate", async () =>
      plan.original.ticket_id
        ? getEffectivePauseForTicket(tenantId, plan.original.ticket_id)
        : getEffectivePause(tenantId, null),
    );
    if (automationGate.paused) {
      throw new ReplayRefused("automation-paused", pauseRefusalMessage(automationGate));
    }

    // ── 2. Insert the new clone row (carries replay_of_run_id) ─────────
    const cloneRunId = await step.run("insert-clone", async () => {
      const supabase = supabaseService();
      const newId = randomUUID();
      const budgetCents = overrides?.budgetCentsOverride ?? plan.original.budget_cents;
      const { error } = await supabase.from("runs").insert({
        id: newId,
        tenant_id: plan.original.tenant_id,
        agent_id: plan.original.agent_id,
        ticket_id: plan.original.ticket_id,
        // DELIBERATELY do NOT set parent_run_id. See header.
        replay_of_run_id: plan.original.id,
        // Stamp the reason so `countReplays` can split operator vs recovery
        // caps. Persisted to runs.replay_reason (text + CHECK constraint
        // from 20260609000000_pause_resume_schema.sql).
        replay_reason: reason,
        budget_cents: budgetCents,
        spent_cents: 0,
        status: "running",
        depth: 0,
        // Per CLAUDE.md non-negotiable #1, the local Claude Code runner is
        // the default. Replays inherit the original run's runner; when the
        // original didn't record one, fall back to local-cc — not the
        // per-token API path.
        runner_kind: plan.original.runner_kind ?? "local-cc",
        last_event_at: new Date().toISOString(),
      });
      if (error) {
        throw new ReplayRefused("step-clone-failed", `insert clone: ${error.message}`);
      }
      return newId;
    });

    // ── 3. Copy run_steps 0..fromStepIdx-1 from the original ───────────
    //     Done in its own durable step so a partial copy retries cleanly.
    //     The unique (run_id, idx) constraint makes the copy idempotent on
    //     Inngest re-execution: re-running the same step is a no-op because
    //     all the target rows already exist (we use ON CONFLICT DO NOTHING).
    await step.run("copy-prior-steps", async () => {
      const toCopy = plan.steps.filter((s) => s.idx < fromStepIdx);
      if (toCopy.length === 0) return { copied: 0 };
      const supabase = supabaseService();
      const rows = toCopy.map((s) => ({
        run_id: cloneRunId,
        idx: s.idx,
        kind: s.kind,
        payload: {
          ...s.payload,
          // Breadcrumb so the inspector can dim or badge cloned context.
          replayed_from_run: plan.original.id,
          replayed_from_step_id_marker: true,
        },
        created_at: s.created_at,
      }));
      // upsert with onConflict so an Inngest retry of this step doesn't
      // double-insert (we'd hit the unique constraint otherwise).
      const { error } = await supabase
        .from("run_steps")
        .upsert(rows, { onConflict: "run_id,idx", ignoreDuplicates: true });
      if (error) {
        throw new ReplayRefused("step-clone-failed", `copy steps: ${error.message}`);
      }
      return { copied: rows.length };
    });

    // ── 4. Resolve role + prompts to feed the resumed agent loop ───────
    // Roll the role + modelTier forward from the original's recorded steps
    // (first role-stamped think step — matches `deriveRoleFromSteps` in
    // lib/runs/queries.ts). Originals that failed before persisting a step
    // have none, so fall back to the run row's agent (agents.role); a replay
    // must never lose the role, or postprocess and the reconciler can't
    // apply the role's ticket contract.
    //
    // System prompt: an operator override wins; otherwise reconstruct the
    // role config's system prompt through `composeRoleSystemPrompt` — the same
    // seam the dispatcher builds from, so a replayed run carries the role's
    // reviewer-awareness note exactly as the original did. That note only holds
    // when the original was ticket-bound, hence the `ticket_id` gate: replaying
    // a ticket-less run must not claim a QA review that can't happen.
    // (Installed-skill merge is deliberately skipped here — hence the empty
    // skill list: replays resume recorded work, and the skills seam lives on
    // the dispatch path.)
    //
    // Prompt: recorded step data wins as before; when nothing was recorded,
    // rebuild the ticket context instead of replaying a bare placeholder.
    const resumeContext = await step.run("resolve-resume-context", async () => {
      const seed = deriveSeedFromSteps(plan.steps);
      let role = seed.role;
      if (!role && plan.original.agent_id) {
        const supabase = supabaseService();
        const { data: agentRow } = await supabase
          .from("agents")
          .select("role")
          .eq("id", plan.original.agent_id)
          .maybeSingle();
        role = (agentRow?.role as string | null) ?? null;
      }
      const roleConfig = role
        ? (getBuiltinRoleConfig(role) ??
          (await loadCustomRoleConfig(plan.original.tenant_id, role)))
        : null;
      let ticketContextPrompt: string | null = null;
      if (plan.original.ticket_id) {
        try {
          const ctx = await buildTicketContext(plan.original.ticket_id, plan.original.tenant_id, {
            // Null when the original run's role cannot be resolved; role-scoped
            // lessons are then simply skipped (global + user still apply).
            roles: role ? [role] : [],
          });
          ticketContextPrompt = renderTicketPrompt(ctx);
        } catch (err) {
          console.warn(
            `[replay] buildTicketContext(${plan.original.ticket_id}) failed; falling back to recorded/placeholder prompt:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      // Phase 2 — the operator's overlay is a property of the ROLE, so a replay
      // of that role gets it too: a resumed run that silently dropped the
      // operator's standing instructions would behave differently from the run
      // it is resuming. Null when the original run's role cannot be resolved
      // (there is then no role to look one up for).
      const overlay = role ? await loadOverlayForDispatch(plan.original.tenant_id, role) : null;
      const { prompt, systemPrompt } = pickResumePrompts(plan.steps, fromStepIdx, overrides ?? {}, {
        roleSystemPrompt: roleConfig
          ? composeRoleSystemPrompt(roleConfig, [], Boolean(plan.original.ticket_id), overlay)
          : null,
        ticketContextPrompt,
      });
      return { role, prompt, systemPrompt, seedModelId: seed.modelId };
    });
    const { prompt, systemPrompt, seedModelId } = resumeContext;
    const role = resumeContext.role ?? undefined;
    const modelTier =
      overrides?.modelTierOverride ??
      (seedModelId?.includes("haiku")
        ? ("cheap" as const)
        : seedModelId?.includes("opus")
          ? ("heavy" as const)
          : ("default" as const));

    await step.sendEvent("emit-run-requested", {
      name: "agent/run.requested",
      data: {
        runId: cloneRunId,
        tenantId: plan.original.tenant_id,
        agentId: plan.original.agent_id ?? undefined,
        ticketId: plan.original.ticket_id ?? undefined,
        prompt,
        systemPrompt,
        iterations: REPLAY_ITERATIONS,
        modelTier,
        budgetCents: overrides?.budgetCentsOverride ?? plan.original.budget_cents,
        // Inherit the original runner; default to local-cc per CLAUDE.md.
        runnerPolicy: plan.original.runner_kind ?? "local-cc",
        role,
        // Resume the think-loop AT the replay point, not at idx 0.
        startIterationIdx: fromStepIdx,
      },
    });

    return {
      originalRunId,
      replayRunId: cloneRunId,
      fromStepIdx,
      copiedSteps: Math.min(fromStepIdx, plan.steps.length),
      existingReplays: plan.existingReplays + 1,
      cap: MAX_REPLAYS_PER_RUN,
    };
  },
);
