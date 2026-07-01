// POST /api/runners/tools/move-ticket
//
// One of the three MCP-backed board tools. Applies a state-machine transition
// to a ticket on the runner's behalf. Always stamps a `system`-authored audit
// comment in the same call (the runner's reason when supplied, a default body
// otherwise) so QA REJECT/APPROVE leaves an audit trail without the runner
// needing two round-trips — and so the ticket-reconciler/sweeper has a
// durable signal that the agent rendered an explicit verdict. Phase 1 / M1 Wave 2:
// infrastructure only; wave 3 retires the `applyRolePostProcess` heuristic
// and lets QA call this directly.
//
// Auth: `x-devpilot-runner-key` header — same gate as `/api/runners/register`.
//
// Request body:  { ticketId: string, status: TicketStatus, reason?: string,
//                  role?: string, runnerId?: string, runId?: string }
// Response 200:  { ticketId: string, status: TicketStatus, retryCount: number }
// Response 400:  { error } — missing/invalid fields, unknown status string
// Response 401:  { error } — bad runner key
// Response 404:  { error } — ticket not found
// Response 422:  { error } — invalid state-machine transition (assertTransition threw)
// Response 422:  { error, code } — L1 QA hand-off gate refused (see below)
// Response 500:  { error } — other DB error
//
// L1 QA hand-off gate (`ENGINEER_QA_GATE_ENABLED`, default OFF)
// ────────────────────────────────────────────────────────────
// This is the LIVE tool path (a role calling `devpilot_move_ticket(in_review)`
// mid-run). The gate itself lives in `transitionTicket` (keyed on
// `actor:"agent"`); it reads THIS run's verification via the `runId` the MCP
// relay forwards. On refusal `transitionTicket` mutates nothing and returns a
// `gateRefusal`; because the run is still alive, we return 422 with a fenced
// reason so the agent fixes it and retries IN SESSION — strictly better than
// parking. The engine producer-completion paths (engineer postprocess,
// reconciler, aggregator) park to blocked instead, since their run is dead.
//
// curl example:
//   curl -X POST http://localhost:3000/api/runners/tools/move-ticket \
//     -H 'Content-Type: application/json' \
//     -H "x-devpilot-runner-key: $DEVPILOT_RUNNER_REGISTRATION_KEY" \
//     -d '{"ticketId":"<uuid>","status":"in_review","reason":"Implemented + tests pass."}'

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { ALLOWED_TRANSITIONS, type TicketStatus } from "@/lib/board/state";
import { transitionTicket, addComment } from "@/lib/board/transitions";
import { QA_GATE_CEILING_AUTHOR } from "@/lib/board/gate-retry";
import { sendEventBounded } from "@/lib/engine/send-bounded";

export const dynamic = "force-dynamic";

const KNOWN_STATUSES = Object.keys(ALLOWED_TRANSITIONS) as TicketStatus[];

type MoveBody = {
  ticketId?: string;
  status?: string;
  reason?: string;
  /** Role slug of the calling run, stamped by the MCP relay from `DEVPILOT_ROLE`. */
  role?: string;
  runnerId?: string;
  /** Run id of the calling run, forwarded by the MCP relay from `DEVPILOT_RUN_ID`,
   *  so the L1 gate reads exactly this run's verification. */
  runId?: string;
};

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const body = (await request.json().catch(() => null)) as MoveBody | null;
  if (!body?.ticketId || typeof body.ticketId !== "string") {
    return NextResponse.json({ error: "ticketId required" }, { status: 400 });
  }
  if (!body.status || typeof body.status !== "string") {
    return NextResponse.json({ error: "status required" }, { status: 400 });
  }
  if (!KNOWN_STATUSES.includes(body.status as TicketStatus)) {
    return NextResponse.json(
      { error: `unknown status '${body.status}' — allowed: ${KNOWN_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = supabaseService();

  // Lookup tenant + current retry count so we can return the post-transition
  // value and pass tenantId to `transitionTicket` (which needs it to emit the
  // dispatch event).
  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .select("id, tenant_id, status, retry_count")
    .eq("id", body.ticketId)
    .single();
  if (ticketErr || !ticket) {
    return NextResponse.json({ error: "ticket not found" }, { status: 404 });
  }

  const newStatus = body.status as TicketStatus;

  // Same-state move is a no-op success. The FSM (state.ts) rejects from===to
  // unconditionally, but agents sometimes terminate with a move to the state
  // the ticket is already in — typically because a sibling/parallel role
  // advanced it first (over-dispatch). Refusing here turns a clean no-op into
  // a hard run failure that burns LLM spend and stalls the ticket. We
  // short-circuit instead, still recording the reason comment if supplied.
  //
  // BUT we must still nudge the dispatcher: a real-world case (cb860274) hit
  // this branch when QA second-pass-rejected a ticket already in `in_progress`
  // (the prior engineer crashed mid-run without transitioning). Without
  // re-emitting `ticket/dispatch-needed` the ticket sat indefinitely with no
  // follow-up run despite QA's explicit reject signal. Match transitionTicket's
  // emit policy — skip only terminal / pause / input_required states.
  if (ticket.status === newStatus) {
    // ALWAYS stamp the devpilot_move_ticket system comment here, even without a
    // reason: it is the durable signal the ticket-reconciler uses to detect
    // that the agent rendered an explicit (no-op) verdict. A same-state move
    // changes neither status nor updated_at, so without this comment the
    // reconciler would see "run completed, ticket untouched" and second-guess
    // the verdict.
    try {
      await addComment({
        ticketId: ticket.id,
        tenantId: ticket.tenant_id,
        authorType: "system",
        authorId: "devpilot_move_ticket",
        body:
          body.reason && body.reason.trim().length > 0
            ? body.reason
            : `Confirmed ticket status '${newStatus}' (no-op move, no reason supplied).`,
      });
    } catch (err) {
      console.error("[devpilot_move_ticket] reason comment failed (no-op move):", err);
    }
    const shouldRedispatch =
      newStatus !== "done" &&
      newStatus !== "failed" &&
      newStatus !== "input_required" &&
      newStatus !== "paused";
    if (shouldRedispatch) {
      try {
        await sendEventBounded({
          name: "ticket/dispatch-needed",
          data: { ticketId: ticket.id, tenantId: ticket.tenant_id },
        });
      } catch (err) {
        console.error("[devpilot_move_ticket] dispatch re-emit failed (no-op move):", err);
      }
    }
    return NextResponse.json({
      ticketId: ticket.id,
      status: newStatus,
      retryCount: ticket.retry_count ?? 0,
      noop: true,
    });
  }

  // QA reject convention: in_review → in_progress always bumps retry_count.
  // Other transitions leave it alone. This matches `applyRolePostProcess` so
  // wave 3's swap-over is behavior-preserving.
  const isQaReject = ticket.status === "in_review" && newStatus === "in_progress";

  try {
    const result = await transitionTicket({
      ticketId: ticket.id,
      tenantId: ticket.tenant_id,
      to: newStatus,
      // Live agent tool call — the gated actor. runId run-scopes the gate.
      actor: "agent",
      runId: typeof body.runId === "string" ? body.runId : undefined,
      retryDelta: isQaReject ? 1 : undefined,
    });
    // B2 — the gate has now refused this ticket its full budget. Retrying is
    // futile in exactly the way a safety refusal is: another 422 invites another
    // lap the producer has already failed DEVPILOT_QA_GATE_MAX_RETRIES times. So
    // this takes the PARK path, not the retry path — same shape as the safety
    // gate below, under its own author so a ceiling park is greppable apart from
    // the per-refusal `devpilot_qa_gate` explanations.
    if (result.gateRefusal?.code === "gate_retry_exhausted") {
      try {
        await addComment({
          ticketId: ticket.id,
          tenantId: ticket.tenant_id,
          authorType: "system",
          authorId: QA_GATE_CEILING_AUTHOR,
          body: result.gateRefusal.reason,
        });
      } catch (err) {
        console.error("[devpilot_move_ticket] qa-gate ceiling comment failed:", err);
      }
      try {
        await transitionTicket({
          ticketId: ticket.id,
          tenantId: ticket.tenant_id,
          to: "blocked",
          actor: "system",
          emitDispatch: false,
          expectedFrom: ticket.status as TicketStatus,
        });
      } catch (err) {
        console.error("[devpilot_move_ticket] qa-gate ceiling park failed:", err);
      }
      // 200, not 422: the agent must STOP, not retry. Mirrors the safety park.
      return NextResponse.json({
        ticketId: ticket.id,
        status: "blocked",
        parked: true,
        code: result.gateRefusal.code,
        note: result.gateRefusal.reason,
      });
    }
    if (result.gateRefusal?.code === "safety_approval_required") {
      // SME safety gate: this run tried to complete a safety-critical ticket.
      // Unlike the L1 gate, retrying is FUTILE — no non-human can ever approve
      // it — so we PARK to `blocked` pending a human board approval instead of
      // handing back a 422 the agent would loop on. The park mirrors the L1
      // dead-run recovery (in_review/in_progress → blocked is a legal edge, and
      // `blocked` is outside the reconciler's RECONCILABLE_STATUSES and the
      // sweeper's scan, so this fully exits both loops). The reason goes under a
      // distinct `devpilot_safety_gate` author — NEVER `devpilot_move_ticket`, which the
      // reconciler reads as "the role rendered its verdict, leave it alone".
      try {
        await addComment({
          ticketId: ticket.id,
          tenantId: ticket.tenant_id,
          authorType: "system",
          authorId: "devpilot_safety_gate",
          body: result.gateRefusal.reason,
        });
      } catch (err) {
        console.error("[devpilot_move_ticket] safety-gate refusal comment failed:", err);
      }
      try {
        await transitionTicket({
          ticketId: ticket.id,
          tenantId: ticket.tenant_id,
          to: "blocked",
          // Engine-authored park; the producer run is over, so don't nudge the
          // dispatcher at a parked ticket. CAS-guard on the status we read so a
          // concurrent move is a clean no-op rather than a clobber.
          actor: "system",
          emitDispatch: false,
          expectedFrom: ticket.status as TicketStatus,
        });
      } catch (err) {
        console.error("[devpilot_move_ticket] safety-gate park-to-blocked failed:", err);
      }
      // 200 (not 422): the verdict was accepted, the ticket is simply awaiting
      // human safety sign-off. The agent should STOP, not retry.
      return NextResponse.json({
        ticketId: ticket.id,
        status: "blocked",
        parked: true,
        requiresHumanApproval: true,
        code: result.gateRefusal.code,
        note: result.gateRefusal.reason,
      });
    }
    if (result.gateRefusal) {
      // L1 QA gate (`verification_failed`). Audit the refusal under its OWN
      // author (`devpilot_qa_gate`), never `devpilot_move_ticket`: the reconciler reads an
      // `devpilot_move_ticket` comment after run start as "the role rendered its
      // verdict, leave it alone". A refused move is the opposite — the ticket is
      // still the producer's to finish — so mislabelling it would strand exactly
      // what the gate blocks.
      try {
        await addComment({
          ticketId: ticket.id,
          tenantId: ticket.tenant_id,
          authorType: "system",
          authorId: "devpilot_qa_gate",
          body: result.gateRefusal.reason,
        });
      } catch (err) {
        console.error("[devpilot_move_ticket] qa-gate refusal comment failed:", err);
      }
      // 422 to the live tool so the agent sees it and retries in-session. NO
      // park — the run is alive; a live retry beats parking every time.
      return NextResponse.json(
        { error: result.gateRefusal.reason, code: result.gateRefusal.code },
        { status: 422 },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // `transitionTicket` throws on invalid state-machine moves — surface as 422.
    if (msg.startsWith("invalid ticket transition")) {
      return NextResponse.json({ error: msg }, { status: 422 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // ALWAYS stamp the devpilot_move_ticket system comment, reason or not: it is the
  // durable signal the ticket-reconciler/sweeper uses to see that the agent
  // rendered an explicit verdict (the sweep path has no run-start status
  // snapshot to compare against).
  try {
    await addComment({
      ticketId: ticket.id,
      tenantId: ticket.tenant_id,
      authorType: "system",
      authorId: "devpilot_move_ticket",
      body:
        body.reason && body.reason.trim().length > 0
          ? body.reason
          : `Moved ticket '${ticket.status}' → '${newStatus}' (no reason supplied).`,
    });
  } catch (err) {
    // The transition already committed — log but don't 500 on a follow-up
    // audit comment failure; the run shouldn't get stuck because of it.
    console.error("[devpilot_move_ticket] reason comment failed:", err);
  }

  return NextResponse.json({
    ticketId: ticket.id,
    status: newStatus,
    retryCount: (ticket.retry_count ?? 0) + (isQaReject ? 1 : 0),
  });
}
