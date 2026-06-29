// The project supervisor - the READ/WRITE half. The decision core is the pure
// `supervisor-policy.ts`; read that header first, it carries the whole argument
// for why this exists and why remediation is gated.
//
// MARKER-FREE BY CONSTRUCTION, and that is load-bearing rather than tidiness.
// This module imports no `server-only` value: the Supabase client, the two
// recovery primitives it delegates to, and the bounded event emit all arrive as
// INJECTED DEPS, with production wiring in the `.server.ts` twin next door. That
// is what lets the executor be unit-tested at all - `supabaseService`,
// `transitionTicket`, `releaseGroup` and `recoverOrphanedTicket` every one reach
// `server-only`, so a module importing them directly cannot load under Vitest,
// which is precisely the gap defects in this codebase keep living in. Same
// split, same reasoning, as `harvest-batch.ts` / `harvest.server.ts`.
//
// It is also split from any Inngest registration: `inngest.createFunction` runs
// at MODULE SCOPE, and the system-health probe imports this file.
//
// ── WHERE THE WORK HAPPENS, AND WHY ───────────────────────────────────────
// The runner is the CLOCK and this module is the ACTOR. The runner is the only
// resident process in the system, so it keeps ticking when Inngest's scheduler
// is dead; but it holds no database credentials and must never gain any, so it
// drives this through an authenticated HTTP endpoint and the engine derives
// every tenant and project from the rows it reads. The runner's only inputs are
// its own identity and the set of runs it is provably executing - see
// `isVetoedByLiveRunner`.
//
// ── IT REIMPLEMENTS NO RECOVERY ───────────────────────────────────────────
// A `board_deadlock` remediation is `releaseGroup` (dispatch-rescue-store.ts).
// A `stalled_ticket` remediation is `recoverOrphanedTicket`
// (orphan-ticket-reaper.ts). Those are the exact functions the crons call, with
// the same caps, the same atomic claims, the same idempotency and the same
// operator-facing comments. What this module adds is the liveness gate, the
// per-project opt-in, and the ledger.
//
// Defence in depth falls out of that reuse: `planSupervision` decides from a
// SNAPSHOT, and then `recoverOrphanedTicket` re-derives all five pieces of
// evidence itself and re-runs the policy. A ticket that came alive between the
// snapshot and the act is refused by the actor even though the plan named it.
//
// ── TENANT SCOPING ────────────────────────────────────────────────────────
// Every read and write here is service-role (there is no session - the caller
// is a runner), so RLS is off and the co-located `.eq("tenant_id", …)` is the
// ENTIRE boundary. It matters unusually much: what these reads produce is a list
// of tickets to MOVE and queue rows to RELEASE, so a foreign row reaching this
// plan is not a disclosure, it is another tenant's board being rearranged.
// `tenantId` always comes from the row scanned, never from the caller - the
// request body has no tenant field at all.

import type { SupabaseClient } from "@supabase/supabase-js";
// TYPE-ONLY on purpose: both of these modules reach `server-only`. Type imports
// are erased, so they cost nothing at runtime; a VALUE import from either would
// make this file unloadable under Vitest.
import type { DispatchQueueGroup } from "@/lib/engine/dispatch-rescue-policy";
import type { OrphanCandidate } from "@/lib/engine/orphan-ticket-reaper";
import {
  LIVE_RUN_STATUSES,
  ORPHANABLE_TICKET_STATUSES,
  ORPHAN_GRACE_SECONDS_DEFAULT,
  ORPHAN_REAPER_COMMENT_AUTHOR,
  type OrphanEvidence,
  type OrphanableStatus,
} from "@/lib/engine/orphan-ticket-policy";
import type { TicketStatus } from "@/lib/board/state";
import { describeUnsettledPushRepair } from "@/lib/integration/unsettled-push-policy";
import {
  scanUnsettledLandedPushes,
  type UnsettledPushStandDownTally,
} from "@/lib/integration/unsettled-push-store";
import {
  ENGINE_LIVENESS_CANARY_ID,
  ENGINE_RECOVERY_STALE_SECONDS_DEFAULT,
  INDICTMENT_THRESHOLD_DEFAULT,
  INDICTMENT_WINDOW_SECONDS_DEFAULT,
  assessEngineRecovery,
  planSupervision,
  selectUnescalatedIndictments,
  renderIndictment,
  type EngineRecoveryLiveness,
  type SupervisedDispatchGroup,
  type SupervisedTicket,
  type SupervisorCause,
  type SupervisorFinding,
  type SupervisorIndictment,
  type SupervisorLedgerEntry,
  type SupervisorPlan,
  type UnsettledLandedPush,
} from "@/lib/engine/supervisor-policy";

/** How many stalled-ticket candidates one pass evaluates. Small on purpose: the
 *  loop runs every minute, and a board with more than this many candidates has a
 *  problem the supervisor is not going to fix in one pass anyway. */
const TICKET_BATCH_LIMIT = 25;

/** Author for the escalation comment. Its OWN id - never `devpilot_move_ticket`,
 *  which `ticket-reconciler.ts` string-matches as a rendered verdict. */
export const SUPERVISOR_COMMENT_AUTHOR = "devpilot_supervisor";

export function engineStaleSeconds(): number {
  const raw = Number(process.env.DEVPILOT_SUPERVISOR_ENGINE_STALE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : ENGINE_RECOVERY_STALE_SECONDS_DEFAULT;
}

export function indictmentWindowSeconds(): number {
  const raw = Number(process.env.DEVPILOT_SUPERVISOR_INDICTMENT_WINDOW_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : INDICTMENT_WINDOW_SECONDS_DEFAULT;
}

export function indictmentThreshold(): number {
  const raw = Number(process.env.DEVPILOT_SUPERVISOR_INDICTMENT_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : INDICTMENT_THRESHOLD_DEFAULT;
}

export function orphanGraceSeconds(): number {
  const raw = Number(process.env.DEVPILOT_ORPHAN_TICKET_GRACE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : ORPHAN_GRACE_SECONDS_DEFAULT;
}

// ───────────────────────────────────────────────────────────────────────────
// Liveness
// ───────────────────────────────────────────────────────────────────────────

/**
 * Read the canary stamp.
 *
 * A read ERROR is reported as `unknown`, never as `wedged`. Postgres being
 * unreadable is not evidence that Inngest stopped, and it is the one state in
 * which remediating would be least defensible - we would be acting on a board we
 * cannot see, using a database we just failed to read.
 */
export async function readEngineLiveness(
  db: SupabaseClient,
  nowIso: string,
  staleSeconds: number,
): Promise<EngineRecoveryLiveness> {
  const { data, error } = await db
    .from("engine_liveness")
    .select("last_seen_at")
    .eq("id", ENGINE_LIVENESS_CANARY_ID)
    .maybeSingle();
  if (error) {
    return { state: "unknown", reason: `liveness read failed: ${error.message.slice(0, 120)}` };
  }
  const lastSeen = (data as { last_seen_at?: string } | null)?.last_seen_at ?? null;
  return assessEngineRecovery(lastSeen, nowIso, staleSeconds);
}

// ───────────────────────────────────────────────────────────────────────────
// Snapshot
// ───────────────────────────────────────────────────────────────────────────

export type SupervisedProject = { projectId: string; tenantId: string };

/** Projects whose operator has opted in to REMEDIATION. Instance-wide, exactly
 *  like the crons this stands in for: the supervisor has no tenant of its own,
 *  and every row it produces carries the tenant it was read from. */
export async function loadSupervisedProjects(db: SupabaseClient): Promise<SupervisedProject[]> {
  const { data, error } = await db
    .from("projects")
    .select("id, tenant_id")
    .eq("supervisor_enabled", true);
  if (error) throw new Error(`loadSupervisedProjects: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; tenant_id: string }>).map((r) => ({
    projectId: r.id,
    tenantId: r.tenant_id,
  }));
}

/**
 * Which (tenant, agent) queue groups are entirely inside supervised projects.
 *
 * Computed from the queue rows' own tickets rather than assumed, because
 * `dispatch_queue_claim_next` takes the HEAD of a (tenant, agent) queue and
 * cannot be steered to a project - so a mixed group must not be released at
 * all. An unreadable mapping yields `false` (detect, report, do not act), which
 * is the fail-closed direction.
 */
async function supervisedGroupKeys(
  db: SupabaseClient,
  tenantId: string,
  supervisedProjectIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const fullySupervised = new Set<string>();
  const { data, error } = await db
    .from("dispatch_queue")
    .select("agent_id, ticket_id")
    .eq("tenant_id", tenantId)
    .eq("status", "pending");
  if (error) return fullySupervised;

  const rows = (data ?? []) as Array<{ agent_id: string; ticket_id: string }>;
  if (rows.length === 0) return fullySupervised;

  const ticketIds = [...new Set(rows.map((r) => r.ticket_id).filter(Boolean))];
  const { data: tickets, error: tErr } = await db
    .from("tickets")
    .select("id, project_id")
    .eq("tenant_id", tenantId)
    .in("id", ticketIds);
  if (tErr) return fullySupervised;

  const projectByTicket = new Map<string, string | null>();
  for (const t of (tickets ?? []) as Array<{ id: string; project_id: string | null }>) {
    projectByTicket.set(t.id, t.project_id);
  }

  const byAgent = new Map<string, boolean>();
  for (const r of rows) {
    const projectId = projectByTicket.get(r.ticket_id) ?? null;
    // A ticket with no project, or one we could not resolve, is NOT supervised -
    // there is no operator who opted it in.
    const ok = projectId !== null && supervisedProjectIds.has(projectId);
    byAgent.set(r.agent_id, (byAgent.get(r.agent_id) ?? true) && ok);
  }
  for (const [agentId, ok] of byAgent) if (ok) fullySupervised.add(agentId);
  return fullySupervised;
}

/** Gather the five pieces of evidence `decideOrphanRecovery` needs, plus the
 *  ticket's run ids for the runner veto. Mirrors `recoverOrphanedTicket`'s own
 *  gathering - deliberately, so the plan and the actor ask the same questions. */
async function gatherTicketEvidence(
  db: SupabaseClient,
  isAutomationPaused: (tenantId: string, ticketId: string) => Promise<boolean>,
  row: {
    id: string;
    tenant_id: string;
    project_id: string | null;
    status: string;
    updated_at: string;
  },
  nowIso: string,
  graceSeconds: number,
): Promise<SupervisedTicket | null> {
  const tenantId = row.tenant_id;

  const [runsRes, queueRes, commentRes, paused] = await Promise.all([
    db
      .from("runs")
      .select("id, status, fan_out_group, last_event_at, created_at")
      .eq("ticket_id", row.id)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("dispatch_queue")
      .select("id")
      .eq("ticket_id", row.id)
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .limit(1),
    db
      .from("comments")
      .select("created_at")
      .eq("ticket_id", row.id)
      .eq("tenant_id", tenantId)
      .eq("author_id", ORPHAN_REAPER_COMMENT_AUTHOR)
      .order("created_at", { ascending: false })
      .limit(1),
    isAutomationPaused(tenantId, row.id),
  ]);

  // A failed evidence read must not produce a confident plan. Drop the
  // candidate; the next pass re-reads it.
  if (runsRes.error || queueRes.error || commentRes.error) return null;

  const runs = (runsRes.data ?? []) as Array<{
    id: string;
    status: string;
    fan_out_group: string | null;
    last_event_at: string | null;
    created_at: string;
  }>;
  const latest = runs[0] ?? null;

  const evidence: OrphanEvidence = {
    status: row.status as OrphanableStatus,
    ticketUpdatedAtIso: row.updated_at,
    hasLiveRun: runs.some((r) => (LIVE_RUN_STATUSES as readonly string[]).includes(r.status)),
    hasPendingDispatch: (queueRes.data ?? []).length > 0,
    latestRunStatus: latest?.status ?? null,
    latestRunFanOutGroup: latest?.fan_out_group ?? null,
    latestRunActivityIso: latest ? (latest.last_event_at ?? latest.created_at) : null,
    automationPaused: paused,
    lastRecoveryCommentIso:
      ((commentRes.data ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null,
    nowIso,
    graceSeconds,
  };

  return {
    ticketId: row.id,
    tenantId,
    projectId: row.project_id,
    runIds: runs.map((r) => r.id),
    evidence,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Deps
// ───────────────────────────────────────────────────────────────────────────

export type SupervisorDeps = {
  db: SupabaseClient;
  nowIso: string;
  /**
   * The two RECOVERY PRIMITIVES, injected rather than imported.
   *
   * In production these are `releaseGroup` (dispatch-rescue-store.ts) and
   * `recoverOrphanedTicket` (orphan-ticket-reaper.ts) - the exact functions the
   * engine's own crons call, with the same caps, the same atomic claims, the
   * same idempotency and the same operator-facing comments. Nothing about
   * recovery is reimplemented here.
   *
   * Injecting them buys two things beyond testability: this module stays
   * marker-free (see the header), and the wiring site is where the request-path
   * concerns live - in particular the BOUNDED event emit, which matters because
   * remediation runs exactly when the event endpoint is known to be sick.
   */
  releaseQueue: (group: DispatchQueueGroup) => Promise<{ reason: string; released: number }>;
  recoverTicket: (
    candidate: OrphanCandidate,
  ) => Promise<
    | { ok: true; recovered: true; to: TicketStatus }
    | { ok: true; recovered: false; reason: string }
    | { ok: false; reason: string }
  >;
  /** Live queue groups for one tenant. Production: `loadDispatchQueueGroups`. */
  loadQueueGroups: (tenantId: string) => Promise<DispatchQueueGroup[]>;
  /**
   * Settle ONE landed ticket's push row. Production: `settleLandedPush`
   * (lib/integration/landed-push.ts) - the SAME writer `stampLanded` calls, with
   * the same CAS on `pushed_at IS NULL` and the same tenant predicate. Nothing
   * about settling is reimplemented here, exactly as nothing about recovery is.
   *
   * Returns whether a row actually moved: `false` for a row an earlier attempt
   * (or the landing path itself, mid-pass) already stamped. That is ordinary,
   * not an error, and it is what keeps a lost race from writing a ledger row for
   * a repair that did not happen.
   */
  settlePush: (args: { pendingPushId: string; tenantId: string }) => Promise<boolean>;
  /** Effective project/tenant automation pause for a ticket. */
  isAutomationPaused: (tenantId: string, ticketId: string) => Promise<boolean>;
  /** Post the escalation where a human will see it. */
  comment: (args: {
    ticketId: string;
    tenantId: string;
    authorType: "system";
    authorId: string;
    body: string;
  }) => Promise<void>;
  staleSeconds: number;
  dispatchGraceSeconds: number;
  orphanGraceSeconds: number;
  indictWindowSeconds: number;
  indictThreshold: number;
};

// ───────────────────────────────────────────────────────────────────────────
// The pass
// ───────────────────────────────────────────────────────────────────────────

export type SupervisionPassResult = {
  liveness: EngineRecoveryLiveness;
  mode: SupervisorPlan["mode"];
  modeReason: string;
  findings: SupervisorFinding[];
  /** What was actually done - never what was merely planned. */
  applied: Array<{ cause: SupervisorCause; action: string; outcome: string }>;
  indictments: SupervisorIndictment[];
  supervisedProjects: number;
};

/**
 * One supervision pass. Never throws - a supervisor that can crash its own loop
 * is not a supervisor.
 */
export async function runSupervisionPass(
  deps: SupervisorDeps,
  /** Runs the reporting runner is provably executing. VETO-ONLY - it can stop a
   *  remediation the policy decided on, never create one. See
   *  `isVetoedByLiveRunner`. Defaults to empty, which is simply "no veto". */
  liveRunIds: ReadonlySet<string> = new Set(),
): Promise<SupervisionPassResult> {
  const liveness = await readEngineLiveness(deps.db, deps.nowIso, deps.staleSeconds);

  let supervised: SupervisedProject[] = [];
  try {
    supervised = await loadSupervisedProjects(deps.db);
  } catch (e) {
    console.warn(`[supervisor] project scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const supervisedProjectIds = new Set(supervised.map((p) => p.projectId));
  // Grouped by tenant so every downstream read can carry a co-located
  // `.eq("tenant_id", …)`. The tenant always comes from the project row that
  // was read, never from the caller.
  const supervisedByTenant = new Map<string, string[]>();
  for (const p of supervised) {
    const list = supervisedByTenant.get(p.tenantId);
    if (list) list.push(p.projectId);
    else supervisedByTenant.set(p.tenantId, [p.projectId]);
  }

  // ── Gather the snapshot. ──────────────────────────────────────────────────
  const dispatchGroups: SupervisedDispatchGroup[] = [];
  for (const tenantId of supervisedByTenant.keys()) {
    try {
      const [groups, fullySupervised] = await Promise.all([
        deps.loadQueueGroups(tenantId),
        supervisedGroupKeys(deps.db, tenantId, supervisedProjectIds),
      ]);
      for (const g of groups) {
        dispatchGroups.push({ ...g, allRowsSupervised: fullySupervised.has(g.agentId) });
      }
    } catch (e) {
      console.warn(
        `[supervisor] queue scan failed for tenant=${tenantId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const stalledTickets = await loadStalledTicketCandidates(deps, supervisedByTenant);
  const unsettledLandedPushes = await loadUnsettledLandedPushes(deps, supervisedByTenant);

  return await executeSupervisionPlan(
    deps,
    {
      liveness,
      dispatchGroups,
      stalledTickets,
      unsettledLandedPushes,
      supervisedProjects: supervised.length,
    },
    liveRunIds,
  );
}

/**
 * Landed tickets whose push row was never settled, per supervised tenant.
 *
 * Scanned ONE TENANT AT A TIME with the tenant's own supervised project list,
 * for the same reason `loadStalledTicketCandidates` is: `pending_pushes` carries
 * its own `tenant_id`, so a read keyed on `project_id` alone is the tenant-leak
 * class AGENTS.md records as having recurred four times. What would leak here is
 * not a disclosure - it is a `pushed_at` stamped on another tenant's unpushed
 * work, which RELEASES their reap guard.
 *
 * DETECTION IS SCOPED TO SUPERVISED PROJECTS, matching the stalled-ticket scan
 * exactly. The opt-in is what makes acting on someone's board their choice, and
 * this repair acts the moment it detects (there is no observe/remediate split
 * for it), so scoping the scan and scoping the action are the same thing.
 *
 * Never throws. Stand-downs are counted and logged, never turned into findings
 * or ledger rows - a board legitimately carrying nothing-to-land rows would
 * otherwise emit the same non-event once a minute forever, which is the noise
 * that destroyed the last signal.
 */
async function loadUnsettledLandedPushes(
  deps: SupervisorDeps,
  supervisedByTenant: ReadonlyMap<string, string[]>,
): Promise<UnsettledLandedPush[]> {
  const out: UnsettledLandedPush[] = [];
  const standDowns: UnsettledPushStandDownTally = {};
  let scanned = 0;

  for (const [tenantId, projectIds] of supervisedByTenant) {
    const scan = await scanUnsettledLandedPushes(deps.db, { tenantId, projectIds });
    scanned += scan.scanned;
    for (const [reason, n] of Object.entries(scan.standDowns)) {
      standDowns[reason] = (standDowns[reason] ?? 0) + n;
    }
    for (const c of scan.candidates) {
      out.push({
        tenantId: c.tenantId,
        projectId: c.projectId,
        ticketId: c.ticketId,
        pushId: c.pushId,
        detail: describeUnsettledPushRepair({
          ticketId: c.ticketId,
          pushId: c.pushId,
          branch: c.branch,
          landedSha: c.landedSha,
          via: c.via,
        }),
      });
    }
  }

  if (out.length > 0) {
    // Only when something is actually wrong. A quiet board says nothing.
    console.warn(
      `[supervisor] ${out.length} landed ticket(s) carry an unsettled push row ` +
        `(scanned ${scanned}; stood down ${JSON.stringify(standDowns)})`,
    );
  }
  return out;
}

/**
 * Candidate stalled tickets, scanned ONE TENANT AT A TIME.
 *
 * Per-tenant rather than one `.in("project_id", …)` over every supervised
 * project, and the difference is a security boundary rather than a style
 * choice. `tickets` carries its own `tenant_id` and its write policy constrains
 * that column, not the `project_id` it points at - so a read keyed on
 * `project_id` alone is exactly the class AGENTS.md records as having leaked
 * repeatedly, and `lib/security/__tests__/tenant-scope-scan.test.ts` catches it
 * (it caught this one). The `assert_tenant_matches_parent` trigger makes a
 * mismatched row unwritable today, but the app-side predicate is the control
 * that also covers rows written before it existed and any future path that
 * bypasses it. What would leak here is not a disclosure: it is a foreign
 * ticket entering a plan that MOVES tickets.
 *
 * The extra cost is one query per supervised TENANT rather than one overall,
 * which on a healthy board returns zero rows either way - the pre-filter on
 * `updated_at < now - grace` (the same one `sweepOrphanedTickets` uses) means
 * the expensive per-ticket evidence gather below almost never runs at all. That
 * is what keeps a once-a-minute loop close to free.
 */
async function loadStalledTicketCandidates(
  deps: SupervisorDeps,
  supervisedByTenant: ReadonlyMap<string, string[]>,
): Promise<SupervisedTicket[]> {
  if (supervisedByTenant.size === 0) return [];
  const cutoffIso = new Date(
    Date.parse(deps.nowIso) - deps.orphanGraceSeconds * 1000,
  ).toISOString();

  const rows: Array<{
    id: string;
    tenant_id: string;
    project_id: string | null;
    status: string;
    updated_at: string;
  }> = [];

  for (const [tenantId, projectIds] of supervisedByTenant) {
    const { data, error } = await deps.db
      .from("tickets")
      .select("id, tenant_id, project_id, status, updated_at")
      .eq("tenant_id", tenantId)
      .in("project_id", projectIds)
      .in("status", ORPHANABLE_TICKET_STATUSES as unknown as string[])
      .lt("updated_at", cutoffIso)
      .order("updated_at", { ascending: true })
      .limit(TICKET_BATCH_LIMIT);
    if (error) {
      console.warn(
        `[supervisor] ticket scan failed for tenant=${tenantId}: ${error.message.slice(0, 200)}`,
      );
      continue;
    }
    rows.push(...((data ?? []) as typeof rows));
  }

  const out: SupervisedTicket[] = [];
  for (const row of rows) {
    const t = await gatherTicketEvidence(
      deps.db,
      deps.isAutomationPaused,
      row,
      deps.nowIso,
      deps.orphanGraceSeconds,
    );
    if (t) out.push(t);
  }
  return out;
}

/**
 * Plan, act, record, indict.
 *
 * Exported separately from the gathering above so the executor can be driven
 * with a hand-built snapshot in tests without faking a whole database.
 *
 * ── WHY THE TWO REMEDIATIONS SETTLE ON DIFFERENT PASSES ───────────────────
 * Releasing a queue row is not, on its own, useful during a wedge: the released
 * ticket emits `ticket/dispatch-needed` into an event endpoint that is running
 * nothing. It is nonetheless the FIRST thing that has to happen, because a
 * `pending` row DISARMS the stalled-ticket recovery - `decideOrphanRecovery`
 * stands down on `hasPendingDispatch`, exactly as `orphanTicketReaper` does. So
 * a ticket holding an immortal queue row is invisible to both, which is
 * precisely why the incident's reaper recovered some stranded tickets and not
 * the ones behind the queue.
 *
 * Release therefore un-disarms the recovery, and the ticket is handed back to a
 * human ON THE NEXT PASS (60s later), from a fresh snapshot. Sequencing them
 * inside one pass would mean acting on evidence the plan was not computed from,
 * which is the property that makes `planSupervision` testable at all. Against a
 * seven-hour outage, one extra minute is not a cost worth trading it for.
 */
export async function executeSupervisionPlan(
  deps: SupervisorDeps,
  snapshot: {
    liveness: EngineRecoveryLiveness;
    dispatchGroups: readonly SupervisedDispatchGroup[];
    stalledTickets: readonly SupervisedTicket[];
    /** REQUIRED, not optional. Optional is what callers forget, and a forgotten
     *  one here reads as "nothing to repair" - the silent no-op this feature
     *  exists to stop being. */
    unsettledLandedPushes: readonly UnsettledLandedPush[];
    supervisedProjects: number;
  },
  /** Runs the reporting runner is provably executing. Veto-only. */
  liveRunIds: ReadonlySet<string> = new Set(),
): Promise<SupervisionPassResult> {
  const plan = planSupervision(
    {
      liveness: snapshot.liveness,
      dispatchGroups: snapshot.dispatchGroups,
      stalledTickets: snapshot.stalledTickets,
      unsettledLandedPushes: snapshot.unsettledLandedPushes,
      nowIso: deps.nowIso,
      dispatchGraceSeconds: deps.dispatchGraceSeconds,
    },
    liveRunIds,
  );

  const applied: SupervisionPassResult["applied"] = [];

  // ── The one repair that is not gated on the engine being wedged. ──────────
  // Runs BEFORE the gated remediations so a healthy-engine pass, which returns
  // early below with `remediations: []`, still performs it. Every candidate has
  // already been through `decideUnsettledPushRepair`; `settlePush` re-applies
  // the CAS on `pushed_at IS NULL`, so a row the landing path settled between
  // the scan and now moves nothing and records nothing.
  for (const r of plan.bookkeepingRepairs) {
    try {
      const settled = await deps.settlePush({ pendingPushId: r.pushId, tenantId: r.tenantId });
      if (!settled) {
        applied.push({ cause: r.cause, action: r.action, outcome: "skip:already-settled" });
        continue;
      }
      applied.push({ cause: r.cause, action: r.action, outcome: `settled push ${r.pushId}` });
      // THE INDICTMENT'S RAW MATERIAL. A repair that left no trace here would be
      // exactly the silent sweeper PR #156 refused - the state gets fixed and
      // the write-path gap that produced it becomes invisible again.
      await recordSupervisorAction(deps, {
        tenantId: r.tenantId,
        projectId: r.projectId,
        ticketId: r.ticketId,
        cause: r.cause,
        action: r.action,
        detail: r.detail,
      });
    } catch (e) {
      console.warn(
        `[supervisor] settle_landed_push failed for push=${r.pushId}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  for (const r of plan.remediations) {
    try {
      if (r.action === "release_dispatch_queue") {
        const group = snapshot.dispatchGroups.find(
          (g) => g.tenantId === r.tenantId && g.agentId === r.agentId,
        );
        if (!group) continue;
        const out = await deps.releaseQueue(group);
        if (out.released > 0) {
          applied.push({
            cause: r.cause,
            action: r.action,
            outcome: `released ${out.released} queue row(s)`,
          });
          await recordSupervisorAction(deps, {
            tenantId: r.tenantId,
            projectId: null,
            ticketId: null,
            cause: r.cause,
            action: r.action,
            detail: `${r.detail} - released ${out.released} row(s).`,
          });
        }
        continue;
      }

      // `recoverOrphanedTicket` re-derives its own evidence and re-runs the
      // policy, so a ticket that came alive since the snapshot is refused here
      // even though the plan named it.
      const planned = snapshot.stalledTickets.find((t) => t.ticketId === r.ticketId);
      const candidate: OrphanCandidate = {
        id: r.ticketId,
        tenant_id: r.tenantId,
        status: planned?.evidence.status ?? "",
        updated_at: planned?.evidence.ticketUpdatedAtIso ?? deps.nowIso,
      };
      const out = await deps.recoverTicket(candidate);
      if (out.ok && out.recovered) {
        applied.push({ cause: r.cause, action: r.action, outcome: `recovered → ${out.to}` });
        await recordSupervisorAction(deps, {
          tenantId: r.tenantId,
          projectId: r.projectId,
          ticketId: r.ticketId,
          cause: r.cause,
          action: r.action,
          detail: `${r.detail} - handed back to a human as \`${out.to}\`.`,
        });
      } else {
        applied.push({
          cause: r.cause,
          action: r.action,
          outcome: out.ok ? `skip:${out.reason}` : `error:${out.reason}`,
        });
      }
    } catch (e) {
      // One bad remediation must never stall the rest of the pass, and must
      // never crash the loop.
      console.warn(
        `[supervisor] remediation ${r.action} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const indictments = await indictRepeatRemediation(deps, plan, applied);

  if (plan.findings.length > 0) {
    // Loud and greppable. The operator-facing half is the `supervision`
    // system-health probe; this line is what makes it diagnosable after the
    // fact - the incident's actual failure was that nobody knew for six hours.
    const level = plan.mode === "remediate" ? console.error : console.warn;
    level(
      `[supervisor] ${plan.modeReason} - ${plan.findings.length} finding(s), ` +
        `${applied.length} remediation(s) applied`,
    );
  }

  return {
    liveness: snapshot.liveness,
    mode: plan.mode,
    modeReason: plan.modeReason,
    findings: plan.findings,
    applied,
    indictments,
    supervisedProjects: snapshot.supervisedProjects,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The ledger and the indictment
// ───────────────────────────────────────────────────────────────────────────

/**
 * Record one automatic fix WITH ITS CAUSE. Never throws - losing a ledger row
 * must not undo a repair that already happened.
 *
 * Only REMEDIATIONS are recorded. Observe-mode findings are surfaced live (the
 * health probe and the log line above) and write nothing, deliberately: a row
 * per finding per minute for a condition the crons are about to fix is noise,
 * and noise is exactly what destroyed the last signal. The ledger's whole value
 * is that every row in it represents something the platform actually did.
 */
export async function recordSupervisorAction(
  deps: Pick<SupervisorDeps, "db" | "nowIso">,
  row: {
    tenantId: string;
    projectId: string | null;
    ticketId: string | null;
    cause: SupervisorCause;
    action: string;
    detail: string;
  },
): Promise<void> {
  const { error } = await deps.db.from("supervisor_actions").insert({
    tenant_id: row.tenantId,
    project_id: row.projectId,
    ticket_id: row.ticketId,
    cause: row.cause,
    action: row.action,
    detail: row.detail,
    created_at: deps.nowIso,
  });
  if (error) {
    console.warn(`[supervisor] ledger write failed: ${error.message.slice(0, 200)}`);
  }
}

/**
 * Recent ledger rows for one tenant - the input to BOTH the health surface
 * (`detectRepeatDefect`, the STATE) and the escalation (
 * `selectUnescalatedIndictments`, the EVENT). `escalated_at` is carried because
 * only the second one reads it; see that function for why they are separate.
 */
export async function loadRecentSupervisorActions(
  db: SupabaseClient,
  tenantId: string,
  sinceIso: string,
): Promise<SupervisorLedgerEntry[]> {
  // Tenant-scoped IN THE QUERY. This list becomes an ACCUSATION shown to an
  // operator; another tenant's remediations folded into it would both leak their
  // activity and manufacture a defect report about a board that is fine.
  const { data, error } = await db
    .from("supervisor_actions")
    .select("cause, created_at, escalated_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return [];
  return (
    (data ?? []) as Array<{ cause: string; created_at: string; escalated_at: string | null }>
  ).map((r) => ({
    cause: r.cause as SupervisorCause,
    createdAtIso: r.created_at,
    escalatedAtIso: r.escalated_at ?? null,
  }));
}

/**
 * The escalation.
 *
 * Runs only for tenants this pass ACTUALLY remediated, so a quiet board costs
 * nothing. Stamps `escalated_at` on the rows that crossed the threshold (durable
 * - the accusation survives a runner restart) and posts ONE comment per pass per
 * cause on the ticket that triggered it, so the accusation lands somewhere a
 * human reads rather than only in a log.
 */
async function indictRepeatRemediation(
  deps: SupervisorDeps,
  plan: SupervisorPlan,
  applied: SupervisionPassResult["applied"],
): Promise<SupervisorIndictment[]> {
  if (applied.length === 0) return [];

  // BOTH arrays. The gated remediations and the ungated bookkeeping repair are
  // different in every way that matters to safety and identical in the way that
  // matters here: each is an automatic fix that must be counted. Reading only
  // `remediations` would make a pass whose only act was a push-row repair
  // produce no accusation at all - the silent sweeper this feature exists not to
  // be.
  const acted: Array<{ tenantId: string; cause: SupervisorCause; ticketId: string | null }> = [
    ...plan.remediations.map((r) => ({
      tenantId: r.tenantId,
      cause: r.cause,
      ticketId: r.action === "recover_ticket" ? r.ticketId : null,
    })),
    ...plan.bookkeepingRepairs.map((r) => ({
      tenantId: r.tenantId,
      cause: r.cause,
      ticketId: r.ticketId,
    })),
  ];

  const tenantIds = [...new Set(acted.map((r) => r.tenantId))];
  const sinceIso = new Date(
    Date.parse(deps.nowIso) - deps.indictWindowSeconds * 1000,
  ).toISOString();

  const out: SupervisorIndictment[] = [];
  for (const tenantId of tenantIds) {
    const entries = await loadRecentSupervisorActions(deps.db, tenantId, sinceIso);
    // The EVENT, not the state: only causes with enough NOT-YET-ESCALATED rows
    // fire. Without that gate a ledger sitting over threshold would re-post the
    // same accusation to the same ticket on every pass, once a minute, forever -
    // turning the one signal this feature exists to produce into wallpaper.
    const found = selectUnescalatedIndictments(
      entries,
      deps.nowIso,
      deps.indictWindowSeconds,
      deps.indictThreshold,
    );
    for (const ind of found) {
      out.push(ind);
      const text = renderIndictment(ind);
      // Impossible to miss in the log; the durable half is the stamp below and
      // the always-visible half is the `supervision` health probe.
      console.error(`[supervisor] ${text}`);

      // Stamp the rows so the accusation is queryable, and so a later reader can
      // tell "this fired" from "this would fire now".
      const { error } = await deps.db
        .from("supervisor_actions")
        .update({ escalated_at: deps.nowIso })
        .eq("tenant_id", tenantId)
        .eq("cause", ind.cause)
        .gte("created_at", ind.sinceIso)
        .is("escalated_at", null);
      if (error) {
        console.warn(`[supervisor] escalation stamp failed: ${error.message.slice(0, 160)}`);
      }

      // Put it in front of a human. The ticket the supervisor just touched is
      // the surface an operator is actually looking at. A cause with no ticket
      // to land on (a queue release names an agent, not a ticket) reaches the
      // operator through the log and the `supervision` health probe instead.
      const ticketId = acted.find(
        (r) => r.cause === ind.cause && r.tenantId === tenantId && r.ticketId,
      )?.ticketId;
      if (ticketId) {
        try {
          await deps.comment({
            ticketId,
            tenantId,
            authorType: "system",
            authorId: SUPERVISOR_COMMENT_AUTHOR,
            body: text,
          });
        } catch (e) {
          console.warn(
            `[supervisor] escalation comment failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  }
  return out;
}
