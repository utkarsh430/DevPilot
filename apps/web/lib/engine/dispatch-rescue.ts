// The never-released-dispatch sweep — the Inngest registration.
//
// Everything this function does lives in `dispatch-rescue-store.ts` (the IO) and
// `dispatch-rescue-policy.ts` (the decision). Read the policy header first; it
// carries the whole argument for why a `dispatch_queue` row could never be
// released and what that did to the board on 2026-08-03.
//
// This file is deliberately thin. `inngest.createFunction` executes at MODULE
// SCOPE, so every importer of this module inherits a durable-function
// registration — which is why the reader it calls lives next door instead of
// here (see that file's header).

import { inngest } from "@/lib/engine/inngest";
import {
  defaultDispatchRescueDeps,
  sweepStalledDispatches,
} from "@/lib/engine/dispatch-rescue-store";

const SWEEP_ENABLED = (process.env.DEVPILOT_DISPATCH_RESCUE ?? "1") !== "0";

// Cron every 5 minutes, matching the sibling reapers, with an internal trigger
// so an acceptance script can invoke it synchronously. `concurrency {limit: 1}`
// rather than a per-tenant key: this is a cron with no tenant in its event
// data, and the resource it protects is the sweep itself — two overlapping
// ticks would read the same candidate window and both decide to release. The
// atomic claim makes that safe rather than correct; the limit makes it not
// happen.
//
// A CRON, not an event subscription, and that is the entire point: an
// event-triggered rescue would share the single point of failure of the thing
// it exists to rescue.
export const dispatchRescueReaper = inngest.createFunction(
  { id: "dispatch-rescue-reaper", retries: 1, concurrency: { limit: 1 } },
  [{ cron: "*/5 * * * *" }, { event: "internal/rescue-stalled-dispatches" }],
  async ({ step }) => {
    if (!SWEEP_ENABLED) return { skipped: "DEVPILOT_DISPATCH_RESCUE=0" };
    return await step.run("sweep-stalled-dispatches", async () =>
      sweepStalledDispatches(defaultDispatchRescueDeps(new Date().toISOString())),
    );
  },
);
