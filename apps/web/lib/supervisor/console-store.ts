// The supervisor console's READ/ACT half. MARKER-FREE BY CONSTRUCTION - it
// imports no `server-only` value; the Supabase client, the two recovery
// primitives and the automation-pause resolver arrive as INJECTED DEPS, with
// production wiring in the `.server.ts` twin. Same split, same reasoning, as
// `supervisor-store.ts` / `supervisor-store.server.ts` next door: the primitives
// each reach `server-only`, so a module importing them directly cannot load
// under Vitest, which is precisely the gap defects in this codebase keep living
// in.
//
// ── TENANT SCOPING IS THE ENTIRE BOUNDARY ─────────────────────────────────
// Every read here runs service-role with RLS off, so the co-located
// `.eq("tenant_id", …)` on each one is the only thing separating boards. It
// matters unusually much for this surface in BOTH directions:
//
//   • what an unscoped read leaks is not merely another tenant's ticket titles,
//     it is a list of tickets the ACT half can then MOVE; and
//   • a foreign row folded into the explanation makes the console describe a
//     board the operator is not looking at, with total confidence.
//
// `tenantId` always comes from the caller's SESSION (the server action resolves
// it via `requireTenantId`), never from a request field, and the project is
// re-checked against it before anything else runs.
//
// ── THE LEDGER: WHY A COMMANDED FIX SHARES THE AUTONOMOUS CAUSES ──────────
// AGENTS.md records the incident this whole feature family exists for: an
// operator hand-swept the same board about six times in one day, every sweep
// worked, and every sweep HID a WIP-slot leak - which stayed invisible for
// hours precisely because its symptoms kept being cleared.
//
// A console that lets an operator sweep faster makes that strictly worse unless
// the sweeps are counted. So a commanded remediation writes a
// `supervisor_actions` row with the SAME `cause` the autonomous supervisor
// would have used (`board_deadlock`, `stalled_ticket`), which is what
// `detectRepeatDefect` groups on. Giving commanded fixes their own cause would
// read as tidier and would silently re-open the hole: the indictment would
// stop seeing exactly the sweeps a human performs, which are the ones that
// caused the incident.
//
// Provenance lives in `action` instead - `operator:release_dispatch_queue`
// rather than `release_dispatch_queue` - so "what happened to my board" and
// "why does this keep happening" stay separable without splitting the count.

import type { SupabaseClient } from "@supabase/supabase-js";
// TYPE-ONLY: both reach `server-only`. Type imports are erased, so they cost
// nothing at runtime; a VALUE import from either would make this file
// unloadable under Vitest.
import type { DispatchQueueGroup } from "@/lib/engine/dispatch-rescue-policy";
import type { OrphanCandidate } from "@/lib/engine/orphan-ticket-reaper";
import { detectDispatchStall } from "@/lib/engine/dispatch-rescue-policy";
import {
  LIVE_RUN_STATUSES,
  ORPHANABLE_TICKET_STATUSES,
  ORPHAN_REAPER_COMMENT_AUTHOR,
  type OrphanEvidence,
  type OrphanableStatus,
} from "@/lib/engine/orphan-ticket-policy";
import { readEngineLiveness } from "@/lib/engine/supervisor-store";
import type { TicketStatus } from "@/lib/board/state";
import { BLOCKING_RELATION_TYPES } from "@/lib/board/dependencies";
import { formatTicketKey } from "@/lib/board/ticket-key";
import { LAND_PENDING_QUEUE_STATES, classifyBlocker } from "@/lib/integration/landed";
import { deriveLandingState } from "@/lib/integration/landing-state";
import { loadTicketLandingRecords } from "@/lib/integration/landing-records";
import {
  evaluateOrphan,
  type ConsoleBlocker,
  type ConsoleSnapshot,
  type ConsoleTicketFact,
} from "@/lib/supervisor/console-facts";
import {
  deriveAvailableActions,
  describeActionOutcome,
  findConsoleAction,
  type ConsoleAction,
  type ConsoleActionOutcome,
} from "@/lib/supervisor/console-actions";

/**
 * How many tickets one snapshot covers. Terminal-and-settled tickets are
 * excluded by the query, so on a healthy board this is far more than enough;
 * on an unhealthy one the cap is reported (`truncated`) rather than silently
 * making the counts a lie.
 */
const TICKET_SCAN_LIMIT = 80;
/** Cap on the run rows one snapshot reads. */
const RUN_SCAN_LIMIT = 800;
/** Cap on the platform-note rows one snapshot reads. */
const NOTICE_SCAN_LIMIT = 400;
/** How much of a platform note is carried. The rest is on the ticket. */
const NOTICE_EXCERPT_CHARS = 1200;
/** How many operator-named tickets one snapshot pulls in beyond the scan. */
const MAX_FOCUS_TICKETS = 6;

/** Statuses for which a landing verdict is meaningful. Mirrors the board card's
 *  own `SETTLED_STATUSES` - the scan excludes `failed`, so in practice `done`. */
const SETTLED_TICKET_STATUSES = new Set(["done", "failed"]);

/**
 * System comment authors that explain nothing about why a ticket is where it
 * is, and would otherwise crowd out the note that does.
 *
 * A DENYLIST rather than an allowlist, deliberately. The console's value is
 * explanation, so the failure modes are asymmetric: a missing entry here costs
 * one noisy quote, while a missing entry in an allowlist would silently hide
 * the one comment that answers the operator's question - and every new park or
 * gate in the engine ships with a new author id. `schedule:adhoc` is the only
 * high-volume member today (it stamps a line on every scheduled dispatch).
 */
export const CONSOLE_NOTICE_NOISE_AUTHORS = new Set(["schedule:adhoc"]);

// ───────────────────────────────────────────────────────────────────────────
// Deps
// ───────────────────────────────────────────────────────────────────────────

export type ConsoleDeps = {
  db: SupabaseClient;
  nowIso: string;
  /** Live queue groups for one tenant. Production: `loadDispatchQueueGroups`. */
  loadQueueGroups: (tenantId: string) => Promise<DispatchQueueGroup[]>;
  /** Effective project/tenant automation pause for a ticket. */
  isAutomationPaused: (tenantId: string, ticketId: string) => Promise<boolean>;
  /** THE recovery primitives, injected - the exact functions the crons call.
   *  Nothing about recovery is reimplemented in this module. */
  releaseQueue: (group: DispatchQueueGroup) => Promise<{ reason: string; released: number }>;
  recoverTicket: (
    candidate: OrphanCandidate,
  ) => Promise<
    | { ok: true; recovered: true; to: TicketStatus }
    | { ok: true; recovered: false; reason: string }
    | { ok: false; reason: string }
  >;
  staleSeconds: number;
  dispatchGraceSeconds: number;
  orphanGraceSeconds: number;
};

// ───────────────────────────────────────────────────────────────────────────
// Snapshot
// ───────────────────────────────────────────────────────────────────────────

type TicketRow = {
  id: string;
  ticket_number: number | null;
  title: string | null;
  status: string;
  requested_role: string | null;
  updated_at: string;
  landed_sha: string | null;
  retry_count: number | null;
  gate_retry_count: number | null;
  safety_critical: boolean | null;
};

export type ConsoleSnapshotResult = {
  snapshot: ConsoleSnapshot;
  /** Carried alongside because `deriveAvailableActions` needs them and the
   *  ACT path must re-derive from the same shape the EXPLAIN path used. */
  queueGroups: DispatchQueueGroup[];
  actions: ConsoleAction[];
};

/**
 * Read one board, end to end.
 *
 * NOTHING HERE IS GATED ON `supervisor_enabled` OR ON ENGINE HEALTH, and that
 * is a requirement rather than an oversight: a board is most worth explaining
 * exactly when it is broken and when its operator never opted in to automatic
 * remediation. The opt-in gates ACT only, and it is carried on the snapshot so
 * the console can say so.
 *
 * Every read is batched by ticket id; the query count is flat in the number of
 * tickets (one scan plus seven fan-out reads), so a 5-ticket board and an
 * 80-ticket board cost the same round trips.
 */
export async function loadConsoleSnapshot(
  deps: ConsoleDeps,
  args: {
    tenantId: string;
    projectId: string;
    /**
     * Ticket keys the operator named, pinned into the snapshot even when the
     * base scan would have excluded them.
     *
     * FOUND BY DRIVING IT: asked "why is DevPilot-86 blocked", the console
     * correctly refused to guess - and was useless, because 86 had reached
     * `done` and landed minutes earlier and so fell outside the scan. The scan
     * is right to exclude settled work by default (a board carries hundreds of
     * them) and the operator is right to ask about any ticket they can see, so
     * the two are reconciled here rather than by widening the scan.
     */
    focusTicketKeys?: readonly string[];
  },
): Promise<{ ok: true; result: ConsoleSnapshotResult } | { ok: false; error: string }> {
  const { tenantId, projectId } = args;

  // The project is re-checked against the caller's tenant BEFORE anything else
  // reads a row. Everything downstream keys on `projectId`, and `tickets`'
  // write policy pins the row's own `tenant_id` and says nothing about the
  // `project_id` it points at - so this check plus the per-read predicate is
  // what makes a project id from a URL safe to use as a scan key.
  const { data: projectRow, error: projectErr } = await deps.db
    .from("projects")
    .select("id, name, supervisor_enabled, automation_state")
    .eq("id", projectId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (projectErr) return { ok: false, error: `project read failed: ${projectErr.message}` };
  if (!projectRow) return { ok: false, error: "project not found in this workspace" };
  const project = projectRow as {
    id: string;
    name: string | null;
    supervisor_enabled: boolean | null;
    automation_state: string | null;
  };

  const [tenantRow, liveness, queueGroups, ticketsRes] = await Promise.all([
    deps.db.from("tenants").select("automation_state").eq("id", tenantId).maybeSingle(),
    readEngineLiveness(deps.db, deps.nowIso, deps.staleSeconds),
    deps.loadQueueGroups(tenantId).catch(() => [] as DispatchQueueGroup[]),
    // Non-terminal tickets, plus `done` ones whose work may not have landed.
    // `failed` is excluded: it is a settled outcome nothing is waiting on, and
    // including it would drown the alarm set in history.
    deps.db
      .from("tickets")
      .select(
        "id, ticket_number, title, status, requested_role, updated_at, landed_sha, retry_count, gate_retry_count, safety_critical",
      )
      .eq("tenant_id", tenantId)
      .eq("project_id", projectId)
      .neq("status", "failed")
      .or("status.neq.done,landed_sha.is.null")
      .order("updated_at", { ascending: false })
      .limit(TICKET_SCAN_LIMIT + 1),
  ]);

  if (ticketsRes.error)
    return { ok: false, error: `ticket scan failed: ${ticketsRes.error.message}` };
  const allRows = (ticketsRes.data ?? []) as TicketRow[];
  const truncated = allRows.length > TICKET_SCAN_LIMIT;
  const scanned = allRows.slice(0, TICKET_SCAN_LIMIT);
  const rows = scanned.concat(
    await loadFocusTickets(deps.db, tenantId, projectId, args.focusTicketKeys ?? [], scanned),
  );
  const ids = rows.map((r) => r.id);

  const [
    runs,
    liveRuns,
    notices,
    blockers,
    pausedByTicket,
    landing,
    pendingDispatch,
    unpushed,
    lastRecoveryComment,
  ] = await Promise.all([
    loadLatestRuns(deps.db, tenantId, ids),
    loadLiveRuns(deps.db, tenantId, ids),
    loadPlatformNotices(deps.db, tenantId, ids),
    loadBlockerMap(deps.db, tenantId, ids),
    loadAutomationPauses(deps, tenantId, rows),
    loadTicketLandingRecords(deps.db, tenantId, ids),
    loadPendingDispatch(deps.db, tenantId, ids),
    loadUnpushedBranches(deps.db, tenantId, ids),
    loadLastRecoveryComments(deps.db, tenantId, ids),
  ]);

  const tickets: ConsoleTicketFact[] = rows.map((row) => {
    const key = formatTicketKey(row.ticket_number, row.id);
    const latest = runs.get(row.id) ?? null;
    const live = liveRuns.get(row.id) ?? { any: false, awaitingHuman: false };
    const status = row.status as TicketStatus;
    const records = landing.get(row.id) ?? null;

    // The orphan verdict comes from the reaper's OWN policy, fed the same five
    // pieces of evidence it gathers for itself. That is what stops the console
    // ever claiming a ticket is recoverable that the primitive would refuse.
    const orphanEvidence: OrphanEvidence | null = (
      ORPHANABLE_TICKET_STATUSES as readonly string[]
    ).includes(status)
      ? {
          status: status as OrphanableStatus,
          ticketUpdatedAtIso: row.updated_at,
          hasLiveRun: live.any,
          hasPendingDispatch: pendingDispatch.has(row.id),
          latestRunStatus: latest?.status ?? null,
          latestRunFanOutGroup: latest?.fanOutGroup ?? null,
          latestRunActivityIso: latest?.activityIso ?? null,
          automationPaused: pausedByTicket.get(row.id) ?? false,
          lastRecoveryCommentIso: lastRecoveryComment.get(row.id) ?? null,
          nowIso: deps.nowIso,
          graceSeconds: deps.orphanGraceSeconds,
        }
      : null;

    return {
      ticketId: row.id,
      key,
      title: row.title ?? "(untitled)",
      status,
      requestedRole: row.requested_role,
      updatedAtIso: row.updated_at,
      blockers: blockers.byTicket.get(row.id) ?? [],
      blockersKnown: blockers.ok,
      hasLiveRun: live.any,
      hasPendingDispatch: pendingDispatch.has(row.id),
      latestRunStatus: latest?.status ?? null,
      latestRunActivityIso: latest?.activityIso ?? null,
      hasRunAwaitingHuman: live.awaitingHuman,
      notice: notices.get(row.id) ?? null,
      // ONLY for a SETTLED ticket. `deriveLandingState` answers "where did this
      // ticket's work end up", which is a question that only has an answer once
      // the ticket is finished - an in-flight ticket with an unpushed branch
      // would otherwise report `not_landed (never_pushed)`, which reads as a
      // failure when the truth is "an agent is still working on it". Exactly the
      // rule `landingCardTreatment` applies on the board card, and for the same
      // reason: a warning that fires while things are fine stops being read.
      landing:
        SETTLED_TICKET_STATUSES.has(row.status) && records
          ? deriveLandingState({ landedSha: row.landed_sha, ...records })
          : null,
      unpushedBranches: unpushed.get(row.id) ?? [],
      retryCount: row.retry_count ?? 0,
      gateRetryCount: row.gate_retry_count ?? 0,
      safetyCritical: row.safety_critical === true,
      automationPaused: pausedByTicket.get(row.id) ?? false,
      orphan: evaluateOrphan(orphanEvidence),
    };
  });

  const snapshot: ConsoleSnapshot = {
    nowIso: deps.nowIso,
    tenantId,
    projectId,
    projectName: project.name ?? "this project",
    supervisorEnabled: project.supervisor_enabled === true,
    automation: {
      project: project.automation_state === "paused" ? "paused" : "running",
      tenant:
        (tenantRow.data as { automation_state?: string } | null)?.automation_state === "paused"
          ? "paused"
          : "running",
    },
    engine: liveness,
    dispatch: detectDispatchStall(queueGroups, deps.nowIso, deps.dispatchGraceSeconds),
    tickets,
    truncated,
  };

  return {
    ok: true,
    result: {
      snapshot,
      queueGroups,
      actions: deriveAvailableActions(snapshot, queueGroups, deps.dispatchGraceSeconds),
    },
  };
}

/**
 * Fetch the tickets the operator named that the scan did not already return.
 *
 * Scoped by tenant AND project like every other read here, and keyed on
 * `ticket_number` - which is per-PROJECT, so a number from the question can
 * only ever resolve to a ticket on the board the operator is looking at. A key
 * that names no ticket simply returns nothing; the report says so rather than
 * quietly answering about something else.
 */
async function loadFocusTickets(
  db: SupabaseClient,
  tenantId: string,
  projectId: string,
  keys: readonly string[],
  already: readonly TicketRow[],
): Promise<TicketRow[]> {
  const numbers = keys
    .map((k) => Number(/^DevPilot-(\d+)$/.exec(k)?.[1] ?? NaN))
    .filter((n) => Number.isInteger(n) && n > 0)
    .filter((n) => !already.some((r) => r.ticket_number === n))
    .slice(0, MAX_FOCUS_TICKETS);
  if (numbers.length === 0) return [];
  const { data, error } = await db
    .from("tickets")
    .select(
      "id, ticket_number, title, status, requested_role, updated_at, landed_sha, retry_count, gate_retry_count, safety_critical",
    )
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .in("ticket_number", numbers);
  if (error) return [];
  return (data ?? []) as TicketRow[];
}

// ───────────────────────────────────────────────────────────────────────────
// Fan-out reads. Every one carries its own `.eq("tenant_id", …)`.
// ───────────────────────────────────────────────────────────────────────────

type LatestRun = { status: string; activityIso: string | null; fanOutGroup: string | null };

/** Newest run per ticket. Ordered by (ticket, created_at desc) so the first row
 *  seen for a ticket is its newest; PostgREST has no DISTINCT ON. */
async function loadLatestRuns(
  db: SupabaseClient,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, LatestRun>> {
  const out = new Map<string, LatestRun>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("runs")
    .select("ticket_id, status, fan_out_group, last_event_at, created_at")
    .eq("tenant_id", tenantId)
    .in("ticket_id", ids as string[])
    .order("ticket_id", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(RUN_SCAN_LIMIT);
  if (error) return out;
  for (const r of (data ?? []) as Array<{
    ticket_id: string;
    status: string;
    fan_out_group: string | null;
    last_event_at: string | null;
    created_at: string;
  }>) {
    if (out.has(r.ticket_id)) continue;
    out.set(r.ticket_id, {
      status: r.status,
      activityIso: r.last_event_at ?? r.created_at,
      fanOutGroup: r.fan_out_group,
    });
  }
  return out;
}

/** Live runs, asked separately from the "newest run" read so a ticket with a
 *  long run history can never push its own live run past the scan cap - which
 *  would report executing work as stalled, the one error that would make the
 *  console dangerous rather than merely wrong. */
async function loadLiveRuns(
  db: SupabaseClient,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, { any: boolean; awaitingHuman: boolean }>> {
  const out = new Map<string, { any: boolean; awaitingHuman: boolean }>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("runs")
    .select("ticket_id, status")
    .eq("tenant_id", tenantId)
    .in("ticket_id", ids as string[])
    .in("status", LIVE_RUN_STATUSES as unknown as string[]);
  if (error) return out;
  for (const r of (data ?? []) as Array<{ ticket_id: string; status: string }>) {
    const prev = out.get(r.ticket_id) ?? { any: false, awaitingHuman: false };
    out.set(r.ticket_id, {
      any: true,
      awaitingHuman: prev.awaitingHuman || r.status === "awaiting_human",
    });
  }
  return out;
}

/** Newest PLATFORM note per ticket - the reason a parked ticket is parked. */
async function loadPlatformNotices(
  db: SupabaseClient,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, ConsoleTicketFact["notice"]>> {
  const out = new Map<string, ConsoleTicketFact["notice"]>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("comments")
    .select("ticket_id, author_id, body, created_at")
    .eq("tenant_id", tenantId)
    .eq("author_type", "system")
    .in("ticket_id", ids as string[])
    .order("ticket_id", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(NOTICE_SCAN_LIMIT);
  if (error) return out;
  for (const r of (data ?? []) as Array<{
    ticket_id: string;
    author_id: string | null;
    body: string | null;
    created_at: string;
  }>) {
    if (out.has(r.ticket_id)) continue;
    const author = r.author_id ?? "system";
    if (CONSOLE_NOTICE_NOISE_AUTHORS.has(author)) continue;
    out.set(r.ticket_id, {
      author,
      createdAtIso: r.created_at,
      excerpt: (r.body ?? "").slice(0, NOTICE_EXCERPT_CHARS),
    });
  }
  return out;
}

/**
 * Blockers per ticket, with each one's openness from `classifyBlocker`.
 *
 * Filtered on `BLOCKING_RELATION_TYPES`. An @mention auto-creates a `related`
 * row, and an unfiltered walk would report a mentioned ticket as a blocker -
 * the same bug class that once held real tickets out of `ready` with nothing on
 * the board saying why.
 */
async function loadBlockerMap(
  db: SupabaseClient,
  tenantId: string,
  ids: readonly string[],
): Promise<{ byTicket: Map<string, ConsoleBlocker[]>; ok: boolean }> {
  const out = new Map<string, ConsoleBlocker[]>();
  if (ids.length === 0) return { byTicket: out, ok: true };

  // NO `.eq("tenant_id", …)` HERE, AND THAT IS DELIBERATE: `ticket_dependencies`
  // HAS NO SUCH COLUMN. Adding one is not a harmless extra predicate - PostgREST
  // answers 42703 and the whole read fails, which (before this comment existed)
  // made EVERY ticket on the board report as having no blockers at all. Found by
  // driving the console against a real board: it said DevPilot-92 was "unblocked
  // with nothing queued" while the database had it `blocked_by` DevPilot-27.
  //
  // The boundary is on the ENDPOINTS instead, exactly as `fetchBlockerRows` does
  // it: `ticket_id` comes from our own tenant- and project-scoped scan, and each
  // `blocks_ticket_id` is resolved through a tenant-scoped `tickets` read below,
  // so a dependency row pointing out of the tenant resolves to nothing and is
  // dropped rather than rendered.
  const { data: edges, error } = await db
    .from("ticket_dependencies")
    .select("ticket_id, blocks_ticket_id, relation_type")
    .in("ticket_id", ids as string[])
    .in("relation_type", BLOCKING_RELATION_TYPES as unknown as string[]);
  // An unreadable dependency read must NOT read as "no blockers" - that is the
  // unsafe direction, and it is the exact shape of the defect above. Report the
  // failure so every ticket says its dependencies are unknown.
  if (error) {
    console.warn(`[supervisor-console] blocker read failed: ${error.message.slice(0, 200)}`);
    return { byTicket: out, ok: false };
  }

  const rows = (edges ?? []) as Array<{
    ticket_id: string;
    blocks_ticket_id: string;
    relation_type: string;
  }>;
  const blockerIds = [...new Set(rows.map((r) => r.blocks_ticket_id).filter(Boolean))];
  if (blockerIds.length === 0) return { byTicket: out, ok: true };

  const [blockerRes, landPendingRes] = await Promise.all([
    db
      .from("tickets")
      .select("id, ticket_number, title, status, landed_sha")
      .eq("tenant_id", tenantId)
      .in("id", blockerIds),
    db
      .from("integration_queue")
      .select("ticket_id")
      .eq("tenant_id", tenantId)
      .in("ticket_id", blockerIds)
      .in("status", LAND_PENDING_QUEUE_STATES as unknown as string[]),
  ]);
  // Fail CLOSED on an unreadable queue, exactly as `fetchBlockerRows` does: an
  // empty answer would make every done-but-unlanded blocker read as closed,
  // which is the unsafe direction.
  const landPending = landPendingRes.error
    ? new Set(blockerIds)
    : new Set(
        ((landPendingRes.data ?? []) as Array<{ ticket_id: string }>).map((r) => r.ticket_id),
      );

  const byId = new Map<string, ConsoleBlocker>();
  for (const b of (blockerRes.data ?? []) as Array<{
    id: string;
    ticket_number: number | null;
    title: string | null;
    status: string;
    landed_sha: string | null;
  }>) {
    const state = {
      status: b.status as TicketStatus,
      landedSha: b.landed_sha,
      landPending: landPending.has(b.id),
    };
    byId.set(b.id, {
      key: formatTicketKey(b.ticket_number, b.id),
      title: b.title ?? "(untitled)",
      status: state.status,
      landedSha: state.landedSha,
      landPending: state.landPending,
      openness: classifyBlocker(state),
    });
  }

  for (const r of rows) {
    const blocker = byId.get(r.blocks_ticket_id);
    if (!blocker) continue;
    const list = out.get(r.ticket_id);
    if (list) list.push(blocker);
    else out.set(r.ticket_id, [blocker]);
  }
  // A failed `tickets` resolution is also reported: it would silently drop
  // every blocker for the same reason.
  return { byTicket: out, ok: !blockerRes.error };
}

async function loadPendingDispatch(
  db: SupabaseClient,
  tenantId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await db
    .from("dispatch_queue")
    .select("ticket_id")
    .eq("tenant_id", tenantId)
    .in("ticket_id", ids as string[])
    .eq("status", "pending");
  if (error) return new Set();
  return new Set(((data ?? []) as Array<{ ticket_id: string }>).map((r) => r.ticket_id));
}

async function loadUnpushedBranches(
  db: SupabaseClient,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, Array<{ branch: string; commits: number }>>> {
  const out = new Map<string, Array<{ branch: string; commits: number }>>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("pending_pushes")
    .select("ticket_id, branch, unpushed_count")
    .eq("tenant_id", tenantId)
    .in("ticket_id", ids as string[])
    .is("pushed_at", null);
  if (error) return out;
  for (const r of (data ?? []) as Array<{
    ticket_id: string | null;
    branch: string | null;
    unpushed_count: number | null;
  }>) {
    if (!r.ticket_id) continue;
    const list = out.get(r.ticket_id) ?? [];
    list.push({ branch: r.branch ?? "(unknown)", commits: r.unpushed_count ?? 0 });
    out.set(r.ticket_id, list);
  }
  return out;
}

/** Newest orphan-reaper comment per ticket - the reaper's own idempotency
 *  signal, gathered here so `decideOrphanRecovery` sees the same evidence it
 *  will see when the primitive re-derives it. */
async function loadLastRecoveryComments(
  db: SupabaseClient,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("comments")
    .select("ticket_id, created_at")
    .eq("tenant_id", tenantId)
    .eq("author_id", ORPHAN_REAPER_COMMENT_AUTHOR)
    .in("ticket_id", ids as string[])
    .order("ticket_id", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) return out;
  for (const r of (data ?? []) as Array<{ ticket_id: string; created_at: string }>) {
    if (!out.has(r.ticket_id)) out.set(r.ticket_id, r.created_at);
  }
  return out;
}

/** The effective pause, resolved per ticket. Only asked for tickets that could
 *  be affected by it - a settled ticket's pause state is not interesting and
 *  each call is a real round trip. */
async function loadAutomationPauses(
  deps: ConsoleDeps,
  tenantId: string,
  rows: readonly TicketRow[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const interesting = rows.filter((r) => r.status !== "done" && r.status !== "failed");
  if (interesting.length === 0) return out;
  // One representative resolve, then reuse: `getEffectivePauseForTicket`
  // resolves project + tenant state, which is identical for every ticket on one
  // board. Doing it per ticket would be N round trips for one answer.
  try {
    const paused = await deps.isAutomationPaused(tenantId, interesting[0]!.id);
    for (const r of interesting) out.set(r.id, paused);
  } catch {
    /* unreadable pause state is reported as not-paused; the snapshot's own
       `automation` fields carry the project/tenant answer independently. */
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// ACT
// ───────────────────────────────────────────────────────────────────────────

/**
 * Run ONE operator-commanded action.
 *
 * ── THE THREE THINGS THAT MAKE THIS SAFE, IN ORDER ────────────────────────
 *  1. The available-action list is RE-DERIVED here from the live database. The
 *     caller sends an id and nothing else; an id that is not on the freshly
 *     computed list is refused. So neither a forged POST nor a model reply can
 *     name a target the board does not currently offer.
 *  2. The primitive re-derives AGAIN. `recoverOrphanedTicket` re-reads all five
 *     pieces of evidence and re-runs `decideOrphanRecovery`; `releaseGroup`
 *     re-runs `decideDispatchRescue` and then claims rows atomically. A ticket
 *     that came alive between step 1 and step 2 is refused by the actor.
 *  3. A refusal is REPORTED, never worked around. See `console-actions.ts` for
 *     why no bypass may be added here.
 *
 * It is deliberately NOT gated on engine health. That gate belongs to the
 * autonomous loop, where the question is "should a second writer act on its own
 * initiative"; here a human is asking, and the primitives - not a health check -
 * are what make concurrent writers safe.
 *
 * It IS gated on `projects.supervisor_enabled`, because that switch is the
 * operator's own statement about whether this platform may move tickets on this
 * board at all.
 */
export async function runConsoleAction(
  deps: ConsoleDeps,
  args: { tenantId: string; projectId: string; actionId: string; requestedBy: string },
): Promise<ConsoleActionOutcome> {
  const loaded = await loadConsoleSnapshot(deps, args);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { snapshot, queueGroups, actions } = loaded.result;

  if (!snapshot.supervisorEnabled) {
    return {
      ok: false,
      error:
        "Supervision is switched off for this project, so the console may explain this board but " +
        "not change it. Turn on Supervision in the project settings to allow it.",
    };
  }

  const action = findConsoleAction(actions, args.actionId);
  if (!action) {
    return {
      ok: false,
      error:
        "That action is no longer available on this board - the state it applied to has changed. " +
        "Ask again for a fresh read.",
    };
  }

  if (action.kind === "release_dispatch_queue") {
    const group = queueGroups.find((g) => g.agentId === action.agentId);
    if (!group) {
      return { ok: false, error: "That agent's queue is no longer in the state that was offered." };
    }
    const out = await deps.releaseQueue(group);
    if (out.released > 0) {
      const summary = `Released ${out.released} queued dispatch(es) for this agent. The dispatcher re-applies every gate before any of them starts.`;
      await recordConsoleAction(deps, {
        tenantId: snapshot.tenantId,
        projectId: snapshot.projectId,
        ticketId: null,
        cause: action.cause,
        action: `operator:${action.kind}`,
        detail: `${args.requestedBy} ran "${action.label}". ${out.reason} - released ${out.released} row(s).`,
      });
      return { ok: true, kind: action.kind, applied: true, summary };
    }
    return {
      ok: true,
      kind: action.kind,
      applied: false,
      reason: out.reason,
      summary: describeActionOutcome(action.kind, out.reason),
    };
  }

  const planned = snapshot.tickets.find((t) => t.ticketId === action.ticketId);
  if (!planned) {
    return { ok: false, error: "That ticket is no longer in the state that was offered." };
  }
  const out = await deps.recoverTicket({
    id: planned.ticketId,
    tenant_id: snapshot.tenantId,
    status: planned.status,
    updated_at: planned.updatedAtIso,
  });
  if (out.ok && out.recovered) {
    const summary =
      `${planned.key} is now ${out.to === "input_required" ? "Input required" : "Blocked"}, with a ` +
      `comment on the ticket explaining that nothing was working on it. It has NOT been re-run.`;
    await recordConsoleAction(deps, {
      tenantId: snapshot.tenantId,
      projectId: snapshot.projectId,
      ticketId: planned.ticketId,
      cause: action.cause,
      action: `operator:recover_ticket`,
      detail: `${args.requestedBy} ran "${action.label}". ${planned.orphan?.reason ?? "stalled"} - handed back to a human as \`${out.to}\`.`,
    });
    return { ok: true, kind: action.kind, applied: true, summary };
  }
  const reason = out.reason;
  return {
    ok: true,
    kind: action.kind,
    applied: false,
    reason,
    summary: describeActionOutcome(action.kind, reason),
  };
}

/**
 * Write the ledger row. Never throws - losing the record must not undo a repair
 * that already happened.
 *
 * The `cause` is one of the AUTONOMOUS supervisor's causes on purpose; see this
 * file's header. `action` carries the `operator:` prefix so provenance is
 * legible without splitting the count that the repeat-defect detector groups on.
 */
export async function recordConsoleAction(
  deps: Pick<ConsoleDeps, "db" | "nowIso">,
  row: {
    tenantId: string;
    projectId: string | null;
    ticketId: string | null;
    cause: string;
    action: string;
    detail: string;
    /**
     * The operator console message that caused this fix, when one provably did.
     *
     * NULL for every autonomous remediation (nothing said anything) and for an
     * action run from the report without a conversation. It is written ONLY
     * when `decideConsoleMessageLink` could prove the stored message is the text
     * the command's target was derived from - a wrong link is worse than a
     * missing one, because a gap is visible and a plausible lie is not.
     */
    consoleMessageId?: string | null;
  },
): Promise<void> {
  const { error } = await deps.db.from("supervisor_actions").insert({
    tenant_id: row.tenantId,
    project_id: row.projectId,
    ticket_id: row.ticketId,
    cause: row.cause,
    action: row.action,
    detail: row.detail.slice(0, 2000),
    console_message_id: row.consoleMessageId ?? null,
    created_at: deps.nowIso,
  });
  if (error) {
    console.warn(`[supervisor-console] ledger write failed: ${error.message.slice(0, 200)}`);
  }
}
