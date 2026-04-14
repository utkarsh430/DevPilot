// The engine-liveness canary - the one Inngest function whose entire job is to
// prove that Inngest functions are still being EXECUTED.
//
// ── WHY A CANARY, AND WHY NOT THE TWO SIGNALS WE ALREADY HAD ──────────────
// The runner-resident project supervisor must not duplicate the engine's own
// cron reapers (see `supervisor-policy.ts` for the full argument - duplicate
// actors on this board have already put two agents in one git workspace). Its
// gate is therefore "are the crons executing?", and this row answers that
// DIRECTLY rather than by proxy: the reapers are crons in this same app, so
// their liveness and this stamp's freshness are the same fact.
//
// Neither existing signal can serve as that gate:
//
//   • `probeInngest` (lib/health/probes.ts) never contacts the Inngest server at
//     all. It dynamically imports our OWN `/api/inngest` route and calls its GET
//     handler in-process, which answers "is our serve endpoint wired". That was
//     TRUE for the whole of the 2026-08-03 incident - the dev server kept
//     accepting events and ran nothing. It would have been green throughout.
//
//   • `lib/dev/inngest-log.ts` is a log-BOUNDING module (size rotation plus
//     consecutive-duplicate collapsing). It has no classifier for the lease-wedge
//     signature, it reads a file local to whichever host runs `dev:inngest`, and
//     it does not exist outside local dev.
//
// A canary also degrades correctly against failures neither of those would see:
// an Inngest Cloud outage, a signing-key rotation that silently unregisters the
// app, a deploy that drops the cron registration. All present as a stale stamp,
// with no new detector to write.
//
// ── WHY THIS FUNCTION IS AS SMALL AS IT IS ────────────────────────────────
// It must be the LAST function to fail, so it may not depend on anything that
// could fail first. One UPSERT to a single-row table, no tenant resolution, no
// event payload, no fan-out, no Redis, no LLM. If this cannot run, nothing can.
//
// Cost: one row write per minute per instance. It is the cheapest thing in the
// engine and it is what makes the supervisor safe to arm at all - without it the
// only honest supervisor mode is observe-only.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { ENGINE_LIVENESS_CANARY_ID } from "@/lib/engine/supervisor-policy";

/**
 * Stamp the canary. Exported as a plain function so an acceptance script (and
 * the supervision route's own bootstrap) can drive it without Inngest - the
 * same shape as the reapers' exported workers.
 */
export async function stampEngineLiveness(nowIso: string): Promise<{ ok: boolean }> {
  const db = supabaseService();
  // Read-then-write on `ticks` rather than an atomic increment: this is a
  // single-row table written by one function with `concurrency: {limit: 1}`, so
  // there is no contention to lose, and `ticks` is diagnostic only - the GATE
  // reads `last_seen_at`, which is written unconditionally either way. Keeping
  // it a plain upsert is worth more than an exact counter, because this function
  // must not depend on an RPC that could itself be missing.
  const { data } = await db
    .from("engine_liveness")
    .select("ticks")
    .eq("id", ENGINE_LIVENESS_CANARY_ID)
    .maybeSingle();
  const ticks = typeof data?.ticks === "number" ? data.ticks : Number(data?.ticks ?? 0);

  const { error } = await db.from("engine_liveness").upsert(
    {
      id: ENGINE_LIVENESS_CANARY_ID,
      last_seen_at: nowIso,
      ticks: (Number.isFinite(ticks) ? ticks : 0) + 1,
      updated_at: nowIso,
    },
    { onConflict: "id" },
  );
  if (error) {
    console.warn(`[engine-liveness] stamp failed: ${error.message.slice(0, 200)}`);
    return { ok: false };
  }
  return { ok: true };
}

// Every MINUTE, matching `ticketScheduleCronFn`'s cadence - the fastest cron in
// the app, so a stale stamp is never an artefact of this function simply running
// less often than the thing it reports on.
//
// `retries: 0`: a retried canary would stamp a LATER time for an EARLIER
// scheduled tick, which is the one way this row could lie in the dangerous
// direction (reporting alive during a wedge). A missed tick is harmless - the
// staleness window is five of them.
//
// The `internal/` event trigger mirrors the reapers' so ops tooling and the
// acceptance path can stamp without waiting for the tick.
export const engineLivenessCanary = inngest.createFunction(
  { id: "engine-liveness-canary", retries: 0, concurrency: { limit: 1 } },
  [{ cron: "* * * * *" }, { event: "internal/stamp-engine-liveness" }],
  async ({ step }) =>
    await step.run("stamp", async () => stampEngineLiveness(new Date().toISOString())),
);
