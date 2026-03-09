// Inngest webhook. The Inngest runtime (local dev server or Cloud) discovers
// registered functions via GET, and invokes them via POST when events match.
//
// INSTANCE-level secret: inbound webhooks are verified with INNGEST_SIGNING_KEY,
// which resolves through the platform-secrets resolver at the instance scope
// (tenantId:null) with env as the final fallback. Because the route is
// async/request-scoped we warm the resolver (`ensurePlatformSecretsLoaded`)
// before resolving, then memoize the serve handler by the RESOLVED signing-key
// VALUE — same value-keyed pattern as lib/llm/models-tenant.ts — so rotating
// the key in the UI rebuilds the handler on the next request (a different
// string → memo miss).
//
// env-ALWAYS fallback: when the resolver returns undefined (cold/stale cache,
// flag off, or no DB override) we pass `signingKey: undefined`, and Inngest's
// comm handler reads process.env.INNGEST_SIGNING_KEY itself at request time —
// byte-for-byte today's behavior. INNGEST_EVENT_KEY and the eager send-client
// in lib/engine/inngest.ts stay on env (out of scope here).

import { serve } from "inngest/next";
import type { NextRequest } from "next/server";
import { inngest } from "@/lib/engine/inngest";
import { ensurePlatformSecretsLoaded, resolveSync } from "@/lib/platform-secrets/resolver";
import { dispatcher, dispatchOnRunComplete } from "@/lib/engine/dispatcher";
import { runAgent, runAgentFailed } from "@/lib/engine/run-agent";
import { workspaceReaper } from "@/lib/engine/workspace-reaper";
import { staleRunReaper } from "@/lib/engine/stale-run-reaper";
import { runnerWatchdog } from "@/lib/engine/runner-watchdog";
import { workspaceCleanupEnqueuer } from "@/lib/engine/workspace-cleanup-enqueuer";
import { cascadeKillOnFailure } from "@/lib/engine/cascade-kill";
import { fanInAggregator } from "@/lib/engine/aggregator";
import { replayRun } from "@/lib/engine/replay";
import { billingMeterAggregator } from "@/lib/billing/meter";
import { pendingPushTracker } from "@/lib/engine/pending-push-tracker";
import { startDevServer, stopDevServer, devServerReaper } from "@/lib/engine/dev-server-control";
// Phase 2.5+ / M7 (REVISION 2026-06-04) — Plan-mode durable LLM execution.
// Server actions emit events that these four functions consume; results
// arrive in the UI via Supabase Realtime on `planning_messages`.
import {
  planLeadReplyFn,
  planPanelStepFn,
  planConsolidatorFn,
  planBuildOrchestratorFn,
} from "@/lib/plan/inngest";
// Phase 2.5++ / Scheduler — every-minute cron scans active schedules + the
// durable drain function. "Run now" emits ticket-drain/requested directly
// from the server action; the cron emits it for scheduled rows.
import { drainBacklogFn, ticketScheduleCronFn } from "@/lib/engine/ticket-scheduler";
// Phase 2 / M5j — auto-enrich sparse direct-create tickets with a Haiku
// description + acceptance criteria so terse asks like "Add Payment Page"
// don't land in backlog with no scope.
import { ticketAutoEnrichFn } from "@/lib/engine/ticket-enricher";
// Async dep-suggestion — runs the Haiku "which existing tickets block this new
// one?" rerank OFF the create request path (it used to be a synchronous await
// that hung "Creating…") and parks the result on tickets.suggested_dependencies.
import { suggestTicketDepsFn } from "@/lib/engine/ticket-dep-suggester";
import { watchVercelDeploymentFn } from "@/lib/engine/vercel-deploy-poller";
import { scaffolderFallbackFn } from "@/lib/engine/scaffolder-fallback";
// Slice IB-C — stacked tickets cascade notifier. When a parent ticket's
// push lands, post audit breadcrumbs on every `builds_on` child.
import { buildsOnParentLanded } from "@/lib/engine/builds-on-cascade";
// Stuck-ticket sweeper — repairs tickets stranded in a working state after
// their latest run completed 'done' without advancing them (the event-time
// counterpart lives in runAgent's reconcile-ticket step).
import { stuckTicketSweeper } from "@/lib/engine/stuck-ticket-sweep";
// Orphaned-ticket reaper - the sibling of the sweeper above, covering exactly
// the cases it declines: a ticket in an agent-owned working state whose latest
// run ended `failed`/`cancelled` (or which has no runs at all) with nothing
// live and nothing queued. The sweeper only repairs tickets whose latest run is
// `done`, so those were stranded forever and swallowed every human reply.
import { orphanTicketReaper } from "@/lib/engine/orphan-ticket-reaper";
// Dispatch-rescue reaper - the third member of that family, and the one that
// covers the WIP queue rather than the ticket. `dispatchOnRunComplete` releases
// a pending `dispatch_queue` row ONLY on `agent/run.completed`; a lost or
// never-sent completion leaves the row immortal, which both wedges the board at
// its WIP limit with nothing running AND disarms the orphan reaper above (its
// pending-dispatch guard stands down expecting a drain that can never come).
// This re-derives capacity from live runs and releases what is genuinely free.
import { dispatchRescueReaper } from "@/lib/engine/dispatch-rescue";
// The engine-liveness canary - one cron whose only job is to stamp
// `engine_liveness`, proving that Inngest functions are still being EXECUTED.
// Every reaper above is a cron in this app, so a stale stamp means all of them
// have stopped at once - the 2026-08-03 state, in which the dev server kept
// accepting events and ran nothing while `probeInngest` stayed green (it calls
// our own serve handler in-process and never contacts Inngest at all). The
// runner-resident project supervisor gates its remediation on this row, so that
// it can only act when the crons it must not duplicate are provably dead.
import { engineLivenessCanary } from "@/lib/engine/liveness";
// WI-4 — the serialized auto-land worker: drains integration_queue ONE ticket at
// a time per project (concurrency {limit:1, key:projectId}), rebasing onto the
// live dev tip and landing each ticket as a squashed PR. `integrationQueueReaper`
// reconciles rows whose worker died mid-land; `enqueueLandOnPush` catches a
// branch that appears after the ticket is done. `landRescueReaper` covers the
// opposite failure — a land that NEVER started because its
// `integration/land-needed` event was lost, leaving the row `pending` forever.
import { landTicketFn, integrationQueueReaper, enqueueLandOnPush } from "@/lib/engine/land-worker";
import { landRescueReaper } from "@/lib/engine/land-rescue-reaper";
// …and `unqueuedLandReaper` covers the failure NEITHER of those can see: a done,
// unlanded ticket with a branch and NO queue row at all, because both of the
// reapers above select FROM `integration_queue`. Measured live: three such
// tickets on one board, invisible to the entire recovery layer, permanently.
import { unqueuedLandReaper } from "@/lib/engine/unqueued-land-reaper";
// …and `mergerOutcomeReaper` covers the one ticket shape that must NEVER be
// enqueued at all: an auto-spawned MERGER, which resolves its conflict on the
// SOURCE ticket's branch and so has nothing of its own to land. Every sweep
// above correctly stands down on one — and nothing recorded the outcome, so it
// sat `done` + unlanded forever and every surface reported it as stranded.
// Measured live: 26 of 30 "stranded" tickets on one board were this.
import { mergerOutcomeReaper } from "@/lib/engine/merger-outcome-reaper";
// Audit-grade PDF export — the async PROJECT scope. A project export is far too
// slow for a request (it batches up to MAX_FULL_TICKETS tickets' runs, narration
// and embedded images), so it renders here and lands in the private `exports`
// bucket. The per-TICKET export has no function: it renders and streams
// synchronously from its own route.
import { projectExportFn } from "@/lib/export/inngest";
// Agent Learning — go-forward mistake harvesting. Subscribes to
// `agent/run.completed` and records discrete agent_mistakes rows off the board
// path (best-effort, idempotent). PR 1 of the learning+scoreboard system.
import { harvestMistakesFn } from "@/lib/learning/inngest";

const functions = [
  runAgent,
  runAgentFailed,
  dispatcher,
  dispatchOnRunComplete,
  workspaceReaper,
  staleRunReaper,
  runnerWatchdog,
  workspaceCleanupEnqueuer,
  cascadeKillOnFailure,
  fanInAggregator,
  replayRun,
  billingMeterAggregator,
  pendingPushTracker,
  startDevServer,
  stopDevServer,
  devServerReaper,
  planLeadReplyFn,
  planPanelStepFn,
  planConsolidatorFn,
  planBuildOrchestratorFn,
  drainBacklogFn,
  ticketScheduleCronFn,
  ticketAutoEnrichFn,
  suggestTicketDepsFn,
  watchVercelDeploymentFn,
  scaffolderFallbackFn,
  buildsOnParentLanded,
  stuckTicketSweeper,
  orphanTicketReaper,
  dispatchRescueReaper,
  engineLivenessCanary,
  landTicketFn,
  integrationQueueReaper,
  landRescueReaper,
  unqueuedLandReaper,
  mergerOutcomeReaper,
  enqueueLandOnPush,
  projectExportFn,
  harvestMistakesFn,
];

type ServeHandlers = ReturnType<typeof serve>;

// Value-keyed memo: rebuild the handler only when the resolved signing key
// changes (rotation). `undefined` is its own key — when nothing resolves we
// build a handler with no signingKey and let Inngest read env at request time
// (today's behavior), and we never confuse that with a real resolved value.
let _handlers: ServeHandlers | null = null;
let _key: string | undefined;

function handlersFor(signingKey: string | undefined): ServeHandlers {
  if (_handlers && _key === signingKey) return _handlers;
  _handlers = serve({ client: inngest, functions, signingKey });
  _key = signingKey;
  return _handlers;
}

// Resolve the instance-level signing key, warming the resolver first since the
// route is request-scoped. On a cold/stale cache (or flag off) resolveSync
// returns env; passing `undefined` here lets Inngest fall back to
// process.env.INNGEST_SIGNING_KEY internally — byte-for-byte today.
async function resolvedHandlers(): Promise<ServeHandlers> {
  await ensurePlatformSecretsLoaded(null);
  const signingKey = resolveSync("INNGEST_SIGNING_KEY", { tenantId: null });
  return handlersFor(signingKey);
}

export async function GET(req: NextRequest, ctx: unknown): Promise<Response> {
  return (await resolvedHandlers()).GET(req, ctx);
}

export async function POST(req: NextRequest, ctx: unknown): Promise<Response> {
  return (await resolvedHandlers()).POST(req, ctx);
}

export async function PUT(req: NextRequest, ctx: unknown): Promise<Response> {
  return (await resolvedHandlers()).PUT(req, ctx);
}
