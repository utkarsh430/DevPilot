// Dispatcher — picks the next role for a ticket and kicks off its agent run.
//
// Phase 0: deterministic role selection from ticket state + comment history.
// (TDD §5.1 calls for a Haiku-classified Dispatcher; that comes when we have
// >3 roles. For PM/Engineer/QA the next role is unambiguous from state.)
//
// Phase 1 / M3 additions (this file):
//
//   - Agent materialization. Built-in roles (pm / engineer / qa) now exist as
//     `agents` rows per tenant (see 20260603000000_agents_materialization_wip.sql).
//     The dispatcher looks up the matching row and threads its id through the
//     `agent/run.requested` event so `runs.agent_id` is no longer always null.
//
//   - WIP limits. `agents.config.wip_limit` (default 3) caps the number of
//     concurrent {running, awaiting_human} runs per agent. Over-cap dispatches
//     are NOT emitted — instead the ticket stays in its current state and a
//     `system` comment records the deferral.
//
//   - Queue-on-WIP design choice: when a dispatch is deferred we DON'T enqueue
//     anything new (no `step.sleep` poller). Instead we rely on the existing
//     completion path: a separate Inngest function (`dispatchOnRunComplete`,
//     below) listens on `agent/run.completed` — emitted by `runAgent` when it
//     finishes — and re-issues `ticket/dispatch-needed` for any ticket whose
//     status implies it's still waiting on this role. This avoids long-lived
//     `step.sleep` calls (which churn billable steps) and pins re-tries to the
//     moment capacity actually frees up.
//
//     Two practical trade-offs:
//       (a) if NO sibling run is in flight (everything is already at the cap
//           AND the user manually fires a new dispatch), the ticket sits until
//           the next completion event. M3 acceptance keeps wip_limit=3, so the
//           password-reset scenario never hits this edge case.
//       (b) we re-scan all queued tickets for the role on every completion,
//           which is O(open-tickets-in-this-role). Cheap at MVP scale; we can
//           add a `dispatch_queue` table in M6 when the runner pool widens.
//
//   - Assignment modes (`agents.config.assignment_mode`).
//       'push' (default): dispatcher emits `agent/run.requested` directly.
//       'pull': dispatcher only marks the ticket `assignee_agent_id = agent.id`
//               and leaves it in `ready`. A future "claim" UI / poller picks
//               it up. M3 wires the field but the built-in roles default to
//               'push'; 'pull' is not exercised by the standard scenarios.

import { randomUUID } from "node:crypto";
import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { transitionTicket } from "@/lib/board/transitions";
import { addComment } from "@/lib/board/transitions";
import { enforceQaRetryCeiling } from "@/lib/board/qa-retry.server";
import { buildTicketContext, renderTicketPrompt } from "@/lib/roles/context";
import { ROLES, type Role } from "@/lib/roles/index";
import { getBuiltinRoleConfig, isBuiltinRole, loadCustomRoleConfig } from "@/lib/roles/load";
// Phase 1 / M11 — installed-skill selection for the role's systemPrompt at
// dispatch time. Kept as a separate, additive step.run so the rest of the
// dispatcher remains untouched and skill failures degrade to an empty skill
// list (selectSkillsForDispatch swallows its own errors). Composition below
// still applies the role's reviewer-awareness note, it just merges no fence.
import { selectSkillsForDispatch } from "@/lib/skills/select";
// The one seam every ticket-bound dispatch path shares (`hasTicket: true`
// here, since the dispatcher only ever runs a ticket). Never read
// `roleConfig.systemPrompt` directly; see AGENTS.md → Architecture.
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";
import { loadOverlayForDispatch } from "@/lib/roles/overlay.server";
import { env } from "@/lib/env";
import { cancelDispatchedAsStale, claimNext, enqueueDispatch } from "@/lib/engine/dispatch-queue";
import {
  DEFAULT_FAN_OUT_PHASE,
  DEFAULT_REVIEW_COHORT,
  parseAcceptanceStrategy,
  parseCohortPlan,
  planFanOut,
  selectCohortForDispatch,
  validateCohortPlan,
} from "@/lib/engine/fan-out";
// Phase 1 / M15 — billing gate. Refuse to emit `agent/run.requested` when
// the tenant's balance is negative AND they have no valid payment method.
// Implemented as a single additive `step.run("billing-gate")` block right
// after `decide-role`, BEFORE fan-out / single-emit logic. Refusal writes a
// system comment + returns; the existing dispatcher steps are untouched.
import { checkBillingGate } from "@/lib/billing/gate";
// Workspace/project automation pause gate. Either tenant or project being
// 'paused' short-circuits the dispatcher BEFORE any emit so the operator's
// "off switch" actually halts new work. In-flight runs are untouched.
import { getEffectivePause, getEffectivePauseForTicket } from "@/lib/engine/automation-state";
// Phase 2 / M5h — LLM-driven role classifier. Called from decideNextRole on
// the FIRST dispatch of a ticket that has no operator-supplied requested_role.
// Best-effort: on any failure the function returns { ok: false } and we fall
// through to the deterministic state machine.
//
// Phase 2.5++ / F2 — `classifyNextRole` is the sibling-on-every-dispatch
// classifier (specialist chaining + "done" detection). See its docblock for
// why it does NOT persist `tickets.requested_role`.
import { classifyNextRole, classifyTicketRoleIfNeeded } from "@/lib/engine/ticket-role-classifier";
import { DEFAULT_TEAM_TIER, clampRoleToTier, type TeamTier } from "@/lib/team-tiers/tiers";

const TERMINAL_TICKET_STATES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "blocked",
  "input_required",
]);

const DEFAULT_RUN_BUDGET_CENTS = Number(process.env.DEFAULT_RUN_BUDGET_CENTS ?? "500");
const DEFAULT_WIP_LIMIT = 3;
const DEFAULT_ASSIGNMENT_MODE: AgentAssignmentMode = "push";

type AgentAssignmentMode = "push" | "pull";

type AgentRow = {
  id: string;
  name: string;
  /** Free-form from M5 onward; matches `agents.role` text column. */
  role: string;
  wipLimit: number;
  assignmentMode: AgentAssignmentMode;
};

export const dispatcher = inngest.createFunction(
  {
    id: "ticket-dispatcher",
    retries: 2,
    concurrency: { limit: 4, key: "event.data.tenantId" },
  },
  { event: "ticket/dispatch-needed" },
  async ({ event, step }) => {
    const { ticketId, tenantId, forceRole } = event.data;

    // QA retry ceiling - the FIRST gate, before a role is even picked, so an
    // engineer↔QA reject loop that has burned its budget costs zero LLM spend.
    // `tickets.retry_count` is bumped on every QA reject but nothing compared it
    // to a maximum: the state machine below re-dispatches the engineer on
    // `retry_count > 0`, and the F2 loop-guard (G5) deliberately stands down for
    // exactly that signal - so the two roles could disagree forever. On
    // exhaustion the ticket is parked to `blocked` (a real loop exit) and a human
    // moving it back out resets the counter. See lib/board/qa-retry.ts.
    const retryCeiling = await step.run("qa-retry-ceiling", async () =>
      enforceQaRetryCeiling({ ticketId, tenantId }),
    );
    if (retryCeiling.parked) {
      return {
        ticketId,
        skipped: true,
        reason: "qa-retry-ceiling",
        retryCount: retryCeiling.retryCount,
        maxRetries: retryCeiling.maxRetries,
      };
    }

    const decision = await step.run("decide-role", async () =>
      decideNextRole(ticketId, tenantId, forceRole),
    );
    if (decision.role === null) {
      return { ticketId, skipped: true, reason: decision.reason };
    }

    // Phase 1 / M15 — billing gate. Refuse-and-comment if balance < 0 AND
    // no valid card. Phase 1 does not auto-resume on payment; the operator
    // manually re-fires `ticket/dispatch-needed` once the card is attached.
    const billingGate = await step.run("billing-gate", async () =>
      checkBillingGate({ tenantId, ticketId }),
    );
    if (billingGate.refused) {
      return {
        ticketId,
        skipped: true,
        reason: "billing-cutoff",
        balanceCents: billingGate.balanceCents,
        paymentMethodStatus: billingGate.paymentMethodStatus,
      };
    }

    // Automation pause gate. Workspace- or project-level "off switch" set
    // by the operator. When paused we silently skip the emit — the resume
    // server action fires `ticket/dispatch-needed` again for every still-
    // dispatchable ticket so this skip is recoverable.
    const automationGate = await step.run("automation-gate", async () =>
      getEffectivePauseForTicket(tenantId, ticketId),
    );
    if (automationGate.paused) {
      return {
        ticketId,
        skipped: true,
        reason: "automation-paused",
        pauseScope: automationGate.scope,
        wouldDispatchRole: decision.role,
      };
    }

    // Phase 1 / M6 — fan-out gate. If the ticket carries a non-'single'
    // acceptance_strategy AND we're at the fan-out trigger point (the role
    // the dispatcher would have picked is the cohort's "primary" role —
    // engineer in the canonical demo), emit N sibling events instead of one.
    //
    // Idempotency: the fan-out path stamps `tickets.fan_out_group` once and
    // refuses to re-fan if it's already set. The aggregator clears the row's
    // strategy when the cohort decides (so a follow-up "ready-again" doesn't
    // re-trigger fan-out).
    //
    // Runaway-shape guard: capped at MAX_FAN_OUT siblings. Refused with a
    // NonRetriable if the caller asks for more.
    const fanOutDecision = await step.run("decide-fan-out", async () =>
      decideFanOut(ticketId, tenantId, decision.role!),
    );
    if (fanOutDecision.kind === "fan-out") {
      const plan = fanOutDecision;

      // 1. Stamp the cohort uuid onto the ticket BEFORE emitting any events so
      //    a racing dispatcher invocation that gets here second sees the row
      //    already fanned out and abandons.
      //
      //    Legacy path (cohortKey === null): CAS on tickets.fan_out_group —
      //    same as M6. Only one cohort can ever exist per ticket so the
      //    column itself is the idempotency anchor.
      //
      //    Cohort-plan path (cohortKey !== null): each cohort is its own
      //    "instance" with its own fan_out_group. The ticket-level column is
      //    only stamped on the FIRST cohort (so legacy lookups still find
      //    something) and is not re-stamped on nested cohorts. Idempotency for
      //    subsequent cohorts is enforced by the pre-emit runs-exist check in
      //    decideFanOut and the fan_in_decisions(fan_out_group, phase) unique
      //    constraint after the cohort decides.
      await step.run("fan-out-stamp", async () => {
        const supabase = supabaseService();
        const { data: cur, error: readErr } = await supabase
          .from("tickets")
          .select("status, fan_out_group")
          .eq("id", ticketId)
          .single();
        if (readErr || !cur) {
          throw new NonRetriableError(`fan-out-stamp: ticket ${ticketId} not found`);
        }

        if (plan.cohortKey === null) {
          // Legacy path — strict CAS.
          if (cur.fan_out_group) {
            throw new NonRetriableError(
              `fan-out-stamp: ticket ${ticketId} already has fan_out_group=${cur.fan_out_group} — aborting duplicate fan-out`,
            );
          }
          const patch: Record<string, unknown> = {
            fan_out_group: plan.fanOutGroup,
          };
          if (cur.status === "ready") patch.status = "in_progress";
          const { data: updated, error: upErr } = await supabase
            .from("tickets")
            .update(patch)
            .eq("id", ticketId)
            .is("fan_out_group", null)
            .select("id");
          if (upErr) {
            throw new NonRetriableError(`fan-out-stamp: ${upErr.message}`);
          }
          if (!updated || updated.length === 0) {
            throw new NonRetriableError(
              `fan-out-stamp: lost race for ticket ${ticketId} — another invocation already fanned out`,
            );
          }
        } else {
          // Cohort-plan path. Transition ready → in_progress on the FIRST
          // cohort of the plan; stamp ticket.fan_out_group on the first cohort
          // only (so legacy realtime listeners still see something). Don't CAS
          // on it because nested cohorts must be allowed past the same column.
          const patch: Record<string, unknown> = {};
          if (cur.status === "ready") patch.status = "in_progress";
          if (!cur.fan_out_group) patch.fan_out_group = plan.fanOutGroup;
          if (Object.keys(patch).length > 0) {
            const { error: upErr } = await supabase
              .from("tickets")
              .update(patch)
              .eq("id", ticketId);
            if (upErr) {
              throw new NonRetriableError(`fan-out-stamp: ${upErr.message}`);
            }
          }
        }
      });

      const fanOutPrompt = await step.run("fan-out-build-context", async () => {
        // The cohort shares ONE rendered prompt, so every sibling role is in
        // scope for role-scoped lesson recall (`lib/learning/select.ts`).
        const ctx = await buildTicketContext(ticketId, tenantId, { roles: plan.cohort });
        return renderTicketPrompt(ctx);
      });

      // 2. Resolve each sibling role's config + materialized agent row.
      //    All non-pure work goes through step.run so replays serve the
      //    cached value — see comment below on runId determinism.
      type SiblingRecord = {
        role: string;
        runId: string;
        agentId: string | null;
        modelTier: (typeof ROLES)[Role]["modelTier"];
        runnerPolicy: (typeof ROLES)[Role]["runnerPolicy"];
        systemPrompt: string;
        onSuccessStatus: (typeof ROLES)[Role]["onSuccessStatus"];
        displayName: string;
      };

      // 2a. Cohort plan: resolve config + agent, mint runId, all atomically
      //     inside a single step.run so Inngest caches the EXACT runIds. Any
      //     code outside step.run re-executes on every Inngest invocation of
      //     the function, so a `randomUUID()` between step boundaries would
      //     produce DIFFERENT ids on replays — manifesting as ghost run rows
      //     (the bug we hit on M6 v1).
      const siblings = await step.run("fan-out-plan", async (): Promise<SiblingRecord[]> => {
        const out: SiblingRecord[] = [];
        for (const slug of plan.cohort) {
          const builtin = getBuiltinRoleConfig(slug);
          const config: (typeof ROLES)[Role] | null =
            builtin ?? (await loadCustomRoleConfig(tenantId, slug));
          if (!config) {
            throw new NonRetriableError(
              `fan-out: no RoleConfig for sibling slug "${slug}" — built-in miss and no agents.config.role_config`,
            );
          }
          const sibAgent = await loadAgent(tenantId, slug);
          out.push({
            role: slug,
            runId: randomUUID(),
            agentId: sibAgent?.id ?? null,
            modelTier: config.modelTier,
            runnerPolicy: config.runnerPolicy,
            systemPrompt: config.systemPrompt,
            onSuccessStatus: config.onSuccessStatus,
            displayName: config.displayName,
          });
        }
        return out;
      });

      // 3. Pre-seed run rows so the aggregator's "all sibling runs for this
      //    cohort" lookup works deterministically even on Inngest replays
      //    where the runAgent INIT step hasn't fired yet for one sibling.
      //    Stamps Phase 2.5 cohort attribution (cohort_key, cohort_depth,
      //    parent_run_id) when the fan-out came from a cohort_plan.
      await step.run("fan-out-seed-runs", async () => {
        const supabase = supabaseService();
        const rows = siblings.map((s) => ({
          id: s.runId,
          tenant_id: tenantId,
          agent_id: s.agentId ?? null,
          ticket_id: ticketId,
          parent_run_id: plan.parentRunId ?? null,
          budget_cents: DEFAULT_RUN_BUDGET_CENTS,
          spent_cents: 0,
          status: "running" as const,
          // Supervisor `depth` (M8) tracks recursion in the spawn tree.
          // Cohort fan-out without a parent run is depth 0; nested cohorts
          // attach to a parent leaf and bump depth by 1.
          depth: plan.parentRunId ? 1 : 0,
          runner_kind: s.runnerPolicy,
          last_event_at: new Date().toISOString(),
          fan_out_group: plan.fanOutGroup,
          fan_out_role: s.role,
          cohort_key: plan.cohortKey,
          cohort_depth: plan.cohortDepth,
        }));
        const { error: insErr } = await supabase.from("runs").upsert(rows, { onConflict: "id" });
        if (insErr) {
          throw new NonRetriableError(`fan-out-seed-runs: ${insErr.message}`);
        }
      });

      // Phase 1 / M11 — per-sibling skill merge. Each role's installed-skill
      // set may differ (skill `targets` lists narrow the selection by role),
      // so we re-run the cheap selector per sibling.
      // Phase 2 — the overlay is per-ROLE too, so it is read per sibling for
      // the same reason. A fan-out sibling carries no `agent_id` at all, which
      // is exactly why the overlay is keyed on the slug.
      const siblingPrompts = await step.run("fan-out-merge-skills", async () =>
        Promise.all(
          siblings.map(async (s) => {
            const [skills, overlay] = await Promise.all([
              selectSkillsForDispatch({
                tenantId,
                role: s.role,
                ticketText: fanOutPrompt,
              }),
              loadOverlayForDispatch(tenantId, s.role),
            ]);
            return {
              role: s.role,
              systemPrompt: composeRoleSystemPrompt(s, skills, true, overlay),
            };
          }),
        ),
      );
      const siblingPromptByRole = new Map(siblingPrompts.map((p) => [p.role, p.systemPrompt]));

      // 4. Emit N sibling agent/run.requested events in one Inngest step.
      await step.sendEvent(
        "fan-out-trigger-cohort",
        siblings.map((s) => ({
          name: "agent/run.requested" as const,
          data: {
            runId: s.runId,
            tenantId,
            agentId: s.agentId ?? undefined,
            ticketId,
            prompt: fanOutPrompt,
            systemPrompt: siblingPromptByRole.get(s.role) ?? s.systemPrompt,
            iterations: 1,
            modelTier: s.modelTier,
            runnerPolicy: s.runnerPolicy,
            budgetCents: DEFAULT_RUN_BUDGET_CENTS,
            role: s.role,
            agentDisplayName: s.displayName,
            fanOutGroup: plan.fanOutGroup,
            fanOutPhase: plan.phase,
            fanOutSize: siblings.length,
            acceptanceStrategy: plan.strategy,
            cohortKey: plan.cohortKey ?? undefined,
            cohortDepth: plan.cohortDepth,
            parentRunId: plan.parentRunId ?? undefined,
          },
        })),
      );

      return {
        ticketId,
        fannedOut: true,
        fanOutGroup: plan.fanOutGroup,
        strategy: plan.strategy,
        cohort: plan.cohort,
        cohortKey: plan.cohortKey,
        cohortDepth: plan.cohortDepth,
        parentRunId: plan.parentRunId,
        phase: plan.phase,
        runIds: siblings.map((s) => s.runId),
      };
    }

    // M5 — built-in fast path, then DB-backed custom role lookup. We resolve
    // the RoleConfig at dispatch time so the rest of the function can stay
    // synchronous around the config.
    const builtinRole = getBuiltinRoleConfig(decision.role);
    const role: (typeof ROLES)[Role] =
      builtinRole ??
      (await step.run("load-custom-role", async () => {
        const cfg = await loadCustomRoleConfig(tenantId, decision.role!);
        if (!cfg) {
          throw new NonRetriableError(
            `dispatcher: no RoleConfig for slug "${decision.role}" — built-in miss and no agents.config.role_config`,
          );
        }
        return cfg;
      }));

    // M3 — load the materialized agent row for this (tenant, role). Missing
    // rows fall back to the Phase 0 role-only path so a broken / un-migrated
    // tenant still makes forward progress.
    const agent = await step.run("load-agent", async () => loadAgent(tenantId, decision.role!));
    if (!agent) {
      console.warn(
        `[dispatcher] no agent row for tenant=${tenantId} role=${decision.role} — falling back to role-only event (run.agent_id will be null)`,
      );
    }

    // M3 — WIP gate. Only enforced when we have a materialized agent row.
    if (agent) {
      const wipCheck = await step.run("wip-check", async () => checkWipLimit(agent, tenantId));
      if (wipCheck.over) {
        // Phase 2 redesign — enqueue into `dispatch_queue` instead of the
        // earlier "comment-and-forget" no-op. The drain function
        // (`dispatchOnRunComplete` below) releases the queue when capacity
        // frees up. Idempotent: enqueue is a no-op if an entry for
        // (ticket, agent) is already pending.
        const enqueueResult = await step.run("wip-enqueue", async () =>
          enqueueDispatch({
            tenantId,
            ticketId,
            agentId: agent.id,
            priority: await readTicketPriority(ticketId),
            wipLimitSnapshot: agent.wipLimit,
            metadata: { source: "dispatcher", deferredAt: new Date().toISOString() },
          }),
        );
        if (enqueueResult.enqueued) {
          await step.run("wip-defer-comment", async () =>
            addComment({
              ticketId,
              tenantId,
              authorType: "system",
              authorId: "dispatcher",
              body:
                `${role.displayName} agent at WIP limit (${wipCheck.active}/${agent.wipLimit}). ` +
                `Queued (id=${enqueueResult.queueId.slice(0, 8)}); will release when a sibling run completes.`,
            }),
          );
        }
        return {
          ticketId,
          deferred: true,
          reason: "wip-limit",
          role: decision.role,
          agentId: agent.id,
          active: wipCheck.active,
          limit: agent.wipLimit,
          queued: enqueueResult.enqueued,
          queueId: enqueueResult.enqueued ? enqueueResult.queueId : null,
        };
      }
    }

    // M3 — assignment-mode fork.
    // 'pull' tags the ticket and stops; the user (or an MCP poller) self-claims.
    if (agent && agent.assignmentMode === "pull") {
      await step.run("pull-mark-ready", async () => {
        const supabase = supabaseService();
        const { data: cur } = await supabase
          .from("tickets")
          .select("status")
          .eq("id", ticketId)
          .single();
        const patch: Record<string, unknown> = { assignee_agent_id: agent.id };
        // Bring backlog → ready so a pull queue can see it.
        if (cur?.status === "backlog") patch.status = "ready";
        await supabase.from("tickets").update(patch).eq("id", ticketId);
      });
      return { ticketId, role: decision.role, agentId: agent.id, mode: "pull" };
    }

    const runId = await step.run("prepare-run", async () => {
      // Only move to in_progress when coming from "ready". QA (in_review) and
      // engineer-retry (already in_progress) stay where they are — the agent
      // run is conceptually orthogonal to ticket status at that point.
      const supabase = supabaseService();
      const { data: cur } = await supabase
        .from("tickets")
        .select("status")
        .eq("id", ticketId)
        .single();
      if (cur?.status === "ready") {
        await transitionTicket({
          ticketId,
          tenantId,
          to: "in_progress",
          // Dispatcher claiming a ready ticket for a run — engine-initiated,
          // not a `→ in_review`, ungated.
          actor: "system",
          emitDispatch: false,
          assigneeAgentId: agent?.id ?? null,
        });
      } else if (agent) {
        // Mid-flight transitions (e.g. QA on in_review) — stamp the assignee
        // so the inspector & drawer reflect who's working.
        await supabase.from("tickets").update({ assignee_agent_id: agent.id }).eq("id", ticketId);
      }
      return randomUUID();
    });

    const promptContext = await step.run("build-context", async () => {
      const ctx = await buildTicketContext(ticketId, tenantId, { roles: [decision.role!] });
      return renderTicketPrompt(ctx);
    });

    // Phase 1 / M11 — merge installed skill bodies into systemPrompt.
    // Phase 2 — plus the operator's overlay for this role, read in the SAME
    // step so it is checkpointed with the merge and a replay re-uses the exact
    // composed string rather than re-reading a row that may have changed.
    // Idempotent on Inngest replays (step.run caches the merged string).
    const systemPromptWithSkills = await step.run("merge-skills", async () => {
      const [skills, overlay] = await Promise.all([
        selectSkillsForDispatch({
          tenantId,
          role: decision.role!,
          ticketText: promptContext,
        }),
        loadOverlayForDispatch(tenantId, decision.role!),
      ]);
      return composeRoleSystemPrompt(role, skills, true, overlay);
    });

    await step.sendEvent("trigger-agent", {
      name: "agent/run.requested",
      data: {
        runId,
        tenantId,
        agentId: agent?.id,
        ticketId,
        prompt: promptContext,
        systemPrompt: systemPromptWithSkills,
        iterations: 1,
        modelTier: role.modelTier,
        runnerPolicy: role.runnerPolicy,
        budgetCents:
          env.LOCAL_CC_CONCURRENCY > 0 ? DEFAULT_RUN_BUDGET_CENTS : DEFAULT_RUN_BUDGET_CENTS,
        role: decision.role,
        agentDisplayName: role.displayName,
      },
    });

    return { ticketId, runId, role: decision.role, agentId: agent?.id ?? null };
  },
);

// ---------------------------------------------------------------------------
// Phase 2 — completion-driven WIP queue drain via `dispatch_queue`.
//
// Replaces the disabled-in-Wave-3 broadcast re-fan (kept verbatim in the
// commit history for reference). Contract:
//
//   • Triggered by `agent/run.completed` (both done and failed statuses).
//   • Only considers the (tenant, agent) pair of the completed run — no
//     unbounded re-scan of all open tickets.
//   • Claims AT MOST ONE pending row per invocation. Releasing more would
//     re-introduce the original runaway shape; one-per-completion is enough
//     to keep the queue moving because each released ticket eventually
//     triggers its own completion event.
//   • Verifies the agent has capacity NOW (the claimed run is already
//     status='done', so the same WIP count we use everywhere else applies).
//   • Verifies the ticket is still in a non-terminal state. If not, the
//     claimed row is marked cancelled rather than re-dispatched.
//   • Re-emits `ticket/dispatch-needed` for the released ticket. The
//     dispatcher will go through its normal path (WIP check, assignment
//     mode, agent/run.requested). If the WIP check trips again somehow
//     (race), the ticket re-enqueues idempotently.
//
// Concurrency limit of 1 per (tenantId, agentId) keyspace prevents two
// completions racing to claim two rows when only one capacity slot exists.

export const dispatchOnRunComplete = inngest.createFunction(
  {
    id: "dispatch-on-run-complete",
    retries: 1,
    concurrency: {
      limit: 1,
      // Serialise drains per (tenant, agent) — two concurrent runs of the
      // same agent completing simultaneously would otherwise both try to
      // claim the next row.
      key: 'event.data.tenantId + ":" + (event.data.agentId || "no-agent")',
    },
  },
  { event: "agent/run.completed" },
  async ({ event, step }) => {
    const { tenantId, agentId } = event.data;
    if (!agentId) {
      return { tenantId, drained: 0, skipped: "no-agent-id" };
    }

    // 1. Re-load the agent row to read the live WIP limit (config may have
    //    been edited between enqueue and now).
    const agent = await step.run("load-agent-for-drain", async () =>
      loadAgentById(tenantId, agentId),
    );
    if (!agent) {
      return { tenantId, agentId, drained: 0, skipped: "agent-row-missing" };
    }

    // 2. Capacity check. The just-completed run is already done/failed in
    //    the DB at this point, so the count reflects post-completion state.
    const wipCheck = await step.run("drain-wip-check", async () => checkWipLimit(agent, tenantId));
    if (wipCheck.over) {
      return {
        tenantId,
        agentId,
        drained: 0,
        skipped: "still-over-wip",
        active: wipCheck.active,
        limit: agent.wipLimit,
      };
    }

    // Workspace-level pause gate. We can't cheaply know the project for the
    // next queue entry yet (we haven't claimed it), so we only check the
    // tenant. The per-ticket dispatcher itself does the project check after
    // the redispatch, so a paused project still gets caught one hop later.
    const automationGate = await step.run("drain-automation-gate", async () =>
      getEffectivePause(tenantId, null),
    );
    if (automationGate.paused) {
      return {
        tenantId,
        agentId,
        drained: 0,
        skipped: "automation-paused",
      };
    }

    // 3. Atomic claim. SELECT FOR UPDATE SKIP LOCKED + UPDATE in one SQL
    //    statement — concurrent drains either get different rows or none.
    const claimed = await step.run("claim-next", async () => claimNext(tenantId, agentId));
    if (!claimed) {
      return { tenantId, agentId, drained: 0, skipped: "queue-empty" };
    }

    // 4. Ticket-still-relevant gate. The ticket may have moved to terminal
    //    state (cancelled manually, or QA approved a sibling) between
    //    enqueue and drain. If so, mark the claimed row cancelled and exit.
    const ticketStatus = await step.run("verify-ticket", async () =>
      readTicketStatus(claimed.ticketId),
    );
    if (ticketStatus === null) {
      await step.run("cancel-orphan", async () =>
        cancelDispatchedAsStale(claimed.queueId, "ticket-not-found"),
      );
      return {
        tenantId,
        agentId,
        drained: 0,
        skipped: "ticket-not-found",
        queueId: claimed.queueId,
      };
    }
    if (TERMINAL_TICKET_STATES.has(ticketStatus)) {
      await step.run("cancel-terminal", async () =>
        cancelDispatchedAsStale(claimed.queueId, `ticket-terminal:${ticketStatus}`),
      );
      return {
        tenantId,
        agentId,
        drained: 0,
        skipped: `ticket-terminal:${ticketStatus}`,
        queueId: claimed.queueId,
      };
    }

    // 5. Re-emit the dispatch event. Dispatcher will run through its normal
    //    path and emit agent/run.requested.
    await step.sendEvent("redispatch", {
      name: "ticket/dispatch-needed",
      data: { ticketId: claimed.ticketId, tenantId },
    });

    return {
      tenantId,
      agentId,
      drained: 1,
      ticketId: claimed.ticketId,
      queueId: claimed.queueId,
    };
  },
);

// ---------------------------------------------------------------------------
// Helpers

async function loadAgentById(tenantId: string, agentId: string): Promise<AgentRow | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, role, config")
    .eq("tenant_id", tenantId)
    .eq("id", agentId)
    .maybeSingle();
  if (error || !data) return null;
  const config = (data.config ?? {}) as Record<string, unknown>;
  const wipLimit =
    typeof config.wip_limit === "number" && Number.isFinite(config.wip_limit)
      ? (config.wip_limit as number)
      : DEFAULT_WIP_LIMIT;
  const assignmentModeRaw = config.assignment_mode;
  const assignmentMode: AgentAssignmentMode =
    assignmentModeRaw === "pull" ? "pull" : DEFAULT_ASSIGNMENT_MODE;
  return {
    id: data.id as string,
    name: data.name as string,
    role: data.role as Role,
    wipLimit,
    assignmentMode,
  };
}

async function readTicketStatus(ticketId: string): Promise<string | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("status")
    .eq("id", ticketId)
    .maybeSingle();
  if (error || !data) return null;
  return data.status as string;
}

async function readTicketPriority(ticketId: string): Promise<number> {
  const supabase = supabaseService();
  const { data } = await supabase
    .from("tickets")
    .select("priority")
    .eq("id", ticketId)
    .maybeSingle();
  const p = (data?.priority as number | null | undefined) ?? 3;
  return Number.isFinite(p) ? p : 3;
}

async function loadAgent(tenantId: string, role: string): Promise<AgentRow | null> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, role, config")
    .eq("tenant_id", tenantId)
    .eq("role", role)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const config = (data.config ?? {}) as Record<string, unknown>;
  const wipLimit =
    typeof config.wip_limit === "number" && Number.isFinite(config.wip_limit)
      ? (config.wip_limit as number)
      : DEFAULT_WIP_LIMIT;
  const assignmentModeRaw = config.assignment_mode;
  const assignmentMode: AgentAssignmentMode =
    assignmentModeRaw === "pull" ? "pull" : DEFAULT_ASSIGNMENT_MODE;
  return {
    id: data.id as string,
    name: data.name as string,
    role: data.role as string,
    wipLimit,
    assignmentMode,
  };
}

async function checkWipLimit(
  agent: AgentRow,
  tenantId: string,
): Promise<{ over: boolean; active: number }> {
  const supabase = supabaseService();
  // Tenant-scoped: this COUNT is the WIP gate. `runs`' member write policy pins
  // only the row's own `tenant_id`, never the `agent_id` it names, so unscoped a
  // hostile tenant could plant running rows against our agent, inflate the count
  // past `wipLimit`, and park every dispatch of ours in the queue indefinitely.
  const { count, error } = await supabase
    .from("runs")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agent.id)
    .eq("tenant_id", tenantId)
    .in("status", ["running", "awaiting_human"]);
  if (error) {
    // Fail open — better to dispatch and let the runner queue absorb than to
    // stall the whole loop because of a transient count error. The reaper
    // will catch true overshoots downstream.
    return { over: false, active: 0 };
  }
  const active = count ?? 0;
  return { over: active >= agent.wipLimit, active };
}

// `Role` widens to `string` from M5 onward (custom roles synthesized from a
// JD). The dispatcher trusts whatever slug it pulls from `tickets.requested_role`
// as long as either (a) it's a built-in slug, or (b) an agents row exists for
// (tenant, slug) carrying a `config.role_config`. The custom-config validation
// happens later in `loadCustomRoleConfig`; here we only need to know the slug
// could plausibly be honored.
type RoleSlug = string;
type RoleDecision = { role: RoleSlug; reason: string } | { role: null; reason: string };

async function customAgentExists(tenantId: string, slug: string): Promise<boolean> {
  const supabase = supabaseService();
  const { count, error } = await supabase
    .from("agents")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("role", slug);
  if (error) return false;
  return (count ?? 0) > 0;
}

// Phase 1 / M7 — cycle guard for conditional branching. Cap the number of
// times the dispatcher may route a single ticket via a `branches` map. The
// counter lives durably on `tickets.branch_hops` (incremented when the
// branch route is taken) so the cap survives Inngest replays and crashes.
//
// Why a dedicated counter (not piggy-backing on `tickets.retry_count`):
// retry_count is QA-reject semantics — bumping it on every branch hop would
// trip the QA retry ceiling and mask real QA-driven retries. branch_hops
// is independent and only the dispatcher writes it.
const MAX_BRANCH_HOPS = Number(process.env.DEVPILOT_MAX_BRANCH_HOPS ?? "4");

async function decideNextRole(
  ticketId: string,
  tenantId: string,
  forceRole?: string,
): Promise<RoleDecision> {
  const supabase = supabaseService();
  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("status, retry_count, requested_role, branch_hops")
    .eq("id", ticketId)
    .single();
  if (error || !ticket) {
    throw new NonRetriableError(`dispatcher: ticket ${ticketId} not found`);
  }

  // Phase 2.5 / M6 — transient forceRole hint from the fan-in aggregator.
  // When the aggregator decides a cohort whose `fan_in_role` is set, it
  // emits ticket/dispatch-needed with `forceRole = fan_in_role`. We honor
  // it once here (no persistence) and skip all other routing.
  //
  // Validation: same liveness check as requested_role — the slug must be a
  // built-in OR have an agents row for this tenant. Unknown slugs fall
  // through silently to the state machine; the operator sees the resulting
  // role pick in the inspector either way.
  if (forceRole) {
    const recognised = isBuiltinRole(forceRole) || (await customAgentExists(tenantId, forceRole));
    if (recognised) {
      return {
        role: forceRole,
        reason: `forceRole=${forceRole} (fan-in routing)`,
      };
    }
    console.warn(
      `[dispatcher] forceRole=${forceRole} unrecognised — falling through to state machine`,
    );
  }

  // M4 — explicit requested_role wins over the state machine. Acceptance
  // scripts set this to drive a specific new role; Phase 2's LLM classifier
  // writes here too. We only honor it the FIRST time (no prior comment from
  // that role's display name in the thread) so retries fall back to the
  // state machine.
  //
  // M5 — `requested_role` may name a CUSTOM role; honor it whenever either
  // (a) the slug is a built-in OR (b) an agents row exists for the tenant
  // with that slug. The runtime config check (does `config.role_config`
  // actually resolve?) happens later in the dispatcher's `load-custom-role`
  // step — failing that step turns into a NonRetriable, which marks the run
  // failed and is visible in the inspector.
  // Tenant-scoped: these author ids drive the role decision, so a planted
  // comment on our ticket would steer which role we dispatch next.
  const { data: comments } = await supabase
    .from("comments")
    .select("author_type, author_id")
    .eq("ticket_id", ticketId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  const agentAuthors = (comments ?? [])
    .filter((c) => c.author_type === "agent")
    .map((c) => c.author_id.toLowerCase());

  // Slice B — human-reply resume signal. When the most-recent comment is from
  // a human (typically the operator answering a `devpilot_request_human` /
  // `devpilot_request_secret` ask), the input_required → in_progress transition has
  // just fired and the dispatcher should resume to the asking role even when
  // the F2 loop-guard would otherwise block (priorCountForPick >= 2 with no
  // retry_count signal). A human reply is a legitimate fresh signal that the
  // loop wasn't mechanical role-chaining — it was a real input wait. See
  // `apps/web/app/(app)/board/actions.ts:postCommentAction` for the emit-side
  // pairing and §B of the plan for the full rationale.
  const lastCommentAuthorType =
    (comments ?? []).length > 0 ? (comments ?? [])[(comments ?? []).length - 1]?.author_type : null;
  const humanReplyResume = lastCommentAuthorType === "human";

  const requested = (ticket.requested_role ?? null) as string | null;

  // Phase 2 / M5h — if no requested_role AND this is the truly first
  // dispatch (no agent comments yet) AND the ticket is in a pre-PM state,
  // try the LLM classifier. It writes `requested_role` directly; we then
  // short-circuit with the classified role and the dispatcher honors it
  // exactly as it would an operator-supplied pick.
  if (
    !requested &&
    agentAuthors.length === 0 &&
    (ticket.status === "backlog" || ticket.status === "ready")
  ) {
    const classified = await classifyTicketRoleIfNeeded({
      ticketId,
      tenantId,
    });
    if (classified.ok) {
      return {
        role: classified.slug,
        reason: `classifier picked ${classified.slug}`,
      };
    }
    // On any failure (or "already-set" / "past-first-dispatch"), fall
    // through to the state machine. The classifier never throws.
  }

  if (requested) {
    const recognised = isBuiltinRole(requested) || (await customAgentExists(tenantId, requested));
    if (recognised) {
      const alreadyRan = agentAuthors.includes(requested.toLowerCase());
      if (!alreadyRan && ticket.status !== "in_review") {
        return { role: requested, reason: `requested_role=${requested}` };
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 2.5++ / F2 — classifier-on-every-dispatch.
  //
  // The Haiku classifier now runs on every dispatch (not just the truly first
  // one) so specialist roles can chain naturally. Example: a security_engineer
  // first dispatch is no longer followed by a forced engineer/qa loop —
  // instead the classifier sees the security_engineer's prior comment and can
  // legitimately pick qa, or another specialist, or "done".
  //
  // The state machine below remains intact as a SAFETY NET for two cases:
  //   (a) the classifier fails (Haiku 5xx, network blip, etc.), or
  //   (b) the classifier returns an unknown slug we can't honor.
  //
  // Precedence (rooted in why each gate exists):
  //   • forceRole          — handled above; transient fan-in override.
  //   • first-dispatch     — handled above; persists requested_role.
  //   • requested_role     — handled above; honored once (operator pick / first-class).
  //   • F2 every-dispatch  — THIS BLOCK.
  //   • M7 branch routing  — handled below; explicit role.branches map.
  //   • state machine      — handled below; safety-net for pm/engineer/qa.
  //
  // Escape hatch: `DEVPILOT_CLASSIFIER_ON_EVERY_DISPATCH=0` disables this block at
  // the env level for an emergency rollback. Default is ON.
  //
  // No new lock needed — the dispatcher is already concurrency-keyed per
  // ticket (tenantId), and `classifyNextRole` does NOT persist anything.
  const everyDispatchClassifierEnabled = process.env.DEVPILOT_CLASSIFIER_ON_EVERY_DISPATCH !== "0";
  const ticketStatusStr = String(ticket.status);
  if (
    everyDispatchClassifierEnabled &&
    agentAuthors.length > 0 &&
    ticketStatusStr !== "done" &&
    ticketStatusStr !== "failed"
  ) {
    const classified = await classifyNextRole({ ticketId, tenantId });
    if (classified.ok) {
      if (classified.pick === "done") {
        return {
          role: null,
          reason: `classifier-done: ${classified.reasoning.slice(0, 200)}`,
        };
      }
      const picked = classified.pick;
      const recognised = isBuiltinRole(picked) || (await customAgentExists(tenantId, picked));
      if (recognised) {
        // Phase 2.5++ / G5 — dispatcher loop-guard. Even with the F2 prompt
        // hardening (concrete per-role counts + HARD RULES), Haiku has been
        // observed to occasionally pick the same role 3+ times in a row
        // (e.g. PM → Engineer → Engineer → Engineer on 00df7de9). This is a
        // hard defensive gate: if the picked role already has >=2 prior
        // comments AND there's no QA-reject retry signal on the ticket, we
        // refuse to honour the F2 pick and fall through to the M7 branch /
        // state-machine path below. retry_count > 0 is the canonical
        // QA-rejected signal (transitionTicket bumps it on QA "needs_changes").
        //
        // Slice B — `humanReplyResume` is a second canonical fresh-signal:
        // the operator just answered a `devpilot_request_human` /
        // `devpilot_request_secret` ask, so resuming to the asking role (even after
        // 2+ prior comments) is the correct behaviour, not a mechanical loop.
        const pickLc = picked.toLowerCase();
        const priorCountForPick = agentAuthors.filter((a) => a === pickLc).length;
        const retryCount = (ticket.retry_count as number | null) ?? 0;
        // Terminal-equals-current guard. The picked role's only successful
        // exit is `devpilot_move_ticket(onSuccessStatus)`; if onSuccessStatus is
        // the state the ticket is ALREADY in (typically because a sibling
        // role advanced it ahead of us), the run will dead-end with
        // `invalid ticket transition: X → X` after burning LLM spend.
        // Symmetric to the requested_role guard at L913 (in_review only),
        // but generalised via the role config so custom roles benefit too.
        // Fall through to the state machine, which maps the current status
        // to the correct next role (e.g. in_review → qa).
        const pickedConfig =
          getBuiltinRoleConfig(picked) ?? (await loadCustomRoleConfig(tenantId, picked));
        const terminalEqualsCurrent =
          !!pickedConfig && (pickedConfig.onSuccessStatus as string) === ticketStatusStr;
        if (terminalEqualsCurrent) {
          console.warn(
            `[dispatcher] F2 picked "${picked}" but ticket is already at ${ticketStatusStr} (== role's onSuccessStatus) — falling through to state machine`,
          );
          // Skip the F2 honour, fall through to M7 + state-machine.
        } else if (priorCountForPick >= 2 && retryCount === 0 && !humanReplyResume) {
          console.warn(
            `[dispatcher] F2 picked "${picked}" which has ${priorCountForPick} prior comments and no retry signal — falling through to state machine`,
          );
          // Skip the F2 honour, fall through to M7 + state-machine.
        } else {
          return {
            role: picked,
            reason: humanReplyResume
              ? `classifier-pick: ${picked} (human-reply resume bypasses loop-guard; ${classified.reasoning.slice(0, 160)})`
              : `classifier-pick: ${picked} (${classified.reasoning.slice(0, 200)})`,
          };
        }
      } else {
        console.warn(
          `[dispatcher] classifier-pick="${picked}" not recognised (no built-in, no agents row) — falling through`,
        );
      }
    }
    // On {ok:false} (including "no-history-use-first-dispatch-classifier",
    // which shouldn't trip here because we gated on agentAuthors.length > 0,
    // but is harmless if it does) fall through to branch routing + state
    // machine below. classifyNextRole never throws.
  }

  // Phase 1 / M7 — conditional-branching gate. Before falling through to the
  // state machine, check whether the most recent completed run on this
  // ticket carried a `branch_key`. If yes AND the run's role declared a
  // matching `branches` map AND we're under the cycle-hop ceiling, route to
  // `branches[branch_key]`.
  //
  // Cycle guard: `tickets.branch_hops` caps total branch routes per ticket
  // at MAX_BRANCH_HOPS (default 4). Beyond that we ignore branch routing
  // and fall back to the state machine — the ticket either lands in the
  // normal QA loop or gets stuck and the human escalation path opens.
  //
  // Graceful-degradation contract (spec): a missing branch_key, an unknown
  // role for the run, or an unknown branch key in the role's map all fall
  // through to the state machine. We log loudly but never throw.
  const hops = (ticket.branch_hops as number | null) ?? 0;
  if (hops < MAX_BRANCH_HOPS) {
    const branchRouting = await resolveBranchRoute(ticketId, tenantId);
    if (branchRouting) {
      // Idempotency: stamp the branch hop counter forward so a replay of the
      // dispatcher (which re-runs decideNextRole) doesn't double-count. We
      // increment here rather than at emit time so the durable counter
      // tracks "the dispatcher decided to route via branches" — emission
      // failures don't roll back the count, which is the safer direction
      // for a cycle guard. A double-step on the counter is harmless; a
      // missed step would let a loop slip through.
      //
      // We also clear the source run's branch_key (consumeBranchRoute) so a
      // single Inngest replay of the dispatcher step doesn't re-route on
      // the same signal — the partial index drops the row from the lookup.
      await consumeBranchRoute(branchRouting.prevRunId);
      await supabase
        .from("tickets")
        .update({ branch_hops: hops + 1 })
        .eq("id", ticketId);
      return {
        role: branchRouting.targetRole,
        reason: `branch ${branchRouting.branchKey} → ${branchRouting.targetRole} (hop ${hops + 1}/${MAX_BRANCH_HOPS}, from ${branchRouting.fromRole})`,
      };
    }
  } else {
    // Soft warning — the dispatcher continues to the state machine. The
    // ticket isn't broken, but the branching loop is suspected.
    console.warn(
      `[dispatcher] ticket ${ticketId} hit MAX_BRANCH_HOPS=${MAX_BRANCH_HOPS} — falling back to state machine to break suspected cycle`,
    );
  }

  const hasPm = agentAuthors.includes("pm");
  const hasEngineer = agentAuthors.includes("engineer");

  if (ticket.status === "in_review") return { role: "qa", reason: "ticket in_review" };
  // Bounded by the `qa-retry-ceiling` step at the top of the dispatcher: a ticket
  // whose retry_count reached the ceiling is parked to `blocked` before we ever
  // get here, so this rule (and the G5 bypass above, which stands down whenever
  // retry_count > 0) can no longer chain engineer retries forever.
  if (ticket.status === "in_progress" && (ticket.retry_count ?? 0) > 0) {
    return { role: "engineer", reason: `engineer retry (retry_count=${ticket.retry_count})` };
  }
  // Slice B — safety-net resume after a human reply. Reached only when the F2
  // classifier returned {ok:false} (Haiku 5xx / network blip / unrecognised
  // slug) AND the prior rules didn't claim the ticket. We resume to the most
  // recent agent author — the role that was actually mid-flight when the
  // input was requested. Without this rule the dispatcher returns
  // {role: null} and the ticket hangs in `in_progress` forever.
  if (ticket.status === "in_progress" && humanReplyResume && agentAuthors.length > 0) {
    const lastAgent = agentAuthors[agentAuthors.length - 1]!;
    return {
      role: lastAgent,
      reason: `state-machine: resume to last agent (${lastAgent}) after human reply`,
    };
  }
  if (ticket.status === "ready" && !hasPm)
    return { role: "pm", reason: "needs initial refinement" };
  if (ticket.status === "ready" && hasPm && !hasEngineer) {
    return { role: "engineer", reason: "refined; engineer next" };
  }
  return {
    role: null,
    reason: `no role applies for status=${ticket.status} hasPm=${hasPm} hasEng=${hasEngineer}`,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 / M7 — branch-routing helpers.

type BranchRouting = {
  /** The role slug of the run that emitted the branch signal. */
  fromRole: string;
  /** The parsed branch key (e.g. "small_change"). */
  branchKey: string;
  /** Resolved next-role slug from the from-role's `branches` map. */
  targetRole: string;
  /** Run id whose branch_key we should clear after consuming. */
  prevRunId: string;
};

/**
 * Look at the most recent completed run on this ticket carrying a branch_key.
 * Resolve the from-role's RoleConfig and map the branch key to the target
 * role. Returns null on any failure (no run, no key, unknown role, unknown
 * key) — the dispatcher then falls back to the state machine.
 */
async function resolveBranchRoute(
  ticketId: string,
  tenantId: string,
): Promise<BranchRouting | null> {
  const supabase = supabaseService();
  // Most recent run for this ticket carrying a non-null branch_key. The
  // partial index `runs_ticket_branch_key_idx` covers this query.
  //
  // Tenant-scoped, and this one is sharp: the row that wins this
  // `last_event_at DESC` race decides WHICH BRANCH the next agent is routed
  // onto. A planted `{tenant_id: them, ticket_id: <our ticket>, branch_key: …}`
  // row would pick the branch our engineer works on.
  const { data: runs, error } = await supabase
    .from("runs")
    .select("id, status, branch_key, fan_out_role, agent_id")
    .eq("ticket_id", ticketId)
    .eq("tenant_id", tenantId)
    .not("branch_key", "is", null)
    .order("last_event_at", { ascending: false })
    .limit(1);
  if (error || !runs || runs.length === 0) return null;
  const run = runs[0];
  if (!run) return null;
  const branchKey = run.branch_key as string | null;
  if (!branchKey) return null;

  // Resolve the from-role. We try, in order:
  //   1. fan_out_role on the run (set on sibling runs / role-tagged runs)
  //   2. agent's role column via agent_id
  // The dispatcher's `agent/run.requested` emit set `role` on the event but
  // run-agent.ts persists agent_id on the row (no `role` column on runs in
  // Phase 0 schema). We resolve via the agent row to read its role.
  let fromRole: string | null = (run.fan_out_role as string | null) ?? null;
  if (!fromRole && run.agent_id) {
    const { data: agent } = await supabase
      .from("agents")
      .select("role")
      .eq("id", run.agent_id as string)
      .maybeSingle();
    fromRole = (agent?.role as string | null) ?? null;
  }
  if (!fromRole) return null;

  const config = getBuiltinRoleConfig(fromRole);
  if (!config?.branches) return null;
  const targetRole = config.branches[branchKey];
  if (!targetRole) return null;

  // Team-tier clamp. If the from-role's branch points at a specialist the
  // active tier doesn't permit (e.g. engineer.branches.security ->
  // security_engineer on a Quick-tier project), rewrite to the tier's
  // generalist so handoffs stay inside the chosen roster. Unrestricted
  // tiers (Thorough) and already-allowed targets are no-ops.
  const tier = await loadTeamTierForTicket(ticketId);
  const clampedTarget = clampRoleToTier(tier, targetRole);

  return {
    fromRole,
    branchKey,
    targetRole: clampedTarget,
    prevRunId: run.id as string,
  };
}

/**
 * Resolve a ticket's effective team tier via its project. Falls back to the
 * default tier if the ticket has no project (legacy rows) or the join misses.
 */
async function loadTeamTierForTicket(ticketId: string): Promise<TeamTier> {
  const supabase = supabaseService();
  const { data: ticketRow } = await supabase
    .from("tickets")
    .select("project_id")
    .eq("id", ticketId)
    .maybeSingle();
  const projectId = (ticketRow?.project_id as string | null | undefined) ?? null;
  if (!projectId) return DEFAULT_TEAM_TIER;
  const { data: projectRow } = await supabase
    .from("projects")
    .select("team_tier")
    .eq("id", projectId)
    .maybeSingle();
  return (projectRow?.team_tier as TeamTier | null | undefined) ?? DEFAULT_TEAM_TIER;
}

/**
 * Clear the branch_key on the run row we just routed off. Two-fold purpose:
 *   - prevents an Inngest replay of the dispatcher from re-routing on the
 *     same signal (double cycle-counter bump);
 *   - keeps the partial index lean — only un-consumed signals stay indexed.
 */
async function consumeBranchRoute(runId: string): Promise<void> {
  const supabase = supabaseService();
  await supabase.from("runs").update({ branch_key: null }).eq("id", runId);
}

// ---------------------------------------------------------------------------
// Phase 1 / M6 — fan-out helpers.
//
// Trigger contract
// ────────────────
// • Only the FIRST engineer dispatch on a ticket fans out. (When the
//   deterministic role decision is "engineer" AND the ticket has no prior
//   engineer comment.)
// • Only triggers when `tickets.acceptance_strategy` is 'all' or 'quorum(n)'.
// • If `tickets.fan_out_group` is already set, the cohort already fanned out
//   for this ticket — fall through to the single-emit path. Re-triggering
//   would re-spawn siblings and is the textbook runaway shape we're guarding
//   against.
//
// Cohort plan
// ───────────
// Hard-coded to {engineer, security} for the canonical demo. A future LLM
// classifier (Phase 2) will choose the cohort per-ticket; the dispatcher
// hands the plan list into `emitFanOutCohort` so swapping the source is a
// one-line change.

type FanOutDecision =
  | { kind: "no-fan-out"; reason: string }
  | {
      kind: "fan-out";
      reason: string;
      strategy: string;
      cohort: ReadonlyArray<string>;
      fanOutGroup: string;
      // Phase 2.5 / M6 — cohort plan attribution. Set when this fan-out comes
      // from a `tickets.cohort_plan`; null on the legacy single-cohort path.
      // The dispatcher stamps these onto each seeded run row.
      cohortKey: string | null;
      cohortDepth: number;
      /** Set on nested cohorts: id of the leaf run that triggered this child. */
      parentRunId: string | null;
      /** Phase label for the fan_in_decisions ledger. cohort_key when present;
       *  DEFAULT_FAN_OUT_PHASE otherwise. */
      phase: string;
    };

async function decideFanOut(
  ticketId: string,
  tenantId: string,
  deterministicRole: string,
): Promise<FanOutDecision> {
  const supabase = supabaseService();
  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("acceptance_strategy, fan_out_group, status, cohort_plan")
    .eq("id", ticketId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !ticket) {
    return { kind: "no-fan-out", reason: "ticket-not-found" };
  }

  // Phase 2.5 / M6 — multi-stage cohort plan path. Takes precedence over the
  // legacy single-cohort path when `tickets.cohort_plan` is non-null.
  //
  // Walk:
  //   1. parseCohortPlan — graceful fallback on shape errors.
  //   2. validateCohortPlan — NonRetriable on semantic errors (caps, cycles).
  //   3. Read which cohorts are already decided for this ticket (their
  //      fan_in_decisions rows). selectCohortForDispatch picks the next one.
  //   4. If a cohort fires, emit it (caller side). Otherwise, fall through to
  //      the legacy path.
  //
  // Idempotency hand-off: cohort fan-out idempotency is enforced by the same
  // `fan_in_decisions(fan_out_group, phase)` unique constraint as the legacy
  // path — we use `phase = cohort_key` so each cohort instance has its own
  // ledger row. The pre-emit "is there already a run for (ticket, cohort_key)?"
  // check below catches dispatcher replays before fan_out_group is even minted.
  const cohortPlan = parseCohortPlan(ticket.cohort_plan);
  if (cohortPlan) {
    // Semantic validation — caps, cycles, dangling refs. Throws on bad plan.
    const depths = validateCohortPlan(cohortPlan, NonRetriableError);

    // Which cohorts have already been decided on this ticket?
    const { data: decisions } = await supabase
      .from("fan_in_decisions")
      .select("phase")
      .eq("tenant_id", tenantId)
      .eq("ticket_id", ticketId);
    const completedCohortKeys = new Set<string>(
      (decisions ?? []).map((d) => (d.phase as string) ?? ""),
    );

    const picked = selectCohortForDispatch(cohortPlan, completedCohortKeys, deterministicRole);
    if (picked) {
      // Pre-emit idempotency: a replay of the dispatcher must not re-seed a
      // cohort that already has runs in flight. Check the partial index path:
      // any rows in `runs` for (tenant, ticket, cohort_key) means the seed
      // happened — abandon.
      const { count: existingCount } = await supabase
        .from("runs")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("ticket_id", ticketId)
        .eq("cohort_key", picked.cohort_key);
      if ((existingCount ?? 0) > 0) {
        return {
          kind: "no-fan-out",
          reason: `cohort ${picked.cohort_key} already seeded (${existingCount} runs)`,
        };
      }
      const cohortDepth = depths.get(picked.cohort_key) ?? 0;

      // For nested cohorts: parent_run_id is the just-completed leaf whose
      // role == this cohort's trigger_role. Look it up.
      let parentRunId: string | null = null;
      if (picked.parent_cohort_key !== null) {
        const { data: leaves } = await supabase
          .from("runs")
          .select("id, fan_out_role, last_event_at")
          .eq("tenant_id", tenantId)
          .eq("ticket_id", ticketId)
          .eq("cohort_key", picked.parent_cohort_key)
          .eq("fan_out_role", picked.trigger_role)
          .order("last_event_at", { ascending: false })
          .limit(1);
        parentRunId = ((leaves ?? [])[0]?.id as string | undefined) ?? null;
      }

      return {
        kind: "fan-out",
        reason: `cohort_plan picked ${picked.cohort_key} (depth=${cohortDepth}) trigger=${picked.trigger_role} members=[${picked.members.join(",")}]`,
        strategy: picked.acceptance_strategy,
        cohort: picked.members,
        fanOutGroup: randomUUID(),
        cohortKey: picked.cohort_key,
        cohortDepth,
        parentRunId,
        phase: picked.cohort_key,
      };
    }
    // Plan exists but no cohort fires now — fall through to legacy path.
    // This preserves back-compat for tickets that have both a cohort_plan
    // and the legacy acceptance_strategy != 'single' (the builder emits
    // both for single-cohort case).
  }

  // ── Legacy M6 single-cohort path (back-compat) ───────────────────────
  // Only engineer-first dispatches fan out. QA, retries, PM, and the four M4
  // roles all stay on the single-emit path.
  if (deterministicRole !== "engineer") {
    return { kind: "no-fan-out", reason: `role=${deterministicRole} not a fan-out trigger` };
  }

  const strategy = parseAcceptanceStrategy(ticket.acceptance_strategy as string | null);
  if (strategy.kind === "single") {
    return { kind: "no-fan-out", reason: "strategy=single" };
  }

  // Idempotency: if fan_out_group is already stamped on the ticket the cohort
  // already exists. Re-emitting would re-fan and re-spawn siblings — exactly
  // the 2026-06-02 runaway shape (see SESSION_HANDOFF.md §8b).
  if (ticket.fan_out_group) {
    return {
      kind: "no-fan-out",
      reason: `already-fanned-out group=${(ticket.fan_out_group as string).slice(0, 8)}`,
    };
  }

  const cohort = DEFAULT_REVIEW_COHORT;
  const plan = planFanOut(cohort);
  if (!plan.ok) {
    // Cap violation — refuse loudly so the operator notices. NonRetriable
    // marks the dispatcher invocation failed; the ticket stays where it is.
    throw new NonRetriableError(
      `dispatcher: fan-out cohort rejected by MAX_FAN_OUT guard — ${plan.reason}`,
    );
  }

  return {
    kind: "fan-out",
    reason: `strategy=${ticket.acceptance_strategy} cohort=[${cohort.join(",")}]`,
    strategy: ticket.acceptance_strategy as string,
    cohort,
    fanOutGroup: randomUUID(),
    cohortKey: null,
    cohortDepth: 0,
    parentRunId: null,
    phase: DEFAULT_FAN_OUT_PHASE,
  };
}
