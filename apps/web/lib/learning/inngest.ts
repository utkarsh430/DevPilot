// Go-forward mistake harvesting + lesson extraction.
//
// `agent/run.completed` is the natural correction boundary: it fires when any run
// finishes (done OR failed), and by then the durable signals the harvester reads
// have settled — the run's status, its verification record, and the ticket's
// comment thread (QA verdicts, gate parks, human replies). So rather than emit a
// new event at each of the five mistake sites, we subscribe to the one event that
// already fans out to the aggregator / dispatcher / pending-push tracker.
//
// Two steps, in order, sharing this one durable function:
//   1. harvest-ticket   — derive/upsert the ticket's mistakes (PR 1).
//   2. extract-lessons  — draft a candidate lesson for each mistake that has none
//                         (PR 2). Runs as a SEPARATE step AFTER harvest so the
//                         mistakes it reads already exist; keeping it a step (not
//                         a second function on the same event) avoids the race
//                         where extraction fires before harvest inserts.
//
// It runs OFF the request/board path (Inngest, async) and is best-effort: neither
// the harvester nor the extractor throws, and we RETURN {ok:false} for the no-ops
// (a ticket-less run) rather than throw, so expected non-events don't surface as
// red runs in the Inngest dashboard. Both steps are idempotent (harvest via the
// dedupe key, extraction via the per-mistake source check + body dedupe), which
// is what lets a replay, a retry, or a second completion on the same ticket be
// safe. Extraction makes at most one Haiku call per new mistake; a downed runner
// simply drafts nothing this round (the backfill and a later completion recover).

import { inngest } from "@/lib/engine/inngest";
import { defaultHarvestDeps, harvestTicketMistakes } from "@/lib/learning/harvest.server";
import { defaultExtractDeps, extractTicketLessons } from "@/lib/learning/extract.server";

export const harvestMistakesFn = inngest.createFunction(
  {
    id: "learning-harvest-mistakes",
    // One transient retry is plenty for a best-effort recorder.
    retries: 1,
    // Serialize per ticket so a burst of sibling completions on one ticket doesn't
    // race the same upsert set (the unique index makes it correct either way; this
    // just keeps it tidy).
    concurrency: { limit: 4, key: "event.data.ticketId" },
  },
  { event: "agent/run.completed" },
  async ({ event, step }) => {
    const { tenantId, ticketId } = event.data;
    // Ticket-less runs (supervisor children, ticket-less replays) have no board
    // context to attribute a mistake against — out of scope for this record.
    if (!ticketId) return { ok: false, reason: "no-ticket" };
    const harvest = await step.run("harvest-ticket", async () =>
      harvestTicketMistakes(defaultHarvestDeps(), { tenantId, ticketId }),
    );
    // Extract candidate lessons from whatever mistakes now exist on the ticket.
    // Best-effort and never-throws; a separate durable step so a retry re-runs
    // only extraction, not the harvest.
    const extract = await step.run("extract-lessons", async () =>
      extractTicketLessons(defaultExtractDeps(tenantId), { tenantId, ticketId }),
    );
    return { harvest, extract };
  },
);
