// The merger-outcome sweep - the READ/WRITE half of the cron that gives a
// finished merger ticket the terminal landing outcome nothing ever recorded.
//
// The whole "why this exists / which sha and why / what it deliberately does not
// do" argument lives in the pure policy beside this file:
// `lib/integration/merger-outcome-policy.ts`. Read that first; this module is
// only the IO.
//
// SPLIT FROM THE INNGEST REGISTRATION (`lib/engine/merger-outcome-reaper.ts`)
// for the reason `unqueued-land-store.ts` and `dispatch-rescue-store.ts` both
// record: `inngest.createFunction` runs at MODULE SCOPE, so anything importing
// the registration inherits a durable function.
//
// IT REIMPLEMENTS NO ENQUEUE AND NO LANDING. There is deliberately no call to
// `enqueueForLanding` anywhere in this file - a merger is never enqueued, and
// that is the seam's own rule, unchanged. What this writes is the RECORD of an
// outcome that was already true: `tickets.landed_sha`, the `nothing_to_land`
// notice the board already knows how to read, and the same post-land fan-out
// `closeNothingToLand` fires.
//
// WHY THE FAN-OUT IS INJECTED RATHER THAN IMPORTED. `addComment` and
// `promoteUnblockedDependents` live in `lib/board/transitions.ts`, which reaches
// `queue.server.ts` and `next/headers`; importing either as a value would make
// this module unloadable under Vitest - which is exactly the gap the defects in
// this layer keep living in. The `tickets` UPDATE stays HERE, on the injected
// client, because the tenant predicate on it is the thing most worth testing.
//
// TENANT SCOPE, and it is unusually consequential. This runs on the SERVICE
// client (a cron has no session, so RLS is off), so the co-located
// `.eq("tenant_id", …)` on every read and on the write is the entire boundary.
// `tenantId` always comes from the candidate TICKET the scan selected, never
// from a caller. What a missing predicate produces here is not a disclosure: it
// is a `landed_sha` stamped on ANOTHER TENANT'S ticket, which marks their work
// as shipped and releases every ticket blocked behind it. Both directions are
// dangerous - a foreign `integration_queue` row reading as "already owned"
// strands our merger for good, and a foreign source ticket would supply the sha
// we stamp.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildNothingToLandComment,
  buildNothingToLandMetadata,
  decideMergerRelease,
  type NothingToLandOutcome,
} from "@/lib/integration/land-outcome";
import {
  decideMergerOutcome,
  MERGER_OUTCOME_GRACE_SECONDS_DEFAULT,
  type MergerOutcomeCandidate,
  type MergerOutcomeDecision,
} from "@/lib/integration/merger-outcome-policy";

/** Cap on finished mergers examined per tick. */
const SCAN_LIMIT = Number(process.env.DEVPILOT_MERGER_OUTCOME_SCAN ?? "50");

export function mergerOutcomeGraceSeconds(): number {
  const raw = Number(process.env.DEVPILOT_MERGER_OUTCOME_GRACE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : MERGER_OUTCOME_GRACE_SECONDS_DEFAULT;
}

/** The outcome this sweep records. Named rather than inlined so the sweep and
 *  its tests cannot disagree about which `NothingToLandOutcome` a merger gets. */
export const MERGER_NOTHING_TO_LAND_OUTCOME: NothingToLandOutcome = "merger_no_branch";

export type MergerOutcomeDeps = {
  db: SupabaseClient;
  /**
   * Post the ticket-visible notice. Injected (see the header) - and injected
   * rather than optional, so a wiring that forgets it is a compile error rather
   * than a silent stamp with no explanation on the ticket.
   */
  postNotice: (args: {
    ticketId: string;
    tenantId: string;
    body: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * The post-land fan-out. Same three effects `closeNothingToLand` fires, for
   * the same stated reason: everything downstream keys off `landed_sha`, not off
   * HOW the sha was reached, so a ticket that stamps one and tells nobody leaves
   * a dependent waiting on a blocker that has already closed.
   */
  fanOut: (args: {
    ticketId: string;
    tenantId: string;
    projectId: string;
    sha: string;
    integrationBranch: string | null;
  }) => Promise<void>;
  nowIso: string;
  graceSeconds: number;
  /** `isAutoLandEnabled()` - read once per sweep and threaded into the policy so
   *  the kill switch is a tested CLAUSE rather than only a short-circuit. */
  instanceAutoLandEnabled: boolean;
};

/** The scan row: a `done` ticket with no landing recorded. Identical selection
 *  to the unqueued sweep's, deliberately - the two differ only in which side of
 *  the merger split they act on. */
export type UnlandedMergerRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  status: string | null;
  landed_sha: string | null;
  updated_at: string | null;
  requested_role: string | null;
  parent_ticket_id: string | null;
};

export type MergerOutcomeResult =
  | { ok: true; action: "close"; closed: boolean; sha: string; reason: string }
  | { ok: true; action: "none"; reason: string }
  | { ok: false; reason: string };

/**
 * Gather everything the policy needs about one candidate merger.
 *
 * Every read is scoped to the ticket's OWN `tenant_id`, taken off the scan row.
 * A read that ERRORS reports the fail-closed value for its clause (queue row
 * "present", source sha "absent"), never a permissive default - an unreadable
 * fact must never be able to produce a stamp.
 */
export async function loadMergerOutcomeCandidate(
  deps: Pick<MergerOutcomeDeps, "db" | "instanceAutoLandEnabled">,
  row: UnlandedMergerRow,
): Promise<MergerOutcomeCandidate> {
  const tenantId = row.tenant_id;
  // The merger rule, taken from the seam's OWN pure function rather than
  // re-derived. A second opinion about what a merger is would let this sweep and
  // `decideUnqueuedLandRescue` both act on one ticket, or neither.
  const isMerger =
    decideMergerRelease({
      requestedRole: row.requested_role,
      parentTicketId: row.parent_ticket_id,
      status: row.status,
    }).action !== "not_a_merger";

  const base = {
    ticketId: row.id,
    isMerger,
    sourceTicketId: row.parent_ticket_id,
    status: row.status,
    landedSha: row.landed_sha,
    updatedAtIso: row.updated_at,
    instanceAutoLandEnabled: deps.instanceAutoLandEnabled,
  };

  // Not a merger, or no project to opt in: stand down without spending reads.
  // The fail-closed values are supplied explicitly rather than left to a default
  // so a later edit cannot turn this branch permissive by omission.
  if (!isMerger || !row.project_id) {
    return { ...base, autoLandEnabled: false, hasQueueRow: true, sourceLandedSha: null };
  }

  // (1) ANY queue row, in ANY status. A row means the landing layer already owns
  //     this ticket; this sweep exists for the mergers with no row at all.
  const { data: queued, error: queueErr } = await deps.db
    .from("integration_queue")
    .select("id, status")
    .eq("ticket_id", row.id)
    .eq("tenant_id", tenantId)
    .limit(1);
  const hasQueueRow = Boolean(queueErr) || (queued ?? []).length > 0;

  // (2) The project opt-in.
  const { data: project } = await deps.db
    .from("projects")
    .select("id, auto_land_enabled")
    .eq("id", row.project_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const autoLandEnabled = Boolean(project?.auto_land_enabled);

  // (3) THE SOURCE'S LANDING - both the settledness gate and the witness that
  //     gets stamped. Tenant-scoped: this value is written onto our ticket, so a
  //     foreign row here is a foreign commit recorded as our landing.
  const { data: source, error: sourceErr } = await deps.db
    .from("tickets")
    .select("id, landed_sha")
    .eq("id", row.parent_ticket_id as string)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const sourceLandedSha = sourceErr ? null : ((source?.landed_sha as string | null) ?? null);

  return { ...base, autoLandEnabled, hasQueueRow, sourceLandedSha };
}

/**
 * Record the terminal outcome: stamp, explain, release.
 *
 * ORDER IS DELIBERATE and mirrors `closeNothingToLand`. The stamp is FIRST and
 * is the only step whose failure abandons the close - it is the fact; the notice
 * and the fan-out describe it. The stamp is CAS-guarded on `landed_sha IS NULL`
 * so two overlapping ticks (or this sweep and a late-waking land worker) can
 * never both claim the ticket, and the loser writes nothing further.
 *
 * The notice is BEST-EFFORT: a record-keeping failure must never undo the
 * outcome it is describing. The fan-out is best-effort for the same reason, and
 * reported, because a stamp nobody was told about leaves a dependent waiting on
 * a blocker that has already closed.
 */
export async function closeMergerOutcome(
  deps: MergerOutcomeDeps,
  args: {
    ticketId: string;
    tenantId: string;
    projectId: string;
    sourceTicketId: string;
    sourceRef: string | null;
    integrationBranch: string | null;
    sha: string;
  },
): Promise<{ closed: boolean; reason?: string }> {
  const now = new Date().toISOString();
  const { data, error } = await deps.db
    .from("tickets")
    .update({ landed_sha: args.sha, integrated_at: now })
    .eq("id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .is("landed_sha", null)
    .select("id");
  if (error) return { closed: false, reason: `stamp: ${error.message.slice(0, 200)}` };
  // Lost the CAS: somebody else closed it between the read and here. Their
  // record stands; do not post a second notice describing ours.
  if ((data ?? []).length === 0) return { closed: false, reason: "already-closed" };

  // Built HERE rather than in the wiring so the copy is exercised by the same
  // tests that exercise the decision - the sentence an operator reads is the
  // deliverable, not a detail.
  try {
    await deps.postNotice({
      ticketId: args.ticketId,
      tenantId: args.tenantId,
      body: buildNothingToLandComment({
        branch: null,
        base: args.integrationBranch ?? "the integration branch",
        outcome: MERGER_NOTHING_TO_LAND_OUTCOME,
        sourceRef: args.sourceRef,
      }),
      metadata: buildNothingToLandMetadata({
        branch: null,
        base: args.integrationBranch ?? "the integration branch",
        outcome: MERGER_NOTHING_TO_LAND_OUTCOME,
        sourceTicketId: args.sourceTicketId,
      }),
    });
  } catch (err) {
    console.warn(
      `[merger-outcome] notice failed for ticket=${args.ticketId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await deps.fanOut({
      ticketId: args.ticketId,
      tenantId: args.tenantId,
      projectId: args.projectId,
      sha: args.sha,
      integrationBranch: args.integrationBranch,
    });
  } catch (err) {
    console.warn(
      `[merger-outcome] fan-out failed for ticket=${args.ticketId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { closed: true };
}

/** Read the project's integration branch and the source's printable key — both
 *  only for the notice's wording, so both degrade to null rather than blocking
 *  an outcome that is already established. */
async function loadNoticeContext(
  db: SupabaseClient,
  args: { projectId: string; tenantId: string; sourceTicketId: string },
): Promise<{ integrationBranch: string | null; sourceRef: string | null }> {
  const [project, source] = await Promise.all([
    db
      .from("projects")
      .select("id, integration_branch, default_branch")
      .eq("id", args.projectId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle(),
    db
      .from("tickets")
      .select("id, ticket_number")
      .eq("id", args.sourceTicketId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle(),
  ]);
  const branch =
    ((project.data?.integration_branch as string | null) ??
      (project.data?.default_branch as string | null)) ||
    null;
  const num = source.data?.ticket_number as number | null | undefined;
  return {
    integrationBranch: branch,
    sourceRef: typeof num === "number" ? `DevPilot-${num}` : null,
  };
}

/**
 * Evaluate ONE finished merger and, when its work has provably concluded,
 * record the outcome nothing else ever will.
 *
 * Never throws.
 */
export async function recordMergerOutcome(
  deps: MergerOutcomeDeps,
  row: UnlandedMergerRow,
): Promise<MergerOutcomeResult> {
  try {
    const candidate = await loadMergerOutcomeCandidate(deps, row);
    const decision: MergerOutcomeDecision = decideMergerOutcome(
      candidate,
      deps.nowIso,
      deps.graceSeconds,
    );
    if (decision.action === "none") return { ok: true, action: "none", reason: decision.reason };

    const ctx = await loadNoticeContext(deps.db, {
      projectId: row.project_id as string,
      tenantId: row.tenant_id,
      sourceTicketId: candidate.sourceTicketId as string,
    });

    const result = await closeMergerOutcome(deps, {
      ticketId: row.id,
      tenantId: row.tenant_id,
      projectId: row.project_id as string,
      sourceTicketId: candidate.sourceTicketId as string,
      sourceRef: ctx.sourceRef,
      integrationBranch: ctx.integrationBranch,
      sha: decision.sha,
    });
    console.warn(
      `[merger-outcome] ticket=${row.id} ${
        result.closed ? "closed as nothing-to-land" : `not closed: ${result.reason ?? "?"}`
      } - ${decision.reason}`,
    );
    return {
      ok: true,
      action: "close",
      closed: result.closed,
      sha: decision.sha,
      reason: result.closed ? decision.reason : (result.reason ?? "refused"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[merger-outcome] ticket=${row.id} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

export type MergerOutcomeSweepResult = {
  scanned: number;
  closed: number;
  outcomes: Array<{ ticketId: string; outcome: string }>;
};

/**
 * Scan for `done` tickets carrying no landing and record the outcome of the
 * MERGERS among them.
 *
 * The scan is pre-filtered on `requested_role = 'release_engineer'` and a
 * non-null `parent_ticket_id` - the two halves of `decideMergerRelease`'s merger
 * test - so the rows that reach the policy are almost all mergers. That is a
 * cost filter and NOT the guard: `decideMergerOutcome`'s first clause re-derives
 * `isMerger` through `decideMergerRelease` and refuses anything else, so a
 * loosened scan can never widen what this sweep acts on.
 *
 * No tenant predicate on the scan itself - a cron repairs every tenant, and the
 * `tenant_id` it reads off each row is what scopes every subsequent read and the
 * write. Same shape as `sweepUnqueuedLands` and `sweepStalledLands`.
 */
export async function sweepMergerOutcomes(
  deps: MergerOutcomeDeps,
): Promise<MergerOutcomeSweepResult> {
  const outcomes: Array<{ ticketId: string; outcome: string }> = [];
  const cutoffIso = new Date(Date.parse(deps.nowIso) - deps.graceSeconds * 1000).toISOString();

  const { data, error } = await deps.db
    .from("tickets")
    .select(
      "id, tenant_id, project_id, status, landed_sha, updated_at, requested_role, parent_ticket_id",
    )
    .eq("status", "done")
    .is("landed_sha", null)
    .eq("requested_role", "release_engineer")
    .not("parent_ticket_id", "is", null)
    .lt("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (error) {
    console.warn(`[merger-outcome] scan failed: ${error.message.slice(0, 200)}`);
    return { scanned: 0, closed: 0, outcomes };
  }

  const rows = (data ?? []) as UnlandedMergerRow[];
  let closed = 0;
  for (const row of rows) {
    const result = await recordMergerOutcome(deps, row);
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
      outcome: result.closed ? "closed" : `refused:${result.reason}`,
    });
    if (result.closed) closed += 1;
  }

  return { scanned: rows.length, closed, outcomes };
}
