// Side-effects each role does after its agent run produces text.
// Called from the durable runAgent's "role-post" step.
//
// Asymmetry note (M1 Wave 3): QA drives its own ticket transition via the
// MCP `devpilot_move_ticket` tool — by the time we get here, the ticket is already
// in `done` (approve) or `in_progress` (reject), and `retry_count` has been
// incremented by the engine's move-ticket route. PM and Engineer transitions
// are still postprocess-driven until their wave-3-future MCP graduation.
//
// Phase 1 / M7 — branch-signal seam. Any role whose RoleConfig declares a
// `branches` map runs its final text through `parseBranchSignal`. The parsed
// key (or null) is persisted onto `runs.branch_key` so the dispatcher's
// next-role decision can read it back. We persist BEFORE the transition so
// a dispatch-needed event fired by the transition observes the branch key.

import { addComment, transitionTicket, BlockedByDependencyError } from "@/lib/board/transitions";
import { canTransition, type TicketStatus } from "@/lib/board/state";
import { fenceUntrustedOutput } from "@/lib/board/qa-gate";
import { supabaseService } from "@/lib/db/server";
import { inngest } from "@/lib/engine/inngest";
import { getBuiltinRoleConfig } from "@/lib/roles/load";
import { parseBranchSignal } from "@/lib/roles/branch-signal";
import { qaRole } from "@/lib/roles/qa";
import type { Role } from "@/lib/roles/types";

export type PostProcessInput = {
  /**
   * The role slug — built-in (pm | engineer | qa | …) or a custom M5 slug.
   * Widened from `Role` to `string` so custom roles synthesized from a JD
   * (per `docs/DEVPILOT_PHASE1_PLAN.md` §M5) fall through to the tool-driven
   * default branch.
   */
  role: Role | string;
  ticketId: string;
  tenantId: string;
  agentDisplayName: string;
  finalText: string;
  /**
   * Phase 1 / M7 — the run id whose final-text we're postprocessing. Used to
   * stamp `runs.branch_key` for roles that declare a `branches` map. Optional
   * for backwards compat with any legacy caller; the branch-key write is a
   * no-op when missing.
   */
  runId?: string;
};

export async function applyRolePostProcess(input: PostProcessInput): Promise<{
  next: "dispatch" | "done" | "failed";
  detail?: string;
}> {
  // Phase 1 / M7 — branch-signal capture. If the just-run role declares a
  // `branches` map, parse its final text for the `next: <key>` token and
  // persist it onto `runs.branch_key`. We do this BEFORE the role-specific
  // branch so the value is durable even if the role-specific handler throws.
  //
  // The branch-key is the only piece of data the dispatcher needs from the
  // role's text output — everything else (ticket transition, comment trail)
  // is already on the ticket / comments tables via the MCP tool-driven path.
  await persistBranchKeyIfApplicable(input);

  switch (input.role) {
    case "pm":
      return applyPmPost(input);
    case "engineer":
      return applyEngineerPost(input);
    case "qa":
      return applyQaPost(input);
    // M4 — tool-driven built-in roles. Each role's system prompt mandates
    // calling `devpilot_move_ticket` to advance, so postprocess only mirrors the
    // assistant summary into a comment (matching the QA pattern). No
    // transition fired here — the ticket's landing state lives on the row
    // already.
    case "devops":
    case "techwriter":
    case "designer":
    case "dataeng":
    case "tech_lead":
      return applyToolDrivenPost(input);
    // M7 — Triage emits a branch signal instead of moving the ticket. We
    // mirror the rationale to a comment, leave the ticket where it is, and
    // fire a single `ticket/dispatch-needed` so the dispatcher picks the
    // next role using the branches map.
    case "triage":
      return applyTriagePost(input);
    // M5 — custom roles from a JD follow the same tool-driven contract.
    // The synthesizer always emits a system prompt that mandates an
    // `devpilot_move_ticket` call, so postprocess behaves identically to the
    // built-in tool-driven roles.
    default:
      return applyToolDrivenPost(input);
  }
}

/**
 * Phase 1 / M7 — persist the parsed branch key onto `runs.branch_key` when
 * the just-run role declares a `branches` map. No-op for roles without
 * branches OR when the role's text didn't carry a valid `next:` token.
 *
 * The dispatcher reads this column to decide the next role; null falls
 * through to the state machine (graceful degradation on a missing/garbage
 * signal — the spec's "missing or invalid branch key falls through" rule).
 */
async function persistBranchKeyIfApplicable(input: PostProcessInput): Promise<void> {
  if (!input.runId) return;
  // Only built-in roles declare `branches` today. Custom roles (M5) could in
  // the future via `agents.config.role_config.branches`, but we leave that
  // for a follow-up — getBuiltinRoleConfig returns null for custom slugs and
  // we no-op rather than guessing.
  const config = getBuiltinRoleConfig(String(input.role));
  if (!config?.branches) return;
  const branchKey = parseBranchSignal(input.finalText);
  if (!branchKey) {
    // Parse failure / role didn't emit a signal — log via run_steps so the
    // inspector shows the dispatcher had no signal to act on. We DON'T fail
    // the run: the spec says missing keys fall through to the state machine.
    console.warn(
      `[role-post] role=${input.role} run=${input.runId} declared branches but no valid \`next:\` signal in final text — dispatcher will fall back to state machine`,
    );
    return;
  }
  // Validate the parsed key against the role's declared branches map. A key
  // not in the map is treated as no-signal — same fall-through semantics as
  // a parse failure (spec: "missing or invalid branch key falls through").
  if (!(branchKey in config.branches)) {
    console.warn(
      `[role-post] role=${input.role} run=${input.runId} emitted unknown branch key "${branchKey}" — not in branches map [${Object.keys(config.branches).join(",")}]; falling back to state machine`,
    );
    return;
  }
  const supabase = supabaseService();
  const { error } = await supabase
    .from("runs")
    .update({ branch_key: branchKey, last_event_at: new Date().toISOString() })
    .eq("id", input.runId);
  if (error) {
    console.error(
      `[role-post] failed to persist branch_key=${branchKey} on run=${input.runId}: ${error.message}`,
    );
    return;
  }
}

async function applyTriagePost(input: PostProcessInput) {
  // Mirror the assistant's rationale (full text, branch signal and all) into
  // a durable comment so reviewers see the call.
  const summary = input.finalText.trim();
  // G4 — stamp the role slug (lowercase, e.g. "triage") instead of the
  // capitalized displayName so the dispatcher's state-machine fallback and
  // the F2 classifier transcript see a single canonical author_id across
  // both the MCP tool path and this postprocess path.
  await addComment({
    ticketId: input.ticketId,
    tenantId: input.tenantId,
    authorType: "agent",
    authorId: String(input.role) || input.agentDisplayName || "agent",
    body: summary.length > 0 ? `[Triage] ${summary}` : "[Triage] (no rationale provided)",
  });
  // Triage does not transition the ticket — the dispatcher reads the branch
  // key off the run row and routes to the next role. Fire one dispatch event
  // to wake the dispatcher.
  await inngest.send({
    name: "ticket/dispatch-needed",
    data: { ticketId: input.ticketId, tenantId: input.tenantId },
  });
  return { next: "dispatch" as const };
}

async function applyPmPost(input: PostProcessInput) {
  // G4 — stamp the role slug (lowercase, e.g. "pm") instead of the capitalized
  // displayName so the MCP tool path and this postprocess path agree on a
  // single canonical author_id (dispatcher state-machine fallback + F2
  // classifier transcript both key off the slug).
  await addComment({
    ticketId: input.ticketId,
    tenantId: input.tenantId,
    authorType: "agent",
    authorId: String(input.role) || input.agentDisplayName || "agent",
    body: input.finalText,
  });
  // Refresh the canonical description + acceptance_criteria from the PM's draft
  // so the Engineer reads them cleanly off the ticket row.
  const fields = parsePmRefinement(input.finalText);
  // PM hard-codes this `→ ready` transition (it is not tool-driven). It is an
  // IDEMPOTENT FALLBACK: `expectedFrom: "in_progress"` scopes the move to the
  // one case where postprocess still owns it — the agent left the ticket in its
  // pre-transition state (`in_progress`) without moving it itself. If the agent
  // ALREADY advanced the ticket via `devpilot_move_ticket` during its run (so it
  // now sits at `ready` or beyond), `transitionTicket` short-circuits on the
  // `expectedFrom` mismatch and returns `{ transitioned: false }` — no
  // `assertTransition` throw, so NO spurious park to `blocked` (the #80 double-
  // move regression). We treat that as a silent no-op: the agent already did the
  // move, postprocess has nothing to do.
  //
  // The GENUINE block is preserved. When the ticket IS still `in_progress` but a
  // dependency is unlanded, `expectedFrom` passes and the `→ ready` dependency
  // guard throws `BlockedByDependencyError` — a legitimate human signal — which
  // we catch and park to `blocked` exactly as before. (`assertTransition` can no
  // longer throw here: `in_progress → ready` is always legal, and any other
  // state short-circuits on `expectedFrom` above.) Any OTHER throw (infra/DB) is
  // re-raised to the run-agent role-post net.
  try {
    await transitionTicket({
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      to: "ready",
      // PM lands its work in `ready`, not `in_review` — ungated regardless.
      actor: "agent",
      // Idempotency guard: only advance a ticket the agent left in its
      // pre-transition state; skip silently when the agent already moved it.
      expectedFrom: "in_progress",
      description: fields.description ?? undefined,
      acceptanceCriteria: fields.acceptance ?? undefined,
      clearAssignee: true,
    });
  } catch (err) {
    if (isParkableTransitionError(err)) {
      await parkToBlockedOnPostError(input, "ready", err);
      return { next: "done" as const };
    }
    throw err;
  }
  return { next: "dispatch" as const };
}

async function applyEngineerPost(input: PostProcessInput) {
  // G4 — stamp the role slug (lowercase, e.g. "engineer") instead of the
  // capitalized displayName so the MCP tool path and this postprocess path
  // agree on a single canonical author_id (dispatcher state-machine fallback
  // + F2 classifier transcript both key off the slug).
  await addComment({
    ticketId: input.ticketId,
    tenantId: input.tenantId,
    authorType: "agent",
    authorId: String(input.role) || input.agentDisplayName || "agent",
    body: input.finalText,
  });
  // L1 — THE primary gated path. The engineer auto-advances here through the
  // engine seam. So this is the one place the audit's dominant lever (a
  // failing-test hand-off) is actually caught. The gate lives inside
  // transitionTicket; we act on its refusal.
  //
  // IDEMPOTENT FALLBACK. `expectedFrom: "in_progress"` scopes the advance to the
  // one case postprocess still owns — the agent left the ticket in its
  // pre-transition state without moving it. In practice the engineer agent often
  // ALREADY moves the ticket to `in_review` via `devpilot_move_ticket` during its
  // run, and this postprocess then attempted the SAME `→ in_review` move again — a
  // redundant double-move that `assertTransition` rejects (`in_review → in_review`
  // is illegal), which the #80 hardening caught and parked to `blocked`, surfacing
  // a spurious operator-visible block. With `expectedFrom`, a ticket the agent
  // already moved (now at `in_review` or beyond) short-circuits to
  // `{ transitioned: false }` — no throw, no park — and we treat it as a silent
  // no-op: the agent already did the move.
  //
  // Two failure channels still handled: (a) a typed `gateRefusal` (L1/SME gate)
  // below — reachable only when the ticket IS still `in_progress`, so the gate
  // still fires on the genuine hand-off; and (b) a THROW, now defensive only —
  // `assertTransition` can no longer fire (`in_progress → in_review` is always
  // legal; every other state short-circuits on `expectedFrom`), but any parkable
  // throw is still caught and parked exactly like PM. Non-FSM throws re-raise to
  // the role-post net.
  let result: Awaited<ReturnType<typeof transitionTicket>>;
  try {
    result = await transitionTicket({
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      to: "in_review",
      actor: "agent",
      // Run-scope the gate to THIS run's verification.
      runId: input.runId,
      // Idempotency guard: only advance a ticket the agent left in its
      // pre-transition state; skip silently when the agent already moved it.
      expectedFrom: "in_progress",
      clearAssignee: true,
    });
  } catch (err) {
    if (isParkableTransitionError(err)) {
      await parkToBlockedOnPostError(input, "in_review", err);
      return { next: "done" as const };
    }
    throw err;
  }
  if (result.gateRefusal) {
    // Recovery for a DEAD run (the agent step has ended): park the ticket to
    // `blocked` and leave a fenced explanation. `blocked` is reversible,
    // sweeper-stable and reconciler-stable (an operator, or the deferred
    // auto-re-dispatch, unblocks it), so a flaky check can never terminally
    // kill a ticket unattended. NO auto-re-dispatch in v1.
    await parkToBlockedOnGateRefusal(input, result.gateRefusal.reason);
    return { next: "done" as const };
  }
  return { next: "dispatch" as const };
}

/**
 * Shared refusal recovery for the engine producer-completion paths: post the
 * fenced refusal under the distinct `devpilot_qa_gate` author (never `devpilot_move_ticket`
 * — the reconciler reads that as "the role rendered its verdict, leave it
 * alone", and a refusal is the opposite), then park to `blocked` with the
 * dispatch suppressed. Best-effort throughout: a comment or park failure is
 * logged, never thrown, so the run can still finish cleanly.
 */
async function parkToBlockedOnGateRefusal(input: PostProcessInput, reason: string): Promise<void> {
  try {
    await addComment({
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      authorType: "system",
      authorId: "devpilot_qa_gate",
      body: reason,
    });
  } catch (err) {
    console.error(`[role-post] qa-gate refusal comment failed for ticket=${input.ticketId}:`, err);
  }
  try {
    await transitionTicket({
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      to: "blocked",
      actor: "system",
      // The producer run is over; don't nudge the dispatcher at a parked ticket.
      emitDispatch: false,
    });
  } catch (err) {
    console.error(`[role-post] park-to-blocked failed for ticket=${input.ticketId}:`, err);
  }
}

/**
 * True for the two throws PM/Engineer's hard-coded postprocess transitions
 * raise that are a TICKET-STATE problem, not an infrastructure fault:
 *   • `BlockedByDependencyError` — a `→ ready` move while a dependency is still
 *     unlanded (transitions.ts).
 *   • an `assertTransition` failure — an illegal FSM edge, e.g. `→ ready` from
 *     `in_review`/`blocked` or `→ in_review` from a non-`in_progress` state
 *     (state.ts message: `invalid ticket transition: …`).
 * Everything else (ticket-not-found, a Postgres error) is infrastructure and is
 * re-raised so the run-agent role-post net logs it and reconcile/sweeper recover
 * — parking to `blocked` on a transient DB blip would be wrong.
 */
function isParkableTransitionError(err: unknown): boolean {
  if (err instanceof BlockedByDependencyError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith("invalid ticket transition:");
}

/**
 * Recovery when a role's hard-coded postprocess transition THROWS (see
 * `isParkableTransitionError`). Mirrors `parkToBlockedOnGateRefusal`: post a
 * fenced system comment naming the stall, then park the ticket to `blocked`
 * (reversible, sweeper- and reconciler-stable — `decideTicketReconciliation`
 * treats `blocked` as parked) so a human resolves it, rather than letting the
 * throw fail the whole run. Authored under `devpilot_role_post`, deliberately
 * NOT `devpilot_move_ticket` (the reconciler reads that author as a rendered
 * verdict). Best-effort throughout — a comment/park failure is logged, never
 * thrown, so the run still finishes cleanly.
 *
 * The park is only attempted when `→ blocked` is a legal edge from where the
 * ticket sits now (`in_progress`/`in_review`). If it is already `blocked` the
 * comment alone is the whole recovery; from a state with no `→ blocked` edge
 * (`input_required`/`paused`/terminal) we leave it in place — the comment still
 * surfaces the stall — rather than throw a second time.
 */
async function parkToBlockedOnPostError(
  input: PostProcessInput,
  attemptedTo: TicketStatus,
  err: unknown,
): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  const body =
    `Postprocess could not advance this ticket to \`${attemptedTo}\`; ` +
    `parking to \`blocked\` for a human to resolve.` +
    fenceUntrustedOutput("postprocess transition error", detail);
  try {
    await addComment({
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      authorType: "system",
      authorId: "devpilot_role_post",
      body,
    });
  } catch (e) {
    console.error(`[role-post] park comment failed for ticket=${input.ticketId}:`, e);
  }
  try {
    const supabase = supabaseService();
    const { data } = await supabase
      .from("tickets")
      .select("status")
      .eq("id", input.ticketId)
      .single();
    const current = data?.status as TicketStatus | undefined;
    if (current && current !== "blocked" && canTransition(current, "blocked")) {
      await transitionTicket({
        ticketId: input.ticketId,
        tenantId: input.tenantId,
        to: "blocked",
        actor: "system",
        // The producer run is over; don't nudge the dispatcher at a parked ticket.
        emitDispatch: false,
      });
    }
  } catch (e) {
    console.error(`[role-post] park-to-blocked failed for ticket=${input.ticketId}:`, e);
  }
}

async function applyQaPost(input: PostProcessInput) {
  // QA already moved the ticket and (typically) wrote a reasoning comment via
  // the MCP `devpilot_move_ticket` + `devpilot_comment` tools during the agent step. We
  // do NOT fire another transition here; the engine route already updated
  // status + retry_count. We do still mirror any non-empty assistant summary
  // text into the comment trail so reviewers see the agent's voice on the
  // ticket in addition to any tool-driven comments.
  const summary = input.finalText.trim();
  // G4 — stamp the role slug (lowercase, e.g. "qa") instead of the
  // capitalized displayName so the MCP tool path and this postprocess path
  // agree on a single canonical author_id (dispatcher state-machine fallback
  // + F2 classifier transcript both key off the slug).
  const slugAuthor = String(input.role) || input.agentDisplayName || "agent";
  if (summary.length > 0) {
    await addComment({
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      authorType: "agent",
      authorId: slugAuthor,
      body: `[QA] ${summary}`,
    });
  } else {
    await addComment({
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      authorType: "agent",
      authorId: slugAuthor,
      body: "[QA] moved via tool",
    });
  }
  // Return "done" unconditionally — the actual landing state lives on the
  // ticket row (set by devpilot_move_ticket). The dispatcher will pick the next
  // role on its own scan if appropriate, so we don't emit "dispatch" here.
  return { next: "done" as const };
}

/** Generic tool-driven postprocess shared by QA and the four M4 roles. The
 *  role's MCP tool calls have already moved the ticket; we just write a
 *  summary comment so the agent's voice shows up alongside the tool audit
 *  trail. */
async function applyToolDrivenPost(input: PostProcessInput) {
  const summary = input.finalText.trim();
  // G4 — stamp the role slug (lowercase, e.g. "devops"/"techwriter") instead
  // of the capitalized displayName so the MCP tool path and this postprocess
  // path agree on a single canonical author_id (dispatcher state-machine
  // fallback + F2 classifier transcript both key off the slug). The visible
  // [Tag] in the comment body still uses the displayName for human-friendly
  // rendering — only the structured author_id field switches to the slug.
  const tag = `[${input.agentDisplayName}]`;
  await addComment({
    ticketId: input.ticketId,
    tenantId: input.tenantId,
    authorType: "agent",
    authorId: String(input.role) || input.agentDisplayName || "agent",
    body: summary.length > 0 ? `${tag} ${summary}` : `${tag} moved via tool`,
  });
  return { next: "done" as const };
}

// Best-effort: pull "Description:" and "Acceptance Criteria:" blocks out of the
// PM's free-form output. Phase 0 — good enough for the demo; full structured
// output (e.g. JSON schema or tool-call) is a Phase 1 polish item. [[pm-output-parser]]
function parsePmRefinement(text: string): {
  description?: string;
  acceptance?: string;
} {
  const desc = text.match(
    /Description:\s*([^\n]+(?:\n(?!(?:Acceptance Criteria:|Title:))[^\n]+)*)/i,
  );
  const ac = text.match(/Acceptance Criteria:\s*((?:\n?[-*•][^\n]+)+)/i);
  return {
    description: desc?.[1]?.trim(),
    acceptance: ac?.[1]?.trim(),
  };
}

export { qaRole };
