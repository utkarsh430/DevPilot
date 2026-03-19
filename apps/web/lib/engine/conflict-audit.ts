// Phase 2.5+ / Slice IB-B — Merge-conflict audit + merger-spawn helpers.
//
// Sequencing on a failed pre-push rebase:
//
//   1. pushPendingChangesAction calls `stampConflict()` + `logConflictEvent('detected')`.
//   2. pushPendingChangesAction calls `spawnMerger()`, which:
//       a. inserts a new ticket with requested_role='release_engineer',
//          parent_ticket_id=<source>, status='ready', priority=1 (urgent).
//       b. inserts a `blocked_by` ticket_dependencies row so the source
//          can't move forward until the merger completes.
//       c. stamps `pending_pushes.merger_ticket_id`.
//       d. emits one `ticket/dispatch-needed` event so the dispatcher picks
//          up the merger ticket immediately (skipping the standard
//          dispatch_queue WIP gate by way of priority=1).
//   3. pushPendingChangesAction calls `logConflictEvent('merger_spawned')`.
//
// The merger role runs inside the SOURCE TICKET's workspace (not its own),
// because the conflict markers live there. This is plumbed through by
// run-agent.ts: when the dispatched role is 'release_engineer' AND the
// merger's parent_ticket_id is set, the runner job carries
// `workspaceTicketId = <parent>` so `prepareWorkspace` re-enters the source
// workspace instead of cloning into a fresh per-merger directory.
//
// All inserts/updates use the service-role client. The action that calls
// these helpers has already validated tenant + project ownership.

import { sendEventBounded } from "@/lib/engine/send-bounded";
import { supabaseService } from "@/lib/db/server";

export type ConflictDetail = {
  /** Files left with conflict markers after the rebase failed. */
  files: string[];
  /** Verbatim stderr from `git rebase` for operator inspection. */
  stderr: string;
  /** Commit SHA of `origin/<integration_branch>` at attempt time. */
  base_sha: string | null;
  /** Commit SHA of the source feature branch at attempt time. */
  branch_sha: string | null;
};

export type ConflictEventKind =
  | "detected"
  | "merger_spawned"
  | "merger_started"
  | "file_resolved"
  | "merger_completed"
  | "operator_overrode"
  | "retry_pushed"
  | "retry_failed";

/**
 * Stamp `pending_pushes.conflict_state='conflict'` with the structured
 * detail. Idempotent — repeated calls overwrite with the latest detail.
 */
export async function stampConflict(pendingPushId: string, detail: ConflictDetail): Promise<void> {
  const supabase = supabaseService();
  const { error } = await supabase
    .from("pending_pushes")
    .update({
      conflict_state: "conflict",
      conflict_detail: detail,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pendingPushId);
  if (error) {
    throw new Error(`stampConflict failed: ${error.message}`);
  }
}

/**
 * Stamp `pending_pushes.conflict_state='rebased'` after a successful rebase
 * onto the integration tip. Carries the new HEAD SHA so the operator can
 * trace what was replayed.
 */
export async function stampRebased(pendingPushId: string, newHeadSha: string): Promise<void> {
  const supabase = supabaseService();
  const { error } = await supabase
    .from("pending_pushes")
    .update({
      conflict_state: "rebased",
      rebased_onto_sha: newHeadSha,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pendingPushId);
  if (error) {
    throw new Error(`stampRebased failed: ${error.message}`);
  }
}

/**
 * Stamp `pending_pushes.conflict_state='clean'` after a no-op rebase (head
 * was already up to date with integration tip).
 */
export async function stampClean(pendingPushId: string): Promise<void> {
  const supabase = supabaseService();
  await supabase
    .from("pending_pushes")
    .update({ conflict_state: "clean", updated_at: new Date().toISOString() })
    .eq("id", pendingPushId);
}

// `stampResolved` used to live here, describing exactly the merger-completion
// call it never had — zero call sites, so a merger-resolved push stayed
// `conflict_state='conflict'` with a NULL `rebased_onto_sha` forever. It is
// replaced by `markConflictResolved` (lib/integration/land-outcome-write.ts),
// which is tenant-scoped, CAS-guarded on the `conflict` state, records the
// replayed sha in the same statement, and is called from the land worker on
// PROOF that the rebase now succeeds rather than on the merger's self-reported
// status. Do not reinstate an unscoped, evidence-free version.

/**
 * Append one row to `merge_conflict_events`. Returns the event id so
 * callers can correlate across timelines.
 */
export async function logConflictEvent(
  pendingPushId: string,
  kind: ConflictEventKind,
  payload: Record<string, unknown> = {},
): Promise<string | null> {
  const supabase = supabaseService();
  // Resolve tenant + project + ticket + merger_ticket_id from the pending
  // push so downstream consumers can filter by any axis.
  const { data: pp } = await supabase
    .from("pending_pushes")
    .select("tenant_id, project_id, ticket_id, merger_ticket_id")
    .eq("id", pendingPushId)
    .maybeSingle();
  if (!pp) {
    console.warn(
      `[conflict-audit] logConflictEvent(${kind}): pending_push ${pendingPushId} not found`,
    );
    return null;
  }
  const { data, error } = await supabase
    .from("merge_conflict_events")
    .insert({
      tenant_id: pp.tenant_id,
      project_id: pp.project_id,
      pending_push_id: pendingPushId,
      ticket_id: pp.ticket_id,
      merger_ticket_id: pp.merger_ticket_id,
      kind,
      payload,
    })
    .select("id")
    .single();
  if (error) {
    console.warn(`[conflict-audit] logConflictEvent insert failed: ${error.message}`);
    return null;
  }
  return data.id as string;
}

export type SpawnMergerInput = {
  pendingPushId: string;
  /** Originating ticket id — the ticket whose push triggered the conflict. */
  sourceTicketId: string;
  /** Tenant the source ticket lives in. */
  tenantId: string;
  /** Project the source ticket belongs to. */
  projectId: string;
  /** The integration branch the rebase was trying to land on. Used in the
   *  merger's description so the agent knows the target. */
  integrationBranch: string;
  /** The feature branch (devpilot/<slug>) that needs reconciling. */
  sourceBranch: string;
  /** Conflict detail snapshot from the failed rebase. */
  detail: ConflictDetail;
  /** Source ticket's title (for the merger ticket title). */
  sourceTitle: string;
};

/**
 * Create the merger ticket, wire the blocked_by relation, stamp
 * pending_pushes.merger_ticket_id, and emit the dispatch event.
 *
 * Returns the merger ticket id on success.
 */
export async function spawnMerger(input: SpawnMergerInput): Promise<string> {
  const supabase = supabaseService();

  const filesBlock =
    input.detail.files.length === 0
      ? "- (no specific files reported — see the rebase output)"
      : input.detail.files.map((f) => `- \`${f}\``).join("\n");

  const description =
    `Auto-spawned to resolve a merge conflict on branch \`${input.sourceBranch}\` ` +
    `that cannot fast-forward onto \`${input.integrationBranch}\`.\n\n` +
    `**Source pending push**: \`${input.pendingPushId}\`\n` +
    `**Source ticket**: \`${input.sourceTicketId}\`\n` +
    `**Integration branch**: \`${input.integrationBranch}\`\n` +
    `**Branch SHA**: \`${input.detail.branch_sha ?? "(unknown)"}\`\n` +
    `**Base SHA**: \`${input.detail.base_sha ?? "(unknown)"}\`\n\n` +
    `### Conflicting files (${input.detail.files.length})\n${filesBlock}\n\n` +
    `### Rebase output\n\`\`\`\n${input.detail.stderr.slice(0, 2000)}\n\`\`\`\n\n` +
    `When this ticket reaches done, the source push can be retried. The ` +
    `source ticket is blocked on this one via blocked_by.`;

  const acceptanceCriteria =
    `- Every conflict marker in every listed file is resolved.\n` +
    `- \`git rebase --continue\` completes cleanly.\n` +
    `- Per-file resolution events have been logged via \`devpilot_log_conflict_event\`.\n` +
    `- A final \`merger_completed\` event has been logged.\n` +
    `- The ticket is moved to done via \`devpilot_move_ticket\`.`;

  const { data: ticket, error: insertErr } = await supabase
    .from("tickets")
    .insert({
      tenant_id: input.tenantId,
      project_id: input.projectId,
      title: `Resolve merge conflict: ${input.sourceTitle.slice(0, 120)}`,
      description,
      acceptance_criteria: acceptanceCriteria,
      status: "ready", // dispatcher picks up ready tickets
      priority: 1, // urgent — drop to front of dispatch_queue
      requested_role: "release_engineer",
      parent_ticket_id: input.sourceTicketId,
    })
    .select("id")
    .single();
  if (insertErr || !ticket) {
    throw new Error(`spawnMerger ticket insert failed: ${insertErr?.message ?? "no row"}`);
  }
  const mergerTicketId = ticket.id as string;

  // Block the source ticket on the merger. ticket_dependencies row
  // semantics: ticket_id is blocked_BY blocks_ticket_id (per migration
  // 20260607010000:relation_type).
  const { error: depErr } = await supabase.from("ticket_dependencies").insert({
    ticket_id: input.sourceTicketId,
    blocks_ticket_id: mergerTicketId,
    relation_type: "blocked_by",
  });
  if (depErr) {
    // Non-fatal — log and continue. The dispatch will still fire on the
    // merger; the source ticket just won't be auto-blocked.
    console.warn(
      `[conflict-audit] blocked_by dep insert failed (source=${input.sourceTicketId} ← merger=${mergerTicketId}): ${depErr.message}`,
    );
  }

  // Stamp the merger_ticket_id on the pending push so the conflict UI can
  // link to it and `logConflictEvent` can populate the merger_ticket_id
  // column on subsequent events.
  await supabase
    .from("pending_pushes")
    .update({ merger_ticket_id: mergerTicketId })
    .eq("id", input.pendingPushId);

  // Emit a dispatch event so the dispatcher picks up the merger
  // immediately. The merger's `requested_role='release_engineer'` short-
  // circuits the classifier path.
  try {
    await sendEventBounded({
      name: "ticket/dispatch-needed",
      data: { ticketId: mergerTicketId, tenantId: input.tenantId },
    });
  } catch (err) {
    console.warn(
      `[conflict-audit] dispatch event for merger ${mergerTicketId} failed: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  return mergerTicketId;
}
