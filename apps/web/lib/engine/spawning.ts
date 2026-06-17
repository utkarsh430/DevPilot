// Phase 1 / M8 — Supervisor spawn primitives + hard caps.
//
// CLAUDE.md §3 mandate (P0, non-negotiable):
//   "Hard ceilings everywhere. No agent spawn without passing: max recursion
//    depth, max total agents, max fan-out, and remaining budget."
//
// This module is the single chokepoint every spawn must pass through. The
// caller (Supervisor MCP tool or in-process spawn helper) calls
// `assertCanSpawn(parentRunId, requestedBudgetCents)` BEFORE emitting the
// child `agent/run.requested`. Refusal throws `NonRetriableError` so the
// parent run sees the failure as a structured tool_result rather than a
// silent no-op.
//
// All caps are operator-tunable via env vars. The defaults come from the
// ratified Phase 1 plan (docs/DEVPILOT_PHASE1_PLAN.md):
//   • MAX_DEPTH         = 3
//   • MAX_FAN_OUT       = 4 (per-parent)
//   • MAX_TOTAL_AGENTS  = 20 (global active runs)
//   • DEFAULT_RUN_BUDGET_CENTS — already in run-agent.ts, repeated here for
//     spawn-budget headroom checks.
//
// Why these specific defaults: sized for one operator's subscription. Easy
// to relax per-agent later; hard to recall a $$ charge. See the runaway
// post-mortem in docs/SESSION_HANDOFF.md §8b for context.

import { NonRetriableError } from "inngest";
import { supabaseService } from "@/lib/db/server";
import { MAX_COHORT_DEPTH } from "@/lib/engine/fan-out";
import {
  ACTIVE_RUN_STATUSES,
  MAX_DEPTH,
  MAX_FAN_OUT,
  MAX_TOTAL_AGENTS,
} from "@/lib/engine/spawn-caps";

// The caps themselves live in the marker-free `spawn-caps.ts` so a PURE module
// (the supervisor console's command vocabulary) can quote them to an operator
// without dragging `next/headers` into the Vitest suite. Re-exported here so
// every existing import site is unchanged, and there is still ONE declaration
// of each number. See that file's header.
export { MAX_DEPTH, MAX_FAN_OUT, MAX_TOTAL_AGENTS };

export type SpawnCheckResult = {
  parentDepth: number;
  childDepth: number;
  parentChildrenCount: number;
  globalActiveRuns: number;
  parentRemainingCents: number;
  requestedBudgetCents: number;
  /** Phase 2.5 / M6 — parent's cohort_depth, surfaced for telemetry. */
  parentCohortDepth: number;
};

export type SpawnRefusalReason =
  | "depth-cap"
  | "fan-out-cap"
  | "global-cap"
  | "budget-cap"
  | "parent-terminal"
  | "parent-not-found"
  | "cohort-depth-cap";

export class SpawnRefused extends NonRetriableError {
  readonly code: SpawnRefusalReason;
  constructor(code: SpawnRefusalReason, detail: string) {
    super(`spawn refused (${code}): ${detail}`);
    this.code = code;
    this.name = "SpawnRefused";
  }
}

/**
 * How many runs are active in ONE tenant, i.e. the number `MAX_TOTAL_AGENTS`
 * bounds.
 *
 * Extracted from `assertCanSpawn`'s check 3 (which now calls it) so the
 * supervisor console can PRE-check the same number against the same constant
 * before it offers an operator a team. It is a read, never a decision: the
 * authoritative refusal is still `assertCanSpawn`, unchanged, and it runs again
 * on every child the spawn route actually creates.
 *
 * Returns a result rather than throwing so the console's pre-check can degrade
 * to "I could not count" instead of failing an explanation; `assertCanSpawn`
 * turns the same failure into its own `SpawnRefused` exactly as before.
 */
export async function countActiveRunsForTenant(
  tenantId: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const supabase = supabaseService();
  const { count, error } = await supabase
    .from("runs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .in("status", ACTIVE_RUN_STATUSES as unknown as string[]);
  if (error) return { ok: false, error: error.message };
  return { ok: true, count: count ?? 0 };
}

/**
 * Cap-check + budget-headroom gate. MUST be called BEFORE emitting a child
 * `agent/run.requested`. Does not mutate state — pair with `recordSpawn`
 * after the spawn succeeds so the parent's children_count stays consistent.
 *
 * @throws SpawnRefused (a NonRetriableError) if any cap would be exceeded.
 */
export async function assertCanSpawn(
  parentRunId: string,
  requestedBudgetCents: number,
): Promise<SpawnCheckResult> {
  const supabase = supabaseService();

  const { data: parent, error } = await supabase
    .from("runs")
    .select("id, tenant_id, depth, children_count, budget_cents, spent_cents, status, cohort_depth")
    .eq("id", parentRunId)
    .maybeSingle();

  if (error) {
    throw new SpawnRefused("parent-not-found", `lookup error: ${error.message}`);
  }
  if (!parent) {
    throw new SpawnRefused("parent-not-found", `parent run ${parentRunId} not found`);
  }
  if (parent.status === "failed" || parent.status === "done") {
    throw new SpawnRefused(
      "parent-terminal",
      `parent run ${parentRunId} is already ${parent.status}; cannot spawn children`,
    );
  }

  const parentDepth = (parent.depth as number) ?? 0;
  const childDepth = parentDepth + 1;

  // Check 1 — depth. The leaf must satisfy childDepth <= MAX_DEPTH, i.e. a
  // MAX_DEPTH of 3 allows children at depths 1, 2, 3 (root is depth 0).
  if (childDepth > MAX_DEPTH) {
    throw new SpawnRefused(
      "depth-cap",
      `parent depth=${parentDepth}, child would be depth=${childDepth} > MAX_DEPTH=${MAX_DEPTH}`,
    );
  }

  // Phase 2.5 / M6 — cohort depth gate. Distinct from the supervisor `depth`
  // gate above: `cohort_depth` tracks how deeply nested the cohort entry is
  // in `tickets.cohort_plan`, capped by MAX_COHORT_DEPTH (default 2). The
  // dispatcher's cohort fan-out path stamps cohort_depth on seeded runs;
  // any subsequent spawn from those runs MUST honor the cap so a supervisor
  // tool can't shortcut the workflow builder's structural limit.
  const parentCohortDepth = (parent.cohort_depth as number | null) ?? 0;
  if (parentCohortDepth + 1 > MAX_COHORT_DEPTH) {
    throw new SpawnRefused(
      "cohort-depth-cap",
      `parent cohort_depth=${parentCohortDepth}, child would be ${parentCohortDepth + 1} > MAX_COHORT_DEPTH=${MAX_COHORT_DEPTH}`,
    );
  }

  // Check 2 — per-parent fan-out. children_count is the materialized counter
  // (incremented atomically by recordSpawn via runs_increment_children).
  const childrenCount = (parent.children_count as number) ?? 0;
  if (childrenCount + 1 > MAX_FAN_OUT) {
    throw new SpawnRefused(
      "fan-out-cap",
      `parent ${parentRunId} has ${childrenCount} children, +1 exceeds MAX_FAN_OUT=${MAX_FAN_OUT}`,
    );
  }

  // Check 3 — global active runs. Tenant-scoped: a tenant's runaway shouldn't
  // be able to block a different tenant's normal traffic.
  const counted = await countActiveRunsForTenant(parent.tenant_id as string);
  if (!counted.ok) {
    throw new SpawnRefused("global-cap", `active-run count failed: ${counted.error}`);
  }
  const globalActiveRuns = counted.count;
  if (globalActiveRuns + 1 > MAX_TOTAL_AGENTS) {
    throw new SpawnRefused(
      "global-cap",
      `tenant has ${globalActiveRuns} active runs, +1 exceeds MAX_TOTAL_AGENTS=${MAX_TOTAL_AGENTS}`,
    );
  }

  // Check 4 — budget inheritance. The child can ONLY draw from headroom the
  // parent still has. This is what makes runaway recursion mathematically
  // impossible even before depth/fan-out cap: total subtree spend ≤ root
  // budget_cents.
  const parentBudget = (parent.budget_cents as number) ?? 0;
  const parentSpent = (parent.spent_cents as number) ?? 0;
  const parentRemaining = parentBudget - parentSpent;
  if (requestedBudgetCents <= 0) {
    throw new SpawnRefused(
      "budget-cap",
      `requested child budget must be > 0 (got ${requestedBudgetCents}¢)`,
    );
  }
  if (requestedBudgetCents > parentRemaining) {
    throw new SpawnRefused(
      "budget-cap",
      `parent ${parentRunId} has ${parentRemaining}¢ remaining; child requested ${requestedBudgetCents}¢`,
    );
  }

  return {
    parentDepth,
    childDepth,
    parentChildrenCount: childrenCount,
    globalActiveRuns,
    parentRemainingCents: parentRemaining,
    requestedBudgetCents,
    parentCohortDepth,
  };
}

/**
 * Atomically increment the parent's children_count via the
 * `runs_increment_children` SQL function (FOR UPDATE inside; concurrent
 * spawns serialise). Returns the post-increment count.
 *
 * Pair with `assertCanSpawn`: assertCanSpawn refuses if the increment would
 * cross MAX_FAN_OUT; recordSpawn commits the increment.
 */
export async function recordSpawn(parentRunId: string): Promise<number> {
  const supabase = supabaseService();
  const { data, error } = await supabase.rpc("runs_increment_children", {
    p_parent_id: parentRunId,
  });
  if (error) throw new Error(`recordSpawn: ${error.message}`);
  return (data as number) ?? 0;
}

/**
 * Walk the subtree rooted at `rootRunId` (BFS, depth-bounded by MAX_DEPTH).
 * Returns every descendant run's id + status. Used by the cascade-kill
 * handler on parent failure and by the orphan reaper.
 *
 * Bounded by MAX_DEPTH + a hard scan cap so a misshapen tree (e.g. cycle —
 * which the FK ON DELETE SET NULL allows after manual edits) cannot pin
 * the walker forever.
 */
const SUBTREE_HARD_SCAN_CAP = 1000;

export type SubtreeNode = {
  id: string;
  status: string;
  depth: number;
};

export async function walkSubtree(rootRunId: string, tenantId: string): Promise<SubtreeNode[]> {
  const supabase = supabaseService();
  const collected: SubtreeNode[] = [];
  let frontier: string[] = [rootRunId];
  const seen = new Set<string>([rootRunId]);
  let scanned = 0;
  for (let level = 0; level <= MAX_DEPTH + 1 && frontier.length > 0; level++) {
    // Tenant-scoped, and this is the one that matters most in this file: the
    // subtree this returns is what cascade-kill KILLS. `runs`' member write
    // policy pins only the row's own `tenant_id`, never `parent_run_id`, so
    // unscoped a hostile tenant could graft their run onto our tree by pointing
    // it at one of our run ids — and our next cascade-kill would terminate it.
    // A genuine child is in the same tenant as its parent (enforced by
    // `trg_runs_parent_run_id_tenant`), so no real descendant is dropped.
    const { data, error } = await supabase
      .from("runs")
      .select("id, status, depth")
      .in("parent_run_id", frontier)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(`walkSubtree: ${error.message}`);
    const next: string[] = [];
    for (const row of data ?? []) {
      scanned++;
      if (scanned > SUBTREE_HARD_SCAN_CAP) {
        throw new Error(
          `walkSubtree: scan cap ${SUBTREE_HARD_SCAN_CAP} exceeded; tree is malformed`,
        );
      }
      const id = row.id as string;
      if (seen.has(id)) continue;
      seen.add(id);
      collected.push({
        id,
        status: row.status as string,
        depth: row.depth as number,
      });
      next.push(id);
    }
    frontier = next;
  }
  return collected;
}
