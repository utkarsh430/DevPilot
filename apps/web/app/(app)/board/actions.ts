"use server";

// Server actions for the Work Board UI.
//
// Each action enforces tenant scoping via the auth wrapper, validates state
// transitions through the board state machine, and uses the SERVICE role
// client to run cross-cutting side effects (emit Inngest events, etc.).

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import {
  addComment,
  BlockedByDependencyError,
  PlanHoldError,
  transitionTicket,
} from "@/lib/board/transitions";
import { canTransition, type TicketStatus } from "@/lib/board/state";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseServer, supabaseService } from "@/lib/db/server";
import type { BoardTicket } from "@/components/board/types";
import { resolveActiveProjectId } from "@/lib/projects/current";
import { type DepSuggestion } from "@/lib/engine/dep-suggest";
import { computePlacementAfterBlockers } from "@/lib/board/topo";
import { createTicketCore, loadAndSuggestDeps } from "@/lib/board/create-ticket";
import { probeFirstRun, type FirstRunProbe } from "@/lib/runs/first-run.server";

const STATUS_VALUES = [
  "backlog",
  "ready",
  "assigned",
  "in_progress",
  "input_required",
  "blocked",
  "in_review",
  "paused",
  "done",
  "failed",
] as const satisfies readonly TicketStatus[];

const CreateTicketInput = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(8_000).optional().default(""),
  // Phase 2 / M5g — operator-picked role slug. null/omitted = "Auto-pick"
  // (the dispatcher's classifier decides at dispatch time). We accept any
  // non-empty string here and let the dispatcher validate against the live
  // catalog so adding a role later doesn't require an action edit.
  requestedRole: z.string().min(1).max(64).nullish(),
  // Slice IB-C — parent ticket id when this ticket should stack on top of
  // another. Inserts a `builds_on` row so the runner roots devpilot/<slug-new>
  // at devpilot/<slug-parent>. null/omitted = no stacking.
  buildsOnTicketId: z.string().uuid().nullish(),
  // Ticket image attachments — screenshots the operator pasted/dragged into the
  // dialog and uploaded to the private bucket before create. Keys are validated
  // and tenant-scoped server-side (createTicketCore → sanitizeAttachmentsForInsert),
  // so this shape is loose on purpose; the boundary check runs there. Capped at
  // ATTACHMENT_MAX_COUNT (6) at the schema and again in the sanitizer.
  attachments: z
    .array(
      z.object({
        storageKey: z.string().min(1).max(512),
        mime: z.string().min(1).max(64),
        bytes: z.number().int().positive(),
      }),
    )
    .max(6)
    .optional(),
});

const MoveTicketInput = z.object({
  ticketId: z.string().uuid(),
  toStatus: z.enum(STATUS_VALUES),
});

const UpdateTicketInput = z.object({
  ticketId: z.string().uuid(),
  patch: z
    .object({
      title: z.string().trim().min(3).max(500).optional(),
      description: z.string().max(8_000).nullable().optional(),
      acceptance_criteria: z.string().max(8_000).nullable().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, {
      message: "patch must be non-empty",
    }),
});

const DeleteTicketInput = z.object({
  ticketId: z.string().uuid(),
});

const BulkTicketIdsInput = z.object({
  ticketIds: z.array(z.string().uuid()).min(1).max(100),
});

const PostCommentInput = z.object({
  ticketId: z.string().uuid(),
  body: z.string().min(1).max(8_000),
});

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

/**
 * moveTicketAction's failure shape gains an optional `blockers` payload so the
 * board can snap-back AND show a toast listing what's in the way. Keeping it
 * as an extra field on the existing union (not a new shape) means existing
 * callers that only branch on `ok` keep compiling.
 */
export type MoveTicketResult =
  | { ok: true; value: undefined }
  | { ok: false; error: string; reason?: "blocked"; blockers?: BoardTicket[] };

// ---------------------------------------------------------------------------
// createTicket — humans drop a rough ask into backlog. They then drag to ready
// to kick off the agent loop.

export async function createTicketAction(
  input: z.infer<typeof CreateTicketInput>,
): Promise<ActionResult<{ ticketId: string }>> {
  const parsed = CreateTicketInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  const user = await requireUser();
  const tenantId = await requireTenantId();

  // Phase 2.5 / M6 — Runners gate.
  //
  // When the ticket targets a specific role (operator picked one explicitly),
  // check every agent in the tenant whose role matches that slug for a
  // workflow-level allow-list. If ANY matching agent restricts runners AND
  // the caller's user id is not in the list → refuse the ticket.
  //
  // Multiple agents may share a slug (workflow variants); we treat the gate
  // as a union — caller must be on the allow-list of every restricted
  // agent that would dispatch this ticket. (Liberal alternative: caller on
  // ANY restricted list passes; we chose the strict reading because "who can
  // run this workflow" is a security boundary.)
  //
  // When `requested_role` is omitted (auto-pick), the dispatcher picks a role
  // later via the classifier and we have no agent to gate against — so the
  // gate is skipped. The trade-off is that a workflow can only be locked
  // down by name; tenants who want a fully-gated agent should also restrict
  // their dispatcher catalog.
  if (parsed.data.requestedRole) {
    const gate = await checkRunnersGate({
      tenantId,
      userId: user.id,
      requestedRole: parsed.data.requestedRole,
    });
    if (!gate.ok) return { ok: false, error: gate.error };
  }

  // Stamp the new ticket with the operator's active project so the runner
  // routes it to the right repo and the board filter keeps it in view.
  // Project-first: there is always a real project here (the board redirects a
  // project-less tenant to onboarding), so tickets never land with a null
  // project_id anymore.
  const activeProjectId = await resolveActiveProjectId(tenantId);
  if (!activeProjectId) {
    return { ok: false, error: "Create a project before filing tickets." };
  }

  // WI-14 - the insert, the WI-8 placement, the builds_on link, the dep-suggest
  // emit and the auto-enrich emit all live in `createTicketCore`, shared with
  // the agent's `devpilot_create_ticket` route. Everything ABOVE this line (auth,
  // the Runners gate, active-project resolution) is UI-only and stays here:
  // the agent path has no user session to gate against.
  //
  // The dep-suggestion rerank no longer runs inline (it used to block this
  // response on a slow Haiku call - the "Creating…" freeze). createTicketCore
  // now returns the instant the row is inserted and emits
  // `ticket/suggest-deps.requested`; the suggestions arrive asynchronously on
  // `tickets.suggested_dependencies` and surface as a card chip the operator
  // accepts/skips (acceptTicketDependenciesAction) - see SuggestedDepsModal.
  const supabase = await supabaseServer();
  const created = await createTicketCore({
    tenantId,
    projectId: activeProjectId,
    title: parsed.data.title,
    description: parsed.data.description,
    supabase,
    status: "backlog",
    requestedRole: parsed.data.requestedRole ?? null,
    buildsOnTicketId: parsed.data.buildsOnTicketId ?? null,
    attachments: parsed.data.attachments ?? [],
  });
  if (!created.ok) return { ok: false, error: created.error };

  revalidatePath("/board");
  return { ok: true, value: { ticketId: created.ticketId } };
}

// ---------------------------------------------------------------------------
// seedStarterTicket — first-run activation. Creates one known-good starter
// ticket and immediately promotes it to Ready so it dispatches like any other.
//
// It goes through the exact same validated paths a hand-typed ticket uses:
// `createTicketAction` (auth, tenant, project scoping, insert, auto-enrich)
// then `moveTicketAction` (state-machine-checked backlog→ready transition +
// dispatch). No new write path - this is a thin convenience wrapper so the
// empty-board "Run your first ticket" cards are one click instead of
// create-then-drag.

const SeedStarterTicketInput = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(8_000).optional().default(""),
});

export async function seedStarterTicketAction(
  input: z.infer<typeof SeedStarterTicketInput>,
): Promise<ActionResult<{ ticketId: string }>> {
  const parsed = SeedStarterTicketInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };

  // Reuse the validated create path. Starter tickets carry no explicit role
  // (auto-pick) and never stack on a parent.
  const created = await createTicketAction({
    title: parsed.data.title,
    description: parsed.data.description,
    requestedRole: null,
    buildsOnTicketId: null,
  });
  if (!created.ok) return created;

  // Promote to Ready through the same state-machine-checked transition the
  // board uses on drag, so the ticket dispatches immediately - the whole
  // point of the activation moment is "click → it runs", not "click → drag".
  const moved = await moveTicketAction({
    ticketId: created.value.ticketId,
    toStatus: "ready",
  });
  if (!moved.ok) {
    // The ticket exists in Backlog; the operator can still drag it to Ready.
    // Surface the promotion failure so the UI can toast rather than silently
    // leaving it a step short.
    return { ok: false, error: moved.error };
  }

  return { ok: true, value: { ticketId: created.value.ticketId } };
}

/**
 * Slice IB-C — list in-flight tickets in the active project that can be
 * picked as a `builds_on` parent. We return tickets whose status is in
 * (assigned, in_progress, in_review) — i.e. ones that have produced (or
 * will produce) an `devpilot/<slug>` branch the new ticket can stack on top of.
 *
 * Returns `[]` when the tenant has no projects yet (no project scope means
 * no sensible parent set).
 */
export async function listBuildsOnCandidatesAction(): Promise<
  Array<{ id: string; title: string; status: string }>
> {
  await requireUser();
  const tenantId = await requireTenantId();
  const activeProjectId = await resolveActiveProjectId(tenantId);
  if (!activeProjectId) return [];
  const service = supabaseService();
  const { data, error } = await service
    .from("tickets")
    .select("id, title, status")
    .eq("tenant_id", tenantId)
    .eq("project_id", activeProjectId)
    .in("status", ["assigned", "in_progress", "in_review"])
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    status: r.status as string,
  }));
}

// ---------------------------------------------------------------------------
// Phase 2.5+ / G3 — Suggest + Accept dependency actions.
//
// `suggestTicketDependenciesAction` re-runs the Haiku rerank for an existing
// ticket. The create flow already calls this inline once, but the operator
// can dismiss the modal by accident and re-trigger it from the drawer later.
//
// `acceptTicketDependenciesAction` writes the picked `ticket_dependencies`
// rows (idempotent upsert) and topo-places the ticket below its blockers via
// `computePlacementAfterBlockers`. Empty blocker list = "drop at end of
// backlog" (the Skip path from the suggestion modal).

const SuggestTicketDepsInput = z.object({
  newTicketId: z.string().uuid(),
});

const AcceptTicketDepsInput = z.object({
  ticketId: z.string().uuid(),
  blockerIds: z.array(z.string().uuid()).max(20),
});

export async function suggestTicketDependenciesAction(
  input: z.infer<typeof SuggestTicketDepsInput>,
): Promise<ActionResult<{ suggestions: DepSuggestion[] }>> {
  const parsed = SuggestTicketDepsInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  // Load the ticket via the RLS-bound client so a cross-tenant id leaks back
  // as a "not found" rather than a useful payload.
  const rls = await supabaseServer();
  const { data: ticket, error: tErr } = await rls
    .from("tickets")
    .select("id, title, description, project_id, tenant_id")
    .eq("id", parsed.data.newTicketId)
    .maybeSingle();
  if (tErr) return { ok: false, error: tErr.message };
  if (!ticket) return { ok: false, error: "ticket not found" };
  if (ticket.tenant_id !== tenantId) return { ok: false, error: "forbidden" };
  if (!ticket.project_id) {
    // Same reasoning as the inline create path — no project = no candidates.
    return { ok: true, value: { suggestions: [] } };
  }

  const suggestions = await loadAndSuggestDeps({
    tenantId,
    projectId: ticket.project_id as string,
    newTicketId: ticket.id as string,
    title: ticket.title as string,
    description: (ticket.description as string | null) ?? null,
  });
  return { ok: true, value: { suggestions } };
}

export async function acceptTicketDependenciesAction(
  input: z.infer<typeof AcceptTicketDepsInput>,
): Promise<ActionResult> {
  const parsed = AcceptTicketDepsInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  // De-dupe + self-reference guard (the DB CHECK constraint enforces the
  // self-ref anyway, but failing the whole call for one bad id is worse
  // than dropping it locally).
  const blockerIds = Array.from(new Set(parsed.data.blockerIds)).filter(
    (b) => b !== parsed.data.ticketId,
  );

  // RLS-bound read confirms the ticket belongs to the caller's tenant and
  // gives us the project_id we need for placement scoping.
  const rls = await supabaseServer();
  const { data: ticket, error: tErr } = await rls
    .from("tickets")
    .select("id, tenant_id, project_id")
    .eq("id", parsed.data.ticketId)
    .maybeSingle();
  if (tErr) return { ok: false, error: tErr.message };
  if (!ticket) return { ok: false, error: "ticket not found" };
  if (ticket.tenant_id !== tenantId) return { ok: false, error: "forbidden" };
  if (!ticket.project_id) {
    return { ok: false, error: "ticket has no project — cannot place" };
  }
  const projectId = ticket.project_id as string;

  // Confirm every blocker also lives in the same tenant + project (a
  // cross-project block would break the project filter on the board and is
  // not a flow we want to enable through this action).
  if (blockerIds.length > 0) {
    const { data: blockerRows, error: bErr } = await rls
      .from("tickets")
      .select("id, tenant_id, project_id")
      .in("id", blockerIds);
    if (bErr) return { ok: false, error: bErr.message };
    const allow = new Set<string>();
    for (const r of blockerRows ?? []) {
      if (r.tenant_id === tenantId && r.project_id === projectId) {
        allow.add(r.id as string);
      }
    }
    if (allow.size !== blockerIds.length) {
      return {
        ok: false,
        error: "one or more blockers are out of tenant or project scope",
      };
    }
  }

  const service = supabaseService();

  // Write deps. Idempotent upsert on the composite PK so a re-trigger of the
  // modal can't duplicate-key.
  if (blockerIds.length > 0) {
    const rows = blockerIds.map((bid) => ({
      ticket_id: parsed.data.ticketId,
      blocks_ticket_id: bid,
    }));
    const { error: depErr } = await service
      .from("ticket_dependencies")
      .upsert(rows, { onConflict: "ticket_id,blocks_ticket_id" });
    if (depErr) {
      return { ok: false, error: `dep insert failed: ${depErr.message}` };
    }
  }

  // Compute the new column_position. Empty blockerIds → "end of backlog"
  // semantics (the same drop position commitPlanAction uses for the first
  // ticket of a new batch).
  const newPosition = await computePlacementAfterBlockers({
    projectId,
    tenantId,
    blockerIds,
  });

  // Clear the parked suggestions in the SAME update that re-places the ticket:
  // whether the operator wired a subset (Wire) or dismissed them (Skip / empty
  // blockerIds), they've now dealt with this batch, so the card chip must
  // disappear. Setting it NULL is what the board's realtime UPDATE reflects.
  const { error: updErr } = await service
    .from("tickets")
    .update({ column_position: newPosition, suggested_dependencies: null })
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  if (updErr) {
    return { ok: false, error: `placement update failed: ${updErr.message}` };
  }

  revalidatePath("/board");
  return { ok: true, value: undefined };
}

/**
 * Phase 2.5 / M6 — Runners gate.
 *
 * Returns `{ ok: false, error }` when the caller is NOT allowed to file a
 * ticket against the given role. Returns `{ ok: true }` when there are no
 * restricted agents matching the role, OR when the caller is on every
 * restricted agent's allow-list.
 *
 * Uses the service-role client to read every matching agent's `config` —
 * RLS-bound reads would also be sufficient (every member can see their own
 * tenant's agents) but the service client avoids an extra cookie round trip.
 */
async function checkRunnersGate({
  tenantId,
  userId,
  requestedRole,
}: {
  tenantId: string;
  userId: string;
  requestedRole: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("agents")
    .select("id, config")
    .eq("tenant_id", tenantId)
    .eq("role", requestedRole);
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as { id: string; config: Record<string, unknown> | null }[];
  if (rows.length === 0) {
    // No agent registered for this role — the dispatcher will fall back to
    // the built-in role catalog. There is no workflow to gate against.
    return { ok: true };
  }
  for (const row of rows) {
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    const allowed = cfg.allowed_runner_user_ids;
    if (allowed === undefined || allowed === null) continue; // open
    if (allowed === "all") continue; // explicit open
    if (Array.isArray(allowed)) {
      const list = allowed.filter((v): v is string => typeof v === "string");
      if (list.length === 0) continue; // normalised-empty = open
      if (!list.includes(userId)) {
        return { ok: false, error: "Not allowed to run this workflow" };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// updateTicketAction — edit a ticket's title / description / acceptance_criteria.
//
// G1 — title is editable in ANY column (including done/failed). Operators
// routinely want to rename a card after the fact for clarity, and the title
// is not consumed by downstream agent prompts.
//
// Description + acceptance_criteria stay backlog-only: those fields feed the
// engineer/QA prompts and downstream reasoning, so once a run has started we
// refuse to mutate them.

export type UpdateTicketResult =
  | { ok: true }
  | { ok: false; error: string; code?: "NOT_BACKLOG" | "FORBIDDEN" | "NOT_FOUND" };

export async function updateTicketAction(
  input: z.infer<typeof UpdateTicketInput>,
): Promise<UpdateTicketResult> {
  const parsed = UpdateTicketInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  // Read the current status via RLS-bound client so we get the typed
  // membership check for free.
  const supabase = await supabaseServer();
  const { data: row, error: lookupErr } = await supabase
    .from("tickets")
    .select("status, tenant_id")
    .eq("id", parsed.data.ticketId)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!row) {
    return { ok: false, error: "ticket not found", code: "NOT_FOUND" };
  }
  if (row.tenant_id !== tenantId) {
    return { ok: false, error: "forbidden", code: "FORBIDDEN" };
  }

  // G1 — split the gate by what's in the patch. A title-only patch is allowed
  // in any column; a description or acceptance_criteria touch keeps the
  // backlog-only gate.
  const touchesDescription =
    parsed.data.patch.description !== undefined ||
    parsed.data.patch.acceptance_criteria !== undefined;
  if (touchesDescription && row.status !== "backlog") {
    return {
      ok: false,
      error: `Ticket is ${row.status} — description and acceptance criteria are only editable while it's in Backlog.`,
      code: "NOT_BACKLOG",
    };
  }

  // Normalise: empty string → null for description / AC so the drawer's
  // empty-state renders consistently. Title is min-3 in Zod so it can't be
  // empty here.
  const patch: Record<string, unknown> = {};
  if (parsed.data.patch.title !== undefined) patch.title = parsed.data.patch.title;
  if (parsed.data.patch.description !== undefined) {
    const d = parsed.data.patch.description;
    patch.description = d === null || d.trim().length === 0 ? null : d;
  }
  if (parsed.data.patch.acceptance_criteria !== undefined) {
    const ac = parsed.data.patch.acceptance_criteria;
    patch.acceptance_criteria = ac === null || ac.trim().length === 0 ? null : ac;
  }

  // Race guard: for description/AC writes, re-check status='backlog' as part
  // of the UPDATE predicate so a concurrent PM pickup between the read above
  // and the write here drops the write rather than mutating a row mid-run.
  // Title-only writes skip the predicate — title edits are permitted in any
  // status, including ones the row may have just transitioned into.
  const service = supabaseService();
  let updateQuery = service
    .from("tickets")
    .update(patch)
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  if (touchesDescription) {
    updateQuery = updateQuery.eq("status", "backlog");
  }
  const { data: updated, error: updErr } = await updateQuery.select("id");
  if (updErr) return { ok: false, error: updErr.message };
  if (!updated || updated.length === 0) {
    // For title-only writes, the only way we land here is a row that was
    // deleted between read and write — report it as NOT_FOUND so the client
    // doesn't show a misleading "moved out of Backlog" toast.
    if (!touchesDescription) {
      return {
        ok: false,
        error: "Ticket no longer exists.",
        code: "NOT_FOUND",
      };
    }
    return {
      ok: false,
      error: "Ticket moved out of Backlog while you were editing — edit dropped.",
      code: "NOT_BACKLOG",
    };
  }
  // M2 — scan description / acceptance criteria for #abcdef12 mentions and
  // idempotently materialise them as `related` rows. Non-fatal on failure.
  if (touchesDescription) {
    const { linkMentionsInBody } = await import("@/lib/board/parse-mentions");
    const text = [
      typeof patch.description === "string" ? patch.description : "",
      typeof patch.acceptance_criteria === "string" ? patch.acceptance_criteria : "",
    ].join("\n");
    if (text.length > 0) {
      await linkMentionsInBody({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase: service as any,
        tenantId,
        ticketId: parsed.data.ticketId,
        body: text,
      });
    }
  }
  // Realtime UPDATE streams the change to all open tabs — no revalidate.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// deleteTicketAction — remove a ticket in a deletable state.
//
// "Deletable" = backlog (pre-flight cleanup) OR done / failed (terminal —
// run is over, no engine state is in flight). Active states stay protected
// because an in-flight run + dispatch queue entry assume the ticket row
// still exists; deleting it mid-run would leave the supervisor confused.
//
// FK behavior on delete (see supabase migrations):
//   comments, dispatch_queue, fan_in_decisions, ticket_dependencies     → CASCADE
//   tickets.parent_ticket_id (sub-issues)                               → CASCADE
//   runs, pending_pushes, dev_server_sessions, planning_proposed_tickets → SET NULL
// So run history + push records survive (orphaned, ticket_id = null),
// which preserves cost auditing for already-completed work.

const DELETABLE_STATUSES = ["backlog", "done", "failed"] as const;
type DeletableStatus = (typeof DELETABLE_STATUSES)[number];

function isDeletableStatus(s: string): s is DeletableStatus {
  return (DELETABLE_STATUSES as readonly string[]).includes(s);
}

export type DeleteTicketResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      // NOT_BACKLOG kept as the code name for backwards-compat with existing
      // toast-handling — semantically it now means "not in a deletable state".
      code?: "NOT_BACKLOG" | "FORBIDDEN" | "NOT_FOUND";
    };

export async function deleteTicketAction(
  input: z.infer<typeof DeleteTicketInput>,
): Promise<DeleteTicketResult> {
  const parsed = DeleteTicketInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  const supabase = await supabaseServer();
  const { data: row, error: lookupErr } = await supabase
    .from("tickets")
    .select("status, tenant_id")
    .eq("id", parsed.data.ticketId)
    .maybeSingle();
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!row) return { ok: false, error: "ticket not found", code: "NOT_FOUND" };
  if (row.tenant_id !== tenantId) {
    return { ok: false, error: "forbidden", code: "FORBIDDEN" };
  }
  if (!isDeletableStatus(row.status)) {
    return {
      ok: false,
      error: `Ticket is ${row.status} — only backlog, done, or failed tickets can be deleted.`,
      code: "NOT_BACKLOG",
    };
  }

  // Race guard: re-check status in the DELETE predicate so a concurrent
  // transition (backlog → ready, in_progress → done, etc.) between the
  // read above and the write here drops the write rather than racing.
  const service = supabaseService();
  const { data: removed, error: delErr } = await service
    .from("tickets")
    .delete()
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId)
    .in("status", DELETABLE_STATUSES as readonly string[] as string[])
    .select("id");
  if (delErr) return { ok: false, error: delErr.message };
  if (!removed || removed.length === 0) {
    return {
      ok: false,
      error: "Ticket transitioned while you were viewing it — delete dropped.",
      code: "NOT_BACKLOG",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Bulk operations for the column selection modes. Both actions accept a list
// of ticket ids and act only on rows currently in a deletable / promotable
// state for the caller's tenant; anything else is silently filtered out so a
// stale client selection can't crash the call.

export type BulkDeleteResult =
  | { ok: true; value: { deletedCount: number } }
  | { ok: false; error: string };

/**
 * Bulk-delete any tickets the operator selected, restricted server-side to
 * the same deletable-status set as `deleteTicketAction` (backlog, done,
 * failed). Stale or active selections are filtered out by the SQL predicate
 * — `deletedCount` reports how many rows actually went away.
 */
export async function bulkDeleteTicketsAction(
  input: z.infer<typeof BulkTicketIdsInput>,
): Promise<BulkDeleteResult> {
  const parsed = BulkTicketIdsInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  const service = supabaseService();
  const { data: removed, error } = await service
    .from("tickets")
    .delete()
    .in("id", parsed.data.ticketIds)
    .eq("tenant_id", tenantId)
    .in("status", DELETABLE_STATUSES as readonly string[] as string[])
    .select("id");
  if (error) return { ok: false, error: error.message };

  return { ok: true, value: { deletedCount: removed?.length ?? 0 } };
}

export type BulkMoveToReadyResult =
  | {
      ok: true;
      value: {
        promotedIds: string[];
        queuedIds: string[];
        skippedIds: string[];
      };
    }
  | { ok: false; error: string };

export async function bulkMoveToReadyAction(
  input: z.infer<typeof BulkTicketIdsInput>,
): Promise<BulkMoveToReadyResult> {
  const parsed = BulkTicketIdsInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  // RLS-bound read keeps a stale id from another tenant invisible.
  const supabase = await supabaseServer();
  const { data: rows, error } = await supabase
    .from("tickets")
    .select("id, status")
    .in("id", parsed.data.ticketIds)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: error.message };

  const backlogIds = (rows ?? []).filter((r) => r.status === "backlog").map((r) => r.id as string);
  // Tickets that disappeared, moved, or belong to a different tenant.
  const skippedIds = parsed.data.ticketIds.filter((id) => !backlogIds.includes(id));

  const promotedIds: string[] = [];
  const queuedIds: string[] = [];

  // Sequential: each transition emits a dispatch event and we want each one
  // to land cleanly. The set is bounded at 100 by the schema so this is fast.
  for (const ticketId of backlogIds) {
    try {
      await transitionTicket({ ticketId, tenantId, to: "ready", actor: "human" });
      promotedIds.push(ticketId);
    } catch (e) {
      if (e instanceof BlockedByDependencyError) {
        queuedIds.push(ticketId);
      } else {
        // Surface as skipped so the toast count adds up. A toast on partial
        // success beats failing the whole batch.
        skippedIds.push(ticketId);
      }
    }
  }

  // Flag the queued rows in one update so they auto-promote on blocker done.
  if (queuedIds.length > 0) {
    const service = supabaseService();
    const { error: flagErr } = await service
      .from("tickets")
      .update({ auto_promote_when_unblocked: true })
      .in("id", queuedIds)
      .eq("tenant_id", tenantId)
      .eq("status", "backlog");
    if (flagErr) {
      // The promotions that did succeed are still good. Report the failure
      // as a fall-through error; the client can show a "some queued" toast.
      return { ok: false, error: `queue flag failed: ${flagErr.message}` };
    }
  }

  revalidatePath("/board");
  return {
    ok: true,
    value: { promotedIds, queuedIds, skippedIds },
  };
}

// ---------------------------------------------------------------------------
// moveTicket — drag-and-drop or programmatic transition. Validated against
// the state machine. Moving to "ready" kicks the dispatcher.

export async function moveTicketAction(
  input: z.infer<typeof MoveTicketInput>,
): Promise<MoveTicketResult> {
  const parsed = MoveTicketInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  await requireUser();
  const tenantId = await requireTenantId();

  const supabase = await supabaseServer();
  const { data: row, error: lookupErr } = await supabase
    .from("tickets")
    .select("status, tenant_id")
    .eq("id", parsed.data.ticketId)
    .single();
  if (lookupErr || !row) return { ok: false, error: "ticket not found" };
  if (row.tenant_id !== tenantId) return { ok: false, error: "forbidden" };

  if (!canTransition(row.status as TicketStatus, parsed.data.toStatus)) {
    return {
      ok: false,
      error: `cannot move ${row.status} → ${parsed.data.toStatus}`,
    };
  }

  try {
    const result = await transitionTicket({
      ticketId: parsed.data.ticketId,
      tenantId,
      to: parsed.data.toStatus,
      // COMPARE-AND-SET on the status we just read and validated against the
      // FSM. Without it the UPDATE matches on `id` alone and the dispatch fires
      // unconditionally — so anything that moved the ticket during the read →
      // blocker-check → write window (a plan-commit scaffolder release, an agent
      // move, another operator) gets a SECOND dispatch stacked on top of its
      // own, from a decision made against a status that no longer holds. Two
      // agents in one workspace is the failure that costs real money; a
      // rejected drag is a refresh.
      expectedFrom: row.status as TicketStatus,
      // Operator dragging a card on the board — the human override that is
      // never L1-gated, even for a drag straight into in_review.
      actor: "human",
    });
    if (!result.transitioned) {
      // The CAS lost: the ticket changed underneath the drag. Nothing was
      // written and nothing was dispatched.
      return {
        ok: false,
        error: "This ticket just changed status somewhere else. Refresh the board and try again.",
      };
    }
  } catch (e) {
    // A scaffolder held for a pending plan commit. Not an error the operator
    // did anything wrong to cause — it is a card that is spoken for — so say
    // what will run it instead of surfacing a raw seam message.
    if (e instanceof PlanHoldError) {
      return { ok: false, error: e.message };
    }
    // Phase 1 / M3 — distinguish the blocker case so the client can render a
    // toast listing the open upstream tickets and snap the card back.
    if (e instanceof BlockedByDependencyError) {
      // Audit trail: leave a system comment so the snap-back is visible from
      // the drawer thread even if the user dismisses the toast.
      try {
        await addComment({
          ticketId: parsed.data.ticketId,
          tenantId,
          authorType: "system",
          authorId: "board",
          body:
            `Move to "ready" blocked: ${e.blockers.length} open ` +
            `dependenc${e.blockers.length === 1 ? "y" : "ies"} ` +
            `(${e.blockers.map((b) => b.title).join(", ")}).`,
        });
      } catch {
        /* comment is best-effort; never block the action result on it */
      }
      return { ok: false, error: "blocked", reason: "blocked", blockers: e.blockers };
    }
    return { ok: false, error: e instanceof Error ? e.message : "transition failed" };
  }

  revalidatePath("/board");
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// pauseTicket / resumeTicket — operator-initiated soft-cancel + checkpoint
// resume. Thin wrappers over lib/engine/pause-resume.ts after auth + tenant
// gates. The engine module owns idempotency (conditional UPDATEs), in-flight
// run cancellation, and dispatch_queue drain. See that file's header for the
// full contract.

const PauseResumeInput = z.object({
  ticketId: z.string().uuid(),
});

export type PauseTicketActionResult =
  | { ok: true; cancelledRunIds: string[] }
  | { ok: true; alreadyAtState: true }
  | { ok: false; error: string };

export async function pauseTicketAction(
  input: z.infer<typeof PauseResumeInput>,
): Promise<PauseTicketActionResult> {
  const parsed = PauseResumeInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  const user = await requireUser();
  const tenantId = await requireTenantId();

  // Tenant gate via the RLS-bound client — keeps cross-tenant pauses
  // impossible even with a crafted ticketId. The engine module re-verifies
  // tenant in its conditional UPDATE WHERE clause as defense in depth.
  const supabase = await supabaseServer();
  const { data: ticket, error: tErr } = await supabase
    .from("tickets")
    .select("tenant_id")
    .eq("id", parsed.data.ticketId)
    .maybeSingle();
  if (tErr) return { ok: false, error: `lookup: ${tErr.message}` };
  if (!ticket || ticket.tenant_id !== tenantId) {
    return { ok: false, error: "ticket not found" };
  }

  const { pauseTicket } = await import("@/lib/engine/pause-resume");
  const result = await pauseTicket({
    ticketId: parsed.data.ticketId,
    tenantId,
    reason: "user",
    byUserId: user.id,
  });
  if (!result.ok) return result;
  revalidatePath("/board");
  if ("alreadyAtState" in result) {
    return { ok: true, alreadyAtState: true };
  }
  return { ok: true, cancelledRunIds: result.cancelledRunIds };
}

export type ResumeTicketActionResult =
  | { ok: true; mode: "replay"; latestRunId: string; fromStepIdx: number }
  | { ok: true; mode: "dispatch"; latestRunId: string | null }
  | { ok: true; alreadyAtState: true }
  | { ok: false; error: string };

export async function resumeTicketAction(
  input: z.infer<typeof PauseResumeInput>,
): Promise<ResumeTicketActionResult> {
  const parsed = PauseResumeInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  const supabase = await supabaseServer();
  const { data: ticket, error: tErr } = await supabase
    .from("tickets")
    .select("tenant_id")
    .eq("id", parsed.data.ticketId)
    .maybeSingle();
  if (tErr) return { ok: false, error: `lookup: ${tErr.message}` };
  if (!ticket || ticket.tenant_id !== tenantId) {
    return { ok: false, error: "ticket not found" };
  }

  const { resumeTicket } = await import("@/lib/engine/pause-resume");
  const result = await resumeTicket({
    ticketId: parsed.data.ticketId,
    tenantId,
  });
  if (!result.ok) return result;
  revalidatePath("/board");
  if ("alreadyAtState" in result) {
    return { ok: true, alreadyAtState: true };
  }
  if (result.mode === "replay") {
    return {
      ok: true,
      mode: "replay",
      latestRunId: result.latestRunId,
      fromStepIdx: result.fromStepIdx,
    };
  }
  return { ok: true, mode: "dispatch", latestRunId: result.latestRunId };
}

// ---------------------------------------------------------------------------
// postComment — human reply on a ticket. For input_required tickets we also
// emit the agent/run.human-reply event so the durable run resumes.

export async function postCommentAction(
  input: z.infer<typeof PostCommentInput>,
): Promise<ActionResult> {
  const parsed = PostCommentInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  const user = await requireUser();
  const tenantId = await requireTenantId();

  const supabase = await supabaseServer();
  const { data: ticket, error: lookupErr } = await supabase
    .from("tickets")
    .select("status, tenant_id")
    .eq("id", parsed.data.ticketId)
    .single();
  if (lookupErr || !ticket) return { ok: false, error: "ticket not found" };
  if (ticket.tenant_id !== tenantId) return { ok: false, error: "forbidden" };

  await addComment({
    ticketId: parsed.data.ticketId,
    tenantId,
    authorType: "human",
    authorId: user.email ?? user.id,
    body: parsed.data.body,
  });

  // M2 — scan the comment body for #abcdef12 mentions and auto-link as
  // `related`. Non-fatal on failure; the comment itself has already landed.
  try {
    const { linkMentionsInBody } = await import("@/lib/board/parse-mentions");
    await linkMentionsInBody({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabaseService() as any,
      tenantId,
      ticketId: parsed.data.ticketId,
      body: parsed.data.body,
    });
  } catch {
    /* mention auto-link is a UX nicety, not a correctness gate */
  }

  // Resume the loop after a human reply on an `input_required` ticket.
  //
  // Architecture note (post-F1/F4/F5 wave): the originally-scaffolded
  // pause/resume design (runAgent waits on `agent/run.human-reply` while the
  // run row sits in `status='awaiting_human'`) was never finished — runAgent
  // has no such waitForEvent block and no run is ever set to that status.
  // The pre-fix code dutifully looked for a pending run with that status,
  // found none, fired nothing, and then transitioned the ticket back to
  // in_progress with `emitDispatch: false`, leaving it stuck.
  //
  // Correct behaviour: when a human comments on an `input_required` ticket,
  // transition the ticket back to `in_progress` AND fire a fresh dispatch.
  // The dispatcher's F2 classifier reads the full comment thread (including
  // the human reply) and picks the right next role — typically the same
  // role that asked the question so it can resume with the new info.
  //
  // We also still emit the `agent/run.human-reply` event as a no-op
  // breadcrumb so the typed event surface stays meaningful if/when the true
  // pause/resume architecture lands (it'll be the signal the future
  // waitForEvent block hooks into).
  if (ticket.status === "input_required") {
    try {
      await transitionTicket({
        ticketId: parsed.data.ticketId,
        tenantId,
        to: "in_progress",
        // Human posting a reply that resumes an input_required ticket.
        actor: "human",
        // Fire the dispatch — F2 classifier picks the role from history.
        emitDispatch: true,
      });
    } catch (err) {
      console.warn(
        `[postCommentAction] input_required → in_progress transition failed for ${parsed.data.ticketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Optional: emit the legacy human-reply event for any future consumer.
    // The run lookup is best-effort (the original wait architecture was
    // never wired, so there's typically no run to resume directly).
    const service = supabaseService();
    // Tenant-scoped (`tenantId` is proved against this ticket above). The run id
    // this picks is emitted as the resume target, so a planted row would aim the
    // event at a foreign run.
    const { data: pendingRun } = await service
      .from("runs")
      .select("id")
      .eq("ticket_id", parsed.data.ticketId)
      .eq("tenant_id", tenantId)
      .eq("status", "awaiting_human")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pendingRun?.id) {
      await sendEventBounded({
        name: "agent/run.human-reply",
        data: {
          runId: pendingRun.id,
          ticketId: parsed.data.ticketId,
          body: parsed.data.body,
        },
      });
    }
  }

  revalidatePath("/board");
  return { ok: true, value: undefined };
}

// ===========================================================================
// M1 / M2 — Linear-style properties + relations.
//
// Each action follows the same shape as the rest of this file: zod-validate,
// require user + tenant, route the mutation through the SERVICE client with a
// tenant_id guard so RLS isn't the only line of defence. None of these run
// engine side-effects — they're property edits, so the Realtime UPDATE/INSERT
// on the affected table drives every open board tab.

const TicketIdInput = z.object({ ticketId: z.string().uuid() });

const SetPriorityInput = TicketIdInput.extend({
  priority: z.number().int().min(0).max(4),
});

const SetSafetyCriticalInput = TicketIdInput.extend({
  safetyCritical: z.boolean(),
});

// SME safety gate — flag/unflag a ticket as safety-critical. Setting it true
// arms the human-approval gate in `transitionTicket`: from then on only a human
// board move may complete the ticket to `done`. A plain property edit (no engine
// side-effect); the Realtime UPDATE drives every open board tab. Operator-only,
// like every other setter here.
export async function setTicketSafetyCriticalAction(
  input: z.infer<typeof SetSafetyCriticalInput>,
): Promise<ActionResult<undefined>> {
  const parsed = SetSafetyCriticalInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  const user = await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  const { error } = await service
    .from("tickets")
    .update({ safety_critical: parsed.data.safetyCritical })
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: error.message };
  // Audit trail: arming/disarming a SAFETY control must be attributable. Record
  // WHO changed it (the comment's own created_at is the WHEN) as a system
  // comment so it shows in the ticket thread and survives independent of any
  // UI. Best-effort — the flag write already committed, so an audit-comment
  // failure is logged, not surfaced as an error.
  try {
    const who = user.email ?? user.id;
    await addComment({
      ticketId: parsed.data.ticketId,
      tenantId,
      authorType: "system",
      authorId: "devpilot_safety_gate",
      body: parsed.data.safetyCritical
        ? `[safety] Safety-critical flag ARMED by ${who}. This ticket now requires a human approval before it can reach Done; agent/system completion is blocked and parked.`
        : `[safety] Safety-critical flag REMOVED by ${who}. Agent/system completion to Done is no longer gated for this ticket.`,
    });
  } catch (err) {
    console.error(
      `[setTicketSafetyCritical] audit comment failed for ticket=${parsed.data.ticketId}:`,
      err,
    );
  }
  return { ok: true, value: undefined };
}

export async function setTicketPriorityAction(
  input: z.infer<typeof SetPriorityInput>,
): Promise<ActionResult<undefined>> {
  const parsed = SetPriorityInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  const { error } = await service
    .from("tickets")
    .update({ priority: parsed.data.priority })
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: undefined };
}

const SetEstimateInput = TicketIdInput.extend({
  estimateCents: z.number().int().min(0).max(1_000_000_00).nullable(),
});

export async function setTicketEstimateAction(
  input: z.infer<typeof SetEstimateInput>,
): Promise<ActionResult<undefined>> {
  const parsed = SetEstimateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  const { error } = await service
    .from("tickets")
    .update({ estimate_cents: parsed.data.estimateCents })
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: undefined };
}

const SetDueAtInput = TicketIdInput.extend({
  // ISO timestamp or null to clear.
  dueAt: z.string().datetime().nullable(),
});

export async function setTicketDueAtAction(
  input: z.infer<typeof SetDueAtInput>,
): Promise<ActionResult<undefined>> {
  const parsed = SetDueAtInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  const { error } = await service
    .from("tickets")
    .update({ due_at: parsed.data.dueAt })
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Labels.

const LABEL_COLORS = ["default", "info", "warn", "ok", "danger", "muted", "violet"] as const;

const CreateLabelInput = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.enum(LABEL_COLORS).default("muted"),
});

export async function createLabelAction(
  input: z.infer<typeof CreateLabelInput>,
): Promise<ActionResult<{ id: string; name: string; color: string }>> {
  const parsed = CreateLabelInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  // Idempotent on (tenant_id, name) — the unique index will collapse re-creates.
  // We try-insert; on 23505 (unique violation) we look up the existing row.
  const { data: inserted, error: insErr } = await service
    .from("labels")
    .insert({ tenant_id: tenantId, name: parsed.data.name, color: parsed.data.color })
    .select("id, name, color")
    .single();
  if (insErr) {
    if ((insErr as { code?: string }).code === "23505") {
      const { data: existing, error: lookupErr } = await service
        .from("labels")
        .select("id, name, color")
        .eq("tenant_id", tenantId)
        .eq("name", parsed.data.name)
        .maybeSingle();
      if (lookupErr || !existing) {
        return { ok: false, error: lookupErr?.message ?? "lookup failed" };
      }
      return { ok: true, value: existing as { id: string; name: string; color: string } };
    }
    return { ok: false, error: insErr.message };
  }
  return { ok: true, value: inserted as { id: string; name: string; color: string } };
}

const AttachLabelInput = TicketIdInput.extend({
  labelId: z.string().uuid(),
});

export async function addLabelToTicketAction(
  input: z.infer<typeof AttachLabelInput>,
): Promise<ActionResult<undefined>> {
  const parsed = AttachLabelInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  // Defensive tenant guard: confirm both the ticket and label belong here.
  // RLS would catch a cross-tenant attempt, but checking up-front gives a
  // clearer error to the UI.
  const [{ data: ticket }, { data: label }] = await Promise.all([
    service.from("tickets").select("tenant_id").eq("id", parsed.data.ticketId).maybeSingle(),
    service.from("labels").select("tenant_id").eq("id", parsed.data.labelId).maybeSingle(),
  ]);
  if (!ticket || ticket.tenant_id !== tenantId) return { ok: false, error: "ticket not found" };
  if (!label || label.tenant_id !== tenantId) return { ok: false, error: "label not found" };
  const { error } = await service
    .from("ticket_labels")
    .insert({ ticket_id: parsed.data.ticketId, label_id: parsed.data.labelId });
  if (error) {
    // 23505 — already attached. Treat as success so the UI is idempotent.
    if ((error as { code?: string }).code === "23505") return { ok: true, value: undefined };
    return { ok: false, error: error.message };
  }
  // Bump tickets.updated_at so the realtime UPDATE event wakes other tabs
  // — the ticket_labels INSERT alone wouldn't refresh the ticket card.
  await service
    .from("tickets")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  return { ok: true, value: undefined };
}

export async function removeLabelFromTicketAction(
  input: z.infer<typeof AttachLabelInput>,
): Promise<ActionResult<undefined>> {
  const parsed = AttachLabelInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  const { data: ticket } = await service
    .from("tickets")
    .select("tenant_id")
    .eq("id", parsed.data.ticketId)
    .maybeSingle();
  if (!ticket || ticket.tenant_id !== tenantId) return { ok: false, error: "ticket not found" };
  const { error } = await service
    .from("ticket_labels")
    .delete()
    .eq("ticket_id", parsed.data.ticketId)
    .eq("label_id", parsed.data.labelId);
  if (error) return { ok: false, error: error.message };
  await service
    .from("tickets")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  return { ok: true, value: undefined };
}

export async function listLabelsAction(): Promise<
  ActionResult<Array<{ id: string; name: string; color: string }>>
> {
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  const { data, error } = await service
    .from("labels")
    .select("id, name, color")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: (data ?? []) as Array<{ id: string; name: string; color: string }> };
}

// ---------------------------------------------------------------------------
// Relations: blocked_by / related / duplicate. `blocks` is the inverse query
// of blocked_by — not a separate stored row.

const RELATION_TYPES = ["blocked_by", "related", "duplicate", "builds_on"] as const;

const RelationInput = z.object({
  ticketId: z.string().uuid(),
  otherTicketId: z.string().uuid(),
  relationType: z.enum(RELATION_TYPES),
});

export async function addRelationAction(
  input: z.infer<typeof RelationInput>,
): Promise<ActionResult<undefined>> {
  const parsed = RelationInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  if (parsed.data.ticketId === parsed.data.otherTicketId) {
    return { ok: false, error: "cannot relate a ticket to itself" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  // Both tickets must live in the same tenant. RLS would catch a cross-tenant
  // attempt; the explicit check produces a friendlier error to the UI.
  const { data: rows } = await service
    .from("tickets")
    .select("id, tenant_id")
    .in("id", [parsed.data.ticketId, parsed.data.otherTicketId]);
  if (!rows || rows.length !== 2 || rows.some((r) => r.tenant_id !== tenantId)) {
    return { ok: false, error: "ticket not found in tenant" };
  }
  const { error } = await service.from("ticket_dependencies").insert({
    ticket_id: parsed.data.ticketId,
    blocks_ticket_id: parsed.data.otherTicketId,
    relation_type: parsed.data.relationType,
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") return { ok: true, value: undefined };
    return { ok: false, error: error.message };
  }
  // Touch the ticket so the board card refreshes.
  await service
    .from("tickets")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  return { ok: true, value: undefined };
}

export async function removeRelationAction(
  input: z.infer<typeof RelationInput>,
): Promise<ActionResult<undefined>> {
  const parsed = RelationInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  // Verify the owning ticket is in this tenant before deleting.
  const { data: owner } = await service
    .from("tickets")
    .select("tenant_id")
    .eq("id", parsed.data.ticketId)
    .maybeSingle();
  if (!owner || owner.tenant_id !== tenantId) return { ok: false, error: "ticket not found" };
  const { error } = await service
    .from("ticket_dependencies")
    .delete()
    .eq("ticket_id", parsed.data.ticketId)
    .eq("blocks_ticket_id", parsed.data.otherTicketId)
    .eq("relation_type", parsed.data.relationType);
  if (error) return { ok: false, error: error.message };
  await service
    .from("tickets")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", parsed.data.ticketId)
    .eq("tenant_id", tenantId);
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Bulk actions for the selection-mode bar.

const BulkSetPriorityInput = z.object({
  ticketIds: z.array(z.string().uuid()).min(1).max(100),
  priority: z.number().int().min(0).max(4),
});

export async function bulkSetPriorityAction(
  input: z.infer<typeof BulkSetPriorityInput>,
): Promise<ActionResult<{ updatedCount: number }>> {
  const parsed = BulkSetPriorityInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  const { data, error } = await service
    .from("tickets")
    .update({ priority: parsed.data.priority })
    .in("id", parsed.data.ticketIds)
    .eq("tenant_id", tenantId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: { updatedCount: data?.length ?? 0 } };
}

const BulkAddLabelInput = z.object({
  ticketIds: z.array(z.string().uuid()).min(1).max(100),
  labelId: z.string().uuid(),
});

export async function bulkAddLabelAction(
  input: z.infer<typeof BulkAddLabelInput>,
): Promise<ActionResult<{ updatedCount: number }>> {
  const parsed = BulkAddLabelInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();
  const service = supabaseService();
  // Tenant guard.
  const [{ data: tickets }, { data: label }] = await Promise.all([
    service.from("tickets").select("id, tenant_id").in("id", parsed.data.ticketIds),
    service.from("labels").select("tenant_id").eq("id", parsed.data.labelId).maybeSingle(),
  ]);
  if (!label || label.tenant_id !== tenantId) {
    return { ok: false, error: "label not found" };
  }
  const validIds = (tickets ?? [])
    .filter((t) => t.tenant_id === tenantId)
    .map((t) => t.id as string);
  if (validIds.length === 0) return { ok: true, value: { updatedCount: 0 } };
  const rows = validIds.map((tid) => ({ ticket_id: tid, label_id: parsed.data.labelId }));
  // upsert ignores duplicates via the PK; rows already attached are no-ops.
  const { error } = await service
    .from("ticket_labels")
    .upsert(rows, { onConflict: "ticket_id,label_id", ignoreDuplicates: true });
  if (error) return { ok: false, error: error.message };
  // Touch every affected ticket so realtime carries.
  await service
    .from("tickets")
    .update({ updated_at: new Date().toISOString() })
    .in("id", validIds)
    .eq("tenant_id", tenantId);
  return { ok: true, value: { updatedCount: validIds.length } };
}

// ===========================================================================
// reorderTicketsAction — within-column drag-reorder.
//
// Sortable drag emits an ordered list of ticket ids representing the new
// column order. We rewrite `tickets.column_position` to 1..N in that order,
// scoped to the caller's tenant. Existing default-0 rows in other columns
// keep their default; only the listed ids are touched.
//
// N is the column size (typically < 50). We do per-row UPDATEs rather than a
// CASE-WHEN composite because the supabase-js shape for the latter is awkward
// and the realtime UPDATE-per-row volume is acceptable at typical scale.
//
// No status change: this action is only valid when all listed tickets share
// the same `status` (enforced via a single follow-up read). Cross-column
// movement still flows through moveTicketAction.

const ReorderTicketsInput = z.object({
  ticketIds: z.array(z.string().uuid()).min(1).max(200),
});

export type ReorderTicketsResult =
  | { ok: true; value: { updatedCount: number } }
  | { ok: false; error: string };

export async function reorderTicketsAction(
  input: z.infer<typeof ReorderTicketsInput>,
): Promise<ReorderTicketsResult> {
  const parsed = ReorderTicketsInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
  }
  await requireUser();
  const tenantId = await requireTenantId();

  const service = supabaseService();
  // Tenant + status sanity: every listed ticket must belong to the caller's
  // tenant and share a single status. Filtering both server-side keeps a
  // stale client selection from rewriting unrelated rows.
  const { data: rows, error: lookupErr } = await service
    .from("tickets")
    .select("id, tenant_id, status")
    .in("id", parsed.data.ticketIds);
  if (lookupErr) return { ok: false, error: lookupErr.message };
  if (!rows || rows.length !== parsed.data.ticketIds.length) {
    return { ok: false, error: "some tickets not found" };
  }
  if (rows.some((r) => r.tenant_id !== tenantId)) {
    return { ok: false, error: "forbidden" };
  }
  const firstStatus = rows[0]?.status;
  if (!firstStatus || rows.some((r) => r.status !== firstStatus)) {
    return { ok: false, error: "reorder only valid within a single column" };
  }

  // Per-row UPDATEs in the requested order. Position is 1-indexed so the
  // existing default-0 rows (planning hasn't touched them yet) sort BELOW
  // anything we've reordered — matches the legacy expectation that
  // freshly-created tickets land at the bottom.
  for (let i = 0; i < parsed.data.ticketIds.length; i++) {
    const id = parsed.data.ticketIds[i];
    if (typeof id !== "string") continue;
    const { error } = await service
      .from("tickets")
      .update({ column_position: i + 1 })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) {
      return { ok: false, error: error.message };
    }
  }
  return { ok: true, value: { updatedCount: parsed.data.ticketIds.length } };
}

/**
 * A3 — first-dispatch activation probe. Read-only: reports whether the
 * tenant's first-ever run just came into existence, so the board can route
 * the user to the live trace at exactly the right moment. Shown-once state
 * lives client-side (localStorage) — this action never writes anything.
 */
export async function firstDispatchProbeAction(): Promise<ActionResult<FirstRunProbe>> {
  await requireUser();
  const tenantId = await requireTenantId();
  return { ok: true, value: await probeFirstRun(tenantId) };
}
