// WI-14 - the IO half of the agent-ticket guardrails. Decisions live in the
// pure `agent-ticket.ts`; this file only reads/writes.

import { supabaseService } from "@/lib/db/server";
import type { DuplicateCandidate } from "@/lib/board/agent-ticket";

/**
 * Which statuses count as "open" for dedupe purposes: everything except the two
 * terminal ones. Deliberately WIDER than `backlog`: an agent that files "Add
 * retry to the webhook client" while an identical ticket is already `in_progress`
 * has still filed a duplicate - the work exists and is being done. Only `done`
 * and `failed` tickets may legitimately be re-filed (the work regressed, or the
 * earlier attempt was abandoned).
 */
export const OPEN_TICKET_STATUSES = [
  "backlog",
  "ready",
  "assigned",
  "in_progress",
  "input_required",
  "blocked",
  "in_review",
  "paused",
] as const;

/** Candidate set for the deterministic title dedupe: every open ticket in the
 *  project. Bounded - a project with more open tickets than this has bigger
 *  problems than a duplicate, and the cap keeps the write path's cost flat. */
const MAX_DEDUPE_CANDIDATES = 500;

export async function loadDuplicateCandidates(args: {
  tenantId: string;
  projectId: string;
}): Promise<DuplicateCandidate[]> {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("tickets")
    .select("id, title")
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId)
    .in("status", OPEN_TICKET_STATUSES as unknown as string[])
    .order("created_at", { ascending: false })
    .limit(MAX_DEDUPE_CANDIDATES);
  if (error) {
    throw new Error(`loadDuplicateCandidates: ${error.message}`);
  }
  return (data ?? []).map((r) => ({ id: r.id as string, title: r.title as string }));
}

export type SlotClaim =
  | { ok: true; count: number }
  | { ok: false; reason: "at-cap" }
  | { ok: false; reason: "run-not-found" };

/**
 * Atomically claim one of the run's DEVPILOT_MAX_TICKETS_PER_RUN ticket slots.
 *
 * The counter is `runs.tickets_created_count` and the claim is a single
 * conditional UPDATE inside `runs_claim_ticket_slot` (migration 20260717000000)
 * - the same durable-counter shape as `runs_increment_children`, for the same
 * reason: an app-side `select count(*) … then insert` is a TOCTOU race that two
 * concurrent tool calls from one run can both win, and a cap the agent can race
 * past is not a cap.
 */
export async function claimAgentTicketSlot(runId: string, maxTickets: number): Promise<SlotClaim> {
  const supabase = supabaseService();
  const { data, error } = await supabase.rpc("runs_claim_ticket_slot", {
    p_run_id: runId,
    p_max: maxTickets,
  });
  if (error) {
    // The function raises only for an unknown run id - a broken relay, not a
    // cap refusal. Surface the two separately so the agent isn't told to
    // "reduce scope" when the real problem is a missing DEVPILOT_RUN_ID.
    if (/not found/i.test(error.message)) return { ok: false, reason: "run-not-found" };
    throw new Error(`claimAgentTicketSlot: ${error.message}`);
  }
  const count = Number(data);
  if (count === -1) return { ok: false, reason: "at-cap" };
  return { ok: true, count };
}
