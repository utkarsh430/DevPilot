// Production wiring for the supervisor console's injected deps.
//
// This is the ONLY file on the console's read/act path that touches a
// `server-only` module. Everything that decides anything lives in the
// marker-free `console-store.ts`, `console-facts.ts`, `console-actions.ts` and
// `console-brief.ts`, so all four are loadable - and therefore testable - under
// Vitest. Same split, same reasoning, as `supervisor-store.server.ts`.
//
// The deps are deliberately the SAME primitives the autonomous supervisor
// wires: `releaseGroup` and `recoverOrphanedTicket`, the exact functions the
// crons call, with the same caps, the same atomic claims, the same idempotency
// and the same operator-facing comments. The console reimplements no recovery.
//
// THE EMIT IS BOUNDED, for the same reason it is in `supervisor-store.server.ts`
// and one more besides: this is a REQUEST path (an operator clicked a button),
// and `inngest.send` has no timeout - against a wedged event endpoint it never
// settles, so no `catch` runs and every statement after it is simply never
// executed. The operator would watch a spinner forever while the release had
// already succeeded. The error is SWALLOWED for the same reason the autonomous
// path swallows it: the atomic claim has already happened and is the part that
// matters; a dispatch event that never lands is recovered by the ordinary
// machinery, a claim that is rolled back is not.

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
import { engineStaleSeconds, orphanGraceSeconds } from "@/lib/engine/supervisor-store";
import type { ConsoleDeps } from "@/lib/supervisor/console-store";

export function defaultConsoleDeps(nowIso: string): ConsoleDeps {
  const db = supabaseService();

  const dispatchDeps: DispatchRescueDeps = {
    db,
    emitDispatch: async ({ ticketId, tenantId }) => {
      try {
        await sendEventBounded({ name: "ticket/dispatch-needed", data: { ticketId, tenantId } });
      } catch (e) {
        console.warn(
          `[supervisor-console] dispatch emit failed for ticket=${ticketId} (the queue row is ` +
            `already released): ${e instanceof Error ? e.message : String(e)}`,
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
    loadQueueGroups: (tenantId) => loadDispatchQueueGroups({ db }, tenantId),
    isAutomationPaused: orphanDeps.isAutomationPaused,
    releaseQueue: (group) => releaseGroup(dispatchDeps, group),
    recoverTicket: (candidate) => recoverOrphanedTicket(orphanDeps, candidate),
    staleSeconds: engineStaleSeconds(),
    dispatchGraceSeconds: dispatchRescueGraceSeconds(),
    orphanGraceSeconds: orphanGraceSeconds(),
  };
}
