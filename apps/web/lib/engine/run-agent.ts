// The durable agent run.
//
// The core loop runs N iterations, each dispatched through a runner
// (api-inline or local-cc-async); per-iteration: budget check, runner step,
// persist run_steps, record spend. What began as a Phase 0 "think loop" now
// carries the full stack: roles + dispatcher (Phase 1/M6), supervision
// strategies, per-project repo + GitHub OAuth plumbing (Phase 2/M5a),
// builds-on stacking, and per-project encrypted secrets (Phase 2.5++).
// See `docs/IMPLEMENTATION_STATUS.md` for the current planned-vs-built picture.

import { randomUUID } from "node:crypto";
import { NonRetriableError } from "inngest";
import { inngest } from "@/lib/engine/inngest";
import { ticketBranch } from "@/lib/git/ticket-branch";
import { assertCanProceed, recordSpend } from "@/lib/engine/budget";
import {
  selectDeliverableAttachments,
  estimateImageDeliveryCents,
} from "@/lib/board/attachment-delivery";
import { stepCost } from "@/lib/llm/cost";
import { MODEL_IDS, type ModelTier } from "@/lib/llm/models";
// WI-12 — per-project LLM provider. The seam is deliberately narrow: run-agent
// learns the provider + an optional explicit model, and nothing else. The
// endpoint and the credential stay inside the resolver.
import { providerSupportsLocalCc, resolveClaudeModelArg } from "@/lib/llm/provider";
import { resolveLlmProviderConfig } from "@/lib/llm/provider-config.server";
import { pickRunner } from "@/lib/runners/registry";
import type { RunnerKind, StepResult } from "@/lib/runners/types";
import { ROLES, type Role } from "@/lib/roles/index";
import { applyRolePostProcess } from "@/lib/roles/postprocess";
import { isBuiltinRole, loadRoleConfig } from "@/lib/roles/load";
import { isCodeProducingRole } from "@/lib/roles/code-producing";
import { isVerdictRoleConfig } from "@/lib/roles/verdict-role";
import { applySupervisionStrategy } from "@/lib/engine/supervision";
import { classifyRunFailureReason } from "@/lib/engine/run-failure-reason";
import { langfuseForTenant } from "@/lib/tracing/langfuse";
import { redis } from "@/lib/cache/redis";
import { supabaseService } from "@/lib/db/server";
import { env } from "@/lib/env";
// Phase 2 / M5a — per-project repo + GitHub OAuth plumbing.
import { loadProjectForTicket } from "@/lib/projects/load";
import { loadBuildsOnBase } from "@/lib/board/dependencies";
import { ensureFreshGithubToken } from "@/lib/github/refresh";
import { getGithubTokenRow } from "@/lib/github/oauth";
// Phase 2.5++ / Slice A — per-project encrypted secrets vault.
import { loadProjectSecretsJson } from "@/lib/projects/secrets";
// Account-wide credentials explicitly marked shareable with agents (per-key
// opt-in in the platform-secrets catalog; project vault always wins).
import { mergeAgentSecretsJson } from "@/lib/platform-secrets/agent-shared";
import { loadSharedPlatformSecrets } from "@/lib/platform-secrets/agent-shared.server";
// Phase 2.5++ / C4 — shared slugify for human-readable git branch names.
import { slugify } from "@/lib/slug";
// Stuck-ticket fix (865345ef) — post-completion reconciliation. Tool-driven
// roles advance their ticket only via devpilot_move_ticket during the step; when
// a run completes 'done' without that call (canonical case: a resume-replay
// that lost its role system prompt), nothing else advances the ticket. The
// reconciler detects the untouched ticket and applies the role's FSM
// contract. See lib/engine/reconcile-policy.ts for the decision rules.
import { reconcileTicketAfterRun } from "@/lib/engine/ticket-reconciler";
import { getEffectivePauseForTicket } from "@/lib/engine/automation-state";
// Pre-spend guard: refuse a ticket-bound dispatch of a code-producing role that
// has no repository to clone, instead of running it blind and calling it done.
import { decideWorkspacePrecondition } from "@/lib/engine/workspace-precondition";
import { noticeWorkspacePreconditionRefusal } from "@/lib/engine/workspace-precondition.server";
import { decideCancelCheck } from "@/lib/engine/cancel-check-policy";
import { resolveQaVerifyEnabled } from "@/lib/board/qa-verify-flag";
import type { TicketStatus } from "@/lib/board/state";

const MAX_ITERS = 20;
const DEFAULT_BUDGET_CENTS = 500;
// Phase 3 — minimum budget slack (cents) required ON TOP of the estimated image
// cost before we deliver a ticket's screenshots. Keeps a run from spending its
// last cent on image tokens and then having nothing left for the LLM turn.
const MIN_ATTACHMENT_BUDGET_SLACK_CENTS = 1;
// Per CLAUDE.md non-negotiable #1: the Local Claude Code runner is the DEFAULT
// runner. The per-token API runner is opt-in (multi-tenant serving, the
// public v1/* HTTP endpoints) and never the fallback for internal dispatches.
const DEFAULT_RUNNER_POLICY: RunnerKind = "local-cc";
const LOCAL_CC_QUEUE = "devpilot:jobs:local-cc:ready";
// Runner-side kill channel (drained by apps/runner/src cancelLoop). We LPUSH a
// kill request here when a local-cc step blows past LOCAL_CC_TIMEOUT so the
// wedged `claude -p` is terminated instead of silently burning subscription
// quota after the engine has already given up waiting for its step-result.
const LOCAL_CC_CANCEL_QUEUE = "devpilot:jobs:local-cc:cancel";
const LOCAL_CC_TIMEOUT = "1h";
// Audit-step idx for a board/workspace automation-pause halt. Sits in the
// reserved system-audit range alongside the pause-resume markers (see the
// marker table in lib/engine/pause-resume.ts) and BELOW the per-ticket
// user-pause marker (99_993) so the trace distinguishes an automation-pause
// halt from an operator's per-ticket pause. Excluded from resume's
// last-good-step computation (kind='system', idx > AUDIT_STEP_FLOOR).
const AUTOMATION_PAUSE_AUDIT_STEP_IDX = 99_992;

export const runAgent = inngest.createFunction(
  {
    id: "run-agent",
    retries: 2,
    concurrency: { limit: 8, key: "event.data.tenantId" },
  },
  { event: "agent/run.requested" },
  async ({ event, step }) => {
    const {
      runId,
      tenantId,
      agentId,
      ticketId,
      prompt,
      systemPrompt,
      iterations = 1,
      modelTier = "default" as ModelTier,
      budgetCents = DEFAULT_BUDGET_CENTS,
      runnerPolicy = DEFAULT_RUNNER_POLICY,
      role,
      agentDisplayName,
      // Phase 1 / M6 — sibling cohort metadata. Present only when the dispatcher
      // emitted this run as part of a fan-out. The aggregator joins on
      // fanOutGroup so we MUST persist it onto the run row.
      fanOutGroup,
      fanOutPhase,
      // Phase 1 / M13 — replay clones pre-populate run_steps 0..N-1 from the
      // original; we start the loop at N so we don't collide on (run_id, idx).
      // 0/undefined is the normal Phase 0 / 1 cold-start path.
      startIterationIdx = 0,
    } = event.data;

    // 0. WI-12 — resolve the LLM provider for this run, SERVER-SIDE, from ids the
    //    engine already trusts (this run's tenant, and the project reached through
    //    its own ticket). Nothing here comes from the dispatch event, and nothing
    //    secret comes back OUT: the step's return value is persisted in Inngest's
    //    history, so it carries the provider/model DECISION only — never the base
    //    URL's credential, never the key. The runner is told what model to run,
    //    never where to send it.
    //
    //    Two things fall out of this:
    //      • An `openai_compatible` project is FORCED onto the API runner. The
    //        local-cc runner is `claude -p`, which cannot speak that protocol —
    //        this is the enforcement point for that invariant, not a preference.
    //      • The `--model` plumb-through. Default-OFF: a project that configures
    //        no model yields `claudeModel: null`, the runner emits no `--model`,
    //        and the step runs on the account default exactly as it does today.
    const routing = await step.run("resolve-provider", async () => {
      const project = ticketId ? await loadProjectForTicket(ticketId).catch(() => null) : null;
      const projectId = project?.id ?? null;
      // `role` is the dispatch decision's role, carried on the event by every
      // path that emits one (dispatcher single + fan-out sibling, replay, the
      // two headless /v1 surfaces). It is an id the engine already trusts, which
      // is the bar `resolveLlmProviderConfig`'s header sets for its inputs — so
      // the per-agent × per-project override reaches EVERY run, fan-out siblings
      // included (they carry no agent_id, which is why the override is keyed on
      // the role slug and not on agents.id).
      const config = await resolveLlmProviderConfig({ tenantId, projectId, role });

      const effectivePolicy: RunnerKind = providerSupportsLocalCc(config.provider)
        ? runnerPolicy
        : "api";

      const decision = resolveClaudeModelArg(config.model);
      if (decision.kind === "account_default" && decision.reason === "unrecognised_model") {
        // SAFE FALLBACK, half 1 of 2: an unknown model id never fails a run — we
        // drop the flag and let the account default answer. (Half 2 lives on the
        // runner: a model that IS recognised here can still be unavailable on the
        // operator's actual plan, which only `claude` can know.)
        console.warn(
          `[run-agent] run=${runId} project=${projectId ?? "-"} configured model ` +
            `"${decision.rejected}" is not one we recognise — running on the account default.`,
        );
      }

      return {
        projectId,
        provider: config.provider,
        source: config.source,
        effectivePolicy,
        claudeModel: decision.kind === "explicit" ? decision.model : null,
        // Per-project escape hatch from the PER-RUN budget ceiling (never the
        // tenant velocity breaker — see budget.ts / budget-ceiling-policy.ts).
        // Ticket-less runs (no project) default to false, i.e. today's
        // behaviour exactly, matching every other per-project flag resolved
        // in this step.
        budgetCapOverrideEnabled: project?.budgetCapOverrideEnabled ?? false,
      };
    });
    const effectivePolicy = routing.effectivePolicy;

    // 1. Initialise the run row (idempotent — replays just no-op).
    //    NB: the dispatcher's fan-out path pre-seeds the row already so this
    //    upsert merges fields on those runs.
    await step.run("init", async () => {
      const supabase = supabaseService();
      const { error } = await supabase.from("runs").upsert(
        {
          id: runId,
          tenant_id: tenantId,
          agent_id: agentId ?? null,
          ticket_id: ticketId ?? null,
          budget_cents: budgetCents,
          spent_cents: 0,
          status: "running",
          depth: 0,
          runner_kind: effectivePolicy,
          last_event_at: new Date().toISOString(),
          fan_out_group: fanOutGroup ?? null,
          fan_out_role: fanOutGroup ? (role ?? null) : null,
        },
        { onConflict: "id" },
      );
      if (error) throw new NonRetriableError(`init failed: ${error.message}`);
      langfuseForTenant(tenantId).trace({
        id: runId,
        name: "agent.run",
        metadata: {
          tenantId,
          agentId,
          ticketId,
          modelTier,
          budgetCents,
          runnerPolicy: effectivePolicy,
          llmProvider: routing.provider,
          llmProviderSource: routing.source,
        },
      });
    });

    // Snapshot the ticket's status + wall-clock at run start. The
    // post-completion reconciler compares against these to prove "this run
    // completed without the ticket being advanced" (status unchanged AND no
    // devpilot_move_ticket comment newer than the snapshot) before acting.
    const ticketAtStart = await step.run("snapshot-ticket-status", async () => {
      if (!ticketId) return null;
      const supabase = supabaseService();
      const { data: row } = await supabase
        .from("tickets")
        .select("status")
        .eq("id", ticketId)
        .maybeSingle();
      return {
        status: ((row?.status as string | undefined) ?? null) as TicketStatus | null,
        atIso: new Date().toISOString(),
      };
    });

    // C4 — resolve a stable human-readable branch slug for this ticket. Done
    // ONCE before the iteration loop so the slug is identical across retries
    // and across panel siblings. The slug is cached on `tickets.git_branch_name`
    // — the first run computes it, writes back, and every subsequent run on
    // the ticket (and every concurrent reviewer) reads the same value.
    //
    // Resolved here (not in the runner) because the runner only knows the
    // ticketId; the title lives in Postgres and the runner doesn't have
    // service-role credentials. Falls back to null for ad-hoc smoke tests
    // (no ticketId) and the runner falls back to slugify(ticketId) — the
    // existing pre-C4 behaviour.
    const ticketSlug = await step.run("resolve-ticket-slug", async () => {
      if (!ticketId) return null;
      const supabase = supabaseService();
      const { data: row, error } = await supabase
        .from("tickets")
        .select("title, git_branch_name, project_id")
        .eq("id", ticketId)
        .maybeSingle();
      if (error || !row) return null;
      const stored = (row.git_branch_name as string | null) ?? null;
      if (stored) return stored;
      const title = (row.title as string | null) ?? "";
      const projectId = (row.project_id as string | null) ?? null;
      let candidate = slugify(title, { maxLen: 60 });
      // Project-scoped uniqueness: if another ticket in this project already
      // owns the slug, suffix with the first 6 chars of THIS ticket's id so
      // we deterministically diverge instead of racing on the same branch.
      if (projectId) {
        // Tenant-scoped: this collision probe decides the ticket's BRANCH NAME.
        // A planted `{tenant_id: them, project_id: <our project>,
        // git_branch_name: <our slug>}` row would fake a collision and force our
        // branch onto the suffixed name — or, worse, its absence lets two real
        // tickets converge. Either way the answer must come from our own rows.
        const { data: collide } = await supabase
          .from("tickets")
          .select("id")
          .eq("project_id", projectId)
          .eq("tenant_id", tenantId)
          .eq("git_branch_name", candidate)
          .neq("id", ticketId)
          .limit(1)
          .maybeSingle();
        if (collide) {
          candidate = `${candidate}-${ticketId.slice(0, 6)}`;
        }
      }
      // Best-effort write-back. The `.is("git_branch_name", null)` predicate
      // makes concurrent writers converge on the FIRST stored value — if
      // two runs on the same ticket race, both compute the same `candidate`
      // (deterministic), but only one UPDATE lands; the loser's write is a
      // no-op and the runner still uses the same value.
      await supabase
        .from("tickets")
        .update({ git_branch_name: candidate })
        .eq("id", ticketId)
        .is("git_branch_name", null);
      return candidate;
    });

    let lastText: string | null = null;
    // Phase 1 / M13 — when replaying, iterations 0..startIterationIdx-1 are
    // cloned rows that already exist on this run; the loop only ever produces
    // steps for iterations [startIterationIdx, startIterationIdx + iterations).
    const startIdx = Math.max(0, Math.floor(startIterationIdx));
    const totalIters = Math.min(iterations, MAX_ITERS);
    const endIdx = startIdx + totalIters;

    for (let i = startIdx; i < endIdx; i++) {
      // Soft-cancel / pause gate. Two independent halt sources, both checked
      // here so the loop stops burning `claude -p` calls at the next boundary:
      //
      //   • runs.status='cancelled' — the per-ticket pause primitive
      //     (pauseTicket) and the runner-watchdog flip this on the row; the
      //     loop just notices and exits.
      //   • effective automation pause — the board/workspace off-switch
      //     (setAutomationStateAction). Until now the loop never read it, so a
      //     board pause stopped NEW dispatch but the already-running ticket
      //     burned to completion. We now halt the in-flight run cleanly: flip
      //     the row out of 'running' to 'cancelled' (a legible
      //     `paused:automation:<scope>` reason), audit it, and exit. The ticket
      //     is NOT moved to the paused column (that's the per-ticket primitive)
      //     — it stays put, and the board resume re-dispatches it (fresh from
      //     the last checkpoint) via emitResumeDispatches.
      //
      // Throwing NonRetriableError routes to `runAgentFailed`, which is
      // conditional on status='running'; because we flip the row to 'cancelled'
      // first, that handler takes its "externally-terminated" path and skips
      // the fail-mark, the completion emit, and any supervision RESTART — a
      // paused run must not be auto-restarted.
      const cancelCheck = await step.run(`check-cancel-${i}`, async () => {
        const supabase = supabaseService();
        const { data, error } = await supabase
          .from("runs")
          .select("status")
          .eq("id", runId)
          .maybeSingle();
        if (error) throw new Error(`check-cancel: ${error.message}`);
        const runStatus = data?.status as string | undefined;

        // Only pay for the pause lookup when the run isn't already cancelled
        // and is ticket-bound (a ticket-less run has no project to pause).
        const pause =
          runStatus !== "cancelled" && ticketId
            ? await getEffectivePauseForTicket(tenantId, ticketId)
            : ({ paused: false } as const);

        const decision = decideCancelCheck({
          runStatus,
          hasTicket: Boolean(ticketId),
          pause,
        });

        if (decision.halt === "automation-paused") {
          // Conditional flip so a concurrent per-ticket pause / reaper that
          // already terminated the row isn't clobbered. WIP frees immediately
          // (checkWipLimit counts only running/awaiting_human), so on resume
          // the dispatcher can start a fresh run for this ticket.
          await supabase
            .from("runs")
            .update({
              status: "cancelled",
              status_reason: `paused:automation:${decision.scope}`,
              last_event_at: new Date().toISOString(),
            })
            .eq("id", runId)
            .eq("status", "running");
          await supabase.from("run_steps").insert({
            run_id: runId,
            idx: AUTOMATION_PAUSE_AUDIT_STEP_IDX,
            kind: "system",
            payload: {
              kind: "automation-paused",
              scope: decision.scope,
              ticket_id: ticketId,
              at_iteration: i,
            },
          });
        }
        return decision;
      });
      if (cancelCheck.halt) {
        throw new NonRetriableError(
          `run ${runId} halted (${cancelCheck.halt}) before iteration ${i}`,
        );
      }

      const turnPrompt =
        i === startIdx
          ? prompt
          : `Previous output:\n${lastText}\n\nRefine or extend the answer in one paragraph.`;

      let result: StepResult;

      if (effectivePolicy === "api") {
        // -------- In-process runner path (M4) ---------------------------
        result = await step.run(`think-${i}`, async () => {
          await assertCanProceed(runId, "llm", {
            overrideCap: routing.budgetCapOverrideEnabled,
          });
          const runner = pickRunner("api");
          return runner.execute({
            runId,
            tenantId,
            iterationIdx: i,
            modelTier,
            systemPrompt,
            prompt: turnPrompt,
            // WI-12 — the runner resolves the provider from these ids
            // server-side. `role` carries the per-agent × per-project model
            // rung onto the API path too: the ApiRunner re-resolves rather than
            // being handed a model, so without it the override would reach
            // `claude -p` and silently miss every API-path run.
            projectId: routing.projectId,
            role: role ?? null,
          });
        });
      } else if (effectivePolicy === "local-cc") {
        // -------- Out-of-process runner path (M5) -----------------------
        // Enqueue job + budget check, then waitForEvent until worker POSTs back.
        await step.run(`lc-enqueue-${i}`, async () => {
          const budgetState = await assertCanProceed(runId, "llm", {
            overrideCap: routing.budgetCapOverrideEnabled,
          });
          const id = randomUUID();

          // Phase 3 (ticket screenshots) — decide whether to tell the runner
          // this run's ticket has image attachments to deliver. Only on the
          // FIRST iteration this run executes (that's where the substantive
          // task prompt lives), and only when the run has budget headroom for
          // the estimated image tokens. `attachmentCount` is a HINT: the
          // authoritative selection + signing happens in the run-scoped
          // endpoint (GET /api/runs/[id]/attachments), which re-derives the
          // ticket/tenant from the run row and never trusts this number.
          let attachmentCount = 0;
          if (i === startIdx && ticketId) {
            try {
              const supabase = supabaseService();
              // Tenant-scoped. `selectDeliverableAttachments` already re-checks
              // the tenant on each row's storage key, but that is a key-shape
              // check, not a row-ownership one — the predicate is what stops a
              // planted attachment row on our ticket from being counted (and
              // then fetched, and then handed to our agent as a file to Read).
              const { data: attRows } = await supabase
                .from("ticket_attachments")
                .select("id, storage_key, mime, bytes")
                .eq("ticket_id", ticketId)
                .eq("tenant_id", tenantId);
              const deliverable = selectDeliverableAttachments({
                tenantId,
                rows: (attRows ?? []).map((r) => ({
                  id: r.id as string,
                  storageKey: r.storage_key as string,
                  mime: r.mime as string,
                  bytes: r.bytes as number,
                })),
              });
              if (deliverable.length > 0) {
                // Pre-flight budget GATE (never a charge — the real image
                // tokens are billed post-hoc via the runner-reported usage).
                // If the run can't afford even the estimated image cost plus a
                // cent of slack, deliver no images and let the agent run on the
                // ticket text alone rather than blowing the ceiling.
                const estCents = estimateImageDeliveryCents(deliverable.length, modelTier);
                if (estCents + MIN_ATTACHMENT_BUDGET_SLACK_CENTS <= budgetState.remainingCents) {
                  attachmentCount = deliverable.length;
                } else {
                  console.warn(
                    `[run-agent] run=${runId} ticket=${ticketId} skipping ${deliverable.length} ` +
                      `image attachment(s): est ${estCents}¢ exceeds remaining ${budgetState.remainingCents}¢`,
                  );
                }
              }
            } catch (err) {
              // Non-fatal: attachment delivery is an enrichment. A load failure
              // must never break the dispatch — run without images.
              console.warn(
                `[run-agent] attachment count lookup failed for ticket ${ticketId}:`,
                err instanceof Error ? err.message : err,
              );
            }
          }

          // Phase 2 / M5a — resolve per-project repo + GitHub OAuth identity.
          // The runner uses repoUrl to clone and githubToken to inject into
          // the origin URL so it can `git push` private repos.
          //
          // Failures here are non-fatal: we log them, leave the fields null,
          // and let the runner fall through to its ENGINEER_REPO_URL env
          // var (legacy behavior). A missing project module / missing token
          // for a public-repo project should not break the dispatch path.
          let repoUrl: string | null = null;
          let githubToken: string | null = null;
          let gitAuthorName: string | null = null;
          let gitAuthorEmail: string | null = null;
          // Slice A — per-project encrypted secrets, fetched once at
          // dispatch time and threaded through to the runner so claude
          // -p and the workspace `.env.local` both see them.
          let projectSecretsJson: string | null = null;
          // Slice IB — base branch the workspace clones from. Falls back
          // to the repo's default branch (null) when the project doesn't
          // have an integration_branch set — preserves legacy behavior.
          let baseBranch: string | null = null;
          // WI-5.2 — the exact commit on `baseBranch` to cut the ticket branch
          // from. Only ever set for a `builds_on` child whose parent has LANDED:
          // rooting the child at the parent's `landed_sha` (rather than at
          // whatever the integration tip happens to be by the time the runner
          // clones) is what makes stacked work deterministic. Null everywhere
          // else, which keeps the runner on its existing "branch from the tip"
          // path.
          let baseSha: string | null = null;
          // Slice IB-B — when this run is a merger (role='release_engineer')
          // and the merger ticket has a parent_ticket_id, route the runner
          // into the parent's workspace so the conflict markers in that
          // checkout are still available. Null on every other path.
          let workspaceTicketId: string | null = null;
          if (role === "release_engineer" && ticketId) {
            try {
              const supabase = supabaseService();
              const { data: row } = await supabase
                .from("tickets")
                .select("parent_ticket_id")
                .eq("id", ticketId)
                .maybeSingle();
              const parentId = (row?.parent_ticket_id as string | null) ?? null;
              if (parentId) workspaceTicketId = parentId;
            } catch (err) {
              console.warn(
                `[run-agent] release_engineer parent lookup failed for ${ticketId}:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
          if (ticketId) {
            try {
              const proj = await loadProjectForTicket(ticketId);
              repoUrl = proj?.repoUrl ?? process.env.ENGINEER_REPO_URL ?? null;
              // Prefer integration_branch over default_branch so ticket
              // branches root at the integration tip. Null when neither is
              // set or when the project lookup failed.
              baseBranch = proj?.integrationBranch ?? proj?.defaultBranch ?? null;
              // Slice IB-C — if this ticket `builds_on` an in-flight parent,
              // override the base branch with the parent's `devpilot/<slug>` so
              // the workspace stacks on top of the parent's unmerged work.
              // Only fires for non-merger roles (merger inherits the source
              // workspace, not a fresh clone, so baseBranch is ignored on
              // its path).
              if (role !== "release_engineer") {
                try {
                  const stacked = await loadBuildsOnBase(ticketId);
                  if (stacked?.kind === "landed") {
                    // WI-5.2 — the parent has LANDED. Root the child on the
                    // integration branch AT the parent's landed sha, not at its
                    // tip: deterministic, and it provably contains the parent's
                    // work without picking up whatever landed after it.
                    baseBranch = stacked.baseBranch;
                    baseSha = stacked.baseSha;
                    console.log(
                      `[run-agent] ticket=${ticketId} builds_on parent=${stacked.parentTicketId} landed; ` +
                        `baseBranch=${baseBranch} @ ${baseSha.slice(0, 7)}`,
                    );
                  } else if (stacked?.kind === "branch") {
                    // Parent hasn't landed - stack on its branch, which is where
                    // its commits actually are. This now INCLUDES a done-but-
                    // unlanded parent: the old code sent that case to the
                    // integration tip, which did not contain the parent's work.
                    baseBranch = ticketBranch(stacked.parentBranchName);
                    console.log(
                      `[run-agent] ticket=${ticketId} builds_on parent=${stacked.parentTicketId} (unlanded); baseBranch overridden to ${baseBranch}`,
                    );
                  }
                } catch (err) {
                  console.warn(
                    `[run-agent] loadBuildsOnBase(${ticketId}) failed:`,
                    err instanceof Error ? err.message : err,
                  );
                }
              }
              if (proj?.id) {
                try {
                  projectSecretsJson = await loadProjectSecretsJson(proj.id, tenantId);
                } catch (err) {
                  console.warn(
                    `[run-agent] loadProjectSecretsJson(${proj.id}) failed:`,
                    err instanceof Error ? err.message : err,
                  );
                }
              }
              if (proj?.createdBy) {
                try {
                  // tenantId (the run's tenant = the project's tenant) selects
                  // the platform-secrets scope for the OAuth App credentials.
                  githubToken = await ensureFreshGithubToken(proj.createdBy, tenantId);
                } catch (err) {
                  console.warn(
                    `[run-agent] ensureFreshGithubToken failed for project ${proj.id} owner ${proj.createdBy}:`,
                    err instanceof Error ? err.message : err,
                  );
                }
                try {
                  const row = await getGithubTokenRow(proj.createdBy);
                  if (row) {
                    // Use the GitHub user's login as the commit author so
                    // pushes attribute correctly. `users.noreply.github.com`
                    // is GitHub's documented privacy-preserving email host.
                    gitAuthorName = row.githubLogin;
                    gitAuthorEmail = `${row.githubLogin}@users.noreply.github.com`;
                  }
                } catch (err) {
                  console.warn(
                    `[run-agent] getGithubTokenRow failed for user ${proj.createdBy}:`,
                    err instanceof Error ? err.message : err,
                  );
                }
              }
            } catch (err) {
              // Legacy tickets without project_id, or a project lookup
              // failure: fall through to the ENGINEER_REPO_URL env path so
              // the runner can still prep a workspace for non-project work.
              console.warn(
                `[run-agent] loadProjectForTicket(${ticketId}) failed; falling back to ENGINEER_REPO_URL:`,
                err instanceof Error ? err.message : err,
              );
              repoUrl = process.env.ENGINEER_REPO_URL ?? null;
            }
          }

          // Account-wide credentials the operator explicitly marked shareable
          // with agents (today: VERCEL_TOKEN only). Resolved for THIS run's
          // tenant and merged UNDER the project vault, so a project-level value
          // always wins and a project can override the shared default without
          // the operator removing it. Runs regardless of whether the run has a
          // project: a ticket-less run still spawns an agent.
          //
          // Not a blanket platform-secrets fallback — see
          // `lib/platform-secrets/agent-shared.ts`. Eligibility is the catalog's
          // per-key `shareWithAgents` flag; delivery is separately governed by
          // the runner's SUBSCRIPTION_BLOCKED_ENV_KEYS, which strips blocked
          // names off the `claude -p` spawn no matter which layer supplied them.
          //
          // Best-effort like every other enrichment on this path: a failure
          // leaves projectSecretsJson exactly as it was.
          try {
            const shared = await loadSharedPlatformSecrets(tenantId);
            if (Object.keys(shared).length > 0) {
              projectSecretsJson = mergeAgentSecretsJson({
                sharedPlatform: shared,
                projectSecretsJson,
              });
            }
          } catch (err) {
            console.warn(
              `[run-agent] loadSharedPlatformSecrets failed for tenant ${tenantId}:`,
              err instanceof Error ? err.message : err,
            );
          }

          // Workspace precondition - REFUSE BEFORE SPENDING.
          //
          // A run whose deliverable is committed source and which has no
          // repository to clone cannot succeed; the runner would log
          // `skipping workspace prep (… repoUrl=unset …)` and hand the agent a
          // task it can only hallucinate its way through, at full subscription
          // cost, and the run would then be recorded `done`. This check sits
          // ABOVE the LPUSH, so a refused dispatch never reaches the queue,
          // never reaches `claude -p`, and costs nothing.
          //
          // Scope is deliberately narrow (see workspace-precondition.ts): only
          // a ticket-bound dispatch of a code-producing role. Every ticket-less
          // invocation on this queue - one-shot classifiers, plan-mode calls,
          // supervisor children, the headless /v1 + widget surfaces - and every
          // non-code role on a repo-less project is untouched.
          const precondition = decideWorkspacePrecondition({ ticketId, role, repoUrl });
          if (precondition.refusal) {
            // Board visibility first, then fail the run. Throwing
            // NonRetriableError means the `finish` step never runs, so the row
            // ends `failed` (via runAgentFailed) rather than `done` - a
            // precondition failure must not read like a success.
            //
            // `requiresWorkspace` implies a ticket by construction, so the
            // notice always has one to post on; narrowed rather than asserted,
            // and the throw below is unconditional either way.
            if (ticketId) {
              await noticeWorkspacePreconditionRefusal({
                ticketId,
                tenantId,
                runId,
                role: role ?? null,
                refusal: precondition.refusal,
              });
            }
            console.error(
              `[run-agent] run=${runId} ticket=${ticketId} role=${role ?? "-"} refused: ` +
                `${precondition.refusal.code} - ${precondition.refusal.message}`,
            );
            // NonRetriable on purpose: a missing repo does not become present
            // on retry, and burning Inngest's attempts on it would only delay
            // the operator seeing the reason. It also does not touch
            // `tickets.retry_count`, which belongs to the engineer↔QA reject
            // loop - a precondition refusal is not a QA rejection and must not
            // consume that budget.
            throw new NonRetriableError(
              `workspace precondition failed (${precondition.refusal.code}): ${precondition.refusal.message}`,
            );
          }

          await redis().lpush(
            LOCAL_CC_QUEUE,
            JSON.stringify({
              jobId: id,
              runId,
              tenantId,
              iterationIdx: i,
              prompt: turnPrompt,
              systemPrompt,
              engineUrl: env.LOCAL_CC_ENGINE_URL,
              // Phase 1 / M0 — runner uses this to prepare a git workspace
              // when ENGINEER_REPO_URL is set. Null when the run isn't
              // attached to a ticket (e.g. ad-hoc smoke tests).
              ticketId: ticketId ?? null,
              // C4 — human-readable branch slug resolved from tickets.title
              // (cached on tickets.git_branch_name). Null means the runner
              // falls back to slugify(ticketId) — its pre-C4 behaviour.
              ticketSlug: ticketSlug ?? null,
              // Post-F5 / role-stamping — the role slug for THIS run. The
              // runner injects it as `DEVPILOT_ROLE` into the claude env so the
              // MCP relay can stamp comment author_id with the real role
              // (engineer/qa/verifier/…) instead of the legacy literal
              // "claude". This restores the dispatcher's state-machine
              // fallback (`agentAuthors.includes("engineer")` etc.) as a
              // real safety net under the F2 classifier path.
              role: role ?? null,
              // Phase 2 / M5a — per-project repo + GitHub OAuth. All four
              // are nullable; the runner falls back to its env vars when
              // missing. NEVER log githubToken downstream.
              repoUrl,
              githubToken,
              gitAuthorName,
              gitAuthorEmail,
              // Slice A — per-project encrypted secrets as a serialised
              // JSON object ({"KEY":"value",…}) or null when the project
              // has no secrets. The runner writes <workspace>/.env.local
              // from this AND merges it into envOverrides so `claude -p`
              // and `pnpm dev` both see the values. NEVER log this.
              projectSecretsJson,
              // Slice IB — integration branch (or default_branch fallback)
              // the workspace clones from. Null preserves legacy behavior
              // (clone the repo's default branch).
              baseBranch,
              // WI-5.2 — cut the ticket branch from this exact commit on
              // baseBranch (a landed builds_on parent's sha). Null = branch from
              // the tip, the legacy path.
              baseSha,
              // Slice IB-B — override the workspace path key when this is a
              // merger run (release_engineer) so it re-enters the source
              // ticket's checkout (with conflict markers in place) rather
              // than cloning a fresh per-merger directory. Null elsewhere.
              workspaceTicketId,
              // WI-12 — the model id/alias for `claude -p --model`. NULL for
              // every project that hasn't explicitly configured one, and the
              // runner then emits no `--model` at all: today's exact behaviour
              // (the account default) is what a null preserves. Resolved
              // server-side in `resolve-provider` above — the runner never picks
              // its own model.
              model: routing.claudeModel,
              // Phase 3 (ticket screenshots) — number of image attachments the
              // runner should fetch from GET /api/runs/[id]/attachments and
              // deliver as Read-able files. 0/absent = don't call the endpoint
              // (the common case). A HINT only; the endpoint is authoritative.
              attachmentCount,
              // L1 / B2 — the recording switch, resolved by the ENGINE and
              // shipped per job. Previously the runner read its own host's
              // `ENGINEER_QA_VERIFY_ENABLED`, so "gate enabled here, runner
              // never recording" was a silently valid configuration — and that
              // is the one prod was in (all 20 failing-build QA rejects had no
              // `run_verifications` row, every one allowed by the fail-open
              // rule). Enabling the gate now implies recording; see
              // `lib/board/qa-verify-flag.ts`.
              qaVerifyEnabled: resolveQaVerifyEnabled(),
              // Workspace precondition, runner half. The ENGINE decides whether
              // this job needs a checkout and stamps the answer; the runner
              // refuses to spawn `claude -p` when the stamp says yes and no
              // workspace was prepared. Stamped as its OWN field rather than
              // re-derived from `ticketId` on the far side precisely so a
              // ticketId lost or garbled between enqueue and claim is DETECTED
              // (stamp says workspace required, job arrives ticket-less ->
              // refusal) instead of silently degrading to a blind run.
              // Absent on the two ticket-less enqueuers (local-cc-oneshot,
              // plan/runner-bridge), where the runner's own default is `false`.
              requiresWorkspace: precondition.requiresWorkspace,
              // L1 / B2 — the integration/base branch this workspace was cut
              // from, so the runner can answer "does delivered work exist on
              // this branch at all" (`commits_ahead`) and not only "did THIS
              // run commit" (`base_sha === head_sha`). Null degrades to the
              // pre-B2 behaviour.
              qaBaseBranch: baseBranch,
              // Empty-delivery nudge — is THIS role's deliverable committed
              // source? A property of the ROLE, resolved from the engine-owned
              // `lib/roles/code-producing.ts`, which is the SAME catalog
              // `decideQaGate` consults; stamping it means the seam that warns
              // the agent and the gate that refuses it can never disagree about
              // which roles are expected to commit.
              //
              // Stamped rather than re-derived on the runner for the reason
              // `requiresWorkspace` is (see `workspace-precondition.ts`): the
              // runner cannot import from apps/web, and a second hand-maintained
              // copy of that membership list would drift silently — in the
              // direction that wedges a role. Absent on the two ticket-less
              // enqueuers and on any pre-nudge engine, where the runner's own
              // default is `false` (no nudge), i.e. today's behaviour exactly.
              codeProducing: isCodeProducingRole(role),
              // Verdictless-review nudge — does THIS role's contract make its
              // success state the VERDICT (`onSuccessStatus === 'done'`)? Read
              // through `loadRoleConfig`, which is the SAME resolver
              // `reconcileTicketAfterRun` uses to decide whether to park a
              // verdictless run, so the seam that warns the reviewer and the
              // policy that parks it cannot disagree about who owes a verdict.
              //
              // `loadRoleConfig` fast-paths the built-in catalog with NO DB
              // read, so this costs nothing on the overwhelming majority of
              // dispatches; the one query it does make is for a CUSTOM
              // JD-synthesized role, which is precisely the case a static list
              // on the runner side could not see at all. A failed lookup
              // returns null -> not a verdict role -> no nudge, i.e. today's
              // behaviour.
              verdictRole: role ? isVerdictRoleConfig(await loadRoleConfig(tenantId, role)) : false,
              // Is this the run's last turn? A reviewer nudged mid-review would
              // be pushed to decide before it has finished looking. Today every
              // dispatch sends `iterations: 1` so this is always true — stamped
              // anyway rather than assumed, because the assumption is invisible
              // at the point that would break it.
              finalIteration: i === endIdx - 1,
            }),
          );
          return id;
        });

        // Phase 0: match by runId only (one in-flight job per run at a time).
        // M-future: extend to multi-job-per-run with `if` once we re-verify CEL
        // syntax against the deployed Inngest version.
        const ev = await step.waitForEvent(`lc-await-${i}`, {
          event: "runner/step-result",
          timeout: LOCAL_CC_TIMEOUT,
          match: "data.runId",
        });
        if (!ev) {
          // The runner never posted a step-result within LOCAL_CC_TIMEOUT — the
          // `claude -p` child on the runner host is almost certainly still alive
          // and chewing the subscription with no way for the engine to reach a
          // process on a remote host. LPUSH a kill request so the runner's
          // cancel consumer tears it down. Best-effort, in its own durable step
          // so an Inngest replay can't double-enqueue; the run still fails below.
          await step.run(`lc-cancel-${i}`, async () => {
            try {
              await redis().lpush(
                LOCAL_CC_CANCEL_QUEUE,
                JSON.stringify({ runId, reason: "timeout", timeoutHint: LOCAL_CC_TIMEOUT }),
              );
            } catch (err) {
              console.warn(
                `[run-agent] failed to enqueue cancel for run=${runId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          });
          throw new NonRetriableError(`local-cc step ${i} timed out after ${LOCAL_CC_TIMEOUT}`);
        }
        if (!ev.data.ok || !ev.data.result) {
          throw new NonRetriableError(
            `local-cc step ${i} reported failure: ${ev.data.error ?? "unknown"}`,
          );
        }
        result = {
          text: ev.data.result.text,
          usage: ev.data.result.usage,
          finishReason: ev.data.result.finishReason as StepResult["finishReason"],
          modelId: ev.data.result.modelId,
          // Phase 1 / M0 — runner stamps the absolute workspace cwd onto the
          // event when ENGINEER_REPO_URL is set; null otherwise.
          workspacePath: (ev.data as { workspacePath?: string | null }).workspacePath ?? null,
        };
      } else {
        throw new NonRetriableError(`unknown runnerPolicy: ${effectivePolicy}`);
      }

      // -------- Persist + record spend (kind-agnostic) -------------------
      await step.run(`persist-${i}`, async () => {
        const modelId = result.modelId ?? MODEL_IDS[modelTier];
        // WI-12 — provider-aware. An unrecognised ANTHROPIC id is now priced at
        // the requested tier instead of silently costing 0 (which is what the old
        // `tierFromModelId(...) ?? 0` did to every dated/overridden model id, and
        // it fed a budget guard that then never tripped). A self-hosted /
        // OpenAI-compatible endpoint is an EXPLICIT, labelled zero — we have no
        // price table for it, and inventing one would corrupt the gate the other
        // way. `priced`/`basis` ride along so a zero is legible in the trace.
        const cost = stepCost({
          provider: routing.provider,
          requestedTier: modelTier,
          modelId,
          usage: result.usage,
        });
        const cents = cost.cents;

        const lf = langfuseForTenant(tenantId);
        const gen = lf.generation({
          traceId: runId,
          name: `think-${i}`,
          model: modelId,
          input: { prompt: turnPrompt, systemPrompt },
          output: result.text,
          usage: result.usage
            ? {
                input: result.usage.promptTokens,
                output: result.usage.completionTokens,
                total: result.usage.totalTokens,
                unit: "TOKENS",
              }
            : undefined,
          metadata: {
            runnerKind: effectivePolicy,
            cost_cents: cents,
            cost_priced: cost.priced,
            cost_basis: cost.basis,
            llm_provider: routing.provider,
          },
        });
        gen.end();
        await lf.flushAsync();

        const supabase = supabaseService();
        const { error: stepErr } = await supabase.from("run_steps").insert({
          run_id: runId,
          idx: i,
          kind: "think",
          payload: {
            prompt: turnPrompt,
            text: result.text,
            model: modelId,
            runner_kind: effectivePolicy,
            role: role ?? null,
            usage: result.usage,
            cost_cents: cents,
            // WI-12 — `cost_priced: false` means "we can't price this", NOT
            // "free". Without it a self-hosted run and a zero-token run are the
            // same 0 on the Run Inspector.
            cost_priced: cost.priced,
            cost_basis: cost.basis,
            llm_provider: routing.provider,
            finish_reason: result.finishReason,
            // Per-step deep link into Langfuse observation; falls back to trace URL.
            langfuse_observation_id: gen.id,
            // Phase 1 / M0 — runner cwd for this step; null for the API runner
            // and for local-cc runs where no workspace was prepared.
            workspace_path: result.workspacePath ?? null,
          },
        });
        if (stepErr) throw new Error(`persist step failed: ${stepErr.message}`);
        await recordSpend(runId, cents);
      });

      lastText = result.text;

      // Post-step ceiling check — closes the turnstile gap (budget.ts's
      // header, and the evidence in budget-ceiling-policy.ts). The pre-step
      // check above only ever refused a NEW action from starting; it never
      // looked again once that action's actual cost was known. Because every
      // dispatch sends `iterations: 1`, a run's one step IS its whole
      // lifecycle, so without this the cap was checked once at spent=0 (which
      // trivially passes) and never again — an overshooting step simply
      // completed and the run finished `done` as if it had stayed in budget.
      //
      // Re-running the SAME check immediately after this step's spend just
      // landed stops the run here, cleanly, before the loop's next iteration
      // OR role postprocess can spend anything further. The step that just
      // ran is never interrupted — its committed work (git commits, ticket
      // moves the agent already made via its own tool calls, the run_steps
      // row and spend just persisted above) is untouched either way; at most
      // one step's worth of overshoot is possible, exactly as designed.
      await step.run(`budget-stop-${i}`, async () => {
        await assertCanProceed(runId, "llm", {
          overrideCap: routing.budgetCapOverrideEnabled,
        });
      });
    }

    // 2. Role-specific side effects (comment + ticket transition + dispatch).
    let postOutcome: { next: "dispatch" | "done" | "failed"; detail?: string } | null = null;
    if (role && ticketId && lastText) {
      // M5 — display name preferentially comes from the dispatch event
      // (resolved at dispatch time for custom roles); fall back to the
      // built-in ROLES map for safety, then to the raw slug.
      const displayName =
        agentDisplayName ?? (isBuiltinRole(role) ? ROLES[role as Role].displayName : role);
      postOutcome = await step.run("role-post", async () => {
        // Uniformly non-fatal, mirroring the `reconcile-ticket` step below. The
        // model step has already finished cleanly by the time we get here, so a
        // postprocess side-effect must never fail the RUN. PM/engineer harden
        // their own FSM-illegal transitions (park to `blocked`); this net catches
        // anything they re-raise (infra/DB) or any other role's throw, logs it,
        // and returns a degraded outcome so the `finish` step still marks the run
        // `done` and `reconcile-ticket` gets its normal chance to recover the
        // ticket. Without it, the throw exhausts Inngest retries and the run is
        // spuriously reported FAILED.
        try {
          return await applyRolePostProcess({
            role: role as Role,
            ticketId,
            tenantId,
            agentDisplayName: displayName,
            finalText: lastText!,
            // Phase 1 / M7 — runId lets postprocess persist a branch_key onto
            // this run row when the role declares a `branches` map.
            runId,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.warn(
            `[run-agent] role-post failed for run=${runId} ticket=${ticketId} role=${role}: ${detail}`,
          );
          return { next: "failed" as const, detail };
        }
      });
    }

    // 3. Finalise run row.
    //    Conditional on status='running' so a concurrent pause/cancel/reaper
    //    that already flipped the row to a terminal state isn't clobbered
    //    here. Matches the pattern in cascade-kill.ts and stale-run-reaper.ts.
    await step.run("finish", async () => {
      const supabase = supabaseService();
      const { error } = await supabase
        .from("runs")
        .update({ status: "done", last_event_at: new Date().toISOString() })
        .eq("id", runId)
        .eq("status", "running");
      if (error) throw new Error(`finish failed: ${error.message}`);
    });

    // Phase 1 / M3 — fire the completion event the WIP-drain dispatcher
    // subscribes to. Emitting from a separate durable step keeps it idempotent
    // on Inngest replays.
    //
    // Phase 1 / M6 — forward fanOutGroup + fanOutPhase so the aggregator can
    // route on cohort without a DB hop. The aggregator IS idempotent against
    // missing fields (it re-reads the run row when needed) but the fast path
    // skips the lookup.
    await step.sendEvent("emit-completed", {
      name: "agent/run.completed",
      data: {
        runId,
        tenantId,
        ticketId,
        agentId,
        role,
        status: "done" as const,
        fanOutGroup,
        fanOutPhase,
      },
    });

    // 4. Post-completion reconciliation. If this run finished 'done' but the
    //    ticket is provably untouched (status unchanged since the snapshot,
    //    no devpilot_move_ticket call, no sibling run in flight, no postprocess
    //    dispatch), advance it per the role's FSM contract so it can't
    //    strand in `in_progress`. Runs AFTER emit-completed so a reconciler
    //    hiccup can never block the WIP-queue drain; best-effort by design —
    //    the stuck-ticket sweeper cron is the backstop.
    const reconciled = await step.run("reconcile-ticket", async () => {
      if (!ticketId) return { skipped: "no-ticket" };
      // Fan-out cohort runs are owned by the fan-in aggregator (which claims
      // a fan_in_decisions row and fires exactly one transition/dispatch per
      // cohort) — reconciling a sibling here would race it.
      if (fanOutGroup) return { skipped: "fan-out-cohort" };
      try {
        return await reconcileTicketAfterRun({
          runId,
          tenantId,
          ticketId,
          role: role ?? null,
          agentId: agentId ?? null,
          statusAtRunStart: ticketAtStart?.status ?? null,
          postNext: postOutcome?.next ?? null,
          runStartedAtIso: ticketAtStart?.atIso ?? null,
        });
      } catch (err) {
        // Lost races surface as `{ skipped: "lost-transition-race" }` from
        // the reconciler's compare-and-swap, not as errors. Anything landing
        // here is a genuine failure — logged and left to the sweeper.
        console.warn(
          `[run-agent] reconcile-ticket failed for run=${runId} ticket=${ticketId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { skipped: "reconcile-error" };
      }
    });

    return {
      runId,
      output: lastText,
      iterations: totalIters,
      runnerPolicy,
      role,
      postOutcome,
      reconciled,
    };
  },
);

/**
 * Inngest failure handler. Marks the run row failed and logs why.
 */
export const runAgentFailed = inngest.createFunction(
  { id: "run-agent-failed" },
  { event: "inngest/function.failed" },
  async ({ event }) => {
    const originalData = (event.data as { event?: { data?: { runId?: string } } })?.event?.data;
    const runId = originalData?.runId;
    if (!runId) return { skipped: true };

    const reason = (event.data as { error?: { message?: string } })?.error?.message ?? "unknown";
    const supabase = supabaseService();

    // Read the run row up front. If status !== 'running', something external
    // already terminated this run (pauseTicket → 'cancelled', runner-watchdog
    // → 'failed' with status_reason='runner-disconnected', stale-reaper →
    // 'failed', etc.). In those cases the terminator owns drain + supervision
    // exclusively; we still write the audit step for the trace but skip the
    // status flip, completion emit, and supervision retry to avoid a
    // double-emission that would spuriously fire restart_n_times or
    // re-drain the dispatch_queue twice.
    const { data: runRow } = await supabase
      .from("runs")
      .select(
        "tenant_id, agent_id, ticket_id, parent_run_id, attempt_index, budget_cents, spent_cents, supervision_strategy, runner_kind, status",
      )
      .eq("id", runId)
      .maybeSingle();
    const statusWhenFired = (runRow?.status as string | undefined) ?? null;

    // Audit step lands regardless — useful for "why did this run end" trace.
    await supabase.from("run_steps").insert({
      run_id: runId,
      idx: 9999,
      kind: "system",
      payload: {
        failed_reason: reason,
        status_when_handler_fired: statusWhenFired,
      },
    });

    if (statusWhenFired !== "running") {
      return {
        runId,
        skipped: "externally-terminated",
        status: statusWhenFired,
      };
    }

    // Normal path: this is a genuine in-flight failure (uncaught exception,
    // NonRetriableError from outside the pause path, etc.). Conditional
    // UPDATE keeps the change idempotent under Inngest retry.
    //
    // `reason` above is already the raw error message for EVERY throw site in
    // the run loop (a timed-out waitForEvent, a runner-reported step
    // failure, a refused workspace precondition, an unrecognised runner
    // policy, an init failure, or a genuinely uncaught exception) — this is
    // the ONE choke point all of them funnel through. Classifying it here
    // means `status_reason` is never NULL on a failed run and distinguishes
    // those causes from each other, not just from "no reason recorded".
    await supabase
      .from("runs")
      .update({
        status: "failed",
        status_reason: classifyRunFailureReason(reason),
        last_event_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("status", "running");

    if (runRow?.tenant_id) {
      await inngest.send({
        name: "agent/run.completed",
        data: {
          runId,
          tenantId: runRow.tenant_id as string,
          ticketId: (runRow.ticket_id as string | null) ?? undefined,
          agentId: (runRow.agent_id as string | null) ?? undefined,
          status: "failed" as const,
        },
      });

      // Phase 1 / M9 — apply supervision strategy AFTER the completion
      // event is sent. Order matters: the dispatch-queue drain that listens
      // on agent/run.completed runs in parallel with this. The strategy
      // outcomes (restart-spawned, escalated) write their own events / DB
      // updates and don't interact with the drain.
      const outcome = await applySupervisionStrategy({
        failedRunId: runId,
        reason,
        run: {
          id: runId,
          tenantId: runRow.tenant_id as string,
          agentId: (runRow.agent_id as string | null) ?? null,
          ticketId: (runRow.ticket_id as string | null) ?? null,
          parentRunId: (runRow.parent_run_id as string | null) ?? null,
          attemptIndex: (runRow.attempt_index as number | null) ?? 0,
          budgetCents: (runRow.budget_cents as number | null) ?? 0,
          spentCents: (runRow.spent_cents as number | null) ?? 0,
          supervisionStrategyRaw: (runRow.supervision_strategy as string | null) ?? null,
          runnerKind: (runRow.runner_kind as "api" | "local-cc" | null) ?? null,
        },
      });
      // Audit the outcome onto the failed run.
      await supabase.from("run_steps").insert({
        run_id: runId,
        idx: 99_997,
        kind: "system",
        payload: { supervision_outcome: outcome },
      });
      return { runId, marked: "failed", reason, supervision: outcome };
    }
    return { runId, marked: "failed", reason };
  },
);
