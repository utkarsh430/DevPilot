// Orphaned-ticket reaper - the cron that stops a dead ticket from claiming to
// be busy.
//
// THE INVARIANT: a ticket in an agent-owned working state must have either a
// live run or a queued dispatch. When it has neither, nothing inside the
// product can revive it - a human reply on an `in_progress` ticket does not
// re-dispatch (only `input_required` does), so the operator's messages pile up
// in a thread nobody is reading. Recovering that took a manual database write.
//
// The whole "why does this exist / why did the existing reapers miss it /
// which states / how long / what recovery means" argument lives in the pure
// policy beside this file: lib/engine/orphan-ticket-policy.ts. Read that first.
//
// Shape (following lib/engine/ticket-dep-suggester.ts):
//   • an exported plain worker (`recoverOrphanedTicket`, `sweepOrphanedTickets`)
//     that takes injected deps, so the whole thing is unit-testable with a fake
//     Supabase client and no Inngest;
//   • try/catch throughout - a reaper that throws is a reaper that stops
//     reaping, and one bad row must never stall the sweep;
//   • `{ok:false, reason}` returns rather than throws, so expected non-events
//     (within grace, live run, paused tenant) don't show as red Inngest runs.
//
// Tenant scoping: this runs on the SERVICE client (a cron has no session, so
// RLS is off), and the co-located `.eq("tenant_id", …)` on EVERY read and write
// is the entire boundary. It matters more than usual here because every one of
// the evidence reads is a DISARM signal - a row visible across the tenant line
// could either make us stand down and strand a ticket for good, or make us act
// on someone else's. `tenantId` always comes from the candidate ticket row the
// scan selected, never from a caller.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { getEffectivePauseForTicket } from "@/lib/engine/automation-state";
import { addComment, transitionTicket } from "@/lib/board/transitions";
import type { TicketStatus } from "@/lib/board/state";
import {
  decideOrphanRecovery,
  LIVE_RUN_STATUSES,
  ORPHAN_GRACE_SECONDS_DEFAULT,
  ORPHAN_REAPER_COMMENT_AUTHOR,
  ORPHANABLE_TICKET_STATUSES,
  orphanIdleSinceIso,
  renderOrphanRecoveryComment,
  type OrphanableStatus,
} from "@/lib/engine/orphan-ticket-policy";

const REAPER_ENABLED = (process.env.DEVPILOT_ORPHAN_TICKET_REAPER ?? "1") !== "0";
const BATCH_LIMIT = Number(process.env.DEVPILOT_ORPHAN_TICKET_REAPER_BATCH ?? "25");

function graceSeconds(): number {
  const raw = Number(process.env.DEVPILOT_ORPHAN_TICKET_GRACE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : ORPHAN_GRACE_SECONDS_DEFAULT;
}

export type OrphanReaperDeps = {
  db: SupabaseClient;
  /** Effective project/tenant automation pause for this ticket. */
  isAutomationPaused: (tenantId: string, ticketId: string) => Promise<boolean>;
  /** The one transition seam. Injected so tests can assert the exact args
   *  (actor, expectedFrom, emitDispatch) without a live board. */
  transition: (args: {
    ticketId: string;
    tenantId: string;
    to: TicketStatus;
    actor: "system";
    expectedFrom: OrphanableStatus;
    emitDispatch: boolean;
  }) => Promise<{ transitioned: boolean }>;
  comment: (args: {
    ticketId: string;
    tenantId: string;
    authorType: "system";
    authorId: string;
    body: string;
  }) => Promise<void>;
  nowIso: string;
  graceSeconds: number;
};

export type OrphanCandidate = {
  id: string;
  tenant_id: string;
  status: string;
  updated_at: string;
};

export type OrphanRecoveryResult =
  | { ok: true; recovered: true; to: TicketStatus }
  | { ok: true; recovered: false; reason: string }
  | { ok: false; reason: string };

/**
 * Evaluate ONE candidate ticket and, if it is genuinely orphaned, hand it back
 * to the human. Never throws.
 *
 * All FIVE evidence reads happen before the policy runs, and none of them
 * short-circuits. That is deliberate: the "never touch live work" guarantee is
 * expressed and tested in ONE place (the pure policy), so these reads gather
 * facts and make no decisions. The cost is a handful of indexed point-lookups
 * per candidate, and the candidate set is already narrowed by the grace
 * pre-filter and the batch cap.
 */
export async function recoverOrphanedTicket(
  deps: OrphanReaperDeps,
  ticket: OrphanCandidate,
): Promise<OrphanRecoveryResult> {
  try {
    const status = ticket.status as OrphanableStatus;
    if (!(ORPHANABLE_TICKET_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, reason: `not-orphanable-status:${ticket.status}` };
    }
    const tenantId = ticket.tenant_id;

    // (a) Is anything live? THE guard - a run in `running` or `awaiting_human`
    //     means work is in flight (or legitimately waiting on a human for
    //     days), and we stand down.
    const { data: liveRuns, error: liveErr } = await deps.db
      .from("runs")
      .select("id")
      .eq("ticket_id", ticket.id)
      .eq("tenant_id", tenantId)
      .in("status", LIVE_RUN_STATUSES as unknown as string[])
      .limit(1);
    if (liveErr) return { ok: false, reason: `live-run-lookup:${liveErr.message.slice(0, 120)}` };

    // (b) Is anything queued? A pending `dispatch_queue` row means the WIP gate
    //     is holding this ticket and the drain will release it.
    //
    //     THAT SECOND CLAUSE WAS A PROMISE NOTHING KEPT until 2026-08-03. The
    //     drain (`dispatchOnRunComplete`) fires only on `agent/run.completed`,
    //     so a lost or never-sent completion left the row pending forever — and
    //     because this guard trusts a pending row unconditionally, the ticket
    //     holding it became permanently invisible to the one reaper that owns
    //     failed/cancelled strandings. That is the difference between the
    //     tickets this reaper recovered in that incident and the ones it did
    //     not: the survivors had no queue row.
    //
    //     The guard is deliberately UNCHANGED — standing down while a release
    //     is genuinely coming is correct, and bounding it here would mean
    //     re-deriving capacity in a second place that could disagree with the
    //     dispatcher. What changed is that the promise is now kept:
    //     `dispatchRescueReaper` (lib/engine/dispatch-rescue.ts) releases a
    //     queue row whose completion never arrives, so "the drain will release
    //     it" is true within one grace period rather than never.
    const { data: queued, error: queueErr } = await deps.db
      .from("dispatch_queue")
      .select("id")
      .eq("ticket_id", ticket.id)
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .limit(1);
    if (queueErr) return { ok: false, reason: `queue-lookup:${queueErr.message.slice(0, 120)}` };

    // (c) The newest run - its status decides whether this ticket is ours at
    //     all (a `done` latest run belongs to the stuck-ticket sweeper) and its
    //     activity timestamp is half the grace clock.
    const { data: latestRows, error: latestErr } = await deps.db
      .from("runs")
      .select("id, status, status_reason, fan_out_group, created_at, last_event_at")
      .eq("ticket_id", ticket.id)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (latestErr) return { ok: false, reason: `latest-run:${latestErr.message.slice(0, 120)}` };
    const latest = (latestRows ?? [])[0] as
      | {
          status: string;
          status_reason: string | null;
          fan_out_group: string | null;
          created_at: string;
          last_event_at: string | null;
        }
      | undefined;

    // (d) Have we already spoken about this stall?
    const { data: priorComments, error: commentErr } = await deps.db
      .from("comments")
      .select("created_at")
      .eq("ticket_id", ticket.id)
      .eq("tenant_id", tenantId)
      .eq("author_id", ORPHAN_REAPER_COMMENT_AUTHOR)
      .order("created_at", { ascending: false })
      .limit(1);
    if (commentErr) {
      return { ok: false, reason: `comment-lookup:${commentErr.message.slice(0, 120)}` };
    }

    // (e) The operator's off switch. A board/workspace pause cancels the run and
    //     deliberately leaves the ticket where it is, which is indistinguishable
    //     from an orphan without this read.
    const automationPaused = await deps.isAutomationPaused(tenantId, ticket.id);

    const latestRunActivityIso = latest ? (latest.last_event_at ?? latest.created_at) : null;
    const decision = decideOrphanRecovery({
      status,
      ticketUpdatedAtIso: ticket.updated_at,
      hasLiveRun: (liveRuns ?? []).length > 0,
      hasPendingDispatch: (queued ?? []).length > 0,
      latestRunStatus: latest?.status ?? null,
      latestRunFanOutGroup: latest?.fan_out_group ?? null,
      latestRunActivityIso,
      automationPaused,
      lastRecoveryCommentIso:
        ((priorComments ?? [])[0] as { created_at: string } | undefined)?.created_at ?? null,
      nowIso: deps.nowIso,
      graceSeconds: deps.graceSeconds,
    });

    if (decision.action === "none") {
      return { ok: true, recovered: false, reason: decision.reason };
    }

    // Compare-and-set on the status we evaluated: anything that moved the
    // ticket between our reads and this write wins, and we no-op rather than
    // clobber a newer state.
    //
    // `emitDispatch:false` is rule 3, and it is LOAD-BEARING rather than
    // decorative on the `blocked` path: transitionTicket suppresses the
    // dispatch by default only for done/failed/input_required/paused, so
    // `→ blocked` would otherwise fire `ticket/dispatch-needed` and re-run the
    // very work that just failed. (On the `input_required` path it is
    // redundant-but-explicit - we state the intent rather than inherit it.)
    const { transitioned } = await deps.transition({
      ticketId: ticket.id,
      tenantId,
      to: decision.to,
      actor: "system",
      expectedFrom: status,
      emitDispatch: false,
    });
    if (!transitioned) {
      return { ok: true, recovered: false, reason: "lost-cas-race" };
    }

    // Comment AFTER the transition, and only when it landed - an explanation of
    // a recovery that did not happen is worse than silence. A comment failure
    // is non-fatal: the ticket is already unstuck, which is the point.
    try {
      await deps.comment({
        ticketId: ticket.id,
        tenantId,
        authorType: "system",
        authorId: ORPHAN_REAPER_COMMENT_AUTHOR,
        body: renderOrphanRecoveryComment({
          to: decision.to,
          fromStatus: status,
          idleSinceIso: orphanIdleSinceIso({
            ticketUpdatedAtIso: ticket.updated_at,
            latestRunActivityIso,
          }),
          graceSeconds: deps.graceSeconds,
          latestRunStatus: latest?.status ?? null,
          latestRunStatusReason: latest?.status_reason ?? null,
        }),
      });
    } catch (err) {
      console.warn(
        `[orphan-ticket-reaper] ticket=${ticket.id} recovered to ${decision.to} but the comment failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    console.log(
      `[orphan-ticket-reaper] ticket=${ticket.id} ${status} → ${decision.to} (${decision.reason})`,
    );
    return { ok: true, recovered: true, to: decision.to };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[orphan-ticket-reaper] ticket=${ticket.id} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

export type OrphanSweepResult = {
  scanned: number;
  recovered: number;
  outcomes: Array<{ ticketId: string; outcome: string }>;
};

/**
 * Scan for candidates and evaluate each. Candidates are pre-filtered on
 * `updated_at < now - grace` so the obviously-live majority never leaves
 * Postgres; the policy re-derives the grace from full evidence anyway (the
 * ticket's `updated_at` is only half the clock - a run that failed a minute ago
 * on an old ticket must still get the full window).
 */
export async function sweepOrphanedTickets(deps: OrphanReaperDeps): Promise<OrphanSweepResult> {
  const outcomes: Array<{ ticketId: string; outcome: string }> = [];
  let recovered = 0;

  const cutoffIso = new Date(Date.parse(deps.nowIso) - deps.graceSeconds * 1000).toISOString();

  const { data, error } = await deps.db
    .from("tickets")
    .select("id, tenant_id, status, updated_at")
    .in("status", ORPHANABLE_TICKET_STATUSES as unknown as string[])
    .lt("updated_at", cutoffIso)
    .order("updated_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) {
    console.warn(`[orphan-ticket-reaper] scan failed: ${error.message.slice(0, 200)}`);
    return { scanned: 0, recovered: 0, outcomes };
  }

  const candidates = (data ?? []) as OrphanCandidate[];
  for (const ticket of candidates) {
    const result = await recoverOrphanedTicket(deps, ticket);
    const outcome = !result.ok
      ? `error:${result.reason}`
      : result.recovered
        ? `recovered:${result.to}`
        : `skip:${result.reason}`;
    outcomes.push({ ticketId: ticket.id, outcome });
    if (result.ok && result.recovered) recovered += 1;
  }

  return { scanned: candidates.length, recovered, outcomes };
}

/** Production wiring for the injected deps. */
export function defaultOrphanReaperDeps(nowIso: string): OrphanReaperDeps {
  return {
    db: supabaseService(),
    nowIso,
    graceSeconds: graceSeconds(),
    isAutomationPaused: async (tenantId, ticketId) =>
      (await getEffectivePauseForTicket(tenantId, ticketId)).paused,
    transition: (args) => transitionTicket(args).then((r) => ({ transitioned: r.transitioned })),
    comment: (args) => addComment(args),
  };
}

// Inngest entry point.
//
// Cron every 5 minutes, matching its two sibling reapers (stale-run, stuck-
// ticket) - with the 30-minute grace an orphan is recovered 30–35 minutes after
// it strands. The `internal/` event trigger mirrors theirs so ops and acceptance
// scripts can invoke without waiting for the tick.
//
// `concurrency: { limit: 1 }` rather than the dep-suggester's per-tenant key:
// this is a cron with no tenant in its event data, and the resource it protects
// is the sweep itself - two overlapping ticks reading the same candidate window
// would both see "no live run" and race on the same recovery. The per-ticket CAS
// makes that safe rather than correct; the limit makes it not happen. There is
// no per-tenant contention to shard (no LLM call, no runner seat - this is pure
// Postgres), so a tenant key would only weaken the guarantee.
export const orphanTicketReaper = inngest.createFunction(
  { id: "orphan-ticket-reaper", retries: 1, concurrency: { limit: 1 } },
  [{ cron: "*/5 * * * *" }, { event: "internal/reap-orphan-tickets" }],
  async ({ step }) => {
    if (!REAPER_ENABLED) {
      return { skipped: "DEVPILOT_ORPHAN_TICKET_REAPER=0" };
    }
    return await step.run("sweep-orphans", async () =>
      sweepOrphanedTickets(defaultOrphanReaperDeps(new Date().toISOString())),
    );
  },
);
