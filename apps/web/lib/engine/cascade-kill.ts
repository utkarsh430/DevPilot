// Phase 1 / M8 — Cascade kill on parent run failure.
//
// When a parent (typically a Supervisor) run fails, every descendant run
// must be terminated. Without this, a runaway tree leaves orphans burning
// budget against a parent that's already given up.
//
// Trigger: piggy-backs on `inngest/function.failed` for any run that has at
// least one child. The `runAgentFailed` handler in run-agent.ts already
// listens on this event for run row finalisation; we add a parallel
// function so the responsibilities stay clean (one function, one job).
//
// Termination semantics:
//   • For each descendant in {running, awaiting_human}: PATCH status='failed'
//     and write a synthetic run_step with kind='system' and a cascade reason.
//   • Already-terminal descendants are left alone.
//
// Idempotency: the failed status update is conditional (eq("status", running)
// OR eq("status", awaiting_human)); re-firing the cascade is a no-op.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { walkSubtree } from "@/lib/engine/spawning";

export const cascadeKillOnFailure = inngest.createFunction(
  { id: "cascade-kill-on-failure", retries: 1 },
  { event: "inngest/function.failed" },
  async ({ event, step }) => {
    // The failed event nests the ORIGINAL event under data.event. That
    // original event is what carried our `runId`.
    const originalData = (event.data as { event?: { data?: { runId?: string } } })?.event?.data;
    const parentRunId = originalData?.runId;
    if (!parentRunId) return { skipped: "no-run-id" };

    // The failed-function event carries only a runId, so the parent run row is
    // the only authority on which tenant this subtree lives in. `id` is a
    // primary key — not attacker-aimable — so this read establishes the scope
    // honestly. No row (already reaped) → nothing to cascade.
    const parentTenantId = await step.run("resolve-parent-tenant", async () => {
      const supabase = supabaseService();
      const { data } = await supabase
        .from("runs")
        .select("tenant_id")
        .eq("id", parentRunId)
        .maybeSingle();
      return ((data as { tenant_id?: unknown } | null)?.tenant_id as string | undefined) ?? null;
    });
    if (!parentTenantId) return { skipped: "parent-run-not-found" };

    const subtree = await step.run("walk-subtree", async () =>
      walkSubtree(parentRunId, parentTenantId),
    );
    if (subtree.length === 0) return { parentRunId, descendants: 0, killed: 0 };

    const active = subtree.filter((n) => n.status === "running" || n.status === "awaiting_human");
    if (active.length === 0) {
      return { parentRunId, descendants: subtree.length, killed: 0 };
    }

    const killed = await step.run("kill-active-descendants", async () => {
      const supabase = supabaseService();
      const nowIso = new Date().toISOString();
      const ids = active.map((n) => n.id);
      // Status update — conditional, idempotent. `parentRunId` is embedded in
      // `status_reason` (not just the run_steps audit row below) so the
      // reason is visible from the `runs` row alone — e.g. to the orphan
      // sweep's recovery comment — without a join.
      const { error: upErr } = await supabase
        .from("runs")
        .update({
          status: "failed",
          status_reason: `cascade-killed:${parentRunId}`,
          last_event_at: nowIso,
        })
        .in("id", ids)
        .in("status", ["running", "awaiting_human"]);
      if (upErr) throw new Error(`cascade-kill update: ${upErr.message}`);
      // Audit row per descendant.
      const stepRows = active.map((n) => ({
        run_id: n.id,
        idx: 99_998, // distinguishable from runAgentFailed's 9999
        kind: "system",
        payload: {
          cascade_killed_by: parentRunId,
          reason: "parent-failed-cascade",
        },
      }));
      const { error: insErr } = await supabase.from("run_steps").insert(stepRows);
      if (insErr) {
        // Don't fail the kill on audit-write failure — the status update is
        // the load-bearing operation.
        console.warn(`cascade-kill: audit insert failed: ${insErr.message}`);
      }
      return ids.length;
    });

    // Emit one telemetry event so an operator dashboard can surface this.
    await step.sendEvent("emit-cascade", {
      name: "ops/cascade-kill",
      data: {
        parentRunId,
        killedCount: killed,
        descendantsTotal: subtree.length,
      },
    });

    return {
      parentRunId,
      descendants: subtree.length,
      killed,
    };
  },
);
