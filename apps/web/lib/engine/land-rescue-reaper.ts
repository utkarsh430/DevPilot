// The never-triggered-land sweep — the cron that restarts a queued land whose
// `integration/land-needed` event was lost.
//
// The whole "why this exists / how never-started is told apart from in-flight /
// backoff / give-up / why a rescue is recorded" argument lives in the pure
// policy beside this file: `lib/integration/land-rescue-policy.ts`. Read that
// first; this module is only the IO.
//
// IT DOES NOT TOUCH THE EXISTING REAPER'S JOB. `integrationQueueReaper`
// (`land-worker.ts`) owns rows that are `landing` or
// `awaiting_merge_resolution` — a land that STARTED and stalled — and its reap
// loop is unchanged. This sweep owns `pending` rows only, and the two status
// sets are disjoint by construction, so the two 5-minute crons can never both
// act on one row. What DID move out of that function is its blind
// project-level cron floor ("some row is pending somewhere in this project, so
// emit a pump"), which is this job done without a grace, a backoff, a record or
// a give-up; it is a strict subset of what runs here.
//
// Shape follows `lib/engine/orphan-ticket-reaper.ts`: an exported plain worker
// taking injected deps so the whole thing is unit-testable with a fake Supabase
// client and no Inngest, `{ok:false, reason}` returns rather than throws, and
// one bad row never stalls the sweep.
//
// Tenant scoping: this runs on the SERVICE client (a cron has no session, so
// RLS is off), and the co-located `.eq("tenant_id", …)` on every read and write
// is the entire boundary. `tenantId` always comes from the candidate queue row
// the scan selected, never from a caller. It matters unusually much here
// because two of the reads are DISARM signals — a foreign `integration_queue`
// row in this project would read as "the lane is busy" and strand our land for
// good, and a foreign blocker would read as "dependency-deferred" and do the
// same — while the writes move another tenant's land into `failed`.
// `ticket_dependencies` carries no `tenant_id` column at all, so its safety
// comes from the anchor (`ticket_id`, taken off a row we already scoped) plus
// re-scoping the blocker tickets it points at, exactly as `fetchBlockerRows`
// does. Those three reads now live in `lib/integration/blocking-relations.ts`
// (behaviour unchanged - the helper was lifted verbatim) so the unqueued-land
// sweep shares them rather than growing a second copy of a disarm signal.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { emitLandNeeded, isAutoLandEnabled } from "@/lib/integration/queue.server";
import { loadBlockingRelations } from "@/lib/integration/blocking-relations";
import {
  decideLandRescue,
  isDependencyDeferred,
  parseRescueRecord,
  renderRescueRecord,
  LAND_RESCUE_BASE_GRACE_MS,
  LAND_RESCUE_MAX_RESCUES,
} from "@/lib/integration/land-rescue-policy";

const BATCH_LIMIT = Number(process.env.DEVPILOT_LAND_RESCUE_BATCH ?? "25");

function baseGraceMs(): number {
  const raw = Number(process.env.DEVPILOT_LAND_RESCUE_GRACE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : LAND_RESCUE_BASE_GRACE_MS;
}

function maxRescues(): number {
  const raw = Number(process.env.DEVPILOT_LAND_RESCUE_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : LAND_RESCUE_MAX_RESCUES;
}

export type LandRescueDeps = {
  db: SupabaseClient;
  /** The queue's pump. Injected so a test can assert exactly which
   *  (tenant, project) pairs were re-emitted, and that a skipped row emits
   *  nothing at all. */
  emitLandNeeded: (args: { tenantId: string; projectId: string }) => Promise<void>;
  nowIso: string;
  baseGraceMs: number;
  maxRescues: number;
};

export type PendingLandRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  ticket_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  updated_at: string | null;
  enqueued_at: string;
};

export type LandRescueResult =
  | { ok: true; action: "rescue"; rescues: number }
  | { ok: true; action: "give_up" }
  | { ok: true; action: "skip"; reason: string }
  | { ok: false; reason: string };

/**
 * Evaluate ONE pending queue row and, if its land genuinely never started,
 * re-emit its event (or, out of rescues, fail it). Never throws.
 */
export async function rescuePendingLand(
  deps: LandRescueDeps,
  row: PendingLandRow,
): Promise<LandRescueResult> {
  try {
    const tenantId = row.tenant_id;

    // (a) Is this project's single land lane busy? A live `landing` row means
    //     a worker is mid-merge and will re-pump the queue itself.
    const { data: inFlight, error: inFlightErr } = await deps.db
      .from("integration_queue")
      .select("id")
      .eq("project_id", row.project_id)
      .eq("tenant_id", tenantId)
      .eq("status", "landing")
      .limit(1);
    if (inFlightErr) {
      return { ok: false, reason: `in-flight-lookup:${inFlightErr.message.slice(0, 120)}` };
    }

    // (b) Is the claim skipping this row for a legitimate dependency reason?
    const relations = await loadBlockingRelations(deps.db, {
      ticketId: row.ticket_id,
      tenantId,
    });

    const { rescues, original } = parseRescueRecord(row.last_error);
    const anchor = row.updated_at ?? row.enqueued_at;
    const decision = decideLandRescue({
      status: row.status,
      idleMs: Date.parse(deps.nowIso) - Date.parse(anchor),
      rescues,
      attempts: row.attempts,
      projectLandInFlight: (inFlight ?? []).length > 0,
      // `null` = we could not tell. Never give up on an unknown.
      dependencyDeferred: relations === null ? true : isDependencyDeferred(relations),
      baseGraceMs: deps.baseGraceMs,
      maxRescues: deps.maxRescues,
    });

    if (decision.action === "skip") {
      return { ok: true, action: "skip", reason: decision.reason };
    }

    if (decision.action === "give_up") {
      // CAS on the status we evaluated: a row claimed between the read and this
      // write is a land that DID start, and must not be failed out from under
      // its worker.
      const { data: failed, error: failErr } = await deps.db
        .from("integration_queue")
        .update({
          status: "failed",
          last_error: `${decision.reason}${original ? `\n${original}` : ""}`.slice(0, 2000),
        })
        .eq("id", row.id)
        .eq("tenant_id", tenantId)
        .eq("status", "pending")
        .select("id");
      if (failErr) return { ok: false, reason: `give-up-write:${failErr.message.slice(0, 120)}` };
      if ((failed ?? []).length === 0) {
        return { ok: true, action: "skip", reason: "lost-cas-race" };
      }
      console.warn(
        `[land-rescue] queue=${row.id} ticket=${row.ticket_id} gave up: ${decision.reason}`,
      );
      return { ok: true, action: "give_up" };
    }

    // RESCUE. Record FIRST, emit second, and both are load-bearing in that
    // order. The write is the compare-and-set that proves the row is still
    // unclaimed (so a rescue can never race a live land), and it is also the
    // backoff clock — the `updated_at` trigger fires on it, which is what keeps
    // the next rescue a doubling away without needing a new column. Emitting
    // first and failing to record would re-emit every tick forever.
    const { data: marked, error: markErr } = await deps.db
      .from("integration_queue")
      .update({
        last_error: renderRescueRecord({
          rescues: decision.nextRescueCount,
          maxRescues: deps.maxRescues,
          nowIso: deps.nowIso,
          original,
        }),
      })
      .eq("id", row.id)
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .select("id");
    if (markErr) return { ok: false, reason: `rescue-write:${markErr.message.slice(0, 120)}` };
    if ((marked ?? []).length === 0) {
      // Claimed while we were deciding — the land started on its own.
      return { ok: true, action: "skip", reason: "lost-cas-race" };
    }

    await deps.emitLandNeeded({ tenantId, projectId: row.project_id });

    console.warn(
      `[land-rescue] queue=${row.id} ticket=${row.ticket_id} rescue ` +
        `${decision.nextRescueCount}/${deps.maxRescues}: ${decision.reason}`,
    );
    return { ok: true, action: "rescue", rescues: decision.nextRescueCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[land-rescue] queue=${row.id} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

export type LandRescueSweepResult = {
  scanned: number;
  rescued: number;
  gaveUp: number;
  outcomes: Array<{ queueId: string; outcome: string }>;
};

/**
 * Scan for `pending` rows past the base grace and evaluate each.
 *
 * The scan is pre-filtered on `updated_at < now - baseGrace` so a freshly
 * enqueued row (whose event is in flight right now) never leaves Postgres; the
 * policy re-derives the real, backed-off wait per row anyway.
 */
export async function sweepStalledLands(deps: LandRescueDeps): Promise<LandRescueSweepResult> {
  const outcomes: Array<{ queueId: string; outcome: string }> = [];
  let rescued = 0;
  let gaveUp = 0;

  const cutoffIso = new Date(Date.parse(deps.nowIso) - deps.baseGraceMs).toISOString();

  const { data, error } = await deps.db
    .from("integration_queue")
    .select(
      "id, tenant_id, project_id, ticket_id, status, attempts, last_error, updated_at, enqueued_at",
    )
    .eq("status", "pending")
    .lt("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) {
    console.warn(`[land-rescue] scan failed: ${error.message.slice(0, 200)}`);
    return { scanned: 0, rescued: 0, gaveUp: 0, outcomes };
  }

  const rows = (data ?? []) as PendingLandRow[];
  for (const row of rows) {
    const result = await rescuePendingLand(deps, row);
    if (!result.ok) {
      outcomes.push({ queueId: row.id, outcome: `error:${result.reason}` });
      continue;
    }
    outcomes.push({
      queueId: row.id,
      outcome: result.action === "skip" ? `skip:${result.reason}` : result.action,
    });
    if (result.action === "rescue") rescued += 1;
    if (result.action === "give_up") gaveUp += 1;
  }

  return { scanned: rows.length, rescued, gaveUp, outcomes };
}

/** Production wiring for the injected deps. */
export function defaultLandRescueDeps(nowIso: string): LandRescueDeps {
  return {
    db: supabaseService(),
    emitLandNeeded,
    nowIso,
    baseGraceMs: baseGraceMs(),
    maxRescues: maxRescues(),
  };
}

// Inngest entry point.
//
// Cron every 5 minutes, matching the sibling reapers. `concurrency {limit: 1}`
// rather than a per-tenant key: this is a cron with no tenant in its event
// data, and the resource it protects is the sweep itself — two overlapping
// ticks would read the same candidate window and both decide to rescue. The
// per-row CAS makes that safe rather than correct; the limit makes it not
// happen.
//
// The kill switch is `isAutoLandEnabled()`, the same one that gates the land
// worker, the enqueue seam and the existing reaper: with auto-land off, nothing
// in this pipeline may emit.
export const landRescueReaper = inngest.createFunction(
  { id: "land-rescue-reaper", retries: 1, concurrency: { limit: 1 } },
  [{ cron: "*/5 * * * *" }, { event: "internal/rescue-stalled-lands" }],
  async ({ step }) => {
    if (!isAutoLandEnabled()) return { skipped: "DEVPILOT_AUTO_LAND_ENABLED=0" };
    return await step.run("sweep-stalled-lands", async () =>
      sweepStalledLands(defaultLandRescueDeps(new Date().toISOString())),
    );
  },
);
