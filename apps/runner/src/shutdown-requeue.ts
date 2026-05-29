// What happens to a job the runner is holding when the runner is told to stop.
//
// Until this existed a `pnpm dev:local` restart (or a reboot, or a deploy of
// the runner) with a step in flight KILLED the `claude -p` process, and
// handleJob's catch then reported the step as FAILED - so the run ended
// `failed`, the ticket was parked for a human by the orphan reaper, and the
// only way to continue was a manual re-dispatch. Nothing was lost in the
// database; what was lost was the operator's afternoon.
//
// The rule: a job whose step has NOT produced a result yet is put BACK on the
// queue and its process killed, so the next runner to start simply runs the
// step again. The engine notices nothing - its `lc-await` is still waiting for
// the step result, and with the Inngest dev server persisting its state that
// wait survives the restart too. A job that has already finished its model
// turn is NOT requeued: its result is about to be posted and re-running the
// step would spend the model twice for one answer.
//
// Pure. The IO (the RPUSH, the kill, the skipped postStepResult) lives in
// index.ts; this is the part a test can hold still.

/** Where a job is in handleJob when the shutdown signal arrives.
 *
 *  - `prep`:  claimed; preparing the workspace / fetching attachments. No
 *             process to kill, nothing posted.
 *  - `model`: `claude -p` is running. Killing it loses the turn; the step must
 *             run again.
 *  - `post`:  the model turn RETURNED; nudges, verification and the result
 *             POST are in progress. Let it finish. */
export type JobPhase = "prep" | "model" | "post";

export type ShutdownDecision = "requeue" | "let-finish";

export function decideShutdownRequeue(phase: JobPhase): ShutdownDecision {
  return phase === "post" ? "let-finish" : "requeue";
}

/** The queue is LPUSHed by the engine and RPOPed by the runner, so a requeued
 *  job goes to the RIGHT (tail), where the next RPOP takes it first - it does
 *  not wait behind everything the engine has queued since. */
export const REQUEUE_PUSH_SIDE = "rpush" as const;

/** The payload is the job exactly as it was popped. Re-serialised from the
 *  parsed object rather than the raw string so a job the runner has mutated in
 *  memory cannot drift from the one it will run next time - handleJob never
 *  mutates `job`, and this keeps it that way by construction. */
export function requeuePayload(job: object): string {
  return JSON.stringify(job);
}
