// The unqueued-land sweep - the Inngest registration.
//
// The FOURTH member of the landing recovery family, and the one that covers the
// case the other three cannot see at all:
//
//   `landTicketFn`            claims and lands ONE queue row per project
//   `integrationQueueReaper`  reconciles rows that are `landing` /
//                             `awaiting_merge_resolution` - a land that STARTED
//   `landRescueReaper`        re-pumps rows that are `pending` - a land that
//                             never started
//   THIS                      a done, unlanded, branch-bearing ticket with NO
//                             QUEUE ROW AT ALL - a land that was never ASKED FOR
//
// The argument, the measurement it comes from, and why every selection clause is
// load-bearing live in `lib/integration/unqueued-land-policy.ts`. The reads live
// in `lib/integration/unqueued-land-store.ts`. This file is the wiring and
// nothing else - the split is the one `dispatch-rescue.ts` / `-store.ts` uses,
// because `inngest.createFunction` runs at module scope and would otherwise drag
// a durable registration into every importer's graph.
//
// SCOPE DISJOINTNESS IS BY CONSTRUCTION, NOT BY CONVENTION. The other two sweeps
// SELECT FROM `integration_queue`; this one selects from `tickets` and acts only
// when `integration_queue` holds nothing for the ticket. So no ticket can be
// inside two of these scopes at once, and neither existing reaper was widened -
// AGENTS.md records why widening one is the wrong move (two crons with two
// policies on one row endanger each other). `__tests__/unqueued-land-wiring.ts`
// pins the disjointness as a source scan, exactly as the existing pair do.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { enqueueForLanding, isAutoLandEnabled } from "@/lib/integration/queue.server";
import {
  sweepUnqueuedLands,
  unqueuedLandGraceSeconds,
  type UnqueuedLandDeps,
} from "@/lib/integration/unqueued-land-store";

/** Production wiring for the injected deps. */
export function defaultUnqueuedLandDeps(nowIso: string): UnqueuedLandDeps {
  return {
    db: supabaseService(),
    // THE one entry point. Never a hand-rolled insert: this owns the merger
    // redirect, the `landed_sha` gate, the 23505 collision handling and the
    // pump, and it re-checks landability itself - so a disagreement between the
    // sweep's pre-filter and the seam is resolved in the seam's favour.
    enqueue: async ({ ticketId, tenantId }) => {
      const res = await enqueueForLanding({ ticketId, tenantId });
      return res.enqueued ? { enqueued: true } : { enqueued: false, reason: res.reason };
    },
    nowIso,
    graceSeconds: unqueuedLandGraceSeconds(),
    instanceAutoLandEnabled: isAutoLandEnabled(),
  };
}

// Cron every 5 minutes, matching the sibling reapers - and the period the
// policy's grace is pinned against (`UNQUEUED_LAND_CRON_PERIOD_SECONDS`).
//
// `concurrency { limit: 1 }` rather than a per-tenant key: this is a cron with
// no tenant in its event data, and the resource it protects is the sweep itself.
// Two overlapping ticks would read the same candidate window and both hand the
// same ticket to `enqueueForLanding` - whose partial unique index makes that
// safe rather than correct; the limit makes it not happen.
//
// The kill switch short-circuits here AND is threaded into the policy as a
// clause, so it is covered by a test rather than only by this line.
export const unqueuedLandReaper = inngest.createFunction(
  { id: "unqueued-land-reaper", retries: 1, concurrency: { limit: 1 } },
  [{ cron: "*/5 * * * *" }, { event: "internal/rescue-unqueued-lands" }],
  async ({ step }) => {
    if (!isAutoLandEnabled()) return { skipped: "DEVPILOT_AUTO_LAND_ENABLED=0" };
    return await step.run("sweep-unqueued-lands", async () =>
      sweepUnqueuedLands(defaultUnqueuedLandDeps(new Date().toISOString())),
    );
  },
);
