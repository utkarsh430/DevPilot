// The unqueued-land sweep - the READ/ACT half of the cron that hands a `done`,
// unlanded, branch-bearing ticket back to the land queue when nothing ever
// enqueued it.
//
// The whole "why this exists / why every clause is load-bearing / what it
// deliberately does not do" argument lives in the pure policy beside this file:
// `lib/integration/unqueued-land-policy.ts`. Read that first; this module is
// only the IO.
//
// SPLIT FROM THE INNGEST REGISTRATION (`lib/engine/unqueued-land-reaper.ts`) for
// the reason `dispatch-rescue-store.ts` records: `inngest.createFunction` runs
// at MODULE SCOPE, so anything importing the registration inherits a durable
// function. It is also what makes this testable at all - `enqueueForLanding`
// lives in `queue.server.ts`, which reaches `next/headers` through
// `supabaseService` and cannot load under Vitest. So the ACTION is injected,
// exactly as `land-rescue-reaper.ts` injects `emitLandNeeded`, and the tests
// drive the real reads against a filter-APPLYING fake.
//
// IT REIMPLEMENTS NO ENQUEUE. `deps.enqueue` is wired to `enqueueForLanding` -
// the ONE entry point, which owns the merger redirect, the `landed_sha` gate,
// the 23505 collision handling and the pump. A hand-rolled insert here would be
// a second inserter and the two would drift.
//
// TENANT SCOPE, and it is unusually consequential. This runs on the SERVICE
// client (a cron has no session, so RLS is off), so the co-located
// `.eq("tenant_id", …)` on every read is the entire boundary. `tenantId` always
// comes from the candidate TICKET the scan selected, never from a caller. What a
// missing predicate leaks here is not a disclosure - it is a list of BRANCHES TO
// MERGE into another tenant's integration branch, and the queue row this sweep
// creates is what sends one there. Both directions are dangerous: a foreign
// `integration_queue` row reading as "already queued" strands our ticket for
// good, and a foreign `projects` row reading as auto-land-enabled arms a project
// that opted out.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveTicketPush } from "@/lib/integration/merger-push";
import { decideMergerRelease } from "@/lib/integration/land-outcome";
import { loadBlockingRelations } from "@/lib/integration/blocking-relations";
import { isDependencyDeferred } from "@/lib/integration/land-rescue-policy";
import {
  decideUnqueuedLandRescue,
  UNQUEUED_LAND_GRACE_SECONDS_DEFAULT,
  type UnqueuedLandCandidate,
  type UnqueuedLandDecision,
} from "@/lib/integration/unqueued-land-policy";

/** Cap on done-and-unlanded tickets examined per tick. */
const SCAN_LIMIT = Number(process.env.DEVPILOT_UNQUEUED_LAND_SCAN ?? "50");

export function unqueuedLandGraceSeconds(): number {
  const raw = Number(process.env.DEVPILOT_UNQUEUED_LAND_GRACE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : UNQUEUED_LAND_GRACE_SECONDS_DEFAULT;
}

export type UnqueuedLandDeps = {
  db: SupabaseClient;
  /**
   * The queue's ONE entry point. Injected so a test can assert exactly which
   * tickets were handed back - and, just as importantly, that a stood-down
   * ticket is handed back to nothing at all.
   */
  enqueue: (args: {
    ticketId: string;
    tenantId: string;
  }) => Promise<{ enqueued: boolean; reason?: string }>;
  nowIso: string;
  graceSeconds: number;
  /** `isAutoLandEnabled()` - read once per sweep and threaded into the policy
   *  so the kill switch is a tested CLAUSE rather than only a short-circuit at
   *  the top of the cron. */
  instanceAutoLandEnabled: boolean;
};

/** The scan row: a ticket that is `done` with no landing recorded. */
export type UnlandedTicketRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  status: string | null;
  landed_sha: string | null;
  updated_at: string | null;
  /** Both read only to feed `decideMergerRelease` - see the policy's `isMerger`. */
  requested_role: string | null;
  parent_ticket_id: string | null;
};

export type UnqueuedLandOutcome =
  | { ok: true; action: "enqueue"; enqueued: boolean; reason: string }
  | { ok: true; action: "none"; reason: string }
  | { ok: false; reason: string };

/**
 * Gather everything the policy needs about one candidate ticket.
 *
 * Every read is scoped to the ticket's OWN `tenant_id`, taken off the scan row.
 * A read that ERRORS is reported by returning the fail-closed value for its
 * clause (queue row "present", branch "absent", dependency "deferred"), never a
 * permissive default - an unreadable fact must not be able to produce an
 * enqueue.
 */
export async function loadUnqueuedLandCandidate(
  deps: Pick<UnqueuedLandDeps, "db" | "instanceAutoLandEnabled">,
  row: UnlandedTicketRow,
): Promise<UnqueuedLandCandidate> {
  const tenantId = row.tenant_id;
  const base = {
    ticketId: row.id,
    // The merger rule, taken from the seam's own pure function rather than
    // re-derived - a second opinion about what a merger is would let the two
    // disagree about which ticket a landing belongs to.
    isMerger:
      decideMergerRelease({
        requestedRole: row.requested_role,
        parentTicketId: row.parent_ticket_id,
        status: row.status,
      }).action !== "not_a_merger",
    status: row.status,
    landedSha: row.landed_sha,
    updatedAtIso: row.updated_at,
    instanceAutoLandEnabled: deps.instanceAutoLandEnabled,
  };

  // A ticket with no project has no land lane to be serialized on - the same
  // refusal `enqueueForLanding` makes. Report it as an opt-out rather than
  // guessing the project's flag.
  if (!row.project_id) {
    return {
      ...base,
      autoLandEnabled: false,
      hasQueueRow: false,
      hasBranch: false,
      dependencyDeferred: true,
    };
  }

  // (1) ANY queue row, in ANY status. The clause that stops this sweep
  //     re-litigating a terminal decision every five minutes forever.
  const { data: queued, error: queueErr } = await deps.db
    .from("integration_queue")
    .select("id, status")
    .eq("ticket_id", row.id)
    .eq("tenant_id", tenantId)
    .limit(1);
  // Fail closed: an unreadable queue is treated as "a row exists", so the sweep
  // stands down rather than minting a duplicate landing.
  const hasQueueRow = Boolean(queueErr) || (queued ?? []).length > 0;

  // (2) The project opt-in.
  const { data: project } = await deps.db
    .from("projects")
    .select("id, auto_land_enabled")
    .eq("id", row.project_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const autoLandEnabled = Boolean(project?.auto_land_enabled);

  // (3) Does the ticket have a branch with work? Through `resolveTicketPush`,
  //     never a guess and never a bare `ticket_id` read: a merger that resolved
  //     this ticket's conflict may hold the push, and reading it directly is the
  //     orphan that already cancelled one land over a branch with 15 commits on
  //     it.
  let hasBranch = false;
  try {
    const push = await resolveTicketPush(deps.db, { ticketId: row.id, tenantId });
    hasBranch = Boolean(push?.branch && push.branch.trim().length > 0);
  } catch {
    hasBranch = false;
  }

  // (4) Is a blocking relation legitimately holding the land back? `null` means
  //     we could not tell - treated as deferred, so an unreadable dependency
  //     never produces an enqueue.
  const relations = await loadBlockingRelations(deps.db, { ticketId: row.id, tenantId });
  const dependencyDeferred = relations === null ? true : isDependencyDeferred(relations);

  return { ...base, autoLandEnabled, hasQueueRow, hasBranch, dependencyDeferred };
}

/**
 * Evaluate ONE done-and-unlanded ticket and, when the database says a landing is
 * owed and nothing ever asked for one, hand it to `enqueueForLanding`.
 *
 * Never throws. `enqueueForLanding` re-checks landability itself, so a
 * disagreement between this pre-filter and the seam is resolved in the seam's
 * favour and reported, not acted around.
 */
export async function rescueUnqueuedLand(
  deps: UnqueuedLandDeps,
  row: UnlandedTicketRow,
): Promise<UnqueuedLandOutcome> {
  try {
    const candidate = await loadUnqueuedLandCandidate(deps, row);
    const decision: UnqueuedLandDecision = decideUnqueuedLandRescue(
      candidate,
      deps.nowIso,
      deps.graceSeconds,
    );
    if (decision.action === "none") return { ok: true, action: "none", reason: decision.reason };

    const result = await deps.enqueue({ ticketId: row.id, tenantId: row.tenant_id });
    console.warn(
      `[unqueued-land] ticket=${row.id} ${
        result.enqueued ? "re-enqueued" : `refused by enqueueForLanding: ${result.reason ?? "?"}`
      } - ${decision.reason}`,
    );
    return {
      ok: true,
      action: "enqueue",
      enqueued: result.enqueued,
      reason: result.enqueued ? decision.reason : (result.reason ?? "refused"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[unqueued-land] ticket=${row.id} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

export type UnqueuedLandSweepResult = {
  scanned: number;
  enqueued: number;
  outcomes: Array<{ ticketId: string; outcome: string }>;
};

/**
 * Scan for `done` tickets carrying no landing and evaluate each.
 *
 * THE SCAN IS THE ONLY QUERY IN THE LANDING LAYER THAT DOES NOT START FROM A
 * QUEUE ROW, and that is exactly the point: the rows this exists to find are the
 * ones with no queue row to start from. Pre-filtered on `updated_at` past the
 * grace so a ticket that reached done seconds ago never leaves Postgres; the
 * policy re-derives the real idle time per row anyway.
 *
 * No tenant predicate on the scan itself - a cron repairs every tenant, and the
 * `tenant_id` it reads off each row is what scopes every subsequent read. That
 * is the same shape `sweepStalledLands` uses.
 */
export async function sweepUnqueuedLands(deps: UnqueuedLandDeps): Promise<UnqueuedLandSweepResult> {
  const outcomes: Array<{ ticketId: string; outcome: string }> = [];
  const cutoffIso = new Date(Date.parse(deps.nowIso) - deps.graceSeconds * 1000).toISOString();

  const { data, error } = await deps.db
    .from("tickets")
    .select(
      "id, tenant_id, project_id, status, landed_sha, updated_at, requested_role, parent_ticket_id",
    )
    .eq("status", "done")
    .is("landed_sha", null)
    .lt("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (error) {
    console.warn(`[unqueued-land] scan failed: ${error.message.slice(0, 200)}`);
    return { scanned: 0, enqueued: 0, outcomes };
  }

  const rows = (data ?? []) as UnlandedTicketRow[];
  let enqueued = 0;
  for (const row of rows) {
    const result = await rescueUnqueuedLand(deps, row);
    if (!result.ok) {
      outcomes.push({ ticketId: row.id, outcome: `error:${result.reason}` });
      continue;
    }
    if (result.action === "none") {
      outcomes.push({ ticketId: row.id, outcome: `none:${result.reason}` });
      continue;
    }
    outcomes.push({
      ticketId: row.id,
      outcome: result.enqueued ? "enqueued" : `refused:${result.reason}`,
    });
    if (result.enqueued) enqueued += 1;
  }

  return { scanned: rows.length, enqueued, outcomes };
}
