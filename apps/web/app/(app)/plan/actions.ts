"use server";

// Phase 2.5+ / M7 (REVISION 2026-06-04) — Plan-mode server actions.
//
// The original M7 actions did inline `@ai-sdk/anthropic` calls, which
// violated CLAUDE.md #1 (Local Claude Code Runner is the default; never
// hardwire a vendor SDK outside the runner/adapter layer). After the
// revision, actions are fire-and-forget event emitters:
//
//   • startPlanSessionAction   — creates the session + user message,
//                                emits `plan/lead-reply.requested`.
//   • sendPlanMessageAction    — appends user message, emits
//                                `plan/lead-reply.requested`.
//   • buildPlanUltraAction     — transitions to `planning`, emits
//                                `plan/build-orchestrator.requested`.
//   • updateProposedTicketAction — inline edit (no LLM, unchanged).
//   • commitPlanAction         — bulk-create real tickets + deps
//                                (no LLM, unchanged).
//   • discardPlanSessionAction — soft-state discard (unchanged).
//
// The LLM-bearing work lives in apps/web/lib/plan/inngest.ts behind the
// runner-bridge. Results land in `planning_messages` via Realtime, which
// the PlanSheet UI already reacts to without any client changes.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { assertCanProceedPlan } from "@/lib/engine/budget";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import type { StackFlavor } from "@/lib/plan/prompts";
import { TEAM_TIERS, type TeamTier } from "@/lib/team-tiers/tiers";
import {
  StartPlanSessionInput,
  SendPlanMessageInput,
  EditPlanMessageInput,
} from "@/lib/plan/input-schemas";
import { computeTopoOrder } from "@/lib/board/topo";
import {
  PLAN_SCAFFOLDER_ROLE_REFUSAL,
  isScaffolderRole,
  planScaffolderRooting,
} from "@/lib/plan/scaffolder";
import {
  findHeldScaffolder,
  findScaffolderToRootOn,
  releaseScaffolder,
} from "@/lib/plan/scaffolder-release.server";

// ─── shared constants ──────────────────────────────────────────────────────

const STACK_FLAVORS = ["industry", "mixed", "oss"] as const satisfies readonly StackFlavor[];

// Per-plan team-tier override. Null/omitted = inherit the project default.
const TEAM_TIER_ENUM = TEAM_TIERS as readonly TeamTier[] as [TeamTier, ...TeamTier[]];

// Estimated cents we pre-reserve before each LLM call. These are rough
// upper-bound guesses for the velocity-bucket check; the real cost is
// recorded after the call returns inside the Inngest function via
// `recordPlanSessionSpend`.
const EST_CENTS = {
  leadReply: 4,
  panelDraft: 6,
  consolidator: 8,
} as const;

const ROLE_SLUG_SET = new Set(ROLE_CATALOG.map((e) => e.slug));

// submitPlanAnswersAction — structured answers to a lead's question panel.
// One row per answered question. Choice variants mirror QuestionPanel's
// PendingAnswerChoice union; the server formats them into a single
// human-and-machine-readable user message and re-emits lead-reply.
const PendingAnswerChoiceSchema = z.union([
  z.object({ kind: z.literal("option"), label: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal("options"),
    labels: z.array(z.string().min(1).max(200)).min(1).max(4),
  }),
  z.object({ kind: z.literal("other"), text: z.string().min(1).max(4_000) }),
]);
const PendingAnswerSchema = z.object({
  questionIdx: z.number().int().min(0).max(3),
  q: z.string().min(1).max(400),
  choice: PendingAnswerChoiceSchema,
});
const SubmitPlanAnswersInput = z.object({
  sessionId: z.string().uuid(),
  inReplyToMessageId: z.string().uuid(),
  answers: z.array(PendingAnswerSchema).min(1).max(4),
});

const BuildPlanUltraInput = z.object({
  sessionId: z.string().uuid(),
});

const UpdateProposedTicketInput = z.object({
  proposedTicketId: z.string().uuid(),
  patch: z
    .object({
      title: z.string().min(3).max(160).optional(),
      description: z.string().max(4_000).optional(),
      acceptance_criteria: z.string().max(4_000).optional(),
      requested_role: z.string().max(60).optional(),
      depends_on_ordinals: z.array(z.number().int().positive()).max(20).optional(),
      selected: z.boolean().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, { message: "patch must be non-empty" }),
});

const CommitPlanInput = z.object({
  sessionId: z.string().uuid(),
  mode: z.enum(["selected", "all"]),
});

const DiscardPlanSessionInput = z.object({
  sessionId: z.string().uuid(),
});

// Restart-this-step input. The UI button fires per-stage:
//   - panel:pm | panel:tech_lead | panel:devops
//       → re-fire `plan/panel-step.requested` for that lens only
//   - consolidator
//       → re-fire `plan/consolidator.requested` with the previously-cached
//         panel drafts (read from the panel.done system messages' metadata)
//
// We deliberately do NOT support "restart lead" — lead replies are short
// (10-30s) and already retriable via the chat composer's normal send flow.
//
// Pre-condition for restart: the session must be in 'planning' status (the
// orchestrator's catch leaves it there pre-rollback OR the orchestrator
// rolled it back to 'discussing' and the user wants to retry just one step
// rather than re-running the whole build). Accept both.
const RESTART_STAGES = ["panel:pm", "panel:tech_lead", "panel:devops", "consolidator"] as const;
const RestartPlanStepInput = z.object({
  sessionId: z.string().uuid(),
  stage: z.enum(RESTART_STAGES),
});

// ─── topological order over proposed-ticket DAG (C3) ──────────────────────
//
// The `computeTopoOrder` helper used to live inline here. It was extracted
// verbatim to `@/lib/board/topo` in the G3 wave so the new
// `acceptTicketDependenciesAction` (board create-time dep wiring) and this
// `commitPlanAction` (plan-mode batch commit) can share the same topo logic.
// Pure extract — no behaviour change here, the signature and algorithm are
// identical to the previous inline version.

// ─── helper: persist a message ─────────────────────────────────────────────

async function insertPlanMessage(args: {
  sessionId: string;
  tenantId: string;
  role: "user" | "assistant" | "system";
  content: string;
  agentRole?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabase = supabaseService();
  const { error } = await supabase.from("planning_messages").insert({
    session_id: args.sessionId,
    tenant_id: args.tenantId,
    role: args.role,
    content: args.content,
    agent_role: args.agentRole ?? null,
    metadata: args.metadata ?? null,
  });
  if (error) {
    throw new Error(`insertPlanMessage failed: ${error.message}`);
  }
}

// ─── helper: load session ──────────────────────────────────────────────────

type SessionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  status: string;
  stack_flavor: StackFlavor;
  stack_preferences: string;
  goal_summary: string | null;
};

async function loadSession(sessionId: string, tenantId: string): Promise<SessionRow> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_sessions")
    .select("id, tenant_id, project_id, status, stack_flavor, stack_preferences, goal_summary")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`loadSession failed: ${error.message}`);
  if (!data) throw new Error(`loadSession: session ${sessionId} not found`);
  if (data.tenant_id !== tenantId) {
    throw new Error(`loadSession: tenant mismatch on ${sessionId}`);
  }
  return data as SessionRow;
}

// ─── 1. startPlanSessionAction ──────────────────────────────────────────────

export type StartPlanSessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

export async function startPlanSessionAction(
  input: z.infer<typeof StartPlanSessionInput>,
): Promise<StartPlanSessionResult> {
  const user = await requireUser();
  const tenantId = await requireTenantId();

  const parsed = StartPlanSessionInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { projectId, stackFlavor, stackPreferences, openingMessage, teamTier } = parsed.data;

  const supabase = supabaseService();

  // Defensive: confirm the project belongs to this tenant. RLS would block it
  // either way, but a friendlier error message helps debug.
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id, tenant_id")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return { ok: false, error: `project lookup failed: ${projErr.message}` };
  if (!project) return { ok: false, error: "project not found" };
  if (project.tenant_id !== tenantId) {
    return { ok: false, error: "project does not belong to your tenant" };
  }

  const { data: session, error: insertErr } = await supabase
    .from("planning_sessions")
    .insert({
      tenant_id: tenantId,
      project_id: projectId,
      created_by: user.id,
      status: "discussing",
      stack_flavor: stackFlavor,
      stack_preferences: stackPreferences,
      team_tier: teamTier ?? null,
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
    tenantId,
    role: "user",
    content: openingMessage.trim(),
  });

  // Cost-gate the first reply before emitting. assertCanProceedPlan reads
  // the session row's spent_cents; this catches a misconfigured per-
  // session ceiling early so we don't burn an Inngest invocation.
  try {
    await assertCanProceedPlan({
      tenantId,
      projectId,
      sessionId,
      estCents: EST_CENTS.leadReply,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Fire-and-forget — the Inngest function reads the session + transcript
  // and posts the assistant reply via Realtime. The caller doesn't await
  // the reply.
  try {
    await sendEventBounded({
      name: "plan/lead-reply.requested",
      // Pre-allocated runId so the bridge's waitForEvent match works.
      data: { sessionId, tenantId, runId: randomUUID() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `event dispatch failed: ${msg.slice(0, 200)}` };
  }

  return { ok: true, sessionId };
}

// ─── 2. sendPlanMessageAction ───────────────────────────────────────────────

export type SendPlanMessageResult = { ok: true } | { ok: false; error: string };

export async function sendPlanMessageAction(
  input: z.infer<typeof SendPlanMessageInput>,
): Promise<SendPlanMessageResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = SendPlanMessageInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { sessionId, content } = parsed.data;

  let session: SessionRow;
  try {
    session = await loadSession(sessionId, tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "load failed" };
  }
  if (session.status !== "discussing") {
    return {
      ok: false,
      error: `session is ${session.status}; can only chat while status='discussing'`,
    };
  }

  await insertPlanMessage({
    sessionId,
    tenantId,
    role: "user",
    content: content.trim(),
  });

  try {
    await assertCanProceedPlan({
      tenantId,
      projectId: session.project_id,
      sessionId,
      estCents: EST_CENTS.leadReply,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    await sendEventBounded({
      name: "plan/lead-reply.requested",
      // Pre-allocated runId so the bridge's waitForEvent match works.
      data: { sessionId, tenantId, runId: randomUUID() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `event dispatch failed: ${msg.slice(0, 200)}` };
  }

  return { ok: true };
}

// ─── 2b. editPlanMessageAction ──────────────────────────────────────────────
//
// Edit-and-resend a prior USER message. Truncates the transcript at that
// point (hard-deletes every later message in the session) and re-emits
// `plan/lead-reply.requested` so the existing `planLeadReplyFn` regenerates
// the reply against the new transcript. Mirrors the send-message RLS shape
// (any tenant member can edit, matching the send-message contract).

export type EditPlanMessageResult =
  | { ok: true; deletedFollowUps: number }
  | { ok: false; error: string };

export async function editPlanMessageAction(
  input: z.infer<typeof EditPlanMessageInput>,
): Promise<EditPlanMessageResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = EditPlanMessageInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { messageId, content } = parsed.data;

  const supabase = supabaseService();

  // Load the target row to confirm tenant + role + capture created_at.
  const { data: msg, error: loadErr } = await supabase
    .from("planning_messages")
    .select("id, session_id, tenant_id, role, created_at, metadata")
    .eq("id", messageId)
    .maybeSingle();
  if (loadErr) return { ok: false, error: `load failed: ${loadErr.message}` };
  if (!msg) return { ok: false, error: "message not found" };
  if (msg.tenant_id !== tenantId) {
    return { ok: false, error: "message does not belong to your tenant" };
  }
  if (msg.role !== "user") {
    return { ok: false, error: "only user messages can be edited" };
  }

  // Confirm the session is still in `discussing` — once the panel has
  // committed work to `planned` / `committed` we don't want to retroactively
  // mutate the transcript that produced it.
  let session: SessionRow;
  try {
    session = await loadSession(msg.session_id as string, tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "load failed" };
  }
  if (session.status !== "discussing") {
    return {
      ok: false,
      error: `session is ${session.status}; edits only allowed while discussing`,
    };
  }

  // Patch the message content + record edited_at in metadata.
  const newMeta: Record<string, unknown> = {
    ...((msg.metadata as Record<string, unknown> | null) ?? {}),
    edited_at: new Date().toISOString(),
  };
  const { error: updErr } = await supabase
    .from("planning_messages")
    .update({ content: content.trim(), metadata: newMeta })
    .eq("id", messageId);
  if (updErr) return { ok: false, error: `update failed: ${updErr.message}` };

  // Hard-delete every later message in the same session. We can't use the
  // edited row's PK because Realtime DELETE fires per row; we use the
  // `created_at` strict-greater filter so the edited message survives.
  const { data: removed, error: delErr } = await supabase
    .from("planning_messages")
    .delete()
    .eq("session_id", msg.session_id)
    .eq("tenant_id", tenantId)
    .gt("created_at", msg.created_at as string)
    .select("id");
  if (delErr) return { ok: false, error: `truncate failed: ${delErr.message}` };
  const deletedFollowUps = removed?.length ?? 0;

  // Re-emit the lead-reply event so the regenerated reply lands.
  try {
    await assertCanProceedPlan({
      tenantId,
      projectId: session.project_id,
      sessionId: session.id,
      estCents: EST_CENTS.leadReply,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await sendEventBounded({
      name: "plan/lead-reply.requested",
      data: {
        sessionId: session.id,
        tenantId,
        runId: randomUUID(),
      },
    });
  } catch (err) {
    const msg2 = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `event dispatch failed: ${msg2.slice(0, 200)}` };
  }

  return { ok: true, deletedFollowUps };
}

// ─── 2c. submitPlanAnswersAction ────────────────────────────────────────────
//
// Sibling of sendPlanMessageAction. Takes the structured answers picked in
// QuestionPanel, formats them into a single user message that's both
// human-readable AND parseable on the next lead turn (the lead's next prompt
// includes the prior transcript, so it sees the `**Q:** … **A:** …` blocks
// the same way it'd see any other user reply). Stores the structured
// `answers` and `in_reply_to` in `metadata` so the UI can later detect
// "this turn answered that question panel" and lock the panel.

export type SubmitPlanAnswersResult = { ok: true } | { ok: false; error: string };

function formatAnswerBlock(a: z.infer<typeof PendingAnswerSchema>): string {
  const qNum = a.questionIdx + 1;
  const qLine = `**Q${qNum}:** ${a.q}`;
  let aLine = "";
  if (a.choice.kind === "option") {
    aLine = `**A:** ${a.choice.label}`;
  } else if (a.choice.kind === "options") {
    aLine = `**A:** ${a.choice.labels.join("; ")}`;
  } else {
    aLine = `**A (other):** ${a.choice.text}`;
  }
  return `${qLine}\n${aLine}`;
}

export async function submitPlanAnswersAction(
  input: z.infer<typeof SubmitPlanAnswersInput>,
): Promise<SubmitPlanAnswersResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = SubmitPlanAnswersInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { sessionId, inReplyToMessageId, answers } = parsed.data;

  let session: SessionRow;
  try {
    session = await loadSession(sessionId, tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "load failed" };
  }
  if (session.status !== "discussing") {
    return {
      ok: false,
      error: `session is ${session.status}; answers only allowed while discussing`,
    };
  }

  const formattedBody = answers.map(formatAnswerBlock).join("\n\n");

  await insertPlanMessage({
    sessionId,
    tenantId,
    role: "user",
    content: formattedBody,
    metadata: {
      in_reply_to: inReplyToMessageId,
      answers,
    },
  });

  try {
    await assertCanProceedPlan({
      tenantId,
      projectId: session.project_id,
      sessionId,
      estCents: EST_CENTS.leadReply,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    await sendEventBounded({
      name: "plan/lead-reply.requested",
      data: { sessionId, tenantId, runId: randomUUID() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `event dispatch failed: ${msg.slice(0, 200)}` };
  }

  return { ok: true };
}

// ─── 3. buildPlanUltraAction ────────────────────────────────────────────────

export type BuildPlanUltraResult = { ok: true } | { ok: false; error: string };

export async function buildPlanUltraAction(
  input: z.infer<typeof BuildPlanUltraInput>,
): Promise<BuildPlanUltraResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = BuildPlanUltraInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { sessionId } = parsed.data;

  let session: SessionRow;
  try {
    session = await loadSession(sessionId, tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "load failed" };
  }
  if (session.status !== "discussing") {
    return {
      ok: false,
      error: `session is ${session.status}; build-plan only allowed from 'discussing'`,
    };
  }

  // Up-front cost gate — sum of three panels + consolidator + a margin.
  const ultraEst = EST_CENTS.panelDraft * 3 + EST_CENTS.consolidator;
  try {
    await assertCanProceedPlan({
      tenantId,
      projectId: session.project_id,
      sessionId,
      estCents: ultraEst,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Transition to 'planning' so the UI flips to the progress mode. The
  // orchestrator Inngest function carries the pipeline forward.
  const supabase = supabaseService();
  {
    const { error: tErr } = await supabase
      .from("planning_sessions")
      .update({ status: "planning" })
      .eq("id", sessionId);
    if (tErr) return { ok: false, error: `status transition failed: ${tErr.message}` };
  }

  try {
    await sendEventBounded({
      name: "plan/build-orchestrator.requested",
      data: { sessionId, tenantId },
    });
  } catch (err) {
    // Roll the status back so the operator can retry from the UI.
    await supabase.from("planning_sessions").update({ status: "discussing" }).eq("id", sessionId);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `event dispatch failed: ${msg.slice(0, 200)}` };
  }

  return { ok: true };
}

// ─── 4. updateProposedTicketAction ──────────────────────────────────────────

export type UpdateProposedTicketResult = { ok: true } | { ok: false; error: string };

const ALLOWED_PATCH_KEYS = new Set([
  "title",
  "description",
  "acceptance_criteria",
  "requested_role",
  "depends_on_ordinals",
  "selected",
]);

export async function updateProposedTicketAction(
  input: z.infer<typeof UpdateProposedTicketInput>,
): Promise<UpdateProposedTicketResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = UpdateProposedTicketInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { proposedTicketId, patch } = parsed.data;

  // Strip any sneaky keys (defense-in-depth on top of the Zod schema).
  const safePatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED_PATCH_KEYS.has(k) && v !== undefined) {
      safePatch[k] = v;
    }
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
    // The scaffolder is IN the role catalog, so `ROLE_SLUG_SET` alone happily
    // accepts it here — and the commit would then file a second scaffolder row.
    // Refused rather than silently clamped: this is a deliberate operator edit,
    // and a field that quietly ignores what you typed is worse than one that
    // tells you why. The commit's own clamp covers the planner-proposed case,
    // where there is nobody to tell.
    if (isScaffolderRole(safePatch.requested_role)) {
      return { ok: false, error: PLAN_SCAFFOLDER_ROLE_REFUSAL };
    }
  }

  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_proposed_tickets")
    .update(safePatch)
    .eq("id", proposedTicketId)
    .eq("tenant_id", tenantId)
    .is("committed_ticket_id", null)
    .select("id");
  if (error) {
    return { ok: false, error: `update failed: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "ticket not found, already committed, or wrong tenant" };
  }
  return { ok: true };
}

// ─── 5. commitPlanAction ────────────────────────────────────────────────────

export type CommitPlanResult = { ok: true; ticketIds: string[] } | { ok: false; error: string };

export async function commitPlanAction(
  input: z.infer<typeof CommitPlanInput>,
): Promise<CommitPlanResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = CommitPlanInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { sessionId, mode } = parsed.data;

  let session: SessionRow;
  try {
    session = await loadSession(sessionId, tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "load failed" };
  }
  if (session.status !== "planned") {
    return {
      ok: false,
      error: `session is ${session.status}; commit only allowed from 'planned'`,
    };
  }

  const supabase = supabaseService();

  // 1. Load proposed tickets (filter by selected if mode='selected').
  let pq = supabase
    .from("planning_proposed_tickets")
    .select(
      "id, ordinal, title, description, acceptance_criteria, requested_role, depends_on_ordinals, selected",
    )
    .eq("session_id", sessionId)
    .eq("tenant_id", tenantId)
    .is("committed_ticket_id", null)
    .order("ordinal", { ascending: true });
  if (mode === "selected") pq = pq.eq("selected", true);
  const { data: proposed, error: pErr } = await pq;
  if (pErr) return { ok: false, error: `load proposed failed: ${pErr.message}` };
  if (!proposed || proposed.length === 0) {
    return { ok: false, error: "no proposed tickets to commit (after selection filter)" };
  }

  // 2a. Topological order. Kahn's algorithm over the committed subset of
  // proposed tickets, tiebreak on ordinal (preserves the LLM's narrative
  // order). On a detected cycle, fall back to plain ordinal order with a
  // warning — the Consolidator prompt should never emit cycles, this is
  // defensive only.
  const committedOrdinalSet = new Set(proposed.map((p) => p.ordinal as number));
  const topoOrder = computeTopoOrder(
    proposed.map((p) => ({
      ordinal: p.ordinal as number,
      deps: ((p.depends_on_ordinals as number[] | null) ?? []).filter((d) =>
        committedOrdinalSet.has(d),
      ),
    })),
  );
  if (topoOrder.length !== proposed.length) {
    console.warn(
      `[plan.commit] cycle in proposed deps (sessionId=${sessionId}); falling back to ordinal order`,
    );
    topoOrder.length = 0;
    for (const p of proposed) topoOrder.push(p.ordinal as number);
  }

  // 2b. Project-scoped base offset so successive commits stack BELOW the
  // existing backlog rather than colliding with prior tickets' positions.
  // We read max(column_position) over the project's backlog and add a 1024
  // gap so the new batch sits cleanly under it. WI-8 — always add the gap,
  // even when maxPos is 0 (an empty backlog, or one whose only rows are
  // still at the column_position DB default). The old `if (maxPos > 0)`
  // guard left baseOffset at 0 for a project's first-ever commit, so its
  // first ticket (topoIdx 0) landed at column_position 0 — the same
  // top-of-column collision createTicketAction had.
  const { data: maxRow } = await supabase
    .from("tickets")
    .select("column_position")
    .eq("tenant_id", tenantId)
    .eq("project_id", session.project_id)
    .eq("status", "backlog")
    .order("column_position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const maxPos = maxRow && typeof maxRow.column_position === "number" ? maxRow.column_position : 0;
  const baseOffset = maxPos + 1024;

  // Map ordinal → topoIndex so we can look up the column_position per
  // proposed row in original ordinal order.
  const ordinalToTopoIdx = new Map<number, number>();
  topoOrder.forEach((o, i) => ordinalToTopoIdx.set(o, i));

  // 2c. Insert N tickets — service-role write so RLS doesn't trip on the cross-
  //     table bulk insert. We stamp project_id, status='backlog', requested_role,
  //     and column_position (topo-ranked with 1024 spacing for future reorders).
  const ticketInserts = proposed.map((p) => {
    const topoIdx = ordinalToTopoIdx.get(p.ordinal as number) ?? 0;
    const proposedRole = (p.requested_role as string | null) ?? null;
    return {
      tenant_id: tenantId,
      project_id: session.project_id,
      title: (p.title as string).slice(0, 500),
      description: p.description as string | null,
      acceptance_criteria: p.acceptance_criteria as string | null,
      status: "backlog" as const,
      // RE-CLAMP the scaffolder role at the insert, not just at the edit route.
      // `project_scaffolder` is a full catalog slug, so the Thorough tier's
      // planner (which is shown the whole catalog) can propose it and the
      // consolidator will happily keep it — and this insert used to copy
      // `requested_role` through verbatim. That made the plan flow a SECOND
      // creator of scaffolder rows, which is precisely the class of bug #79
      // fixed and precisely what this feature claims immunity to. Project
      // creation is the only path that may file one; a plan ticket that wanted
      // to scaffold falls back to the role classifier (null) rather than being
      // dropped, so the work still gets done by whoever the router picks.
      requested_role: isScaffolderRole(proposedRole) ? null : proposedRole,
      priority: 3,
      column_position: baseOffset + topoIdx * 1024,
    };
  });
  const clampedScaffolderRoles = proposed.filter((p) =>
    isScaffolderRole((p.requested_role as string | null) ?? null),
  ).length;
  if (clampedScaffolderRoles > 0) {
    // Visible, not silent: the operator should be able to find out why a ticket
    // the planner labelled "scaffold the project" came back role-less.
    console.warn(
      `[plan.commit] clamped ${clampedScaffolderRoles} proposed ticket(s) away from the scaffolder role (sessionId=${sessionId}); project creation is its only creator`,
    );
  }

  const { data: inserted, error: insErr } = await supabase
    .from("tickets")
    .insert(ticketInserts)
    .select("id");
  if (insErr || !inserted) {
    return { ok: false, error: `ticket insert failed: ${insErr?.message ?? "no rows returned"}` };
  }
  if (inserted.length !== proposed.length) {
    return {
      ok: false,
      error: `ticket insert count mismatch: ${inserted.length} inserted vs ${proposed.length} proposed`,
    };
  }

  // 3. ordinal → ticketId map.
  const ordinalToTicketId = new Map<number, string>();
  for (let i = 0; i < proposed.length; i++) {
    ordinalToTicketId.set(proposed[i]!.ordinal as number, inserted[i]!.id as string);
  }

  // 4. Dependencies — only those whose target was committed (mode='selected'
  //    may have skipped some). Use blocks_ticket_id semantics: in the
  //    `ticket_dependencies` table the row `(ticket_id, blocks_ticket_id)`
  //    means "ticket_id is blocked by blocks_ticket_id". So a depends_on
  //    edge "A depends on B" → row `(A, B)`.
  const depRows: Array<{ ticket_id: string; blocks_ticket_id: string }> = [];
  for (const p of proposed) {
    const aTicket = ordinalToTicketId.get(p.ordinal as number);
    if (!aTicket) continue;
    const deps = (p.depends_on_ordinals as number[] | null) ?? [];
    for (const dep of deps) {
      const bTicket = ordinalToTicketId.get(dep);
      if (!bTicket) continue; // target wasn't selected — silently drop
      if (aTicket === bTicket) continue; // self-ref guard (also enforced by DB CHECK)
      depRows.push({ ticket_id: aTicket, blocks_ticket_id: bTicket });
    }
  }
  if (depRows.length > 0) {
    const { error: depErr } = await supabase.from("ticket_dependencies").insert(depRows);
    if (depErr) {
      // Don't fail the whole commit — the tickets are already in. Surface a
      // warning-shaped error string the caller can choose to log. We'll
      // still proceed to mark the session committed.
      console.warn(
        `[plan.commit] dependency insert failed (sessionId=${sessionId}): ${depErr.message}`,
      );
    }
  }

  // 4b. Release the project's HELD scaffolder, rooted under the plan.
  //
  // A plan-mode "Create new repo" files exactly one `project_scaffolder` ticket
  // and holds it in `backlog` precisely so THIS moment can inform it: the
  // operator has now settled the stack and committed a backlog, which is the
  // context the scaffolder's decisions needed all along. We RELEASE that
  // existing row - we never insert one (the #79 invariant; a second creator is
  // exactly what produced the duplicate-scaffolder bug). No held row (a
  // connect-existing project, a plain create whose scaffolder already ran, or a
  // fallback that got there first) means there is simply nothing to do here.
  //
  // ROOTING and RELEASING are separate questions, deliberately. Rooting asks
  // "does this project have a scaffolder to branch off?" and applies whether or
  // not it is still held - an earlier version gated both on the hold and
  // silently dropped the rooting whenever the scaffolder had already been
  // released (a discussion longer than the 90-minute TTL, or an operator
  // promote), leaving the whole committed backlog branching off an unseeded
  // repo. Releasing asks "is the instance we parked still parked?" and is
  // answered by the atomic claim.
  //
  // Ordering is deliberate: root FIRST, then claim. If we crash between the two,
  // the children point at a still-held scaffolder that the fallback will release
  // - the safe direction. Claiming first and crashing would dispatch a
  // scaffolder nothing is rooted on.
  //
  // Failure here is non-fatal: the tickets are already committed, and the
  // fallback still releases the scaffolder on its TTL. Wedging a successful
  // commit over an enrichment step would be the worse trade.
  try {
    // Root every committed ticket that has no other blocker on the scaffolder
    // (`builds_on`). The rest reach it transitively through those roots - see
    // `planScaffolderRooting`. This is what makes feature work branch off the
    // SEEDED repo: `builds_on` is a blocking relation, so the landed-readiness
    // gate holds each dependent until the scaffold is actually on the
    // integration branch.
    const root = await findScaffolderToRootOn({ tenantId, projectId: session.project_id });
    if (root) {
      const blockedBy = new Map<string, string[]>();
      for (const row of depRows) {
        const list = blockedBy.get(row.ticket_id) ?? [];
        list.push(row.blocks_ticket_id);
        blockedBy.set(row.ticket_id, list);
      }
      const rootRows = planScaffolderRooting({
        scaffolderTicketId: root.ticketId,
        committed: inserted.map((r) => ({
          ticketId: r.id as string,
          blockedBy: blockedBy.get(r.id as string) ?? [],
        })),
      });
      if (rootRows.length > 0) {
        const { error: rootErr } = await supabase.from("ticket_dependencies").insert(rootRows);
        if (rootErr) {
          console.warn(
            `[plan.commit] scaffolder rooting failed (sessionId=${sessionId}): ${rootErr.message}`,
          );
        }
      }
    }

    // The claim. Guarded on the still-held state inside the UPDATE, so a
    // fallback firing at this exact instant loses cleanly instead of both of us
    // dispatching the same ticket. `planSessionId` is the enrichment: it makes
    // the dispatch prompt carry this session's confirmed stack + the lead's
    // decisions, through the single injection seam.
    const held = await findHeldScaffolder({ tenantId, projectId: session.project_id });
    if (held) {
      await releaseScaffolder({
        tenantId,
        ticketId: held.ticketId,
        planSessionId: sessionId,
        via: "plan-commit",
      });
    }
  } catch (err) {
    console.warn(
      `[plan.commit] scaffolder release threw (sessionId=${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 5. Stamp committed_ticket_id back on the proposed rows for audit.
  for (let i = 0; i < proposed.length; i++) {
    const proposedId = proposed[i]!.id as string;
    const ticketId = inserted[i]!.id as string;
    const { error: stampErr } = await supabase
      .from("planning_proposed_tickets")
      .update({ committed_ticket_id: ticketId })
      .eq("id", proposedId)
      .eq("tenant_id", tenantId);
    if (stampErr) {
      console.warn(
        `[plan.commit] stamp committed_ticket_id failed (proposed=${proposedId}): ${stampErr.message}`,
      );
    }
  }

  // 6. Mark session committed.
  const { error: sessUpErr } = await supabase
    .from("planning_sessions")
    .update({ status: "committed" })
    .eq("id", sessionId);
  if (sessUpErr) {
    return {
      ok: false,
      error: `session transition to 'committed' failed: ${sessUpErr.message}`,
    };
  }

  // 7. Single board revalidation.
  revalidatePath("/board");

  return { ok: true, ticketIds: inserted.map((r) => r.id as string) };
}

// ─── 6. discardPlanSessionAction ────────────────────────────────────────────

export type DiscardPlanSessionResult = { ok: true } | { ok: false; error: string };

export async function discardPlanSessionAction(
  input: z.infer<typeof DiscardPlanSessionInput>,
): Promise<DiscardPlanSessionResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = DiscardPlanSessionInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { sessionId } = parsed.data;

  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("planning_sessions")
    .update({ status: "discarded" })
    .eq("id", sessionId)
    .eq("tenant_id", tenantId)
    .not("status", "in", "(committed,discarded)")
    .select("id, project_id");
  if (error) {
    return { ok: false, error: `discard failed: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "session not found, already committed/discarded, or wrong tenant",
    };
  }

  // Discarding the plan RELEASES this project's held scaffolder, with base
  // context. Two reasons this belongs here rather than being left to the TTL:
  //
  //   • It is what the operator just said. "I'm not planning this after all"
  //     means the scaffolder has nothing left to wait for, and an empty repo
  //     should not sit empty for another 90 minutes on a decision already made.
  //   • It is the human-driven release path, so the empty-repo guarantee does
  //     not rest solely on the fallback's best-effort `inngest.send`. Since a
  //     held row cannot be promoted by hand (the plan-hold gate), this and
  //     "commit the plan" are what the gate's refusal points the operator at.
  //
  // Same atomic claim as every other release, so a TTL fallback firing at the
  // same moment cannot make it two dispatches. Best-effort: the session IS
  // discarded, and the fallback still covers a failure here.
  const projectId = (data[0] as { project_id?: string }).project_id;
  if (projectId) {
    try {
      const held = await findHeldScaffolder({ tenantId, projectId });
      if (held) {
        await releaseScaffolder({
          tenantId,
          ticketId: held.ticketId,
          // No plan was committed, so there is no confirmed context to carry.
          planSessionId: null,
          via: "plan-discard",
        });
      }
    } catch (err) {
      console.warn(
        `[plan.discard] scaffolder release threw (sessionId=${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  revalidatePath("/board");
  return { ok: true };
}

// ─── 7. restartPlanStepAction ───────────────────────────────────────────────
//
// Re-fire a single failed plan-mode step (one panel OR the consolidator)
// without throwing away the whole build. This is the recovery affordance for
// the planConsolidatorFn-hang failure mode that motivates Track 1:
//
//   • For panel:{lens} — re-emits `plan/panel-step.requested` with a fresh
//     runId; the planPanelStepFn handler re-runs that lens against the
//     current transcript and re-stamps the panel.done metadata.
//
//   • For consolidator — reads the most recent panel.done metadata for each
//     of the three lenses (drafts cached in JSONB metadata by inngest.ts's
//     pill-done step) and re-emits `plan/consolidator.requested` carrying
//     those drafts. Avoids re-running the 3 panel passes from scratch.
//
// All restart paths also flip the session status back to 'planning' (if it
// got rolled back by the orchestrator's catch) so the UI's PlanningProgress-
// Strip stays mounted while the restart runs. The orchestrator's catch is
// idempotent against status='planning' so a subsequent failure during the
// restart still rolls cleanly back to 'discussing'.

export type RestartPlanStepResult = { ok: true } | { ok: false; error: string };

export async function restartPlanStepAction(
  input: z.infer<typeof RestartPlanStepInput>,
): Promise<RestartPlanStepResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = RestartPlanStepInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  const { sessionId, stage } = parsed.data;

  let session: SessionRow;
  try {
    session = await loadSession(sessionId, tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "load failed" };
  }
  // Allow restart from EITHER 'planning' (still mid-build, want to re-fire
  // one piece) or 'discussing' (orchestrator catch rolled it back; user wants
  // to retry just the failed step rather than starting the whole build over).
  if (session.status !== "planning" && session.status !== "discussing") {
    return {
      ok: false,
      error: `session is ${session.status}; restart only allowed from 'planning' or 'discussing'`,
    };
  }

  // Re-flip to 'planning' if needed so the UI's progress strip stays up. The
  // orchestrator's catch is idempotent on status='planning' so a subsequent
  // failure still rolls back cleanly.
  const supabase = supabaseService();
  if (session.status === "discussing") {
    const { error: tErr } = await supabase
      .from("planning_sessions")
      .update({ status: "planning" })
      .eq("id", sessionId)
      .eq("tenant_id", tenantId);
    if (tErr) {
      return { ok: false, error: `status transition failed: ${tErr.message}` };
    }
  }

  // Per-stage cost gate — same shape as buildPlanUltraAction but on the
  // subset that's actually about to run.
  try {
    await assertCanProceedPlan({
      tenantId,
      projectId: session.project_id,
      sessionId,
      estCents: stage === "consolidator" ? EST_CENTS.consolidator : EST_CENTS.panelDraft,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Panel restart — one lens. New runId so the bridge's waitForEvent match
  // works for the fresh `runner/step-result` event.
  if (stage.startsWith("panel:")) {
    const lens = stage.slice("panel:".length) as "pm" | "tech_lead" | "devops";
    try {
      await sendEventBounded({
        name: "plan/panel-step.requested",
        data: {
          sessionId,
          tenantId,
          lens,
          runId: randomUUID(),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `event dispatch failed: ${msg.slice(0, 200)}` };
    }
    return { ok: true };
  }

  // Consolidator restart — read the most-recent panel.done message for each
  // lens, pull the drafts from metadata, and re-fire with the same payload
  // the orchestrator would have built. Order matters: the most recent
  // panel.done wins per lens (a successful re-run from a prior restart
  // supersedes the earlier hang).
  const { data: panelMessages, error: msgErr } = await supabase
    .from("planning_messages")
    .select("metadata, created_at")
    .eq("session_id", sessionId)
    .eq("tenant_id", tenantId)
    .eq("role", "system")
    .order("created_at", { ascending: false })
    .limit(50); // generous bound — typical session has <20 system messages
  if (msgErr) {
    return { ok: false, error: `load panel drafts failed: ${msgErr.message}` };
  }

  // Find the latest panel.done per lens.
  const draftsByLens: Record<"pm" | "tech_lead" | "devops", Record<string, unknown>[]> = {
    pm: [],
    tech_lead: [],
    devops: [],
  };
  const seen = new Set<string>();
  for (const row of panelMessages ?? []) {
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    if (meta.stage !== "panel.done") continue;
    const panel = typeof meta.panel === "string" ? meta.panel : null;
    if (!panel || !(panel in draftsByLens) || seen.has(panel)) continue;
    seen.add(panel);
    const drafts = Array.isArray(meta.drafts) ? meta.drafts : [];
    draftsByLens[panel as "pm" | "tech_lead" | "devops"] = drafts as Record<string, unknown>[];
    if (seen.size === 3) break;
  }

  // If no panels have completed yet, the user shouldn't be hitting Restart on
  // the consolidator pill. Surface a clear error.
  if (seen.size === 0) {
    return {
      ok: false,
      error:
        "No panel drafts cached yet — the panels haven't completed. Use 'Cancel build' and start fresh, or wait for at least one panel to finish.",
    };
  }

  try {
    await sendEventBounded({
      name: "plan/consolidator.requested",
      data: {
        sessionId,
        tenantId,
        runId: randomUUID(),
        drafts: draftsByLens,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `event dispatch failed: ${msg.slice(0, 200)}` };
  }
  return { ok: true };
}
