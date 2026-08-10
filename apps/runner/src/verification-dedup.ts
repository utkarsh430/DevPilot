// L1 (ticket-speed audit, §#5) — per-run, per-process verification dedup guard.
//
// A single run spans ~20 iterations that all reuse the same working tree, and
// BOTH verification hooks (index.ts hook (ii) before every step-result, and
// mcp/server.ts hook (i) on `devpilot_move_ticket(in_review)`) can fire for the same
// commit. Running the ~10-minute check command every time would be ruinous.
//
// The guard keys on (runId, headSha): the FIRST time a run is asked to verify a
// given HEAD it runs; every later request at the SAME head is skipped, because
// the stored record already reflects that commit. When the agent commits again,
// HEAD changes and the next request verifies afresh (this is what makes
// fix-and-retry work — a new commit is always re-verified).
//
// Scope is per-process and in-memory ON PURPOSE:
//   • The two hooks live in different OS processes (mcp/server.ts is a stdio
//     subprocess of `claude -p`), so they cannot share one Map. That is fine —
//     the ingest route upserts on run_id, so at worst each process verifies a
//     given head once and the second POST overwrites the first identically.
//   • Losing the Map on a runner restart just causes one extra harmless
//     re-verify. There is no correctness dependency on durability.
//
// Pure and side-effect-free apart from the module-local Map, so it is unit
// tested directly (verification-dedup.test.ts) without spawning anything.

/** runId → the HEAD sha most recently verified for that run in THIS process. */
const lastVerifiedHead = new Map<string, string>();

// Bound the map so a very long-lived runner that has processed thousands of
// runs cannot grow it without limit. One short string per run is tiny; this is
// belt-and-braces. When the cap is hit we clear wholesale (the worst case is a
// batch of harmless re-verifies, never a wrong answer).
const MAX_TRACKED_RUNS = 1024;

/**
 * Should this run verify at `headSha` right now? True when the head is unknown
 * (unborn HEAD / git failed — we cannot dedup, so err toward verifying) or when
 * it differs from the last head verified for this run in this process.
 */
export function shouldVerifyHead(runId: string, headSha: string | null): boolean {
  if (!headSha) return true;
  return lastVerifiedHead.get(runId) !== headSha;
}

/** Record that `runId` has now been verified at `headSha`. No-op for a null
 *  head (nothing to dedup against). Call AFTER the record has been posted, so a
 *  crashed verification does not suppress a later retry of the same head. */
export function markVerifiedHead(runId: string, headSha: string | null): void {
  if (!headSha) return;
  if (lastVerifiedHead.size >= MAX_TRACKED_RUNS) lastVerifiedHead.clear();
  lastVerifiedHead.set(runId, headSha);
}

/** Test-only: wipe the guard between cases. */
export function __resetVerificationDedup(): void {
  lastVerifiedHead.clear();
}
