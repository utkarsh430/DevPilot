// Phase 2.5+ / M7 (REVISION 2026-06-04) — Plan-mode durable functions.
//
// Four functions, registered in apps/web/app/api/inngest/route.ts:
//
//   • planLeadReplyFn — `plan/lead-reply.requested`. Generates the lead's
//     next reply in a discussion. Every ~2 user turns, also fires the
//     Haiku goal_summary updater (M5h pattern) via the same runner bridge.
//   • planPanelStepFn — `plan/panel-step.requested`. One panel agent
//     (PM / Tech Lead / DevOps) per invocation. Inserts a start + done
//     system pill so the UI can flip the progress indicator.
//   • planConsolidatorFn — `plan/consolidator.requested`. Merges the
//     three panel drafts, Zod-validates, persists
//     planning_proposed_tickets, transitions session → 'planned'.
//   • planBuildOrchestratorFn — `plan/build-orchestrator.requested`.
//     Fans out the three panel steps via step.invoke in Promise.all,
//     then invokes the consolidator. One durable pipeline.
//
// All four go through `invokePlannerRunner` in lib/plan/runner-bridge.ts
// — never directly call `@ai-sdk/anthropic` from here.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { costCents } from "@/lib/llm/cost";
import { MODEL_IDS } from "@/lib/llm/models";
import { assertCanProceedPlan, recordPlanSessionSpend } from "@/lib/engine/budget";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import {
  CONSOLIDATOR_PROMPT,
  GOAL_SUMMARY_PROMPT,
  LEAD_SYSTEM_PROMPT,
  PANEL_DEVOPS_PROMPT,
  PANEL_PM_PROMPT,
  PANEL_TECH_LEAD_PROMPT,
  type PanelDraft,
  type PromptContext,
  type StackFlavor,
} from "@/lib/plan/prompts";
import {
  clampRoleToTier,
  getMaxTicketsForTier,
  resolveEffectiveTier,
  type TeamTier,
} from "@/lib/team-tiers/tiers";
import { toProjectType } from "@/lib/projects/project-type";
import { DEFAULT_ECOSYSTEM, isEcosystemChoice } from "@/lib/stack/rank";
import {
  invokePlannerRunner,
  safeParseJsonBlock,
  type PlannerStep,
} from "@/lib/plan/runner-bridge";
import { getGithubTokenRow } from "@/lib/github/oauth";
import { fetchRawFile } from "@/lib/github/raw";
import { loadProjectStackTags } from "@/lib/stack/persist.server";
import { publishNotification } from "@/lib/notifications/publish";

// ─── shared schemas + helpers ──────────────────────────────────────────────

const ROLE_SLUG_SET = new Set(ROLE_CATALOG.map((e) => e.slug));
const ROLE_SLUGS = ROLE_CATALOG.map((e) => e.slug) as [string, ...string[]];

const ProposedTicketSchema = z.object({
  title: z.string().min(3).max(160),
  description: z.string().min(1).max(4_000),
  acceptance_criteria: z.string().min(1).max(4_000),
  requested_role: z.enum(ROLE_SLUGS),
  depends_on_ordinals: z.array(z.number().int().positive()).max(20),
});

const ProposedTicketsObjectSchema = z.object({
  proposedTickets: z.array(ProposedTicketSchema).min(1).max(50),
});

const GoalSummarySchema = z.object({
  goal_summary: z.string().min(1).max(160),
});

const EST_CENTS = {
  leadReply: 4,
  goalSummary: 1,
  panelDraft: 6,
  consolidator: 8,
} as const;

type SessionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  created_by: string | null;
  status: string;
  stack_flavor: StackFlavor;
  stack_preferences: string;
  goal_summary: string | null;
  /** Per-plan tier override. Null = inherit from the project's default. */
  team_tier: TeamTier | null;
};

async function loadSession(sessionId: string): Promise<SessionRow> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_sessions")
    .select(
      "id, tenant_id, project_id, created_by, status, stack_flavor, stack_preferences, goal_summary, team_tier",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (error) {
    throw new NonRetriableError(`loadSession ${sessionId}: ${error.message}`);
  }
  if (!data) {
    throw new NonRetriableError(`loadSession ${sessionId}: not found`);
  }
  return data as SessionRow;
}

type TranscriptMessage = { role: "user" | "assistant" | "system"; content: string };

async function loadTranscript(sessionId: string, tenantId: string): Promise<TranscriptMessage[]> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) throw new NonRetriableError(`loadTranscript: ${error.message}`);
  return (data ?? [])
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content as string,
    }));
}

async function insertPlanMessage(args: {
  sessionId: string;
  tenantId: string;
  role: "user" | "assistant" | "system";
  content: string;
  agentRole?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabase = supabaseService();
  const { error } = await supabase.from("planning_messages").insert({
    session_id: args.sessionId,
    tenant_id: args.tenantId,
    role: args.role,
    content: args.content,
    agent_role: args.agentRole ?? null,
    metadata: args.metadata ?? null,
  });
  if (error) {
    throw new NonRetriableError(`insertPlanMessage: ${error.message}`);
  }
}

// ─── helper: rollback a stuck `planning` session back to `discussing` ──────
//
// Used by the orchestrator's catch block when any child step.invoke throws.
// Without this, a bridge timeout (PLANNER_TIMEOUT) or unparseable consolidator
// output leaves `planning_sessions.status='planning'` orphaned forever and the
// UI's "Building…" pane locks. Operator's only escape was a manual DB PATCH.
//
// Idempotent: the `eq("status", "planning")` guard ensures the update is a
// no-op once another retry / human edit has already moved the session out
// of `planning`. Safe to call multiple times on Inngest replay.
async function rollbackSessionIfPlanning(sessionId: string): Promise<{ rolledBack: boolean }> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_sessions")
    .update({ status: "discussing" })
    .eq("id", sessionId)
    .eq("status", "planning")
    .select("id");
  if (error) {
    // Don't re-throw from inside a catch — the original error is more
    // important. Swallow + log; the operator can still manually unstick.
    console.error(
      `[plan/inngest] rollbackSessionIfPlanning(${sessionId}) failed: ${error.message}`,
    );
    return { rolledBack: false };
  }
  return { rolledBack: (data?.length ?? 0) > 0 };
}

// ─── helper: project context (README + package.json best-effort) ───────────

const README_CANDIDATES = ["README.md", "README", "readme.md"] as const;
const README_MAX_BYTES = 4_000;
const PACKAGE_JSON_MAX_BYTES = 4_000;

async function loadProjectContext(args: {
  projectId: string;
  tenantId: string;
  stackFlavor: StackFlavor;
  stackPreferences: string;
  /** Per-session team-tier override; null falls back to the project default. */
  sessionTier: TeamTier | null;
}): Promise<PromptContext> {
  const supabase = supabaseService();
  const { data: proj } = await supabase
    .from("projects")
    .select(
      "name, repo_url, github_owner, github_repo, default_branch, created_by, team_tier, project_type, stack_ecosystem",
    )
    .eq("id", args.projectId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  const projectTier = (proj?.team_tier as TeamTier | null | undefined) ?? null;
  const effectiveTier = resolveEffectiveTier(projectTier, args.sessionTier);
  // The project's committed stack (WI-15) — the hard frame every prompt below
  // opens with. Tenant-scoped read; unknown keys dropped against the catalog.
  const stackTags = await loadProjectStackTags({
    tenantId: args.tenantId,
    projectId: args.projectId,
  });
  const base: PromptContext = {
    projectName: (proj?.name as string | undefined) ?? "(unnamed project)",
    repoUrl: (proj?.repo_url as string | null | undefined) ?? null,
    // Narrowed, not cast — an unreadable project (deleted mid-plan) or an
    // unexpected value degrades to 'other', i.e. no platform frame.
    projectType: toProjectType(proj?.project_type),
    stackFlavor: args.stackFlavor,
    stackPreferences: args.stackPreferences,
    stackTags,
    // Narrowed, not cast — same degrade-to-the-neutral-default contract as
    // `toProjectType` above: an unreadable project or an unexpected column
    // value falls back to 'unset', i.e. no ecosystem clause in the frame.
    stackEcosystem: isEcosystemChoice(proj?.stack_ecosystem)
      ? proj.stack_ecosystem
      : DEFAULT_ECOSYSTEM,
    teamTier: effectiveTier,
    readmeExcerpt: null,
    packageJsonExcerpt: null,
  };
  const owner = proj?.github_owner as string | undefined;
  const repoName = proj?.github_repo as string | undefined;
  const branch = (proj?.default_branch as string | undefined) ?? "main";
  const createdBy = proj?.created_by as string | undefined;
  if (!owner || !repoName || !createdBy) return base;
  let token: string;
  try {
    const row = await getGithubTokenRow(createdBy);
    if (!row) return base;
    token = row.accessToken;
  } catch {
    return base;
  }
  let readme: string | null = null;
  for (const name of README_CANDIDATES) {
    readme = await fetchRawFile(owner, repoName, branch, token, name);
    if (readme) break;
  }
  const pkg = await fetchRawFile(owner, repoName, branch, token, "package.json");
  return {
    ...base,
    readmeExcerpt: readme ? readme.slice(0, README_MAX_BYTES) : null,
    packageJsonExcerpt: pkg ? pkg.slice(0, PACKAGE_JSON_MAX_BYTES) : null,
  };
}

// ─── helper: transcript serialisation for prompts ──────────────────────────

function transcriptToText(transcript: TranscriptMessage[]): string {
  return transcript.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
}

// ─── 1. planLeadReplyFn ────────────────────────────────────────────────────

export const planLeadReplyFn = inngest.createFunction(
  {
    id: "plan-lead-reply",
    retries: 1,
    concurrency: {
      // Mirror runAgent's per-tenant cap shape but key on tenant +
      // session so two operators on different sessions don't starve.
      limit: 4,
      key: "event.data.tenantId + '_' + event.data.sessionId + '_lead'",
    },
  },
  { event: "plan/lead-reply.requested" },
  async ({ event, step }) => {
    const { sessionId, tenantId, runId } = event.data;
    const typedStep = step as unknown as PlannerStep;

    // 1. Load session + transcript + project context.
    const session = await step.run("load-session", async () => loadSession(sessionId));
    if (session.tenant_id !== tenantId) {
      throw new NonRetriableError(
        `tenant mismatch on session ${sessionId}: ${session.tenant_id} !== ${tenantId}`,
      );
    }
    if (session.status !== "discussing") {
      // Tolerable: the operator may have raced a "Build plan" click against
      // a queued reply. Bail without erroring.
      return { skipped: "session_not_discussing", status: session.status };
    }

    // 2. Cost gate. Throwing here marks the function failed cleanly.
    await step.run("budget-gate", async () => {
      await assertCanProceedPlan({
        tenantId,
        projectId: session.project_id,
        sessionId,
        estCents: EST_CENTS.leadReply,
      });
    });

    const ctx = await step.run("load-context", async () =>
      loadProjectContext({
        projectId: session.project_id,
        tenantId,
        stackFlavor: session.stack_flavor,
        stackPreferences: session.stack_preferences,
        sessionTier: session.team_tier,
      }),
    );
    const transcript = await step.run("load-transcript", async () =>
      loadTranscript(sessionId, tenantId),
    );

    if (transcript.length === 0) {
      throw new NonRetriableError(`planLeadReplyFn: empty transcript for session ${sessionId}`);
    }

    // 3. Build the prompt — lead is the only stage that takes a
    //    transcript as the user-facing prompt body rather than a fresh
    //    instruction. Format as alternating turns.
    const userPrompt = transcript
      .map((m) => `${m.role === "assistant" ? "ASSISTANT" : "USER"}: ${m.content}`)
      .join("\n\n");

    // Notify the session creator that the lead has engaged — fires once per
    // session via the dedupeKey unique index, so subsequent reply turns are
    // a no-op insert. Wrapped in its own step so Inngest replays don't even
    // try to re-publish (belt to the dedupe-key suspenders at the table
    // level). Best-effort: a failure here must not block the actual reply.
    if (session.created_by) {
      await step.run("notify-started", async () => {
        await publishNotification({
          tenantId,
          userId: session.created_by!,
          kind: "plan.started",
          title: "Planner is thinking…",
          body: "The lead planner picked up your prompt.",
          href: `/projects/${session.project_id}?planSessionId=${sessionId}`,
          metadata: { sessionId, projectId: session.project_id },
          dedupeKey: `plan.started:${sessionId}`,
        });
      });
    }

    // Bridge timeouts / runner failures / parse errors throw out of
    // invokePlannerRunner. The lead reply leaves status='discussing' so we
    // don't need a status rollback — but we DO need to surface a friendly
    // operator-facing pill, otherwise the UI's "Lead is thinking…"
    // indicator just stops with no explanation. Re-throw so Inngest still
    // marks the function failed and the operator can debug from Langfuse.
    let result: Awaited<ReturnType<typeof invokePlannerRunner>>;
    try {
      result = await invokePlannerRunner(typedStep, {
        tenantId,
        sessionId,
        runId,
        iterationIdx: 0,
        modelTier: "default",
        systemPrompt: LEAD_SYSTEM_PROMPT(ctx),
        prompt: userPrompt,
        spanName: "plan.lead.reply",
        // Lead replies are short (10-30s typical) — use the lead-stage
        // timeout so a wedged subprocess gets killed promptly instead of
        // sitting on the legacy 10-min ceiling.
        stage: "lead",
      });
    } catch (err) {
      await step.run("rollback-on-error", async () => {
        await insertPlanMessage({
          sessionId,
          tenantId,
          role: "system",
          content:
            "⚠ Lead reply failed — runner timed out or errored. Try sending the message again.",
          agentRole: "lead",
          metadata: {
            stage: "planLeadReplyFn.rollback",
            error: err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400),
          },
        });
      });
      throw err;
    }

    // 4. Persist + spend. Guard against empty model output: the runner
    //    sometimes reports completion tokens (the model "spoke") but the
    //    extracted text is empty — usually a parser miss in `claude -p`'s
    //    stream-json or an extended-thinking-only turn. Inserting an empty
    //    assistant bubble is a poor UX; surface a system message instead so
    //    the operator can re-send.
    const cents = costCents("default", {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    });
    const trimmed = result.text.trim();
    await step.run("persist-reply", async () => {
      if (trimmed.length === 0) {
        await insertPlanMessage({
          sessionId,
          tenantId,
          role: "system",
          content: `⚠ Lead replied with empty output (${result.usage.completionTokens} completion tokens). Try sending your message again — phrasing it as a single question often helps.`,
          agentRole: "lead",
          metadata: {
            stage: "planLeadReplyFn.empty",
            model: result.modelId,
            runner_kind: result.runnerKind,
            token_usage: {
              prompt: result.usage.promptTokens,
              completion: result.usage.completionTokens,
              total: result.usage.totalTokens,
            },
            cost_cents: cents,
          },
        });
      } else {
        await insertPlanMessage({
          sessionId,
          tenantId,
          role: "assistant",
          content: trimmed,
          agentRole: "lead",
          metadata: {
            model: result.modelId,
            runner_kind: result.runnerKind,
            token_usage: {
              prompt: result.usage.promptTokens,
              completion: result.usage.completionTokens,
              total: result.usage.totalTokens,
            },
            cost_cents: cents,
          },
        });
      }
      // Spend is recorded either way — the runner did the work; we pay for
      // it regardless of whether the text came back parseable.
      await recordPlanSessionSpend({
        tenantId,
        projectId: session.project_id,
        sessionId,
        addCents: cents,
      });
    });

    // 5. Haiku goal-summary updater — deferred to v2.
    //
    // The original design called for a cheap Haiku call once every 2 user
    // turns to update `planning_sessions.goal_summary`. After the M7
    // runner-route revision this would need its OWN runId (so the bridge's
    // waitForEvent can match a second runner/step-result event in the same
    // function invocation). Two clean ways forward:
    //   (a) extract it to a separate Inngest function triggered by a
    //       `plan/goal-summary.requested` event, with its own runId;
    //   (b) have the action emit two events (lead-reply + goal-summary).
    // Both are out of scope for the runner-route hotfix; the UI shows
    // `goal_summary IS NULL` as "no summary yet" which is fine. Leaving as
    // a TODO so the path is rediscoverable.
    // TODO(M7-v2): re-enable Haiku goal-summary via a separate Inngest fn.

    return { ok: true, runnerKind: result.runnerKind, costCents: cents };
  },
);

// ─── 2. planPanelStepFn ────────────────────────────────────────────────────

const PANEL_LABELS: Record<"pm" | "tech_lead" | "devops", string> = {
  pm: "PM panel",
  tech_lead: "Tech Lead panel",
  devops: "DevOps panel",
};

export const planPanelStepFn = inngest.createFunction(
  {
    id: "plan-panel-step",
    retries: 1,
    concurrency: {
      limit: 4,
      key: "event.data.tenantId + '_' + event.data.sessionId + '_panel_' + event.data.lens",
    },
  },
  { event: "plan/panel-step.requested" },
  async ({ event, step }) => {
    const { sessionId, tenantId, lens, runId } = event.data;
    const typedStep = step as unknown as PlannerStep;

    const session = await step.run("load-session", async () => loadSession(sessionId));
    if (session.tenant_id !== tenantId) {
      throw new NonRetriableError(`tenant mismatch on session ${sessionId}`);
    }

    await step.run("budget-gate", async () => {
      await assertCanProceedPlan({
        tenantId,
        projectId: session.project_id,
        sessionId,
        estCents: EST_CENTS.panelDraft,
      });
    });

    // 1. Start pill. We include `runId` so the PlanSheet pill can render the
    //    "Open terminal" affordance pointed at /api/runs/<runId>/attach —
    //    every local-cc panel now spawns inside a named tmux session (Track 2)
    //    keyed by this runId, and runs.tmux_session_name is stamped on claim.
    await step.run("pill-start", async () => {
      await insertPlanMessage({
        sessionId,
        tenantId,
        role: "system",
        content: `${PANEL_LABELS[lens]} start`,
        agentRole: lens,
        metadata: { stage: "panel.start", panel: lens, runId },
      });
    });

    const ctx = await step.run("load-context", async () =>
      loadProjectContext({
        projectId: session.project_id,
        tenantId,
        stackFlavor: session.stack_flavor,
        stackPreferences: session.stack_preferences,
        sessionTier: session.team_tier,
      }),
    );
    const transcript = await step.run("load-transcript", async () =>
      loadTranscript(sessionId, tenantId),
    );
    const transcriptText = transcriptToText(transcript);
    const userPrompt =
      `# Discussion transcript so far\n\n${transcriptText || "(empty transcript)"}` +
      (session.goal_summary ? `\n\n# Goal summary (rolling)\n\n${session.goal_summary}` : "");

    const systemPrompt =
      lens === "pm"
        ? PANEL_PM_PROMPT(ctx)
        : lens === "tech_lead"
          ? PANEL_TECH_LEAD_PROMPT(ctx)
          : PANEL_DEVOPS_PROMPT(ctx);

    // 2. Call the runner. Bridge throws (timeout / runner failure) bubble up
    //    to the orchestrator's catch — that's the single rollback site. We
    //    DON'T transition the session here because the panel doesn't know
    //    whether it's running solo or as part of a build pipeline. The
    //    orchestrator owns the cross-stage rollback; we just leave a debug
    //    pill so the operator can see which lens broke.
    let result: Awaited<ReturnType<typeof invokePlannerRunner>>;
    try {
      result = await invokePlannerRunner(typedStep, {
        tenantId,
        sessionId,
        runId,
        iterationIdx: 0,
        modelTier: "default",
        systemPrompt,
        prompt: userPrompt,
        spanName: `plan.panel.${lens}`,
        // Panels chew 3-6 min on long transcripts — keep the looser 10m
        // ceiling here so a healthy slow run doesn't get killed mid-draft.
        stage: "panel",
      });
    } catch (err) {
      await step.run("rollback-on-error", async () => {
        await insertPlanMessage({
          sessionId,
          tenantId,
          role: "system",
          content: `⚠ ${PANEL_LABELS[lens]} failed — runner timed out or errored.`,
          agentRole: lens,
          metadata: {
            stage: "planPanelStepFn.rollback",
            panel: lens,
            error: err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400),
          },
        });
      });
      throw err;
    }

    // 3. Parse + Zod-validate. local-cc may return prose; api path
    //    returns whatever the model produced. We always run the result
    //    through safeParseJsonBlock so both runners are handled.
    //
    // Soft failure: if one panel returns unparseable output, we DON'T
    // throw — Promise.all in the orchestrator would short-circuit and
    // sink the whole build. Instead, insert a warning system message and
    // return empty drafts. The consolidator can still merge 0-2 panel
    // drafts; the operator gets a smaller plan but the session reaches
    // 'planned' instead of failing outright.
    const raw = safeParseJsonBlock<{ proposedTickets?: unknown }>(result.text);
    const parseRes = ProposedTicketsObjectSchema.safeParse(raw);
    let drafts: ReturnType<typeof ProposedTicketsObjectSchema.parse>["proposedTickets"];
    if (!parseRes.success) {
      await step.run("pill-error", async () => {
        await insertPlanMessage({
          sessionId,
          tenantId,
          role: "system",
          content: `${PANEL_LABELS[lens]} returned unparseable output — proceeding with empty drafts`,
          agentRole: lens,
          metadata: {
            stage: "panel.softfail",
            panel: lens,
            reason: "schema",
            issue: parseRes.error.issues[0]?.message?.slice(0, 200),
            // Snippet of the raw text so the operator can debug later.
            sample: result.text.slice(0, 400),
          },
        });
      });
      drafts = [];
    } else {
      drafts = parseRes.data.proposedTickets;
    }

    // 4. Record spend + done pill.
    const cents = costCents("default", {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    });
    await step.run("record-spend", async () => {
      await recordPlanSessionSpend({
        tenantId,
        projectId: session.project_id,
        sessionId,
        addCents: cents,
      });
    });
    await step.run("pill-done", async () => {
      await insertPlanMessage({
        sessionId,
        tenantId,
        role: "system",
        content: `${PANEL_LABELS[lens]} done — ${drafts.length} draft ticket(s)`,
        agentRole: lens,
        metadata: {
          stage: "panel.done",
          panel: lens,
          ticket_count: drafts.length,
          cost_cents: cents,
          runner_kind: result.runnerKind,
          token_usage: {
            prompt: result.usage.promptTokens,
            completion: result.usage.completionTokens,
            total: result.usage.totalTokens,
          },
          // Persist the panel's drafts so the new "Restart this step" action
          // can re-fire ONLY the consolidator with the existing panel output
          // — instead of redoing the 3 panel passes from scratch. The
          // ProposedTicket arrays are small (typically <20 entries each), so
          // putting them in JSONB metadata is cheap and keeps the restart
          // path off any new tables.
          drafts: drafts as unknown as Record<string, unknown>[],
        },
      });
    });

    // The orchestrator reads this via `step.invoke`'s return value.
    return {
      lens,
      drafts: drafts as PanelDraft["proposedTickets"],
      costCents: cents,
      runnerKind: result.runnerKind,
    };
  },
);

// ─── 3. planConsolidatorFn ─────────────────────────────────────────────────

export const planConsolidatorFn = inngest.createFunction(
  {
    id: "plan-consolidator",
    retries: 1,
    concurrency: {
      limit: 4,
      key: "event.data.tenantId + '_' + event.data.sessionId + '_consolidator'",
    },
  },
  { event: "plan/consolidator.requested" },
  async ({ event, step }) => {
    const { sessionId, tenantId, drafts, runId } = event.data;
    const typedStep = step as unknown as PlannerStep;

    const session = await step.run("load-session", async () => loadSession(sessionId));
    if (session.tenant_id !== tenantId) {
      throw new NonRetriableError(`tenant mismatch on session ${sessionId}`);
    }

    await step.run("budget-gate", async () => {
      await assertCanProceedPlan({
        tenantId,
        projectId: session.project_id,
        sessionId,
        estCents: EST_CENTS.consolidator,
      });
    });

    await step.run("pill-start", async () => {
      await insertPlanMessage({
        sessionId,
        tenantId,
        role: "system",
        content: "Consolidator start",
        agentRole: "consolidator",
        // runId persisted so the PlanSheet pill can render "Open terminal" →
        // /api/runs/<runId>/attach. Track 2 stamps runs.tmux_session_name on
        // claim; Track 3 component reads it back on attach.
        metadata: { stage: "consolidator.start", runId },
      });
    });

    const ctx = await step.run("load-context", async () =>
      loadProjectContext({
        projectId: session.project_id,
        tenantId,
        stackFlavor: session.stack_flavor,
        stackPreferences: session.stack_preferences,
        sessionTier: session.team_tier,
      }),
    );
    const transcript = await step.run("load-transcript", async () =>
      loadTranscript(sessionId, tenantId),
    );
    const transcriptText = transcriptToText(transcript);

    // The consolidator prompt expects three named drafts in the user
    // message. Drafts arrive verbatim from the orchestrator (or external
    // emitter) — we trust the payload shape.
    const draftsBlock = (["pm", "tech_lead", "devops"] as const)
      .map(
        (lens) =>
          `# Draft from ${lens}\n\n` +
          JSON.stringify({ proposedTickets: drafts[lens] ?? [] }, null, 2),
      )
      .join("\n\n");
    const userPrompt =
      `# Discussion transcript\n\n${transcriptText || "(empty transcript)"}\n\n` + draftsBlock;

    // Bridge throws bubble up to the orchestrator's catch (single rollback
    // site). We just leave a debug pill so the operator can see the
    // consolidator stage was where the build broke.
    let result: Awaited<ReturnType<typeof invokePlannerRunner>>;
    try {
      result = await invokePlannerRunner(typedStep, {
        tenantId,
        sessionId,
        runId,
        iterationIdx: 0,
        modelTier: "default",
        systemPrompt: CONSOLIDATOR_PROMPT(ctx),
        prompt: userPrompt,
        spanName: "plan.consolidator",
        // Consolidator is the canonical hang case (90+ min reported pre-fix).
        // Tightest 5m default so a wedged `claude -p` gets killed promptly
        // and the orchestrator's catch rolls the session back to discussing.
        stage: "consolidator",
      });
    } catch (err) {
      await step.run("rollback-on-error", async () => {
        await insertPlanMessage({
          sessionId,
          tenantId,
          role: "system",
          content: "⚠ Consolidator failed — runner timed out or errored.",
          agentRole: "consolidator",
          metadata: {
            stage: "planConsolidatorFn.rollback",
            error: err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400),
          },
        });
      });
      throw err;
    }

    const raw = safeParseJsonBlock<{ proposedTickets?: unknown }>(result.text);
    const parseRes = ProposedTicketsObjectSchema.safeParse(raw);
    if (!parseRes.success) {
      // Keep the schema-fail debug pill so the operator sees which stage
      // produced bad output. The session-level rollback (status →
      // 'discussing') is owned by the orchestrator's catch; we just throw.
      await step.run("pill-error", async () => {
        await insertPlanMessage({
          sessionId,
          tenantId,
          role: "system",
          content: `Consolidator failed: invalid JSON output`,
          agentRole: "consolidator",
          metadata: {
            stage: "consolidator.error",
            reason: "schema",
            issue: parseRes.error.issues[0]?.message?.slice(0, 200),
          },
        });
      });
      throw new NonRetriableError(
        `planConsolidatorFn: schema validation failed — ${parseRes.error.issues[0]?.message ?? "unknown"}`,
      );
    }

    const finalTickets = parseRes.data.proposedTickets.slice(0, getMaxTicketsForTier(ctx.teamTier));
    const cents = costCents("default", {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
    });
    await step.run("record-spend", async () => {
      await recordPlanSessionSpend({
        tenantId,
        projectId: session.project_id,
        sessionId,
        addCents: cents,
      });
    });

    // Persist proposed tickets. Cleanup:
    //   - replace unknown role slugs with `engineer` (catalog fallback)
    //   - clamp specialist slugs that aren't in the active tier's allow-list
    //     to the tier's bundle role (e.g. Quick tier rewrites `security_engineer`
    //     to `engineer` so the bundled ticket lands on a generalist)
    //   - drop self-referential / out-of-range depends_on_ordinals
    const rows = finalTickets.map((t, idx) => {
      const ordinal = idx + 1;
      const catalogClean = ROLE_SLUG_SET.has(t.requested_role) ? t.requested_role : "engineer";
      const cleanRole = clampRoleToTier(ctx.teamTier, catalogClean);
      const cleanDeps = (t.depends_on_ordinals ?? []).filter(
        (d) => Number.isInteger(d) && d >= 1 && d <= finalTickets.length && d !== ordinal,
      );
      return {
        session_id: sessionId,
        tenant_id: tenantId,
        ordinal,
        title: t.title.slice(0, 160),
        description: t.description.slice(0, 4_000),
        acceptance_criteria: t.acceptance_criteria.slice(0, 4_000),
        requested_role: cleanRole,
        depends_on_ordinals: cleanDeps,
        selected: true,
        committed_ticket_id: null,
      };
    });

    if (rows.length > 0) {
      await step.run("persist-proposed", async () => {
        const supabase = supabaseService();
        const { error } = await supabase.from("planning_proposed_tickets").insert(rows);
        if (error) {
          throw new NonRetriableError(`persist proposed tickets: ${error.message}`);
        }
      });
    }

    await step.run("pill-done", async () => {
      await insertPlanMessage({
        sessionId,
        tenantId,
        role: "system",
        content: `Consolidator done — ${finalTickets.length} ticket(s)`,
        agentRole: "consolidator",
        metadata: {
          stage: "consolidator.done",
          ticket_count: finalTickets.length,
          cost_cents: cents,
          runner_kind: result.runnerKind,
          token_usage: {
            prompt: result.usage.promptTokens,
            completion: result.usage.completionTokens,
            total: result.usage.totalTokens,
          },
        },
      });
    });

    await step.run("finish-session", async () => {
      const supabase = supabaseService();
      const { error } = await supabase
        .from("planning_sessions")
        .update({ status: "planned" })
        .eq("id", sessionId);
      if (error) {
        throw new NonRetriableError(`finish-session: ${error.message}`);
      }
    });

    // Notify the session creator that their plan is ready. Wrapped in its
    // own step so an Inngest replay won't double-publish — the dedupe key
    // belt-and-suspenders that with a unique-index guard at the table level.
    if (session.created_by) {
      await step.run("notify-finished", async () => {
        await publishNotification({
          tenantId,
          userId: session.created_by!,
          kind: "plan.finished",
          title: `Plan ready — ${finalTickets.length} ticket${finalTickets.length === 1 ? "" : "s"} proposed`,
          body: "Open the plan to review and commit the selected tickets.",
          href: `/projects/${session.project_id}?planSessionId=${sessionId}`,
          metadata: { sessionId, projectId: session.project_id },
          dedupeKey: `plan.finished:${sessionId}`,
        });
      });
    }

    // NB: the project_scaffolder ticket is deliberately NOT filed here anymore
    // (Part D). This step used to inject + dispatch a `project_scaffolder`
    // ticket on EVERY successful plan build, but that was wrong on two counts:
    //   • it fired for existing / connect-existing projects that need no
    //     scaffolding at all, and for already-scaffolded projects on a re-plan;
    //   • it ran BEFORE the plan was committed, and its "already exists" guard
    //     (keyed on requested_role='project_scaffolder') could not see the
    //     plan's OWN scaffolding work — that lives as uncommitted
    //     planning_proposed_tickets under a feature role and is materialized as
    //     `backlog` later by commitPlanAction — so it injected a redundant
    //     scaffolder that duplicated the plan's own.
    // The guaranteed seed for a genuinely-new EMPTY repo is now filed INLINE by
    // createProjectWithNewRepoAction (the only flow that knows the repo is
    // empty). An existing/connect-existing project's plan gets no auto-scaffold.

    return {
      ok: true,
      ticketCount: finalTickets.length,
      runnerKind: result.runnerKind,
      costCents: cents,
    };
  },
);

// ─── 4. planBuildOrchestratorFn ────────────────────────────────────────────

export const planBuildOrchestratorFn = inngest.createFunction(
  {
    id: "plan-build-orchestrator",
    retries: 1,
    concurrency: {
      limit: 4,
      key: "event.data.tenantId + '_' + event.data.sessionId + '_orchestrator'",
    },
  },
  { event: "plan/build-orchestrator.requested" },
  async ({ event, step }) => {
    const { sessionId, tenantId } = event.data;

    // Pre-allocate one runId per invoked function so each child's
    // triggering event carries `data.runId` for the runner-bridge's
    // `match: "data.runId"` waitForEvent. Allocated in a step.run so
    // Inngest replays see the same uuids.
    const runIds = await step.run("alloc-run-ids", async () => ({
      pm: randomUUID(),
      tech_lead: randomUUID(),
      devops: randomUUID(),
      consolidator: randomUUID(),
    }));

    // The orchestrator is the SINGLE rollback site for the build pipeline.
    // Any child step.invoke (panel or consolidator) that throws — whether
    // from a bridge PLANNER_TIMEOUT, a PLANNER_RUNNER_FAILED, a schema
    // validation NonRetriableError, etc. — re-raises here. Without this
    // catch, `planning_sessions.status='planning'` would stick forever and
    // the UI's "Building…" pane would lock with no recovery short of a
    // manual DB PATCH.
    //
    // The catch performs three steps before re-throwing:
    //   1. Transition session back to 'discussing' (idempotent: gated on
    //      `eq("status", "planning")` so retries don't clobber a session
    //      a human already moved out of planning).
    //   2. Insert a recognisable system pill so the UI can flip out of
    //      'planning' mode and the operator sees what happened.
    //   3. Re-raise so Inngest marks the orchestrator failed (Langfuse,
    //      retries policy, etc. all stay correct).
    try {
      // Fan-out: three panel steps in parallel via step.invoke. Each
      // returns its drafts; we join them into the consolidator payload.
      const [pm, tl, ops] = await Promise.all([
        step.invoke("plan-panel-pm", {
          function: planPanelStepFn,
          data: { sessionId, tenantId, lens: "pm" as const, runId: runIds.pm },
        }),
        step.invoke("plan-panel-tech-lead", {
          function: planPanelStepFn,
          data: { sessionId, tenantId, lens: "tech_lead" as const, runId: runIds.tech_lead },
        }),
        step.invoke("plan-panel-devops", {
          function: planPanelStepFn,
          data: { sessionId, tenantId, lens: "devops" as const, runId: runIds.devops },
        }),
      ]);

      // Fan-in: consolidator. step.invoke returns the called function's
      // result; we forward only the `drafts` field shape it expects.
      const consolidatorResult = await step.invoke("plan-consolidator", {
        function: planConsolidatorFn,
        data: {
          sessionId,
          tenantId,
          runId: runIds.consolidator,
          drafts: {
            pm: (pm as { drafts: Array<Record<string, unknown>> }).drafts ?? [],
            tech_lead: (tl as { drafts: Array<Record<string, unknown>> }).drafts ?? [],
            devops: (ops as { drafts: Array<Record<string, unknown>> }).drafts ?? [],
          },
        },
      });

      return { ok: true, consolidator: consolidatorResult };
    } catch (err) {
      await step.run("rollback-on-error", async () => {
        await rollbackSessionIfPlanning(sessionId);
        // Tailor the failure pill to WHICH stage broke so the operator
        // doesn't see a generic "build cancelled" message after a 5+ minute
        // consolidator hang. We sniff the error message for the bridge's
        // structured PLANNER_TIMEOUT / PLANNER_RUNNER_FAILED prefixes plus
        // the `stage=...` suffix the bridge stamps in.
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = errMsg.startsWith("PLANNER_TIMEOUT");
        const stageMatch = errMsg.match(/stage=(lead|panel|consolidator)/);
        const failedStage = stageMatch?.[1] ?? null;
        let content: string;
        if (isTimeout && failedStage === "consolidator") {
          content =
            "⚠ Consolidator timed out — the merge step did not finish in time and the runner subprocess was killed. " +
            'Click "Restart this step" on the Consolidator pill to re-run the merge with the existing panel drafts, ' +
            'or "Cancel build" to start fresh.';
        } else if (isTimeout && failedStage === "panel") {
          content =
            "⚠ A panel stage timed out — the runner subprocess was killed. " +
            'Click "Restart this step" on the failed panel pill to re-run just that lens, ' +
            'or "Cancel build" to start over.';
        } else if (isTimeout) {
          content =
            "⚠ Build cancelled — planner timed out and the runner subprocess was killed. Click Build plan to retry.";
        } else {
          content =
            '⚠ Build cancelled — runner errored. Click "Restart this step" to retry the failed stage, or "Cancel build" to start fresh.';
        }
        await insertPlanMessage({
          sessionId,
          tenantId,
          role: "system",
          content,
          metadata: {
            stage: "planBuildOrchestratorFn.rollback",
            error: errMsg.slice(0, 400),
            failedStage,
            isTimeout,
          },
        });
      });
      await step.run("notify-failed", async () => {
        const supabase = supabaseService();
        const { data } = await supabase
          .from("planning_sessions")
          .select("created_by, project_id")
          .eq("id", sessionId)
          .maybeSingle();
        if (!data?.created_by) return;
        await publishNotification({
          tenantId,
          userId: data.created_by as string,
          kind: "plan.failed",
          title: "Plan failed",
          body:
            err instanceof Error
              ? err.message.slice(0, 200)
              : "The planning panel errored before finishing.",
          href: `/projects/${data.project_id}?planSessionId=${sessionId}`,
          metadata: { sessionId, projectId: data.project_id },
          dedupeKey: `plan.failed:${sessionId}`,
        });
      });
      throw err;
    }
  },
);

// Touch the model-id constant so TS doesn't tree-shake the import-only
// usage in unused branches (kept for the spanName parity comments).
void MODEL_IDS;
