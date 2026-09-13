// One poll of a running deployment: read Vercel, update the ledger, and — once
// the build settles — stamp the production URL and tell the ticket.
//
// Dependency-injected and marker-free, so it loads under Vitest with a fake
// Supabase client and a stub Vercel read. That is the whole reason it is not
// inside the Inngest function: a durable worker drags in the engine and cannot
// be unit-tested, and the states this has to get right (queued → building →
// ready / error / cancelled, plus the two ways a poll can end without a verdict)
// are exactly the thing that needs testing when the feature ships without a live
// account to try it against. `lib/learning/harvest-batch.ts` + its `.server`
// twin is the precedent.
//
// ── Contract: never throws ─────────────────────────────────────────────────
// Every path returns `{ok:false, reason}` instead. The caller is a durable
// Inngest step and a thrown error there means a red run and a retry that re-does
// a poll for no benefit — the deployment is on Vercel either way, and the next
// scheduled poll picks it up. This mirrors `ticket-dep-suggester.ts`.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelDeployment } from "@/lib/vercel/types";
import {
  classifyDeployState,
  formatDeployComment,
  DEPLOY_COMMENT_AUTHOR,
  type DeployPhase,
  type DeployTarget,
} from "@/lib/vercel/deploy-state";
import { upsertDeploymentRecord, writeProductionUrl } from "@/lib/vercel/deploy-write";
import { boundMessage, scrubSecrets } from "@/lib/vercel/errors";

/** Vercel's `errorMessage` is third-party text that reaches a ticket thread and
 *  a rendered card. Bounded so a pathological body cannot flood either, and put
 *  through the same scrubber every other Vercel-sourced string goes through —
 *  a build error commonly echoes back the command line it failed on. */
const ERROR_MESSAGE_MAX = 400;

export type PollDeps = {
  db: SupabaseClient;
  /** Reads `GET /v13/deployments/{id}`. Injected so tests never touch fetch. */
  fetchDeployment: (deploymentId: string) => Promise<VercelDeployment>;
  /** Post the outcome comment. Injected because the real one writes `comments`
   *  and the test asserts on the BODY, which is the security-relevant part. */
  postComment: (args: { ticketId: string; tenantId: string; body: string }) => Promise<void>;
  /** ISO timestamp. Injected for determinism. */
  now: () => string;
  /** Extra scrubber needles — the Vercel token, so a build error that echoes it
   *  cannot reach a comment. */
  secrets?: readonly string[];
};

export type PollArgs = {
  tenantId: string;
  projectId: string;
  ticketId: string | null;
  vercelDeploymentId: string;
  target: DeployTarget;
  triggeredBy: string | null;
  triggerSource: "human" | "agent" | "git_push";
  /** 1-based. Only used to decide whether this is the final poll. */
  attempt: number;
  /** True when the poll ceiling has been reached and this is the last look. */
  isFinalAttempt: boolean;
};

export type PollOutcome =
  | {
      ok: true;
      phase: DeployPhase;
      /** True when no further poll can change the answer. */
      terminal: boolean;
      /** True when the outcome comment was written on this poll. */
      commented: boolean;
      /** True when `projects.vercel_production_url` was stamped on this poll. */
      productionUrlWritten: boolean;
    }
  | { ok: false; reason: string };

/**
 * Read the deployment once and reconcile DevPilot's record with it.
 *
 * Ordering matters and is not arbitrary:
 *
 *   1. Read Vercel.
 *   2. Write the ledger row. Done FIRST, and unconditionally, so that even if
 *      everything after it fails the operator's card shows the true state with a
 *      working build-log link. This is the row the whole failure surface reads.
 *   3. Stamp `vercel_production_url` — production + READY + a URL only.
 *   4. Comment on the ticket — terminal states only.
 *
 * Steps 3 and 4 are best-effort and reported in the result rather than thrown:
 * a failed comment must not cause a retry that re-runs step 2 and, more to the
 * point, must not make a successful deploy look failed.
 */
export async function pollDeploymentOnce(deps: PollDeps, args: PollArgs): Promise<PollOutcome> {
  const secrets = deps.secrets ?? [];

  let deployment: VercelDeployment;
  try {
    deployment = await deps.fetchDeployment(args.vercelDeploymentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A transient read failure is NOT a failed deploy, and must never be
    // recorded as one. We simply learn nothing this round; the next poll tries
    // again, and the ceiling bounds how long that can go on.
    return { ok: false, reason: `read-failed:${boundMessage(msg, 160)}` };
  }

  const cls = classifyDeployState(deployment.readyState);
  const now = deps.now();
  const timedOut = args.isFinalAttempt && !cls.terminal;

  const errorMessage = deployment.errorMessage
    ? boundMessage(scrubSecrets(deployment.errorMessage, secrets), ERROR_MESSAGE_MAX)
    : null;

  // Vercel returns the hostname bare. Store a clickable absolute URL so nothing
  // downstream has to remember to prefix it — a card that renders `foo.vercel.app`
  // as a relative href sends the operator to a 404 inside DevPilot.
  const url = absoluteUrl(deployment.url);
  const readyAt = deployment.readyAt ? new Date(deployment.readyAt).toISOString() : null;

  const isLiveProduction = args.target === "production" && cls.succeeded;

  const write = await upsertDeploymentRecord(deps.db, args.tenantId, {
    projectId: args.projectId,
    vercelDeploymentId: args.vercelDeploymentId,
    target: args.target,
    // Stored VERBATIM, including a value we did not recognise: the operator can
    // then see what Vercel actually said rather than DevPilot's guess at it.
    readyState: deployment.readyState ?? "UNKNOWN",
    url,
    inspectorUrl: deployment.inspectorUrl,
    errorMessage,
    branch: deployment.branch,
    commitSha: deployment.commitSha,
    ticketId: args.ticketId,
    triggeredBy: args.triggeredBy,
    triggerSource: args.triggerSource,
    readyAt,
    // Set ONLY when a production build actually reached READY. A production
    // build that errored never served production, and recording otherwise would
    // put a dead deployment at the top of PR 5's rollback list.
    becameProductionAt: isLiveProduction ? (readyAt ?? now) : null,
    polledAt: now,
  });
  if (!write.ok) {
    return { ok: false, reason: `record-failed:${boundMessage(write.error, 160)}` };
  }

  let productionUrlWritten = false;
  if (isLiveProduction && url) {
    const res = await writeProductionUrl(deps.db, args.tenantId, args.projectId, url);
    productionUrlWritten = res.ok;
    if (!res.ok) {
      console.warn(
        `[vercel-deploy] project=${args.projectId} production URL write failed: ${boundMessage(res.error, 160)}`,
      );
    }
  }

  // Comment only once the answer is final — a comment per poll would bury the
  // ticket thread in build-progress noise that no agent reading it can act on.
  const shouldComment = (cls.terminal || timedOut) && args.ticketId !== null;
  let commented = false;
  if (shouldComment && args.ticketId) {
    try {
      await deps.postComment({
        ticketId: args.ticketId,
        tenantId: args.tenantId,
        body: formatDeployComment({
          target: args.target,
          phase: cls.phase,
          deploymentId: args.vercelDeploymentId,
          url,
          inspectorUrl: deployment.inspectorUrl,
          ref: deployment.branch,
          commitSha: deployment.commitSha,
          errorMessage,
          timedOut,
        }),
      });
      commented = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[vercel-deploy] ticket=${args.ticketId} deploy comment failed: ${boundMessage(msg, 160)}`,
      );
    }
  }

  return {
    ok: true,
    phase: cls.phase,
    terminal: cls.terminal,
    commented,
    productionUrlWritten,
  };
}

/** Vercel returns `my-app-abc123.vercel.app` with no scheme. */
export function absoluteUrl(raw: string | null): string | null {
  const v = (raw ?? "").trim();
  if (v.length === 0) return null;
  if (v.startsWith("https://") || v.startsWith("http://")) return v;
  return `https://${v}`;
}

export { DEPLOY_COMMENT_AUTHOR };
