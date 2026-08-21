// POST /api/runners/tools/spawn
//
// Phase 1 / M8 — MCP-backed Supervisor tool. The Supervisor's `claude -p`
// invocation calls `devpilot_spawn_agent({ role, prompt, budgetCents })`; the MCP
// relay forwards here. We:
//   1. Auth-check the runner via the registration key.
//   2. Look up the parent run by the runner's run-context env (DEVPILOT_RUN_ID).
//   3. Run the cap check via `assertCanSpawn` — refuses with a structured
//      error if any cap would be exceeded (CLAUDE.md §3 mandate).
//   4. Resolve the requested role (built-in or M5 custom) so the dispatcher
//      doesn't see an unknown slug.
//   5. Increment the parent's children_count atomically via `recordSpawn`.
//   6. Emit `agent/run.requested` with parent_run_id set and a fresh runId.
//
// Auth: x-devpilot-runner-key (same gate as the other tool routes).
// Request:  { runId, tenantId, role, prompt, budgetCents, runnerId? }
// Response 200: { childRunId, depth, childrenCount }
// Response 403: { error, code } when a cap refuses
// Response 4xx: validation / lookup errors

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { assertCanSpawn, recordSpawn, SpawnRefused } from "@/lib/engine/spawning";
import { getBuiltinRoleConfig, loadCustomRoleConfig } from "@/lib/roles/load";
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";
import { loadOverlayForDispatch } from "@/lib/roles/overlay.server";

export const dynamic = "force-dynamic";

type SpawnBody = {
  runId?: string;
  tenantId?: string;
  role?: string;
  prompt?: string;
  budgetCents?: number;
  runnerId?: string;
};

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const body = (await request.json().catch(() => null)) as SpawnBody | null;
  if (!body?.runId || typeof body.runId !== "string") {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }
  if (!body.tenantId || typeof body.tenantId !== "string") {
    return NextResponse.json({ error: "tenantId required" }, { status: 400 });
  }
  if (!body.role || typeof body.role !== "string") {
    return NextResponse.json({ error: "role required" }, { status: 400 });
  }
  if (!body.prompt || typeof body.prompt !== "string") {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }
  const budgetCents = Number(body.budgetCents ?? 0);
  if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
    return NextResponse.json({ error: "budgetCents required (must be > 0)" }, { status: 400 });
  }

  // Cap-check is the chokepoint — every other safety lives downstream of this.
  let check;
  try {
    check = await assertCanSpawn(body.runId, budgetCents);
  } catch (err) {
    if (err instanceof SpawnRefused) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    }
    throw err;
  }

  // Role resolution — built-in fast path, else custom config from agents row.
  const builtin = getBuiltinRoleConfig(body.role);
  const roleConfig = builtin ?? (await loadCustomRoleConfig(body.tenantId, body.role));
  if (!roleConfig) {
    return NextResponse.json({ error: `unknown role: ${body.role}` }, { status: 400 });
  }

  // Atomic increment — paired with assertCanSpawn so the fan-out gate is
  // race-safe.
  const childrenCount = await recordSpawn(body.runId);

  // Seed the child run row at the right depth so subsequent cap checks see
  // the lineage correctly. runAgent's init step will upsert this same id.
  const childRunId = randomUUID();
  const supabase = supabaseService();
  const { error: insErr } = await supabase.from("runs").insert({
    id: childRunId,
    tenant_id: body.tenantId,
    parent_run_id: body.runId,
    depth: check.childDepth,
    status: "running",
    budget_cents: budgetCents,
    spent_cents: 0,
    runner_kind: roleConfig.runnerPolicy,
  });
  if (insErr) {
    return NextResponse.json({ error: `child run insert: ${insErr.message}` }, { status: 500 });
  }

  // Phase 2 — the operator's overlay is a property of the ROLE, not of the
  // ticket, so a supervisor's ad-hoc child of that role gets it too. An
  // "instructions for this agent" that quietly excluded supervisor children
  // would not be true. `hasTicket` stays false: the child has no ticket, so the
  // reviewer-awareness note still (correctly) does not apply.
  const overlay = await loadOverlayForDispatch(body.tenantId, body.role);

  await sendEventBounded({
    name: "agent/run.requested",
    data: {
      runId: childRunId,
      tenantId: body.tenantId,
      prompt: body.prompt,
      systemPrompt: composeRoleSystemPrompt(roleConfig, [], false, overlay),
      iterations: 1,
      modelTier: roleConfig.modelTier,
      runnerPolicy: roleConfig.runnerPolicy,
      budgetCents,
      role: body.role,
      agentDisplayName: roleConfig.displayName,
    },
  });

  return NextResponse.json({
    childRunId,
    depth: check.childDepth,
    childrenCount,
  });
}
