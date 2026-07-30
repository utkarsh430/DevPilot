// The durable watcher for a Vercel deployment.
//
// A deploy takes minutes. Nothing that takes minutes may sit on a request, so
// the action fires `vercel/deploy.requested` and returns immediately with the
// deployment id; this function watches the build to a terminal state, keeps
// `project_deployments` current, stamps `projects.vercel_production_url` on a
// successful production deploy, and posts the outcome to the ticket.
//
// Shape follows `ticket-dep-suggester.ts`, which is this repo's reference for a
// background best-effort worker:
//
//   • The worker is an EXPORTED PLAIN FUNCTION (`watchDeployment`) with the
//     Inngest function as a thin wrapper. The logic under it
//     (`pollDeploymentOnce`) is dependency-injected in `lib/vercel/deploy-poll.ts`
//     and unit-tested there.
//   • try/catch throughout; it RETURNS `{ok:false, reason}` rather than
//     throwing, so an expected non-event (credential disconnected, deployment
//     deleted) is not a red run in the Inngest dashboard.
//   • Concurrency keyed per tenant, so one operator hammering deploy cannot
//     starve another tenant's polls.
//
// ── Why the sleep loop rather than one long step ──────────────────────────
// Each poll is its own `step.run`, separated by `step.sleep`. That is what makes
// the watch DURABLE per AGENTS.md principle 2: a restart mid-build resumes at
// the next poll instead of losing the deployment, and no single step holds a
// connection open for half an hour. The ceiling (`MAX_DEPLOY_POLLS`) guarantees
// the run terminates; a build still going at the ceiling is recorded as still
// building — NOT as failed, which would be a lie about a build that may yet
// succeed — and the final poll posts a comment saying DevPilot stopped watching.

import { inngest } from "@/lib/engine/inngest";
import { buildDeployPollDeps } from "@/lib/vercel/deploy.server";
import { pollDeploymentOnce, type PollOutcome } from "@/lib/vercel/deploy-poll";
import { MAX_DEPLOY_POLLS, pollDelaySeconds, type DeployTarget } from "@/lib/vercel/deploy-state";

export type WatchDeploymentArgs = {
  tenantId: string;
  projectId: string;
  ticketId: string | null;
  vercelDeploymentId: string;
  target: DeployTarget;
  triggeredBy: string | null;
  triggerSource: "human" | "agent" | "git_push";
  attempt: number;
  isFinalAttempt: boolean;
};

/**
 * One poll, with the dependencies resolved. Never throws.
 *
 * Kept separate from the Inngest wrapper so the "resolve credentials, then
 * poll" seam is a plain async function a caller can drive directly.
 */
export async function watchDeploymentOnce(args: WatchDeploymentArgs): Promise<PollOutcome> {
  try {
    const deps = await buildDeployPollDeps(args.tenantId);
    if (!deps.ok) return { ok: false, reason: deps.reason };
    return await pollDeploymentOnce(deps.deps, args);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[vercel-deploy-poller] deployment=${args.vercelDeploymentId} failed: ${msg.slice(0, 200)}`,
    );
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

export const watchVercelDeploymentFn = inngest.createFunction(
  {
    id: "vercel-watch-deployment",
    // retries: 0 — a poll is idempotent and cheap, and the NEXT scheduled poll
    // is a better retry than Inngest's: it waits the backoff interval instead of
    // hammering Vercel's rate limit immediately after a failure.
    retries: 0,
    concurrency: {
      limit: 4,
      key: "event.data.tenantId + '_vercelDeploy'",
    },
  },
  { event: "vercel/deploy.requested" },
  async ({ event, step }) => {
    const {
      tenantId,
      projectId,
      ticketId,
      vercelDeploymentId,
      target,
      triggeredBy,
      triggerSource,
    } = event.data;

    let last: PollOutcome = { ok: false, reason: "never-polled" };
    let consecutiveReadFailures = 0;

    for (let attempt = 1; attempt <= MAX_DEPLOY_POLLS; attempt++) {
      // Sleep BEFORE the poll: a deployment is never terminal the instant it is
      // created, so polling at t=0 spends a request to learn "QUEUED".
      await step.sleep(`wait-${attempt}`, `${pollDelaySeconds(attempt)}s`);

      const isFinalAttempt = attempt === MAX_DEPLOY_POLLS;
      const outcome: PollOutcome = await step.run(`poll-${attempt}`, async () =>
        watchDeploymentOnce({
          tenantId,
          projectId,
          ticketId: ticketId ?? null,
          vercelDeploymentId,
          target,
          triggeredBy: triggeredBy ?? null,
          triggerSource,
          attempt,
          isFinalAttempt,
        }),
      );
      last = outcome;

      if (outcome.ok) {
        consecutiveReadFailures = 0;
        if (outcome.terminal) {
          return { ok: true, phase: outcome.phase, polls: attempt };
        }
        continue;
      }

      // A refusal that can never resolve — no credential, or a row we cannot
      // write — will not resolve on the next attempt either, so give up rather
      // than burning the whole ceiling. A transient READ failure is different
      // and gets a few tries before we conclude the deployment is unreachable.
      if (outcome.reason.startsWith("read-failed:")) {
        consecutiveReadFailures += 1;
        if (consecutiveReadFailures < 5) continue;
        return { ok: false, reason: `unreachable-after-5-reads:${outcome.reason}`, polls: attempt };
      }
      return { ok: false, reason: outcome.reason, polls: attempt };
    }

    return {
      ok: false,
      reason: last.ok ? `still-building-at-ceiling:${last.phase}` : last.reason,
      polls: MAX_DEPLOY_POLLS,
    };
  },
);
