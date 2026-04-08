// Server-side input for the QA hand-off gate (`lib/board/qa-gate.ts`): load a
// run's verification record, strictly scoped to that exact run.
//
// Why run-scoped, not ticket-scoped (failure mode §#9)
// ────────────────────────────────────────────────────
// The gate lives inside `transitionTicket`, and every non-human caller that can
// land a ticket in `in_review` already knows its exact `run_id` (engineer
// postprocess, the reconciler, the fan-in aggregator all carry it; the MCP
// relay forwards it on `devpilot_move_ticket`). So we read `WHERE run_id = <that
// run>` — never "the latest row on the ticket". That deletes the entire
// concurrent-run ambiguity the first attempt had to guess through: an operator
// unblocks → a NEW run starts with a NEW run_id → the old failed run's row is
// invisible to the new run's gate, so a stale record can never re-park an
// unblocked ticket.
//
// Producer-ness is not resolved here: the runner only ever writes a record for
// a producer run that actually ran a check (its own `isProducerRole` + non-
// blank-command gate), so record PRESENCE already means "a producer verified
// this run". A non-producer run simply has no row and the policy allows.

import "server-only";

import { supabaseService } from "@/lib/db/server";
import { decideQaGate, pickCohortRefusal, type VerificationRecord } from "@/lib/board/qa-gate";
import { isCodeProducingRole } from "@/lib/roles/code-producing";
import type { TicketStatus } from "@/lib/board/state";

/**
 * Load the verification record for `runId`, or null when it has none. Never
 * throws: a DB hiccup degrades to null, which the policy reads as "no record →
 * allow" (fail-open — a transient DB error must not strand a ticket).
 *
 * `tenantId` is the TICKET's tenant, read by `transitionTicket` from the very row
 * it is about to move. It is a defence-in-depth predicate, not decoration: this
 * table's member write policy pins only the row's OWN `tenant_id` and says
 * nothing about `run_id`, so without it a hostile tenant could insert
 * `{tenant_id: them, run_id: <our run>, exit_code: 0}` and hand our QA gate a
 * forged pass. A run for this ticket is always in this ticket's tenant, so the
 * predicate never excludes a legitimate record.
 */
export async function loadRunVerification(
  runId: string,
  tenantId: string,
): Promise<VerificationRecord | null> {
  try {
    const supabase = supabaseService();
    const { data } = await supabase
      .from("run_verifications")
      .select("command, exit_code, head_sha, base_sha, pushed, output_tail, commits_ahead")
      .eq("run_id", runId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!data) return null;
    return {
      command: data.command as string,
      exitCode: data.exit_code as number,
      headSha: data.head_sha as string,
      baseSha: (data.base_sha as string | null) ?? null,
      pushed: data.pushed as boolean,
      outputTail: (data.output_tail as string | null) ?? "",
      commitsAhead: (data.commits_ahead as number | null) ?? null,
    };
  } catch (err) {
    console.error(`[qa-gate] verification load failed for run=${runId}:`, err);
    return null;
  }
}

/**
 * B2 — evaluate the QA gate across an ENTIRE fan-out cohort, not just whichever
 * sibling happened to trigger the fan-in.
 *
 * `transitionTicket`'s gate is run-scoped by design (that is what kills the
 * stale-record ambiguity), so it structurally cannot see a cohort. The
 * aggregator therefore asks this first and parks on a refusal, leaving the
 * run-scoped gate downstream intact as defence in depth.
 *
 * Each sibling's role comes from `fanOutRole` when the caller has it (a fan-out
 * sibling carries its role there and has no `agent_id` at all), falling back to
 * the run row. Returns null when every sibling allows — including when none of
 * them has a record, which is the pre-B2 fail-open and stays that way.
 */
export async function loadCohortGateRefusal(
  siblings: readonly { id: string; fanOutRole: string | null }[],
  tenantId: string,
  from: TicketStatus,
): Promise<{ code: "verification_failed" | "empty_delivery"; reason: string } | null> {
  const decisions = await Promise.all(
    siblings.map(async (s) => {
      const [verification, fallbackRole] = await Promise.all([
        loadRunVerification(s.id, tenantId),
        s.fanOutRole ? Promise.resolve(s.fanOutRole) : loadRunRole(s.id, tenantId),
      ]);
      return decideQaGate({
        enabled: true,
        from,
        to: "in_review",
        verification,
        codeProducing: isCodeProducingRole(s.fanOutRole ?? fallbackRole),
      });
    }),
  );
  const refusal = pickCohortRefusal(decisions);
  return refusal ? { code: refusal.code, reason: refusal.reason } : null;
}

/**
 * B2 — the dispatched role for `runId`, for the gate's code-producing question.
 *
 * Resolved HERE rather than threaded through `TransitionInput` on purpose. Every
 * `→ in_review` caller already passes `runId`; making them each also pass a role
 * would add four places to forget one, and the aggregator and the reconciler do
 * not straightforwardly have it. The run row does, so the single seam reads it
 * itself and no caller can omit it.
 *
 * `COALESCE(runs.fan_out_role, agents.role)` is the established attribution rule
 * (AGENTS.md): a fan-out sibling carries its role in `fan_out_role` and has no
 * `agent_id` at all, so reading the agent alone would mis-resolve every fan-out
 * run to null and silently disable the empty-delivery check for the whole cohort.
 *
 * The `agents` embed is FK-HINTED (`agents!agent_id`). `runs` and `agents` have
 * one FK today, but a bare embed is exactly the shape that starts returning
 * PGRST201 the moment a second one is added in either direction — the failure
 * mode that rendered the Run Inspector as a blank 404 (see AGENTS.md).
 *
 * Never throws: any failure degrades to null, which the gate reads as
 * "not code-producing" — i.e. the permissive pre-B2 behaviour. A DB hiccup must
 * not refuse a hand-off.
 */
export async function loadRunRole(runId: string, tenantId: string): Promise<string | null> {
  try {
    const supabase = supabaseService();
    const { data, error } = await supabase
      .from("runs")
      .select("fan_out_role, agents!agent_id ( role )")
      .eq("id", runId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) {
      console.error(`[qa-gate] role load failed for run=${runId}:`, error);
      return null;
    }
    if (!data) return null;
    const fanOut = (data as { fan_out_role?: string | null }).fan_out_role ?? null;
    if (fanOut) return fanOut;
    // PostgREST returns a to-one embed as an object; older shapes hand back a
    // single-element array. Accept both rather than depending on which.
    const agent = (data as { agents?: { role?: string | null } | { role?: string | null }[] })
      .agents;
    const agentRow = Array.isArray(agent) ? agent[0] : agent;
    return agentRow?.role ?? null;
  } catch (err) {
    console.error(`[qa-gate] role load failed for run=${runId}:`, err);
    return null;
  }
}
