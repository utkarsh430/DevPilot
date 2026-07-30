// Phase 2.5+ / M7 (REVISION 2026-06-04) — internal test endpoint for the
// plan-session acceptance script.
//
// Mirrors the production server-action shape in apps/web/app/(app)/plan/
// actions.ts: the route is a fire-and-forget event emitter. The actual LLM
// work happens in the durable Inngest functions in lib/plan/inngest.ts
// behind the local-cc runner bridge.
//
// Auth model: gated by the `x-devpilot-runner-key` header (same trust boundary
// as `/api/runners/register`). The acceptance script runs outside any
// Supabase Auth session, so we re-implement the auth-gated wrappers with
// the service client + an explicit tenantId / userId in the body.
//
// IMPORTANT: This route is NOT exposed in any UI or documented externally.
// It exists solely to enable the M7 acceptance script. Do not import from
// feature code.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { assertCanProceedPlan } from "@/lib/engine/budget";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import type { StackFlavor } from "@/lib/plan/prompts";

export const dynamic = "force-dynamic";

type StartBody = {
  op: "start";
  tenantId: string;
  userId: string;
  projectId: string;
  stackFlavor: StackFlavor;
  stackPreferences?: string;
  openingMessage: string;
};

type SendBody = {
  op: "send";
  tenantId: string;
  userId: string;
  sessionId: string;
  content: string;
};

type BuildBody = {
  op: "build";
  tenantId: string;
  userId: string;
  sessionId: string;
};

type UpdateBody = {
  op: "update";
  tenantId: string;
  userId: string;
  proposedTicketId: string;
  patch: Record<string, unknown>;
};

type CommitBody = {
  op: "commit";
  tenantId: string;
  userId: string;
  sessionId: string;
  mode: "selected" | "all";
};

type DiscardBody = {
  op: "discard";
  tenantId: string;
  userId: string;
  sessionId: string;
};

type Body = StartBody | SendBody | BuildBody | UpdateBody | CommitBody | DiscardBody;

const ROLE_SLUG_SET = new Set(ROLE_CATALOG.map((e) => e.slug));

// Same EST_CENTS schedule the production actions use — keeps the gate
// behaviour identical for the acceptance script.
const EST_CENTS = {
  leadReply: 4,
  panelDraft: 6,
  consolidator: 8,
} as const;

// ─── small helpers (service-role; no requireUser/requireTenantId) ──────────

async function insertPlanMessage(args: {
  sessionId: string;
  tenantId: string;
  role: "user" | "assistant" | "system";
  content: string;
}) {
  const supabase = supabaseService();
  const { error } = await supabase.from("planning_messages").insert({
    session_id: args.sessionId,
    tenant_id: args.tenantId,
    role: args.role,
    content: args.content,
    agent_role: null,
    metadata: null,
  });
  if (error) throw new Error(`insertPlanMessage failed: ${error.message}`);
}

async function loadSession(sessionId: string, tenantId: string) {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_sessions")
    .select("id, tenant_id, project_id, status, stack_flavor, stack_preferences, goal_summary")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`loadSession failed: ${error.message}`);
  if (!data) throw new Error(`session ${sessionId} not found`);
  if (data.tenant_id !== tenantId) throw new Error("tenant mismatch");
  return data as {
    id: string;
    tenant_id: string;
    project_id: string;
    status: string;
    stack_flavor: StackFlavor;
    stack_preferences: string;
    goal_summary: string | null;
  };
}

// ─── handlers per op ────────────────────────────────────────────────────────

async function handleStart(b: StartBody) {
  const supabase = supabaseService();
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id, tenant_id")
    .eq("id", b.projectId)
    .maybeSingle();
  if (projErr || !project) {
    return { ok: false, error: `project lookup failed: ${projErr?.message ?? "not found"}` };
  }
  if (project.tenant_id !== b.tenantId) {
    return { ok: false, error: "project tenant mismatch" };
  }
  const { data: session, error: insertErr } = await supabase
    .from("planning_sessions")
    .insert({
      tenant_id: b.tenantId,
      project_id: b.projectId,
      created_by: b.userId,
      status: "discussing",
      stack_flavor: b.stackFlavor,
      stack_preferences: b.stackPreferences ?? "",
      spent_cents: 0,
    })
    .select("id")
    .single();
  if (insertErr || !session) {
    return { ok: false, error: insertErr?.message ?? "session insert failed" };
  }
  const sessionId = session.id as string;
  await insertPlanMessage({
    sessionId,
    tenantId: b.tenantId,
    role: "user",
    content: b.openingMessage.trim(),
  });
  try {
    await assertCanProceedPlan({
      tenantId: b.tenantId,
      projectId: b.projectId,
      sessionId,
      estCents: EST_CENTS.leadReply,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await sendEventBounded({
      name: "plan/lead-reply.requested",
      data: { sessionId, tenantId: b.tenantId, runId: randomUUID() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `event dispatch failed: ${msg.slice(0, 200)}` };
  }
  return { ok: true, sessionId };
}

async function handleSend(b: SendBody) {
  let session;
  try {
    session = await loadSession(b.sessionId, b.tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "load failed" };
  }
  if (session.status !== "discussing") {
    return { ok: false, error: `session status=${session.status}` };
  }
  await insertPlanMessage({
    sessionId: b.sessionId,
    tenantId: b.tenantId,
    role: "user",
    content: b.content.trim(),
  });
  try {
    await assertCanProceedPlan({
      tenantId: b.tenantId,
      projectId: session.project_id,
      sessionId: b.sessionId,
      estCents: EST_CENTS.leadReply,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await sendEventBounded({
      name: "plan/lead-reply.requested",
      data: { sessionId: b.sessionId, tenantId: b.tenantId, runId: randomUUID() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `event dispatch failed: ${msg.slice(0, 200)}` };
  }
  return { ok: true };
}

async function handleBuild(b: BuildBody) {
  let session;
  try {
    session = await loadSession(b.sessionId, b.tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "load failed" };
  }
  if (session.status !== "discussing") {
    return { ok: false, error: `session status=${session.status}` };
  }
  try {
    await assertCanProceedPlan({
      tenantId: b.tenantId,
      projectId: session.project_id,
      sessionId: b.sessionId,
      estCents: EST_CENTS.panelDraft * 3 + EST_CENTS.consolidator,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const supabase = supabaseService();
  const { error: tErr } = await supabase
    .from("planning_sessions")
    .update({ status: "planning" })
    .eq("id", b.sessionId);
  if (tErr) {
    return { ok: false, error: `status transition failed: ${tErr.message}` };
  }
  try {
    await sendEventBounded({
      name: "plan/build-orchestrator.requested",
      data: { sessionId: b.sessionId, tenantId: b.tenantId },
    });
  } catch (err) {
    // Roll the status back so the script (or operator) can retry.
    await supabase.from("planning_sessions").update({ status: "discussing" }).eq("id", b.sessionId);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `event dispatch failed: ${msg.slice(0, 200)}` };
  }
  return { ok: true };
}

async function handleUpdate(b: UpdateBody) {
  const supabase = supabaseService();
  const ALLOWED = new Set([
    "title",
    "description",
    "acceptance_criteria",
    "requested_role",
    "depends_on_ordinals",
    "selected",
  ]);
  const safePatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b.patch ?? {})) {
    if (ALLOWED.has(k) && v !== undefined) safePatch[k] = v;
  }
  if (Object.keys(safePatch).length === 0) {
    return { ok: false, error: "no allowed fields in patch" };
  }
  if (typeof safePatch.requested_role === "string") {
    if (!ROLE_SLUG_SET.has(safePatch.requested_role)) {
      return {
        ok: false,
        error: `unknown role slug: ${String(safePatch.requested_role).slice(0, 60)}`,
      };
    }
  }
  const { data, error } = await supabase
    .from("planning_proposed_tickets")
    .update(safePatch)
    .eq("id", b.proposedTicketId)
    .eq("tenant_id", b.tenantId)
    .is("committed_ticket_id", null)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "not found / already committed / wrong tenant" };
  }
  return { ok: true };
}

async function handleCommit(b: CommitBody) {
  let session;
  try {
    session = await loadSession(b.sessionId, b.tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "load failed" };
  }
  if (session.status !== "planned") {
    return { ok: false, error: `session status=${session.status}` };
  }
  const supabase = supabaseService();
  let pq = supabase
    .from("planning_proposed_tickets")
    .select(
      "id, ordinal, title, description, acceptance_criteria, requested_role, depends_on_ordinals, selected",
    )
    .eq("session_id", b.sessionId)
    .eq("tenant_id", b.tenantId)
    .is("committed_ticket_id", null)
    .order("ordinal", { ascending: true });
  if (b.mode === "selected") pq = pq.eq("selected", true);
  const { data: proposed, error: pErr } = await pq;
  if (pErr) return { ok: false, error: `load proposed failed: ${pErr.message}` };
  if (!proposed || proposed.length === 0) {
    return { ok: false, error: "no proposed tickets to commit" };
  }
  const ticketInserts = proposed.map((p) => ({
    tenant_id: b.tenantId,
    project_id: session.project_id,
    title: (p.title as string).slice(0, 500),
    description: p.description as string | null,
    acceptance_criteria: p.acceptance_criteria as string | null,
    status: "backlog" as const,
    requested_role: (p.requested_role as string | null) ?? null,
    priority: 3,
  }));
  const { data: inserted, error: insErr } = await supabase
    .from("tickets")
    .insert(ticketInserts)
    .select("id");
  if (insErr || !inserted) {
    return { ok: false, error: `ticket insert failed: ${insErr?.message ?? "none"}` };
  }
  if (inserted.length !== proposed.length) {
    return { ok: false, error: `insert count mismatch` };
  }
  const ordinalToTicketId = new Map<number, string>();
  for (let i = 0; i < proposed.length; i++) {
    ordinalToTicketId.set(proposed[i]!.ordinal as number, inserted[i]!.id as string);
  }
  const depRows: Array<{ ticket_id: string; blocks_ticket_id: string }> = [];
  for (const p of proposed) {
    const aTicket = ordinalToTicketId.get(p.ordinal as number);
    if (!aTicket) continue;
    const deps = (p.depends_on_ordinals as number[] | null) ?? [];
    for (const dep of deps) {
      const bTicket = ordinalToTicketId.get(dep);
      if (!bTicket || aTicket === bTicket) continue;
      depRows.push({ ticket_id: aTicket, blocks_ticket_id: bTicket });
    }
  }
  if (depRows.length > 0) {
    await supabase.from("ticket_dependencies").insert(depRows);
  }
  for (let i = 0; i < proposed.length; i++) {
    await supabase
      .from("planning_proposed_tickets")
      .update({ committed_ticket_id: inserted[i]!.id as string })
      .eq("id", proposed[i]!.id as string)
      .eq("tenant_id", b.tenantId);
  }
  await supabase.from("planning_sessions").update({ status: "committed" }).eq("id", b.sessionId);
  return { ok: true, ticketIds: inserted.map((r) => r.id as string) };
}

async function handleDiscard(b: DiscardBody) {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_sessions")
    .update({ status: "discarded" })
    .eq("id", b.sessionId)
    .eq("tenant_id", b.tenantId)
    .not("status", "in", "(committed,discarded)")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "not found / already terminal" };
  return { ok: true };
}

// ─── route handler ──────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || !("op" in body) || !("tenantId" in body) || !("userId" in body)) {
    return NextResponse.json({ error: "missing op / tenantId / userId" }, { status: 400 });
  }

  try {
    let result: unknown;
    switch (body.op) {
      case "start":
        result = await handleStart(body);
        break;
      case "send":
        result = await handleSend(body);
        break;
      case "build":
        result = await handleBuild(body);
        break;
      case "update":
        result = await handleUpdate(body);
        break;
      case "commit":
        result = await handleCommit(body);
        break;
      case "discard":
        result = await handleDiscard(body);
        break;
      default:
        return NextResponse.json({ error: "unknown op" }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
