// The merger-outcome sweep - the Inngest registration.
//
// The FIFTH member of the landing family, and the only one that RECORDS an
// outcome rather than driving a landing:
//
//   `landTicketFn`            claims and lands ONE queue row per project
//   `integrationQueueReaper`  reconciles rows that are `landing` /
//                             `awaiting_merge_resolution` - a land that STARTED
//   `landRescueReaper`        re-pumps rows that are `pending` - a land that
//                             never started
//   `unqueuedLandReaper`      a done, unlanded, branch-bearing ticket with NO
//                             queue row - a land that was never ASKED FOR
//   THIS                      a finished MERGER, which can never land by design
//                             and whose outcome nothing ever wrote down
//
// The argument, the measurement it comes from, and WHICH SHA IT STAMPS AND WHY
// live in `lib/integration/merger-outcome-policy.ts`. The reads and the write
// live in `lib/integration/merger-outcome-store.ts`. This file is the wiring and
// nothing else - the split is the one `unqueued-land-reaper.ts` uses, because
// `inngest.createFunction` runs at module scope and would otherwise drag a
// durable registration into every importer's graph.
//
// ACTION SCOPE IS DISJOINT FROM EVERY SIBLING, BY CONSTRUCTION. The other three
// sweeps all end in `enqueueForLanding`; this one never calls it, and there is a
// source scan that says so. Against `unqueuedLandReaper`, whose SCAN overlaps
// this one, the disjointness is in the policies: `decideUnqueuedLandRescue`
// stands down on every merger as its second clause and `decideMergerOutcome`
// stands down on every non-merger as its first, both deriving `isMerger` from
// the same `decideMergerRelease`. Pinned in both directions by
// `__tests__/merger-outcome.test.ts` rather than argued here.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { addComment, promoteUnblockedDependents } from "@/lib/board/transitions";
import { isAutoLandEnabled } from "@/lib/integration/queue.server";
import { NOTHING_TO_LAND_AUTHOR_ID } from "@/lib/integration/land-outcome";
import {
  mergerOutcomeGraceSeconds,
  sweepMergerOutcomes,
  type MergerOutcomeDeps,
} from "@/lib/integration/merger-outcome-store";

/** Production wiring for the injected deps. */
export function defaultMergerOutcomeDeps(nowIso: string): MergerOutcomeDeps {
  return {
    db: supabaseService(),
    // The notice goes under `devpilot_nothing_to_land` - the SAME author and the
    // same `metadata.kind` the land worker writes, because this IS that outcome
    // reached by another route. That is what lets `deriveLandingState` render it
    // with no new UI, and it is deliberately NEVER `devpilot_move_ticket`, which
    // the ticket reconciler string-matches as "an agent rendered a verdict".
    postNotice: async ({ ticketId, tenantId, body, metadata }) => {
      await addComment({
        ticketId,
        tenantId,
        authorType: "system",
        authorId: NOTHING_TO_LAND_AUTHOR_ID,
        body,
        metadata,
      });
    },
    // The same three effects `closeNothingToLand` fires. `sendEventBounded`
    // rather than a raw `inngest.send`: this sweep runs inside a cron, but it
    // runs BECAUSE the landing layer has been unwell, which is exactly when the
    // event endpoint is most likely to accept a connection and answer nothing -
    // and a hang is not an error, so the statements after it would simply never
    // execute.
    fanOut: async ({ ticketId, tenantId, projectId, sha, integrationBranch }) => {
      await sendEventBounded({
        name: "branch/parent-landed",
        data: { ticketId, tenantId, integrationSha: sha, integrationBranch },
      });
      await promoteUnblockedDependents({ blockerTicketId: ticketId, tenantId });
      await sendEventBounded({ name: "ticket-drain/requested", data: { tenantId, projectId } });
    },
    nowIso,
    graceSeconds: mergerOutcomeGraceSeconds(),
    instanceAutoLandEnabled: isAutoLandEnabled(),
  };
}

// Cron every 5 minutes, matching the sibling reapers - and the period the
// policy's grace is pinned against (`MERGER_OUTCOME_CRON_PERIOD_SECONDS`).
//
// `concurrency { limit: 1 }` rather than a per-tenant key: this is a cron with
// no tenant in its event data. Two overlapping ticks would read the same window
// and both try to stamp - which the CAS on `landed_sha IS NULL` makes safe
// rather than correct; the limit makes it not happen.
//
// The kill switch short-circuits here AND is threaded into the policy as a
// clause, so it is covered by a test rather than only by this line.
export const mergerOutcomeReaper = inngest.createFunction(
  { id: "merger-outcome-reaper", retries: 1, concurrency: { limit: 1 } },
  [{ cron: "*/5 * * * *" }, { event: "internal/record-merger-outcomes" }],
  async ({ step }) => {
    if (!isAutoLandEnabled()) return { skipped: "DEVPILOT_AUTO_LAND_ENABLED=0" };
    return await step.run("sweep-merger-outcomes", async () =>
      sweepMergerOutcomes(defaultMergerOutcomeDeps(new Date().toISOString())),
    );
  },
);
