// WI-14 - the ONE ticket-insert path shared by the human board form and the
// agent's `devpilot_create_ticket` MCP tool.
//
// Why this lives in `lib/` and not in `app/(app)/board/actions.ts`:
// `actions.ts` carries the `"use server"` directive, so EVERY exported async
// function in it is published as a callable server action - a public,
// browser-reachable endpoint. `createTicketCore` takes `tenantId` / `projectId`
// as explicit arguments and writes with an RLS-bypassing service client, so
// exporting it from that file would hand any browser a cross-tenant ticket
// writer. Extracting it here keeps the reusable body reusable and keeps the
// server-action surface exactly as it was.
//
// The two callers differ in ONE way, and only one:
//   • `createTicketAction` (UI)   - RLS-bound client, session-derived tenant,
//                                    operator-picked role, optional builds_on.
//   • `POST /api/runners/tools/create-ticket` (agent) - service client, tenant
//                                    and project derived from the SPAWNING
//                                    ticket, role forced to null, backlog only.
// Everything else - the WI-8 1024-spaced placement, the builds_on link, the
// dep-suggest emit, the auto-enrich emit - is identical, which is the whole
// point of the extraction.
//
// The Haiku dep-suggestion rerank used to be an INLINE `await` here, which made
// the create response block on a slow model call (the "Creating…" freeze). It is
// now a background Inngest function (`ticket/suggest-deps.requested` →
// `suggestTicketDepsFn`), so this core returns the instant the row is inserted;
// the shared `loadAndSuggestDeps` helper below is what the background job calls.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseService } from "@/lib/db/server";
import { sendEventBounded } from "@/lib/engine/send-bounded";
import { computePlacementAfterBlockers } from "@/lib/board/topo";
import { suggestDependencies, type DepSuggestion } from "@/lib/engine/dep-suggest";
import { sanitizeAttachmentsForInsert, type AttachmentInput } from "@/lib/board/attachments";
import type { TicketStatus } from "@/lib/board/state";

/** The client that performs the INSERT. The UI passes the RLS-bound
 *  `supabaseServer()` client (so a compromised session still can't write
 *  outside its tenant); the agent route passes `supabaseService()` (no session
 *  exists, and its tenant/project are derived authoritatively from the spawning
 *  ticket). Neither is coerced into the other. */
type TicketInsertClient = SupabaseClient;

export type CreateTicketCoreInput = {
  tenantId: string;
  projectId: string;
  title: string;
  description: string;
  /** The client that performs the INSERT. RLS-bound for the UI path,
   *  service-role for the agent path (which has no user session and derives
   *  its tenant/project authoritatively from the spawning ticket). */
  supabase: TicketInsertClient;
  /** Every caller today files into `backlog`; the parameter exists so a future
   *  caller states its intent rather than inheriting a default silently. */
  status?: TicketStatus;
  /** Operator-picked role slug, or null for "auto-pick" (the dispatcher's
   *  classifier decides at dispatch time). The agent path always passes null:
   *  an agent must not be able to aim a ticket at a specific role, which is
   *  also what keeps the UI-only Runners gate inert on that path. */
  requestedRole?: string | null;
  /** Parent ticket this one stacks on (`builds_on`). UI-only today. */
  buildsOnTicketId?: string | null;
  /** Extra tickets this one should sit BELOW in the backlog column.
   *
   *  Placement only - these do NOT create dependency rows (the agent path writes
   *  its `blocked_by` edges itself, after every reference has been resolved and
   *  adjudicated). It exists because `column_position` and the dependency graph
   *  are different facts that must not disagree on screen: a decomposition whose
   *  children render ABOVE the ticket they wait for reads as a scheduling bug
   *  every time an operator looks at it. */
  placeAfterTicketIds?: readonly string[];
  /** WI-14 provenance - the agent run that filed this ticket. NULL for every
   *  human-created ticket. */
  sourceRunId?: string | null;
  /** Pre-generated primary key, SERVER-side (`crypto.randomUUID()`), never
   *  supplied by a client or an agent.
   *
   *  The agent path pre-generates so that dependency validation - resolving
   *  every `dependsOn` reference and running the cycle guard - can happen BEFORE
   *  this row exists. That ordering is what makes a dependency refusal leave
   *  nothing behind: there is no half-created ticket to unwind, because none was
   *  created. Omitted by the UI path, which lets Postgres default it. */
  ticketId?: string;
  /** Run-local label for this ticket, so a LATER `devpilot_create_ticket` call on
   *  the same run can name it in `dependsOn` before the model has seen its uuid.
   *  Written in THIS insert rather than a follow-up write, so no window exists
   *  in which the ticket is referenceable but unlabelled. Agent path only. */
  agentAlias?: string | null;
  /** Image attachments uploaded from the browser BEFORE the ticket existed
   *  (paste/drag screenshots). Best-effort: the rows are written right after
   *  the ticket insert, and any invalid/cross-tenant entry is dropped by
   *  `sanitizeAttachmentsForInsert` rather than failing the create. Human
   *  dialog only today; the agent path passes none. */
  attachments?: readonly AttachmentInput[];
};

export type CreateTicketCoreResult =
  | {
      ok: true;
      ticketId: string;
      /** `DevPilot-<N>`'s N, assigned by the `assign_ticket_number` BEFORE-INSERT
       *  trigger. Null only for a project-less ticket, which has no counter.
       *  Returned from the insert rather than read back so the caller can name
       *  the ticket the way the board does without a second round trip. */
      ticketNumber: number | null;
    }
  | { ok: false; error: string };

export async function createTicketCore(
  input: CreateTicketCoreInput,
): Promise<CreateTicketCoreResult> {
  const {
    tenantId,
    projectId,
    title,
    description,
    supabase,
    status = "backlog",
    requestedRole = null,
    buildsOnTicketId = null,
    placeAfterTicketIds = [],
    sourceRunId = null,
    ticketId: presetTicketId = undefined,
    agentAlias = null,
    attachments = [],
  } = input;

  // WI-8 - place the new ticket after its `builds_on` parent (if any) or at
  // the end of the project's backlog, using the same 1024-spaced convention
  // `commitPlanAction` and `acceptTicketDependenciesAction` already use.
  // Without this, every hand-typed ticket ties at the column_position DB
  // default (0) and the board's updated_at tiebreak shoves it to the top -
  // the opposite of "new work goes to the bottom of the backlog".
  const columnPosition = await computePlacementAfterBlockers({
    projectId,
    tenantId,
    blockerIds: [...(buildsOnTicketId ? [buildsOnTicketId] : []), ...placeAfterTicketIds],
  });

  const { data, error } = await supabase
    .from("tickets")
    .insert({
      tenant_id: tenantId,
      project_id: projectId,
      title,
      description,
      status,
      requested_role: requestedRole,
      column_position: columnPosition,
      ...(presetTicketId ? { id: presetTicketId } : {}),
      ...(sourceRunId ? { source_run_id: sourceRunId } : {}),
      ...(agentAlias ? { agent_alias: agentAlias } : {}),
    })
    .select("id, ticket_number")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };

  const ticketId = data.id as string;
  const ticketNumber = (data.ticket_number as number | null) ?? null;

  // Ticket image attachments - write one `ticket_attachments` row per uploaded
  // screenshot, right after the ticket insert. Best-effort, mirroring the
  // builds_on link below: a failure here must NOT fail the ticket create (the
  // typed ticket is already saved; the operator can re-attach from the drawer).
  // The create path stays instant - no LLM call, no network beyond this one
  // insert. `sanitizeAttachmentsForInsert` is the boundary re-check: it drops
  // any cross-tenant key, disallowed MIME, or oversized/duplicate entry, and
  // caps the count, so a tampered client payload can't register a row pointing
  // at another tenant's folder. Uses the service client because the metadata
  // table denies JWT inserts (RLS), the same posture as project_handoffs.
  if (attachments.length > 0) {
    const clean = sanitizeAttachmentsForInsert({ tenantId, attachments });
    if (clean.length > 0) {
      const service = supabaseService();
      const { error: attachErr } = await service.from("ticket_attachments").insert(
        clean.map((a) => ({
          ticket_id: ticketId,
          tenant_id: tenantId,
          storage_key: a.storageKey,
          mime: a.mime,
          bytes: a.bytes,
        })),
      );
      if (attachErr) {
        console.warn(
          `[createTicketCore] attachment rows failed for ${ticketId}: ${attachErr.message}`,
        );
      }
    }
  }

  // Slice IB-C - when the operator picked a "builds on" parent, insert
  // the relation immediately. Best-effort: a failure here doesn't fail the
  // ticket create (the operator can wire it from the drawer instead).
  if (buildsOnTicketId) {
    const service = supabaseService();
    // Verify the parent is in the same tenant before linking.
    const { data: parent } = await service
      .from("tickets")
      .select("tenant_id")
      .eq("id", buildsOnTicketId)
      .maybeSingle();
    if (parent && parent.tenant_id === tenantId) {
      const { error: depErr } = await service.from("ticket_dependencies").insert({
        ticket_id: ticketId,
        blocks_ticket_id: buildsOnTicketId,
        relation_type: "builds_on",
      });
      if (depErr) {
        console.warn(
          `[createTicketCore] builds_on link failed for ${ticketId} → ${buildsOnTicketId}: ${depErr.message}`,
        );
      }
    } else {
      console.warn(
        `[createTicketCore] builds_on parent ${buildsOnTicketId} not in tenant ${tenantId}; skipping`,
      );
    }
  }

  // Phase 2.5+ / G3 - Haiku-rerank dep suggestion, now OFF the request path.
  // This used to be an inline `await loadAndSuggestDeps(...)` - a slow model
  // call that blocked the create response and hung the "Creating…" button
  // whenever the local-cc runner was busy. It is now a background Inngest
  // function (`suggestTicketDepsFn`) that runs the SAME rerank and parks the
  // result on `tickets.suggested_dependencies` for the operator to accept/skip
  // asynchronously (the board's realtime subscription lights up a card chip).
  // Best-effort like the auto-enrich emit below: a flaky send must never fail
  // the create - the operator can still wire deps manually from the drawer.
  try {
    await sendEventBounded({
      name: "ticket/suggest-deps.requested",
      data: { ticketId, tenantId, projectId, title, description },
    });
  } catch (err) {
    console.warn(
      `[createTicketCore] inngest.send suggest-deps failed for ${ticketId}: ${String(err)}`,
    );
  }

  // Phase 2 / M5j - fire auto-enrich for direct-create tickets. Neither create
  // path carries an AC field, so freshly-inserted rows always have
  // acceptance_criteria=null - i.e. ALWAYS sparse on at least one axis, so we
  // always emit. The enricher itself re-checks sparseness on both fields and
  // bails (a) if the operator edited between emit and process, or (b) the
  // description is already rich enough that only AC needs filling (which the
  // enricher handles). The planning-commit path inserts tickets via a separate
  // code path that already writes both fields rich, so this emit doesn't
  // affect those.
  try {
    await sendEventBounded({
      name: "ticket/auto-enrich.requested",
      data: { ticketId, tenantId },
    });
  } catch (err) {
    // Don't fail the create over a flaky inngest send. The caller gets the
    // ticket; they just lose the auto-enrich pass.
    console.warn(
      `[createTicketCore] inngest.send auto-enrich failed for ${ticketId}: ${String(err)}`,
    );
  }

  return { ok: true, ticketId, ticketNumber };
}

/**
 * Shared helper: load up to 30 in-scope candidate tickets in the same project
 * (status in backlog/ready/assigned/in_progress, excluding the just-created
 * one), pass them to `suggestDependencies`, and return the resulting array.
 * Never throws - on any failure returns `[]` and logs a warning so the create
 * flow can carry on cleanly.
 */
export async function loadAndSuggestDeps(args: {
  tenantId: string;
  projectId: string;
  newTicketId: string;
  title: string;
  description: string | null;
}): Promise<DepSuggestion[]> {
  try {
    const service = supabaseService();
    const { data: candidates, error } = await service
      .from("tickets")
      .select("id, title, description, status, updated_at")
      .eq("tenant_id", args.tenantId)
      .eq("project_id", args.projectId)
      .in("status", ["backlog", "ready", "assigned", "in_progress"])
      .neq("id", args.newTicketId)
      .order("updated_at", { ascending: false })
      .limit(30);
    if (error) {
      console.warn(
        `[loadAndSuggestDeps] dep-candidate load failed for ${args.newTicketId}: ${error.message}`,
      );
      return [];
    }
    if (!candidates || candidates.length === 0) return [];

    const res = await suggestDependencies({
      tenantId: args.tenantId,
      newTicket: {
        id: args.newTicketId,
        title: args.title,
        description: args.description,
      },
      candidates: candidates.map((c) => ({
        id: c.id as string,
        title: c.title as string,
        description: (c.description as string | null) ?? null,
        status: c.status as TicketStatus,
        updated_at: c.updated_at as string,
      })),
    });
    if (!res.ok) {
      console.warn(
        `[loadAndSuggestDeps] dep-suggest failed for ${args.newTicketId}: ${res.reason}`,
      );
      return [];
    }
    return res.suggestions;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[loadAndSuggestDeps] dep-suggest threw for ${args.newTicketId}: ${msg.slice(0, 200)}`,
    );
    return [];
  }
}
