// The never-released-dispatch sweep — the READ/WRITE half of the cron that
// releases a `dispatch_queue` row whose `agent/run.completed` never arrived.
//
// Split from the Inngest registration (`dispatch-rescue.ts`) deliberately, and
// not only for testability: `inngest.createFunction` runs at MODULE SCOPE, so
// anything importing it inherits a durable-function registration. The system-
// health probe needs `loadDispatchQueueGroups`, and `lib/health/probes.ts` is
// reachable from the LLM layer that half the engine imports — wiring the two
// together in one module dragged a cron registration into that whole graph and
// broke every suite that stubs the Inngest client. The reader lives here; the
// registration lives next door and imports this.
//
// The whole "why this exists / why the release condition is unsatisfiable /
// what it deliberately does not do" argument lives in the pure policy beside
// this file: `lib/engine/dispatch-rescue-policy.ts`. Read that first; this
// module is only the IO.
//
// IT DOES NOT TOUCH THE EXISTING DRAIN'S JOB. `dispatchOnRunComplete`
// (`dispatcher.ts`) owns the happy path — a run completes, one row is released
// — and is unchanged. This sweep owns rows whose completion is NEVER COMING,
// and it recognises them by the only evidence that settles it: the agent is
// below its WIP limit and the row is still queued. The two cannot double-release
// because both go through the SAME atomic claim (`dispatch_queue_claim_next`,
// FOR UPDATE SKIP LOCKED → status='dispatched' in one statement), so a row
// claimed by either is invisible to the other.
//
// Shape follows `lib/engine/land-rescue-reaper.ts` and
// `lib/engine/orphan-ticket-reaper.ts`: an exported plain worker taking injected
// deps so the whole thing is unit-testable with a fake Supabase client and no
// Inngest, `{ok:false, reason}` returns rather than throws, and one bad group
// never stalls the sweep.
//
// Tenant scoping: this runs on the SERVICE client (a cron has no session, so
// RLS is off), and the co-located `.eq("tenant_id", …)` on every read is the
// entire boundary. `tenantId` always comes from the candidate queue row the
// scan selected, never from a caller. It matters unusually much here because
// the run COUNT is a disarm signal in one direction and an arm signal in the
// other: a foreign tenant's runs counted against our agent would hold our queue
// shut for good, and our agent measured against a foreign tenant's empty run
// set would release a queue that is legitimately full.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { claimNext } from "@/lib/engine/dispatch-queue";
import {
  decideDispatchRescue,
  describeDispatchStall,
  detectDispatchStall,
  DISPATCH_RESCUE_GRACE_SECONDS_DEFAULT,
  NO_DISPATCH_STALL,
  WIP_OCCUPYING_RUN_STATUSES,
  type DispatchQueueGroup,
  type DispatchStallSignal,
} from "@/lib/engine/dispatch-rescue-policy";

/** Cap on pending rows scanned per tick. Groups are derived from this window,
 *  so it bounds the whole sweep. */
const SCAN_LIMIT = Number(process.env.DEVPILOT_DISPATCH_RESCUE_SCAN ?? "500");
/** Mirrors `dispatcher.ts`'s DEFAULT_WIP_LIMIT — an agent whose config omits
 *  `wip_limit` is capped at 3 by the gate, so the sweep must assume the same
 *  number or it would compute capacity the dispatcher does not agree with. */
const DEFAULT_WIP_LIMIT = 3;

export function dispatchRescueGraceSeconds(): number {
  const raw = Number(process.env.DEVPILOT_DISPATCH_RESCUE_GRACE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DISPATCH_RESCUE_GRACE_SECONDS_DEFAULT;
}

export type DispatchRescueDeps = {
  db: SupabaseClient;
  /** Re-emit `ticket/dispatch-needed` for a released ticket. Injected so tests
   *  can assert exactly which tickets were released without an Inngest client. */
  emitDispatch: (args: { ticketId: string; tenantId: string }) => Promise<void>;
  /** Claim ONE pending row for (tenant, agent), atomically. Injected for the
   *  same reason; the default is the same RPC the completion drain uses. */
  claim: (
    tenantId: string,
    agentId: string,
  ) => Promise<{ queueId: string; ticketId: string } | null>;
  nowIso: string;
  graceSeconds: number;
};

export function defaultDispatchRescueDeps(nowIso: string): DispatchRescueDeps {
  return {
    db: supabaseService(),
    emitDispatch: async ({ ticketId, tenantId }) => {
      await inngest.send({
        name: "ticket/dispatch-needed",
        data: { ticketId, tenantId },
      });
    },
    claim: claimNext,
    nowIso,
    graceSeconds: dispatchRescueGraceSeconds(),
  };
}

type PendingRow = {
  tenant_id: string;
  agent_id: string;
  enqueued_at: string;
};

export type DispatchRescueSummary = {
  groups: number;
  released: number;
  /** Per-group outcome, for the Inngest run view. */
  outcomes: Array<{ tenantId: string; agentId: string; reason: string; released: number }>;
  stall: DispatchStallSignal;
};

/**
 * Read every pending queue row (capped) and fold it into one group per
 * (tenant, agent), carrying the live run counts that decide capacity.
 *
 * The run counts are read PER GROUP rather than in one pass over `runs`
 * because the question is per-agent and the tenant predicate has to be
 * co-located with the agent predicate — a single grouped read would either
 * lose the tenant scoping or need a bespoke RPC for no benefit at this size
 * (the group count is bounded by the number of agents holding a queue).
 */
export async function loadDispatchQueueGroups(
  deps: Pick<DispatchRescueDeps, "db">,
  /** Narrow to ONE tenant. The cron omits it (it repairs every tenant); the
   *  system-health probe MUST pass it. Applied as a co-located `.eq` on the
   *  query rather than a `.filter()` on the result, because reading every
   *  tenant's rows and discarding most of them in JS is the exact shape
   *  AGENTS.md records as having leaked four times — and it would also let one
   *  busy tenant exhaust SCAN_LIMIT and blind another tenant's probe. */
  tenantId?: string,
): Promise<DispatchQueueGroup[]> {
  let q = deps.db
    .from("dispatch_queue")
    .select("tenant_id, agent_id, enqueued_at")
    .eq("status", "pending");
  if (tenantId) q = q.eq("tenant_id", tenantId);
  const { data, error } = await q.order("enqueued_at", { ascending: true }).limit(SCAN_LIMIT);
  if (error) throw new Error(`loadDispatchQueueGroups: ${error.message}`);

  const rows = (data ?? []) as PendingRow[];
  // Rows arrive oldest-first, so the first row seen for a pair IS its oldest.
  const byPair = new Map<
    string,
    { tenantId: string; agentId: string; count: number; oldest: string }
  >();
  for (const r of rows) {
    if (!r.tenant_id || !r.agent_id) continue;
    const key = `${r.tenant_id}:${r.agent_id}`;
    const seen = byPair.get(key);
    if (seen) seen.count += 1;
    else
      byPair.set(key, {
        tenantId: r.tenant_id,
        agentId: r.agent_id,
        count: 1,
        oldest: r.enqueued_at,
      });
  }

  const groups: DispatchQueueGroup[] = [];
  for (const pair of byPair.values()) {
    const [wipLimit, runCounts] = await Promise.all([
      readWipLimit(deps.db, pair.tenantId, pair.agentId),
      countLiveRuns(deps.db, pair.tenantId, pair.agentId),
    ]);
    groups.push({
      tenantId: pair.tenantId,
      agentId: pair.agentId,
      wipLimit,
      runningRuns: runCounts.running,
      waitingRuns: runCounts.waiting,
      pendingRows: pair.count,
      oldestPendingIso: pair.oldest,
    });
  }
  return groups;
}

/** Live WIP limit for the agent. A missing row or unreadable config yields the
 *  dispatcher's own default rather than a guess, so the two agree. */
async function readWipLimit(
  db: SupabaseClient,
  tenantId: string,
  agentId: string,
): Promise<number> {
  const { data, error } = await db
    .from("agents")
    .select("config")
    .eq("tenant_id", tenantId)
    .eq("id", agentId)
    .maybeSingle();
  if (error || !data) return DEFAULT_WIP_LIMIT;
  const config = (data.config ?? {}) as Record<string, unknown>;
  return typeof config.wip_limit === "number" && Number.isFinite(config.wip_limit)
    ? (config.wip_limit as number)
    : DEFAULT_WIP_LIMIT;
}

/**
 * The FACT the whole fix rests on: how many runs actually occupy this agent's
 * slots right now.
 *
 * `running` and `awaiting_human` are counted separately even though both hold a
 * slot, because the contradiction detector must tell "nothing is happening"
 * from "a human is being waited on" — collapsing them would make the alarm fire
 * on a legitimate human-in-the-loop pause, and an alarm that fires when things
 * are fine is one people stop reading.
 *
 * A read error fails CLOSED (reported as a full agent), the opposite of
 * `checkWipLimit`'s fail-open. The asymmetry is deliberate and is the direction
 * each one can afford to be wrong in: that gate refusing to dispatch stalls the
 * board, so it errs toward dispatching; this sweep releasing a queue it cannot
 * measure would exceed the concurrency cap, so it errs toward waiting. Waiting
 * costs one more 5-minute tick.
 */
async function countLiveRuns(
  db: SupabaseClient,
  tenantId: string,
  agentId: string,
): Promise<{ running: number; waiting: number }> {
  const counts = await Promise.all(
    WIP_OCCUPYING_RUN_STATUSES.map(async (status) => {
      const { count, error } = await db
        .from("runs")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agentId)
        .eq("tenant_id", tenantId)
        .eq("status", status);
      if (error) return null;
      return count ?? 0;
    }),
  );
  // Any unreadable count → fail closed: report enough occupancy that no
  // capacity is ever inferred from a number we do not have.
  if (counts.some((c) => c === null)) {
    return { running: Number.POSITIVE_INFINITY, waiting: 0 };
  }
  return { running: counts[0] ?? 0, waiting: counts[1] ?? 0 };
}

/**
 * Release one group's worth of queue rows. Never throws.
 *
 * Releasing is a CLAIM plus an emit, in that order and reusing the completion
 * drain's own atomic claim. The order matters: claiming first means a row can
 * be released at most once even if two ticks overlap, and an emit that fails
 * after the claim leaves the row `dispatched` with the ticket untouched — which
 * the dispatcher's own idempotent re-enqueue restores on the next transition.
 * Emitting first would let two sweeps both emit for the same row.
 */
export async function releaseGroup(
  deps: DispatchRescueDeps,
  group: DispatchQueueGroup,
): Promise<{ reason: string; released: number }> {
  const decision = decideDispatchRescue(group, deps.nowIso, deps.graceSeconds);
  if (decision.action === "none") return { reason: decision.reason, released: 0 };

  let released = 0;
  for (let i = 0; i < decision.slots; i++) {
    try {
      const claimed = await deps.claim(group.tenantId, group.agentId);
      if (!claimed) break; // queue drained underneath us — nothing to do.
      await deps.emitDispatch({ ticketId: claimed.ticketId, tenantId: group.tenantId });
      released += 1;
    } catch (e) {
      // One bad row must not stall the rest of the sweep, and a partial
      // release is strictly better than none: the remaining rows are picked up
      // on the next tick.
      console.warn(
        `[dispatch-rescue] release failed for agent=${group.agentId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      break;
    }
  }
  return { reason: decision.reason, released };
}

/**
 * One sweep: find every stalled queue, release what genuinely has capacity, and
 * report the contradiction.
 *
 * The detector runs over the SAME group snapshot the release decision used, so
 * what is reported is what was acted on. It is computed before the releases so
 * it describes the state that was WRONG, not the state after we repaired it —
 * a report that only ever says "fine" because the reporter fixed it first is
 * how a six-hour outage stays invisible.
 */
export async function sweepStalledDispatches(
  deps: DispatchRescueDeps,
): Promise<DispatchRescueSummary> {
  let groups: DispatchQueueGroup[];
  try {
    groups = await loadDispatchQueueGroups(deps);
  } catch (e) {
    console.warn(`[dispatch-rescue] scan failed: ${e instanceof Error ? e.message : String(e)}`);
    return { groups: 0, released: 0, outcomes: [], stall: NO_DISPATCH_STALL };
  }

  const stall = detectDispatchStall(groups, deps.nowIso, deps.graceSeconds);
  if (stall.contradiction) {
    // Loud, greppable, and stating the impossibility rather than the symptom.
    // The operator-facing half of this is the `dispatch` system-health probe
    // (lib/health/probes.ts), which surfaces the same signal in the topbar dot
    // on every page; this line is what makes it diagnosable after the fact.
    console.error(`[dispatch-rescue] STALLED DISPATCH QUEUE — ${describeDispatchStall(stall)}`);
  }

  const outcomes: DispatchRescueSummary["outcomes"] = [];
  let released = 0;
  for (const group of groups) {
    const r = await releaseGroup(deps, group);
    released += r.released;
    outcomes.push({
      tenantId: group.tenantId,
      agentId: group.agentId,
      reason: r.reason,
      released: r.released,
    });
  }

  return { groups: groups.length, released, outcomes, stall };
}
