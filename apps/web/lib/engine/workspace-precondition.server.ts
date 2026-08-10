import "server-only";

// Ticket-visible half of the workspace precondition guard.
//
// The refusal itself already fails the run loudly (`NonRetriableError` from
// `run-agent`'s enqueue step -> `runAgentFailed` marks the row `failed` with the
// reason on a `run_steps` audit row). But a failed run row alone is not enough:
// the operator is looking at the BOARD, and the incident's whole complaint was
// "it says in progress but nothing is happening". So the refusal also leaves a
// system comment saying what is missing and how to fix it.
//
// Shape and de-dupe are lifted DELIBERATELY from `lib/billing/gate.ts` - the
// codebase's existing dispatch-refusal precedent - rather than invented: a
// `system` comment under a dedicated `author_id`, skipped if we already posted
// one on this ticket in the last 24h so Inngest replays cannot spam the thread.
//
// The author id is its own literal and is NEVER `devpilot_move_ticket`: the
// ticket reconciler string-matches that value to mean "an agent rendered a
// verdict", and borrowing it here would fake one.

import { supabaseService } from "@/lib/db/server";
import { addComment } from "@/lib/board/transitions";
import type { WorkspaceRefusalCode } from "@/lib/engine/workspace-precondition";

export const WORKSPACE_PRECONDITION_AUTHOR_ID = "devpilot_workspace_precondition";

const DEDUPE_WINDOW_MS = 24 * 3_600_000;

/**
 * Post the refusal on the ticket. Best-effort: this is a notice, and a comment
 * failure must never mask the refusal itself (which the caller raises
 * immediately after).
 */
export async function noticeWorkspacePreconditionRefusal(args: {
  ticketId: string;
  tenantId: string;
  runId: string;
  role: string | null;
  refusal: { code: WorkspaceRefusalCode; message: string };
}): Promise<{ posted: boolean; skipped?: string }> {
  try {
    const supabase = supabaseService();
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    // Tenant-scoped alongside the ticket id - this read decides whether the
    // operator is told at all, and every service-role read keyed on a ticket
    // pointer carries its tenant predicate (see the export-sweep rule).
    const { data: existing } = await supabase
      .from("comments")
      .select("id")
      .eq("ticket_id", args.ticketId)
      .eq("tenant_id", args.tenantId)
      .eq("author_type", "system")
      .eq("author_id", WORKSPACE_PRECONDITION_AUTHOR_ID)
      .gte("created_at", since)
      .limit(1);
    if (existing && existing.length > 0) return { posted: false, skipped: "already-noticed" };

    await addComment({
      ticketId: args.ticketId,
      tenantId: args.tenantId,
      authorType: "system",
      authorId: WORKSPACE_PRECONDITION_AUTHOR_ID,
      body:
        `Dispatch refused before spending: ${args.refusal.message}\n\n` +
        `(run \`${args.runId}\`, role \`${args.role ?? "unknown"}\`, ` +
        `reason \`${args.refusal.code}\`)`,
    });
    return { posted: true };
  } catch (err) {
    console.warn(
      `[workspace-precondition] notice failed for ticket=${args.ticketId} run=${args.runId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { posted: false, skipped: "notice-error" };
  }
}
