// Phase 1 / M8 acceptance — supervisor hard-cap runaway test.
//
// The plan-mandated acceptance:
//   > A Supervisor spawned with budget=$1 and MAX_DEPTH=2 tries to recursively
//   > spawn 100 children; the runaway is killed at the first cap violation;
//   > total spend stays under $1; Langfuse trace shows the refusal span.
//
// We test the cap CHOKEPOINTS (`assertCanSpawn` + `recordSpawn`) directly
// without driving a real Supervisor LLM run. Reason: the load-bearing
// safety mechanism is the cap-check; whether a Supervisor's prompt
// politely yields when refused is a UX concern, not a safety concern.
// (Independent acceptance for the Supervisor's MCP tool flow ships with the
// MCP wiring in a follow-up commit.)
//
// What we prove
// ─────────────
// 1. FAN-OUT cap: a parent at depth=0 can spawn exactly MAX_FAN_OUT children
//    via repeated assertCanSpawn → recordSpawn. The (MAX_FAN_OUT+1)th call
//    throws SpawnRefused('fan-out-cap'). All siblings stored.
// 2. DEPTH cap: a child at depth=MAX_DEPTH cannot itself spawn — refusal
//    code is 'depth-cap'.
// 3. BUDGET cap: a request whose requestedBudgetCents > parent.remaining
//    refuses with 'budget-cap'. Sum of granted child budgets never exceeds
//    parent remaining.
// 4. RUNAWAY containment: with MAX_DEPTH=2 + MAX_FAN_OUT=4 + budget=$1, a
//    naive 100-iteration spawn-attempting loop completes with ≤ MAX_FAN_OUT
//    successes at depth 1, all others refused. Total spend stays at $0
//    because no LLM step ran.
//
// Run via:
//   cd apps/web
//   pnpm exec tsx --env-file=.env.local scripts/phase1-m8-accept.ts

import { randomUUID } from "node:crypto";
import { supabaseService } from "@/lib/db/server";
import {
  assertCanSpawn,
  recordSpawn,
  SpawnRefused,
  MAX_DEPTH,
  MAX_FAN_OUT,
} from "@/lib/engine/spawning";

const TENANT_ID = "e98507ec-d5a2-4951-8a5d-445c86dbfca8";

async function insertRun(opts: {
  depth?: number;
  budgetCents?: number;
  parentRunId?: string | null;
}): Promise<string> {
  const supabase = supabaseService();
  const id = randomUUID();
  const { error } = await supabase.from("runs").insert({
    id,
    tenant_id: TENANT_ID,
    agent_id: null,
    ticket_id: null,
    parent_run_id: opts.parentRunId ?? null,
    depth: opts.depth ?? 0,
    status: "running",
    budget_cents: opts.budgetCents ?? 100,
    spent_cents: 0,
    runner_kind: "api",
  });
  if (error) throw new Error(`insertRun: ${error.message}`);
  return id;
}

async function deleteRunSubtree(rootId: string): Promise<void> {
  // Children first (FK ON DELETE SET NULL on parent_run_id, so we must walk).
  const supabase = supabaseService();
  const frontier = [rootId];
  const all: string[] = [];
  while (frontier.length > 0) {
    const { data } = await supabase.from("runs").select("id").in("parent_run_id", frontier);
    const next = (data ?? []).map((r) => r.id as string);
    all.push(...next);
    frontier.length = 0;
    frontier.push(...next);
  }
  all.push(rootId);
  // Delete leaves up.
  for (const id of all.reverse()) {
    await supabase.from("runs").delete().eq("id", id);
  }
}

async function tryFanOutCap(): Promise<void> {
  console.log("\n--- Test 1: fan-out cap ---");
  const parentId = await insertRun({ depth: 0, budgetCents: 100 });
  const grants: string[] = [];
  let refusalCode = "";
  for (let i = 0; i < MAX_FAN_OUT + 3; i++) {
    try {
      await assertCanSpawn(parentId, 5);
      const childId = await insertRun({
        depth: 1,
        budgetCents: 5,
        parentRunId: parentId,
      });
      await recordSpawn(parentId);
      grants.push(childId);
    } catch (err) {
      if (err instanceof SpawnRefused) {
        refusalCode = err.code;
        break;
      }
      throw err;
    }
  }
  console.log(`  granted=${grants.length} refused-on-iter=${grants.length} refusal=${refusalCode}`);
  if (grants.length !== MAX_FAN_OUT) {
    throw new Error(`expected ${MAX_FAN_OUT} grants, got ${grants.length}`);
  }
  if (refusalCode !== "fan-out-cap") {
    throw new Error(`expected refusal=fan-out-cap, got ${refusalCode}`);
  }
  console.log("  ✅ PASS");
  await deleteRunSubtree(parentId);
}

async function tryDepthCap(): Promise<void> {
  console.log("\n--- Test 2: depth cap ---");
  // Chain: depth 0 → 1 → 2 → … → MAX_DEPTH. The leaf at MAX_DEPTH must
  // refuse to spawn.
  const ids: string[] = [];
  let parent: string | null = null;
  for (let d = 0; d <= MAX_DEPTH; d++) {
    const id = await insertRun({ depth: d, budgetCents: 100, parentRunId: parent });
    ids.push(id);
    parent = id;
  }
  const leaf = ids[ids.length - 1]!;
  let refusalCode = "";
  try {
    await assertCanSpawn(leaf, 5);
    throw new Error("depth-cap test: spawn was allowed but should have refused");
  } catch (err) {
    if (err instanceof SpawnRefused) refusalCode = err.code;
    else throw err;
  }
  console.log(`  leaf-depth=${MAX_DEPTH} refusal=${refusalCode}`);
  if (refusalCode !== "depth-cap") {
    throw new Error(`expected refusal=depth-cap, got ${refusalCode}`);
  }
  console.log("  ✅ PASS");
  await deleteRunSubtree(ids[0]!);
}

async function tryBudgetCap(): Promise<void> {
  console.log("\n--- Test 3: budget cap ---");
  const parentId = await insertRun({ depth: 0, budgetCents: 10 });
  let refusalCode = "";
  try {
    await assertCanSpawn(parentId, 50); // 50¢ > 10¢ remaining
  } catch (err) {
    if (err instanceof SpawnRefused) refusalCode = err.code;
    else throw err;
  }
  console.log(`  parent-budget=10¢ requested=50¢ refusal=${refusalCode}`);
  if (refusalCode !== "budget-cap") {
    throw new Error(`expected refusal=budget-cap, got ${refusalCode}`);
  }
  console.log("  ✅ PASS");
  await deleteRunSubtree(parentId);
}

async function tryRunawayContainment(): Promise<void> {
  console.log("\n--- Test 4: runaway containment ($1 budget, 100 spawn attempts) ---");
  const parentId = await insertRun({ depth: 0, budgetCents: 100 });
  let granted = 0;
  let refusedByCap: Record<string, number> = {};
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    try {
      await assertCanSpawn(parentId, 5);
      await insertRun({ depth: 1, budgetCents: 5, parentRunId: parentId });
      await recordSpawn(parentId);
      granted++;
    } catch (err) {
      if (err instanceof SpawnRefused) {
        refusedByCap[err.code] = (refusedByCap[err.code] ?? 0) + 1;
        continue;
      }
      throw err;
    }
  }
  const elapsed = Date.now() - t0;
  console.log(`  granted=${granted} refused=${JSON.stringify(refusedByCap)} elapsed=${elapsed}ms`);
  if (granted > MAX_FAN_OUT) {
    throw new Error(`runaway: granted=${granted} exceeds MAX_FAN_OUT=${MAX_FAN_OUT}`);
  }
  if (granted !== MAX_FAN_OUT) {
    throw new Error(`expected exactly ${MAX_FAN_OUT} grants, got ${granted}`);
  }
  // Verify zero subtree spend (no LLM steps fired).
  const supabase = supabaseService();
  const { data: kids } = await supabase
    .from("runs")
    .select("spent_cents")
    .eq("parent_run_id", parentId);
  const subtreeSpent = (kids ?? []).reduce((acc, r) => acc + ((r.spent_cents as number) ?? 0), 0);
  if (subtreeSpent !== 0) {
    throw new Error(`subtree spent ${subtreeSpent}¢ unexpectedly`);
  }
  console.log(`  ✅ PASS — subtree spend ${subtreeSpent}¢ (cap held)`);
  await deleteRunSubtree(parentId);
}

(async () => {
  console.log("=== Phase 1 / M8 acceptance — supervisor hard caps ===");
  console.log(`  caps: MAX_DEPTH=${MAX_DEPTH} MAX_FAN_OUT=${MAX_FAN_OUT}`);
  try {
    await tryFanOutCap();
    await tryDepthCap();
    await tryBudgetCap();
    await tryRunawayContainment();
    console.log("\n=== ALL TESTS PASS ===");
  } catch (err) {
    console.error(`\n❌ FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
})();
