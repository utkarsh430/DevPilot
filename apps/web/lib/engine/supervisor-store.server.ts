// Production wiring for the project supervisor's injected deps.
//
// This is the ONLY file on the supervision path that touches a `server-only`
// module. Everything that decides anything lives in the marker-free
// `supervisor-store.ts` (the IO worker) and `supervisor-policy.ts` (the pure
// rules), so both are loadable - and therefore testable - under Vitest. Same
// split, same reasoning, as `harvest-batch.ts` / `harvest.server.ts`.

import "server-only";

import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { claimNext } from "@/lib/engine/dispatch-queue";
import { addComment, transitionTicket } from "@/lib/board/transitions";
import { getEffectivePauseForTicket } from "@/lib/engine/automation-state";
import {
  dispatchRescueGraceSeconds,
  loadDispatchQueueGroups,
  releaseGroup,
  type DispatchRescueDeps,
} from "@/lib/engine/dispatch-rescue-store";
import { recoverOrphanedTicket, type OrphanReaperDeps } from "@/lib/engine/orphan-ticket-reaper";
import { settleLandedPush } from "@/lib/integration/landed-push";
import {
  engineStaleSeconds,
  indictmentThreshold,
  indictmentWindowSeconds,
  orphanGraceSeconds,
  type SupervisorDeps,
} from "@/lib/engine/supervisor-store";

/**
 * Wire the supervisor to the engine's real recovery primitives.
 *
 * THE EMIT IS BOUNDED, and this is the one place these deps deliberately differ
 * from `defaultDispatchRescueDeps`. That function is on the
 * `BACKGROUND_ONLY_EMITTERS` allowlist because it only ever runs inside a cron,
 * where a raw `inngest.send` is already bounded by the step timeout. The
 * supervisor runs on a REQUEST PATH (a runner POST), where an unbounded send
 * against a wedged event endpoint does not fail - it never settles, so no
 * `catch` runs and every statement after it is simply never executed. That is
 * precisely the failure this whole feature exists to survive, and it is
 * reachable here because remediation runs exactly when the endpoint is known to
 * be sick.
 *
 * THE EMIT ALSO SWALLOWS ITS ERROR, which `releaseGroup` would otherwise treat
 * as a reason to stop releasing. During a wedge the emit is EXPECTED to fail;
 * the release itself - the atomic claim - has already succeeded, and that claim
 * is the part that matters, because a `pending` row is what disarms the stalled
 * ticket recovery on the next pass. See `executeSupervisionPlan`.
 */
export function defaultSupervisorDeps(nowIso: string): SupervisorDeps {
  const db = supabaseService();

  const dispatchDeps: DispatchRescueDeps = {
    db,
    emitDispatch: async ({ ticketId, tenantId }) => {
      try {
        await sendEventBounded({ name: "ticket/dispatch-needed", data: { ticketId, tenantId } });
      } catch (e) {
        console.warn(
          `[supervisor] dispatch emit failed for ticket=${ticketId} (expected while the event ` +
            `endpoint is wedged; the queue row is already released): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    claim: claimNext,
    nowIso,
    graceSeconds: dispatchRescueGraceSeconds(),
  };

  const orphanDeps: OrphanReaperDeps = {
    db,
    nowIso,
    graceSeconds: orphanGraceSeconds(),
    isAutomationPaused: async (tenantId, ticketId) =>
      (await getEffectivePauseForTicket(tenantId, ticketId)).paused,
    transition: (args) => transitionTicket(args).then((r) => ({ transitioned: r.transitioned })),
    comment: (args) => addComment(args),
  };

  return {
    db,
    nowIso,
    releaseQueue: (group) => releaseGroup(dispatchDeps, group),
    recoverTicket: (candidate) => recoverOrphanedTicket(orphanDeps, candidate),
    // The landing path's OWN settle writer, unchanged and un-wrapped. The
    // supervisor adds the evidence rule and the ledger row; the write itself -
    // one row, by id, CAS-guarded on `pushed_at IS NULL`, tenant-scoped - is
    // byte-for-byte what `stampLanded` performs, so the sweep can never settle a
    // row on terms the landing path would not have.
    settlePush: ({ pendingPushId, tenantId }) => settleLandedPush(db, { pendingPushId, tenantId }),
    loadQueueGroups: (tenantId) => loadDispatchQueueGroups({ db }, tenantId),
    isAutomationPaused: orphanDeps.isAutomationPaused,
    comment: orphanDeps.comment,
    staleSeconds: engineStaleSeconds(),
    dispatchGraceSeconds: dispatchRescueGraceSeconds(),
    orphanGraceSeconds: orphanGraceSeconds(),
    indictWindowSeconds: indictmentWindowSeconds(),
    indictThreshold: indictmentThreshold(),
  };
}
