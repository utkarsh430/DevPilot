// A landed ticket whose `pending_pushes` row was never settled: the READ half.
// The decision core is the pure `unsettled-push-policy.ts` - read that header
// first, it carries the argument for why a sweep is acceptable HERE when
// PR #156 refused a plain one.
//
// MARKER-FREE BY CONSTRUCTION, like `supervisor-store.ts`: the Supabase client
// arrives as an argument and nothing here imports `server-only`. Both modules
// this file leans on - `merger-push.ts` (`resolveTicketPush`) and
// `landed-push.ts` (`settleLandedPush`) - are already DI'd for the same reason,
// so the whole path is loadable, and therefore testable, under Vitest. That
// matters unusually much: the settle seam's live call sites (`land-worker.ts`,
// `queue.server.ts`) both reach `server-only` and cannot load at all, which is
// exactly the gap the two 2026-08-04 defects lived in.
//
// ── TENANT SCOPING ────────────────────────────────────────────────────────
// Every read here is service-role (the caller is a runner tick with no
// session), so RLS is off and the co-located `.eq("tenant_id", …)` is the
// ENTIRE boundary. What a missing predicate produces is not a disclosure: it is
// a `pushed_at` stamped on ANOTHER tenant's genuinely unpushed work, dropping it
// off their Changes badge and RELEASING THEIR REAP GUARD - i.e. a route to
// deleting the only copy of one of their commits. `tenantId` always comes from
// the supervised-project row that was scanned, never from the caller.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveTicketPush } from "@/lib/integration/merger-push";
import {
  NOTHING_TO_LAND_AUTHOR_ID,
  NOTHING_TO_LAND_METADATA_KIND,
} from "@/lib/integration/land-outcome";
import {
  decideUnsettledPushRepair,
  type UnsettledPushDecision,
  type UnsettledPushEvidence,
} from "@/lib/integration/unsettled-push-policy";

/**
 * How many unsettled rows one pass looks at, per tenant.
 *
 * Small on purpose. The loop runs every ~45s, so a backlog drains over a few
 * minutes rather than being fixed in one burst, and a board with more unsettled
 * rows than this has a write-path problem the sweep is not going to out-run. It
 * also bounds the cost: rows past this limit cost nothing at all this pass.
 */
export const UNSETTLED_PUSH_BATCH_LIMIT = 50;

/** One candidate, with everything the supervisor needs to act and to report. */
export type UnsettledPushCandidate = {
  tenantId: string;
  projectId: string;
  ticketId: string;
  pushId: string;
  branch: string;
  landedSha: string;
  /** How `resolveTicketPush` reached the row. Diagnostic; see the policy's
   *  `describeUnsettledPushRepair`. */
  via: "direct" | "merger";
};

/** What a pass looked at but deliberately left alone, for the log line. Never a
 *  ledger row and never a finding - see `runSupervisionPass`. */
export type UnsettledPushStandDownTally = Record<string, number>;

export type UnsettledPushScan = {
  candidates: UnsettledPushCandidate[];
  standDowns: UnsettledPushStandDownTally;
  /** Rows examined, before any decision. Reported so a zero-candidate pass is
   *  distinguishable from a pass that read nothing. */
  scanned: number;
};

type PushRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  ticket_id: string | null;
  branch: string;
  pushed_at: string | null;
};

type NoticeRow = {
  ticket_id: string | null;
  author_type: string | null;
  author_id: string | null;
  metadata: unknown;
};

/**
 * PR #137's `nothing_to_land` record, checked exactly as
 * `landing-records.ts#isNothingToLandNotice` checks it.
 *
 * All three clauses are required and `author_type === "system"` is the
 * load-bearing one: the only agent-facing comment route hardcodes
 * `author_type: "agent"`, writes no metadata, and gates its author id through a
 * role-slug regex - so an agent cannot forge a notice. Here the consequence of
 * a forgery would run the SAFE way (a forged notice suppresses a repair), but
 * the check is written identically so the two readers cannot drift into
 * disagreeing about what the record is.
 */
function isNothingToLandNotice(row: NoticeRow): boolean {
  if (row.author_type !== "system") return false;
  if (row.author_id !== NOTHING_TO_LAND_AUTHOR_ID) return false;
  const meta = row.metadata;
  if (!meta || typeof meta !== "object") return false;
  return (meta as { kind?: unknown }).kind === NOTHING_TO_LAND_METADATA_KIND;
}

function tally(into: UnsettledPushStandDownTally, decision: UnsettledPushDecision): void {
  if (decision.action !== "stand_down") return;
  into[decision.reason] = (into[decision.reason] ?? 0) + 1;
}

/**
 * Find every unsettled push row in this tenant's supervised projects whose
 * ticket has provably landed.
 *
 * TWO PHASES, and the split is a cost decision that must not become a policy
 * decision. Phase 1 reads the CHEAP facts in two batched queries and asks the
 * policy; a row it stands down on is finished, because every one of those arms
 * (`already-settled`, `no-ticket`, `not-landed`, `backfill-sentinel`) depends on
 * nothing else. Only a row the cheap facts cannot refuse pays for the expensive
 * per-row reads, and it is then re-decided by the SAME function on complete
 * evidence. The SQL and the batching are therefore a filter on WORK, never a
 * filter on what may be settled - the policy is the only thing that decides
 * that, and it decides it twice.
 *
 * Never throws: a supervision pass that can crash is not a supervisor. A failed
 * read yields fewer candidates, never a wrong one.
 */
export async function scanUnsettledLandedPushes(
  db: SupabaseClient,
  args: { tenantId: string; projectIds: readonly string[] },
): Promise<UnsettledPushScan> {
  const empty: UnsettledPushScan = { candidates: [], standDowns: {}, scanned: 0 };
  if (args.projectIds.length === 0) return empty;

  const { data: pushData, error: pushErr } = await db
    .from("pending_pushes")
    .select("id, tenant_id, project_id, ticket_id, branch, pushed_at")
    .eq("tenant_id", args.tenantId)
    .in("project_id", args.projectIds as string[])
    .is("pushed_at", null)
    .order("updated_at", { ascending: true })
    .limit(UNSETTLED_PUSH_BATCH_LIMIT);
  if (pushErr) {
    console.warn(
      `[supervisor] unsettled-push scan failed for tenant=${args.tenantId}: ` +
        `${pushErr.message.slice(0, 200)}`,
    );
    return empty;
  }

  const rows = (pushData ?? []) as PushRow[];
  if (rows.length === 0) return { ...empty, scanned: 0 };

  // ── Phase 1: the cheap facts. One batched ticket read for the whole page. ──
  const ticketIds = [...new Set(rows.map((r) => r.ticket_id).filter((id): id is string => !!id))];
  const landedByTicket = new Map<string, string | null>();
  if (ticketIds.length > 0) {
    const { data: ticketData, error: ticketErr } = await db
      .from("tickets")
      .select("id, landed_sha")
      .eq("tenant_id", args.tenantId)
      .in("id", ticketIds);
    if (ticketErr) {
      console.warn(
        `[supervisor] unsettled-push ticket read failed for tenant=${args.tenantId}: ` +
          `${ticketErr.message.slice(0, 200)}`,
      );
      return { ...empty, scanned: rows.length };
    }
    for (const t of (ticketData ?? []) as Array<{ id: string; landed_sha: string | null }>) {
      landedByTicket.set(t.id, t.landed_sha ?? null);
    }
  }

  const standDowns: UnsettledPushStandDownTally = {};
  const survivors: PushRow[] = [];
  for (const row of rows) {
    const decision = decideUnsettledPushRepair({
      pushId: row.id,
      pushedAt: row.pushed_at,
      ticketId: row.ticket_id,
      landedSha: row.ticket_id ? (landedByTicket.get(row.ticket_id) ?? null) : null,
      // Not yet read. Both default to the value that CANNOT create a settle:
      // `false` cannot refuse on the notice arm, and `null` refuses on the last
      // arm - so phase 1 can only ever stand a row DOWN, never approve it.
      hasNothingToLandNotice: false,
      resolvedPushId: null,
    });
    if (decision.action === "stand_down" && decision.reason !== "not-the-landings-row") {
      tally(standDowns, decision);
      continue;
    }
    survivors.push(row);
  }
  if (survivors.length === 0) return { candidates: [], standDowns, scanned: rows.length };

  // ── Phase 2: the expensive facts, only for rows the cheap ones could not
  //    refuse. Usually zero on a healthy board.
  const survivorTicketIds = [
    ...new Set(survivors.map((r) => r.ticket_id).filter((id): id is string => !!id)),
  ];
  const noticed = new Set<string>();
  const { data: noticeData, error: noticeErr } = await db
    .from("comments")
    .select("ticket_id, author_type, author_id, metadata")
    .eq("tenant_id", args.tenantId)
    .eq("author_id", NOTHING_TO_LAND_AUTHOR_ID)
    .in("ticket_id", survivorTicketIds);
  if (noticeErr) {
    // FAIL CLOSED. An unreadable notice table means we cannot tell a landing
    // from a nothing-to-land closure, and the second must not be settled.
    console.warn(
      `[supervisor] unsettled-push notice read failed for tenant=${args.tenantId}: ` +
        `${noticeErr.message.slice(0, 200)} - standing down on ${survivors.length} candidate(s)`,
    );
    standDowns["notice-read-failed"] = (standDowns["notice-read-failed"] ?? 0) + survivors.length;
    return { candidates: [], standDowns, scanned: rows.length };
  }
  for (const n of (noticeData ?? []) as NoticeRow[]) {
    if (n.ticket_id && isNothingToLandNotice(n)) noticed.add(n.ticket_id);
  }

  const candidates: UnsettledPushCandidate[] = [];
  for (const row of survivors) {
    const ticketId = row.ticket_id;
    if (!ticketId) continue;

    // The row the LANDING PATH itself would have settled. Same resolver
    // `loadLandContext` feeds `stampLanded`, so the sweep can never reach a row
    // the land path would not have.
    let resolved: Awaited<ReturnType<typeof resolveTicketPush>> = null;
    try {
      resolved = await resolveTicketPush(db, { ticketId, tenantId: args.tenantId });
    } catch (e) {
      console.warn(
        `[supervisor] unsettled-push resolve failed for ticket=${ticketId}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
      standDowns["resolve-failed"] = (standDowns["resolve-failed"] ?? 0) + 1;
      continue;
    }

    const evidence: UnsettledPushEvidence = {
      pushId: row.id,
      pushedAt: row.pushed_at,
      ticketId,
      landedSha: landedByTicket.get(ticketId) ?? null,
      hasNothingToLandNotice: noticed.has(ticketId),
      resolvedPushId: resolved?.id ?? null,
    };
    const decision = decideUnsettledPushRepair(evidence);
    if (decision.action !== "settle") {
      tally(standDowns, decision);
      continue;
    }

    candidates.push({
      tenantId: row.tenant_id,
      projectId: row.project_id,
      ticketId,
      pushId: row.id,
      branch: row.branch,
      // `decideUnsettledPushRepair` refuses a null/backfill sha above, so this
      // narrowing is guaranteed by the arm we just passed.
      landedSha: landedByTicket.get(ticketId) as string,
      via: resolved?.via ?? "direct",
    });
  }

  return { candidates, standDowns, scanned: rows.length };
}
