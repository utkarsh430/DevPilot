// Bridge — translate `workspace/cleanup-requested` events from the reaper
// into a Redis job queue the runner can pop from.
//
// The runner is a polling worker, not an Inngest subscriber, so engine-side
// events don't reach it directly. This mirrors the local-cc pattern: the
// engine LPUSHes a JSON payload onto a well-known list, the runner RPOPs and
// acts. Keeping the runner's interface uniform (only Redis queues) means we
// can add more runners or move to a hosted queue later without rewriting
// the runner's protocol.
//
// Idempotency: pushing the same (ticketId, path) twice is harmless — the
// runner's `cleanupWorkspace` uses `fs.rm({ force: true })` which is a
// no-op on a missing path.

import { inngest } from "@/lib/engine/inngest";
import { redis } from "@/lib/cache/redis";

const WORKSPACE_CLEANUP_QUEUE = "devpilot:jobs:workspace-cleanup";

export const workspaceCleanupEnqueuer = inngest.createFunction(
  { id: "workspace-cleanup-enqueuer", retries: 2 },
  { event: "workspace/cleanup-requested" },
  async ({ event, step }) => {
    const { tenantId, ticketId, paths, reason, force } = event.data;
    if (!paths || paths.length === 0) {
      return { skipped: "no-paths", ticketId };
    }

    const queued = await step.run("lpush-jobs", async () => {
      const r = redis();
      // One job per path so concurrent runners (eventual fleet) can share the
      // work. For a single-runner setup this is equivalent to one job.
      const pushes = paths.map((p) =>
        r.lpush(
          WORKSPACE_CLEANUP_QUEUE,
          JSON.stringify({
            tenantId,
            ticketId,
            path: p,
            reason,
            // DELIBERATE-DISCARD override. Carried through verbatim from the
            // event; only the operator "Discard & restart" action ever sets it,
            // so a reaper/safe-restart job stays byte-identical to before.
            ...(force ? { force: true } : {}),
            enqueuedAt: new Date().toISOString(),
          }),
        ),
      );
      await Promise.all(pushes);
      return pushes.length;
    });

    return { tenantId, ticketId, queued, queue: WORKSPACE_CLEANUP_QUEUE };
  },
);
