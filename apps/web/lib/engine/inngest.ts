// Inngest client. One instance per app — durable functions register against it
// and the /api/inngest route exposes them to the Inngest runtime.
//
// Locally, run `pnpm --filter @devpilot/web dev:inngest` (see scripts) to start the
// Inngest dev server on :8288, which auto-discovers this app.

import { Inngest, EventSchemas } from "inngest";

// `role` is a free-form string from M5 onward. Built-in roles keep their
// fixed slugs ("pm" | "engineer" | …), but custom roles synthesized from a
// JD have arbitrary slugs (e.g. "loc_reviewer"). The runtime dispatcher uses
// `lib/roles/load.ts` to resolve a slug into a RoleConfig at request time.
export type Events = {
  "agent/run.requested": {
    data: {
      runId: string;
      tenantId: string;
      agentId?: string;
      ticketId?: string;
      prompt: string;
      systemPrompt?: string;
      iterations?: number;
      modelTier?: "default" | "heavy" | "cheap";
      budgetCents?: number;
      runnerPolicy?: "api" | "local-cc";
      role?: string;
      /** Display name resolved at dispatch time. Avoids a DB hit in postprocess. */
      agentDisplayName?: string;
      // Phase 1 / M6 — parallel fan-out / fan-in fields. Present only when this
      // run is one of N siblings emitted by the dispatcher in a single
      // transition. The aggregator joins on `fanOutGroup` to detect the cohort.
      /** UUID identifying the sibling cohort; null on Phase 0 single-emit runs. */
      fanOutGroup?: string;
      /** Phase label scoped to the cohort (e.g. "review"). Default "review". */
      fanOutPhase?: string;
      /** Total siblings the dispatcher fanned out for this cohort. */
      fanOutSize?: number;
      /**
       * Acceptance strategy snapshotted at dispatch time:
       *   'single'     — solo run, ignore fan_out_group (kept for symmetry).
       *   'all'        — every sibling must complete.
       *   'quorum(n)'  — first N completed siblings satisfy the cohort.
       */
      acceptanceStrategy?: string;
      // Phase 2.5 / M6 — multi-stage cohort plan attribution. Stamped on
      // sibling runs seeded by `selectCohortForDispatch`. Present only for
      // runs that come from a `tickets.cohort_plan` (legacy single-cohort
      // and single-emit runs leave these undefined). The runtime stamps
      // matching `runs.cohort_key` / `runs.cohort_depth` columns from these.
      /** Cohort plan entry key whose member this run is filling. */
      cohortKey?: string;
      /** Nesting depth of the cohort entry (0 = top-level). */
      cohortDepth?: number;
      /** Parent run id — set for nested cohorts: the leaf whose completion
       *  triggered this child cohort. undefined for top-level cohorts. */
      parentRunId?: string;
      // Phase 1 / M13 — Replay. The think-loop normally starts at iteration 0
      // and inserts `run_steps` rows with idx=0,1,2…. When a run is a replay
      // clone of an original, the replay engine pre-copies the original's
      // steps up to `fromStepIdx` into the clone, so the new loop MUST start
      // at idx `fromStepIdx` to avoid the `run_steps (run_id, idx)` unique
      // collision. `null`/undefined ⇒ start at 0 (the Phase 0 behaviour).
      startIterationIdx?: number;
    };
  };
  // Phase 1 / M13 — Replay / time-travel from any step. The Run Inspector's
  // "Replay from here" button POSTs to `/api/runs/[id]/replay`, which emits
  // this event. The `replayRun` Inngest function (lib/engine/replay.ts) clones
  // the run row, copies run_steps up to `fromStepIdx`, then re-emits
  // `agent/run.requested` with `startIterationIdx = fromStepIdx`.
  "agent/run.replay-requested": {
    data: {
      originalRunId: string;
      tenantId: string;
      /** 0-based step index to resume from. 0 ⇒ replay the whole loop. */
      fromStepIdx: number;
      overrides?: {
        promptOverride?: string;
        systemPromptOverride?: string;
        modelTierOverride?: "default" | "heavy" | "cheap";
        budgetCentsOverride?: number;
      };
      /**
       * Why this replay was fired. Drives the replay cap split:
       *   'operator'     — Run Inspector "Replay from here" button. Counted
       *                    against DEVPILOT_MAX_REPLAYS_PER_RUN (default 5) — this
       *                    is the "you're debugging in circles" guardrail.
       *   'resume'       — User clicked Resume on a paused/failed ticket.
       *                    Uncounted in the operator cap; bounded separately.
       *   'auto-recover' — Runner watchdog or stale-run reaper auto-recovered
       *                    after a runner disconnect / deep stall. Uncounted.
       * Defaults to 'operator' when absent so the legacy Inspector path keeps
       * its existing cap behaviour without a code change.
       */
      replayReason?: "operator" | "resume" | "auto-recover";
    };
  };
  "ticket/dispatch-needed": {
    data: {
      ticketId: string;
      tenantId: string;
      // Phase 2.5 / M6 — transient hint from the fan-in aggregator. When the
      // aggregator decides a cohort and the cohort's `fan_in_role` is set,
      // it emits ticket/dispatch-needed with `forceRole = fan_in_role`. The
      // dispatcher's decideNextRole honors this once (the receiving role
      // becomes the picked role even if the state machine would pick
      // something else) and does NOT persist it — a subsequent natural
      // dispatch event for the same ticket runs through the normal walk.
      //
      // Chosen over "stamp a temporary requested_role on the ticket row"
      // because (a) it keeps the override scoped to a single event, (b) it
      // doesn't need a follow-up DB clear that could race with builder
      // mutations, and (c) the dispatcher already treats requested_role as
      // a first-dispatch-only signal that gets consumed differently.
      forceRole?: string;
    };
  };
  "agent/run.completed": {
    data: {
      runId: string;
      tenantId: string;
      ticketId?: string;
      agentId?: string;
      role?: string;
      status: "done" | "failed";
      // Phase 1 / M6 — copied verbatim from the run row so the aggregator can
      // route on fan-out cohort without a DB lookup on the hot path.
      fanOutGroup?: string;
      fanOutPhase?: string;
      // Phase 2.5 / M6 — cohort attribution from the completed run row.
      // Both fall back to a DB lookup in the aggregator if absent (older
      // legacy emit paths don't carry these).
      cohortKey?: string;
      cohortDepth?: number;
    };
  };
  "agent/run.human-reply": {
    data: {
      runId: string;
      ticketId?: string;
      body: string;
    };
  };
  "runner/step-result": {
    data: {
      jobId: string;
      runId: string;
      ok: boolean;
      result?: {
        text: string;
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
        finishReason?: string;
        modelId?: string;
      };
      error?: string;
      /**
       * Absolute workspace path the runner used for this step, recorded onto
       * `run_steps.payload.workspace_path` by `runAgent` (which is what the
       * workspace reaper and the foreign-host guards later read).
       *
       * The step-result route has always SENT this and `runAgent` has always
       * READ it (behind a cast, because it was declared nowhere) - it was
       * carried by the SDK's permissive generic inference rather than by the
       * schema. Declared here so the two ends are type-checked against each
       * other; surfaced by routing the send through `sendEventBounded`, whose
       * parameter is the concrete payload type.
       */
      workspacePath?: string | null;
    };
  };
  // Phase 1 / M0 Wave 3 — engine-side reaper announces workspaces that should
  // be cleaned. Runners that own those workspaces subscribe and delete the
  // directory. Engine never touches the filesystem itself (cross-host safety).
  "workspace/cleanup-requested": {
    data: {
      tenantId: string;
      ticketId: string;
      /** Distinct workspace paths discovered across the ticket's run history. */
      paths: string[];
      reason: string;
      /**
       * DELIBERATE-DISCARD override. When true, the runner's `cleanupWorkspace`
       * skips its reap guard and wipes the workspace even if it holds unpushed
       * commits. Set ONLY by the operator "Discard & restart from dev" action
       * (an explicit, confirmed, human-initiated discard). The automatic reaper
       * and the safe "Restart from dev" NEVER set it, so their refuse-on-unpushed
       * guard stays fully intact. Absent / false everywhere else.
       */
      force?: boolean;
    };
  };
  // Phase 1 / M8 — Cascade-kill telemetry. Emitted by `cascadeKillOnFailure`
  // after it terminates a failed-parent's descendant subtree. Consumed by
  // ops dashboards / alerting; no engine function should react to it.
  "ops/cascade-kill": {
    data: {
      parentRunId: string;
      killedCount: number;
      descendantsTotal: number;
    };
  };
  // Phase 2 / M0 — Manual trigger for the stale-run reaper. The reaper also
  // runs on a cron (*/5); this event lets the acceptance script invoke it
  // synchronously without waiting for the next tick.
  "internal/reap-stale-runs": {
    data: Record<string, never>;
  };
  // PR3 (pause/resume) — Manual trigger for the runner watchdog. The watchdog
  // also runs on a cron (* * * * *); this event lets tests + ops tooling fire
  // it synchronously to confirm a dead runner's reaping without waiting up to
  // 60s for the next tick.
  "internal/runner-watchdog": {
    data: Record<string, never>;
  };
  // Stuck-ticket sweeper manual trigger. The sweeper also runs on a cron
  // (*/5 * * * *); this event lets ops tooling + acceptance scripts fire a
  // sweep synchronously (see lib/engine/stuck-ticket-sweep.ts).
  "internal/stuck-ticket-sweep": {
    data: Record<string, never>;
  };
  // Orphaned-ticket reaper manual trigger. Also runs on a cron (*/5 * * * *);
  // this event lets ops tooling + acceptance scripts recover a ticket stranded
  // in an agent-owned state with no live run and no queued dispatch without
  // waiting for the next tick (see lib/engine/orphan-ticket-reaper.ts).
  "internal/reap-orphan-tickets": {
    data: Record<string, never>;
  };
  // Never-triggered-land sweep manual trigger. Also runs on a cron
  // (*/5 * * * *); this event lets ops tooling recover an `integration_queue`
  // row left `pending` by a lost `integration/land-needed` event without
  // waiting for the next tick (see lib/engine/land-rescue-reaper.ts).
  "internal/rescue-stalled-lands": {
    data: Record<string, never>;
  };
  // Unqueued-land sweep manual trigger. Also runs on a cron (*/5 * * * *); this
  // event lets ops tooling recover a `done`, unlanded, branch-bearing ticket
  // that has NO `integration_queue` row at all - the shape the two queue-driven
  // reapers above structurally cannot see, because both select FROM the queue
  // (see lib/engine/unqueued-land-reaper.ts).
  "internal/rescue-unqueued-lands": {
    data: Record<string, never>;
  };
  // Merger-outcome sweep manual trigger. Also runs on a cron (*/5 * * * *); this
  // event lets ops tooling record the terminal `nothing_to_land` outcome for a
  // finished MERGER ticket, which can never land by design (it resolves its
  // conflict on the SOURCE ticket's branch) and which nothing else will ever
  // write an outcome for (see lib/engine/merger-outcome-reaper.ts).
  "internal/record-merger-outcomes": {
    data: Record<string, never>;
  };
  // Manual trigger for the dispatch-rescue sweep, which otherwise runs on a
  // cron (*/5 * * * *). Lets ops tooling release a `dispatch_queue` row left
  // `pending` by a lost `agent/run.completed` without waiting for the next
  // tick (see lib/engine/dispatch-rescue.ts).
  "internal/rescue-stalled-dispatches": {
    data: Record<string, never>;
  };
  // Manual trigger for the engine-liveness canary, which otherwise runs on a
  // cron (* * * * *). The canary's stamp is the gate the runner-resident
  // project supervisor uses to decide whether the engine's own cron recovery is
  // alive; this event lets an acceptance script prove the round trip without
  // waiting for the tick (see lib/engine/liveness.ts).
  "internal/stamp-engine-liveness": {
    data: Record<string, never>;
  };
  // Phase 2 / M5c — Pending-push tracker telemetry. Emitted by
  // `pendingPushTracker` (lib/engine/pending-push-tracker.ts) after it upserts
  // a `pending_pushes` row. The badge UI is driven by Supabase realtime on the
  // table itself; these typed events exist for downstream listeners (e.g.
  // notification fan-out) that A6/A7 may add later.
  "pending_push.upserted": {
    data: {
      pendingPushId: string;
      projectId: string;
      tenantId: string;
      commits: number;
    };
  };
  // Emitted by the Push & PR server action (A7) after a successful push.
  "pending_push.cleared": {
    data: {
      pendingPushId: string;
      projectId: string;
      tenantId: string;
      prUrl?: string;
    };
  };
  // Phase 2 / M5e — "Run" button. Emitted by the start server action
  // (`startDevServerForProjectAction` in B3). Consumed by `startDevServer`
  // (lib/engine/dev-server-control.ts), which pushes a start message onto
  // the Redis control queue for the runner-side dev-server loop (B2) and
  // flips the session row to status='starting'.
  "dev_server.start_requested": {
    data: {
      sessionId: string;
      tenantId: string;
      projectId: string;
      workspacePath: string;
      branch: string;
      // Single-line shell command (e.g. "pnpm dev"). The runner re-splits by
      // whitespace; v1 doesn't honour shell metacharacters.
      command: string;
      portHint?: number;
      ticketId?: string;
      pendingPushId?: string;
      startedByUserId: string;
      // "Skip & start anyway" — bypass the runner's required-env gate.
      skipEnvCheck?: boolean;
      // Auto-recovery: when the on-disk workspace has been cleaned up
      // between the original prep run and the operator's "Run on
      // localhost" click, the start action embeds repoUrl + branch (plus
      // an optional short-lived GitHub token) so the runner can fresh-
      // clone before spawning. Absent for the steady-state path where
      // the workspace is still present.
      prepareIfMissing?: {
        repoUrl: string;
        branch: string;
        githubToken?: string;
      };
    };
  };
  // Emitted by the stop server action and by `devServerReaper` (idle/reaper
  // paths). Consumed by `stopDevServer`, which pushes a stop message onto
  // the Redis control queue.
  "dev_server.stop_requested": {
    data: {
      sessionId: string;
      tenantId: string;
      // Why this stop fired:
      //   'user'            — operator clicked Stop in the UI.
      //   'idle'            — reaper found last_interaction_at > 30 min.
      //   'ticket_terminal' — owning ticket transitioned to done/failed.
      //   'reaper'          — runner went away (no heartbeat > 90s).
      reason: "user" | "idle" | "ticket_terminal" | "reaper";
    };
  };
  // Emitted by the runner-side dev-server loop (B2) every ~3s while a
  // session is starting/running. The heartbeat HTTP endpoint translates
  // these into UPDATEs against `dev_server_sessions`; the typed Inngest
  // event exists for downstream listeners (notification fan-out, ops
  // dashboards) that may be wired later.
  "dev_server.heartbeat": {
    data: {
      sessionId: string;
      status: "starting" | "running" | "stopped" | "errored" | "building" | "needs_env";
      statusReason?: string;
      port?: number;
      url?: string;
      pid?: number;
      logTail?: string;
    };
  };
  // Emitted by the heartbeat endpoint when a status transition happens
  // (starting→running, running→stopped, etc.). Drives notification fan-out
  // for "Your dev server is up at http://localhost:3100" toasts.
  "dev_server.status_changed": {
    data: {
      sessionId: string;
      tenantId: string;
      projectId: string;
      status: "starting" | "running" | "stopped" | "errored" | "building" | "needs_env";
      url?: string;
    };
  };
  // Phase 2.5+ / M7 (REVISION 2026-06-04) — Plan-mode runner-route events.
  // The server actions in apps/web/app/(app)/plan/actions.ts are
  // fire-and-forget — they insert the user message + emit one of these
  // events. The durable Inngest functions in apps/web/lib/plan/inngest.ts
  // execute the LLM call through the local-cc Redis queue (or the api
  // fallback) and insert assistant / system messages via Realtime.
  // Each event below carries a `runId` so the runner-bridge's
  // `match: "data.runId"` waitForEvent can correlate the runner's
  // step-result event back to the function invocation that enqueued it.
  // The action / orchestrator pre-allocates the uuid (randomUUID()).
  "plan/lead-reply.requested": {
    data: {
      sessionId: string;
      tenantId: string;
      runId: string;
    };
  };
  "plan/panel-step.requested": {
    data: {
      sessionId: string;
      tenantId: string;
      runId: string;
      lens: "pm" | "tech_lead" | "devops";
    };
  };
  "plan/consolidator.requested": {
    data: {
      sessionId: string;
      tenantId: string;
      runId: string;
      // The three panel drafts the consolidator merges. Shape mirrors
      // PanelDraft["proposedTickets"] from lib/plan/prompts.ts. Kept
      // loose at the event schema level (jsonb in Inngest's serializer
      // anyway) — the consolidator function Zod-validates on receive.
      drafts: {
        pm: Array<Record<string, unknown>>;
        tech_lead: Array<Record<string, unknown>>;
        devops: Array<Record<string, unknown>>;
      };
    };
  };
  "plan/build-orchestrator.requested": {
    data: {
      sessionId: string;
      tenantId: string;
      // The orchestrator allocates 4 runIds internally (one per panel + one
      // for the consolidator) since it's the function that drives step.invoke.
    };
  };
  // Phase 2.5++ / Scheduler — drain a project's backlog one ticket at a time.
  // Emitted by (a) the "Run now" server action immediately, and (b) the
  // every-minute cron when an active recurring/once schedule matches the
  // current wallclock minute. Consumed by `drainBacklogFn`.
  "ticket-drain/requested": {
    data: {
      tenantId: string;
      projectId: string;
      /** Set when the drain was fired by a scheduled row (so the function
       *  can write current_drain_run_id + clear it on completion). Null for
       *  ad-hoc "Run now" drains. */
      scheduleId?: string;
      /** Max tickets the drain keeps in flight at once (the sliding window).
       *  Absent ⇒ DEFAULT_DRAIN_PARALLELISM (3); 1 = strictly serial, the
       *  pre-windowing behaviour. The cron pulls this from
       *  `ticket_schedules.drain_parallelism` for scheduled drains; ad-hoc
       *  "Run now" callers pass it directly. Clamped 1..10 by the
       *  drainBacklogFn handler regardless of payload value. */
      drainParallelism?: number;
    };
  };
  // Phase 2 / M5j — auto-enrich a sparse ticket. Emitted by
  // `createTicketAction` after a successful insert, ONLY when the new row
  // is sparse (empty/short description OR empty acceptance_criteria) —
  // tickets created through the planning-commit path already come in rich
  // and don't need this. Consumed by `ticketAutoEnrichFn`.
  "ticket/auto-enrich.requested": {
    data: {
      ticketId: string;
      tenantId: string;
    };
  };
  // Fired by `createTicketCore` after a successful insert (both the human board
  // form and the agent's `devpilot_create_ticket` tool). Consumed by
  // `suggestTicketDepsFn`, which runs the Haiku dep-suggestion rerank OFF the
  // create request path (it used to be an inline await that hung "Creating…"
  // whenever the local-cc runner was busy) and parks the ranked result on
  // `tickets.suggested_dependencies` for the operator to accept/skip. Best-effort
  // like auto-enrich: a suggestion failure never affects the created ticket.
  // Fired by `triggerVercelDeployAction` immediately after Vercel accepts a
  // deployment. Consumed by `watchVercelDeploymentFn`, which polls the build to
  // a terminal state OFF the request path — a deploy takes minutes and nothing
  // that takes minutes may block a server action.
  //
  // NO agent path. There is no MCP tool and no engine caller that emits this;
  // the only producer is the human-gated server action. `triggerSource` exists
  // for the audit trail and for a later phase that may add agent PREVIEW
  // deploys — it is not a capability this event grants today.
  "vercel/deploy.requested": {
    data: {
      tenantId: string;
      projectId: string;
      ticketId: string | null;
      vercelDeploymentId: string;
      target: "production" | "preview";
      triggeredBy: string | null;
      triggerSource: "human" | "agent" | "git_push";
    };
  };
  "ticket/suggest-deps.requested": {
    data: {
      ticketId: string;
      tenantId: string;
      projectId: string;
      title: string;
      description: string;
    };
  };
  // Fired by createProjectWithNewRepoAction when it files the project's single
  // `project_scaffolder` ticket HELD (`backlog`, undispatched) because the
  // operator asked for a plan. Consumed by `scaffolderFallbackFn`, which sleeps
  // out the hold TTL and then releases the row IF it is still held.
  //
  // This is the abandonment safety net, not the happy path: a committed plan
  // releases the row inline (`commitPlanAction`), and the fallback then finds
  // nothing to claim and no-ops. It exists because an `auto_init: false` repo is
  // genuinely EMPTY - "the operator opened a plan and wandered off" must not be
  // a state where the project stays empty forever.
  "project/scaffolder-held": {
    data: {
      ticketId: string;
      tenantId: string;
      projectId: string;
    };
  };
  // Slice IB-C — fired by pushPendingChangesAction after a successful push.
  // Consumed by `buildsOnParentLanded` to post system comments on every
  // ticket that declared `builds_on <this-ticketId>`.
  "branch/parent-landed": {
    data: {
      ticketId: string;
      tenantId: string;
      integrationSha?: string | null;
      integrationBranch?: string | null;
    };
  };
  // WI-4 — the auto-land queue's pump. Consumed by `landTicketFn`, which claims
  // and fully lands ONE integration_queue row per invocation and then re-emits
  // this for the next one, until the project's queue is empty. A 5-minute cron
  // backs it up as a floor.
  //
  // `projectId` is NOT optional and must be non-null: it is the Inngest
  // concurrency key (`concurrency { limit: 1, key: event.data.projectId }`) that
  // serializes landing per project. An undefined key silently serializes
  // NOTHING, which is precisely why the land cadence is not driven off
  // `agent/run.completed` — that event carries no project at all.
  "integration/land-needed": {
    data: {
      tenantId: string;
      projectId: string;
    };
  };
  // Audit-grade PDF export — the async PROJECT scope. Emitted by
  // POST /api/export/projects/[id] AFTER it has asserted the caller's tenant
  // membership and written the `exports` job row.
  //
  // `exportId` is the ONLY field the worker trusts for authorisation: it re-reads
  // the job row and takes `tenant_id`/`project_id` from THERE, never from this
  // payload. The two ids below are duplicated onto the event purely so the
  // concurrency key can be evaluated without a DB read — the worker still
  // re-derives both from the row before touching any project data. Treat them as
  // routing metadata, not as facts.
  "export/project.requested": {
    data: {
      exportId: string;
      tenantId: string;
      projectId: string;
    };
  };
};

// Default Inngest dev-server host (matches the SDK's own `defaultDevServerHost`).
// `pnpm --filter web dev:inngest` serves both the sync API and the event API here.
const DEFAULT_INNGEST_DEV_SERVER_URL = "http://localhost:8288/";

// Make the client *authoritative* about dev routing instead of relying on the
// SDK's env inference alone.
//
// Why: the SDK derives dev/cloud mode from `INNGEST_DEV`, but its SEND path also
// honours `INNGEST_BASE_URL` / `INNGEST_EVENT_API_BASE_URL`, which take precedence
// over the dev-server default *even when the mode is explicitly dev*. So a stray
// cloud base-URL left in the environment silently routes `inngest.send()` to
// Inngest Cloud while `/api/inngest` still serves in dev (its base-URL resolution
// is independent). Locally emitted events (e.g. `dev_server.start_requested`) then
// never reach the local dev server, and the durable functions that depend on them
// never run - the exact split we hit under a local prod build (`next start`,
// NODE_ENV=production, INNGEST_DEV=1).
//
// Fix: when `INNGEST_DEV` signals dev, pin both `isDev` and the dev-server
// `baseUrl` on the client, overriding any cloud base-URL override. Real cloud
// deploys leave `INNGEST_DEV` unset, so this returns `{}` and the SDK's normal
// cloud inference/config is untouched. `process.env.INNGEST_DEV` is read as a live
// runtime value (Next does not inline it on the server), so a build produced
// without the flag still routes correctly when started with it.
function resolveInngestDevRouting(): { isDev?: boolean; baseUrl?: string } {
  const raw = process.env.INNGEST_DEV;
  if (raw == null || raw.trim() === "") return {};
  // Explicit-URL form (`INNGEST_DEV=http://host:port`): honour that dev host.
  try {
    return { isDev: true, baseUrl: new URL(raw).href };
  } catch {
    // Not a URL - fall through to the boolean form below.
  }
  // Boolean form (`INNGEST_DEV=1|true`): pin the default local dev server.
  // Anything else explicitly falsy (`0|false`) forces cloud.
  const truthy = ["1", "true"].includes(raw.trim().toLowerCase());
  return truthy ? { isDev: true, baseUrl: DEFAULT_INNGEST_DEV_SERVER_URL } : { isDev: false };
}

export const inngest = new Inngest({
  // The app id is the durable identity of every registered function: Inngest addresses a paused
  // run by (app id, function id, run id), so changing it orphans anything in flight - a run
  // suspended in `waitForEvent` has no function left to resume into. It was renamed off the
  // pre-rename `ace-engine` value during a quiet window with nothing in flight. Change it only
  // the same way, and never on a deployed cloud app with live human-pause waits.
  id: "devpilot-engine",
  schemas: new EventSchemas().fromRecord<Events>(),
  ...resolveInngestDevRouting(),
});
