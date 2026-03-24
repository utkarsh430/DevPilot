// The ordered body of "Discard & restart from dev", extracted from the
// `"use server"` action so it can be driven under Vitest.
//
// WHY EXTRACTED. `integration-actions.ts` is `"use server"` and reaches
// `next/headers` through `@/lib/auth`, so it cannot load under Vitest at all -
// which is precisely the gap the reported defect lived in. The auth, tenant and
// FSM checks stay in the action (they are the security envelope, and a server
// action must not take injected effects: every export there is browser
// reachable). What moves here is only the four-step sequence and its failure
// handling, which is what actually broke. Same split, same reason, as
// `createTicketCore` / `lib/learning/write.ts`.
//
// THE DEFECT THIS ENCODES A FIX FOR. Step 2's cleanup emit is best-effort by
// design - "a failed cleanup emit must not block the reset" - and the original
// delivered that ONLY for a thrown error. `requestWorkspaceReset` ends in
// `inngest.send`, which on an unresponsive event endpoint HANGS rather than
// throwing, so the `catch` never ran and steps 3 and 4 never executed: the
// operator watched a spinner forever while the ticket was never reset. The step
// is therefore BOUNDED here, and an expiry is treated exactly like the thrown
// case - log it, record that the wipe was not queued, and carry on.
//
// The bound here wraps the WHOLE step, not just the emit, because the whole step
// is what the operator is blocked on: `requestWorkspaceReset` is a DB read
// FOLLOWED by the send. `reset.server.ts` bounds its own send as part of the
// same sweep, and the two are not redundant - the inner one protects any future
// caller and covers the emit alone, this one caps the operator's total wait and
// is the only thing that also covers a hung read. It is also the only one a test
// can reach, since `reset.server.ts` cannot load under Vitest either.
//
// NOT CHANGED, DELIBERATELY: the reap-guard `force` semantics. `force: true` is
// still set by the action alone, on this path alone, and is not expressible
// here - this module never names it.

import { withSendTimeout } from "@/lib/engine/send-bounded";

/**
 * What happened to the workspace wipe. THREE states, not a boolean.
 *
 * The original `workspaceReset: boolean` conflated two outcomes with opposite
 * meanings for the operator: `false` was both "this ticket has no workspace on
 * disk, so the next run clones dev fresh anyway" (nothing owed) and "the wipe
 * could not be queued, so the stale workspace is still there and the next run
 * will re-enter it" (something owed). The UI printed the same reassuring
 * sentence for both, which is exactly the "cannot tell a queued wipe from a
 * skipped one" gap. Widening the type makes the distinction a compile error to
 * ignore rather than a sentence to remember.
 */
export type WorkspaceResetOutcome =
  /** The `workspace/cleanup-requested` event was accepted; the runner will wipe. */
  | "queued"
  /** The ticket has no recorded workspace path, so there is nothing to wipe. */
  | "not_needed"
  /** The emit failed or timed out. The workspace - if any - is still on disk. */
  | "failed";

export type DiscardAndRestartResult =
  | {
      ok: true;
      discarded: true;
      workspaceReset: WorkspaceResetOutcome;
      discardedPushes: number;
    }
  | { ok: false; error: string };

export type DiscardAndRestartEffects = {
  /** Step 1 - drop the ticket's unpushed `pending_pushes` rows. Fatal on failure:
   *  we must not wipe a workspace whose rows would then dangle at a dead path. */
  discardPendingPushes: () => Promise<{ ok: true; count: number } | { ok: false; error: string }>;
  /** Step 2 - ask the runner to wipe the workspace. Best-effort AND bounded. */
  requestWorkspaceReset: () => Promise<{ emitted: boolean }>;
  /** Step 3 - reset the ticket to `backlog` as a human, without dispatching. */
  resetToBacklog: () => Promise<void>;
  /** Step 4 - clear `landed_sha` / `integrated_at`. Best-effort. */
  clearLandingStamp: () => Promise<void>;
  /** Diagnostics sink. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Test seam only - production leaves this at `EVENT_SEND_TIMEOUT_MS`. */
  workspaceResetTimeoutMs?: number;
};

export async function runDiscardAndRestart(
  effects: DiscardAndRestartEffects,
  ctx: { ticketId: string },
): Promise<DiscardAndRestartResult> {
  const warn = effects.warn ?? ((m: string) => console.warn(m));

  // 1. Soft-discard the unpushed pending_pushes rows. A failure here is FATAL:
  //    the whole point of the next step is to throw the workspace away, and
  //    doing that while the rows still point at it strands them at a dead path.
  let discardedPushes = 0;
  try {
    const dropped = await effects.discardPendingPushes();
    if (!dropped.ok) {
      return { ok: false, error: `Failed to discard pending changes: ${dropped.error}` };
    }
    discardedPushes = dropped.count;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to discard pending changes.",
    };
  }

  // 2. Force the workspace wipe. FIRST, so the runner is already draining the
  //    cleanup while the ticket sits in backlog awaiting the operator's move to
  //    Ready.
  //
  //    BEST-EFFORT AND BOUNDED, and the bound is the fix: an unresponsive event
  //    endpoint makes this hang rather than throw, and a hang walks past every
  //    `catch` below it. Expiry is handled identically to a thrown error - we
  //    record that the wipe was not queued and CONTINUE to steps 3 and 4, so the
  //    ticket still resets. Note the emit may yet be delivered (the bound is a
  //    race, not a cancellation); a late wipe is harmless, and reporting
  //    "failed" is the conservative direction - it tells the operator to check
  //    rather than promising a fresh clone we cannot vouch for.
  let workspaceReset: WorkspaceResetOutcome;
  try {
    const reset = await withSendTimeout(() => effects.requestWorkspaceReset(), {
      label: "workspace/cleanup-requested",
      timeoutMs: effects.workspaceResetTimeoutMs,
    });
    workspaceReset = reset.emitted ? "queued" : "not_needed";
  } catch (err) {
    workspaceReset = "failed";
    warn(
      `[discardAndRestartFromDevAction] workspace reset emit failed for ${ctx.ticketId}: ${String(err)}`,
    );
  }

  // 3. Reset to backlog as a human, without dispatching.
  try {
    await effects.resetToBacklog();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Reset failed." };
  }

  // 4. Clear the landing stamp so re-completed work can land again. AFTER the
  //    reset, so a ticket that fails to reset keeps its stamp.
  try {
    await effects.clearLandingStamp();
  } catch (err) {
    warn(
      `[discardAndRestartFromDevAction] clearing landed_sha failed for ${ctx.ticketId}: ${String(err)}`,
    );
  }

  return { ok: true, discarded: true, workspaceReset, discardedPushes };
}
