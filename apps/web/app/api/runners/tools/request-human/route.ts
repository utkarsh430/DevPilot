// POST /api/runners/tools/request-human
//
// One of the three MCP-backed board tools. Lets the runner park a ticket in
// `input_required` with a question for a human, in a single atomic-ish call.
// The companion run-side block (waitForEvent on `human-reply`) is wave 3 —
// this wave 2 just lays the rail so claude-code's MCP tool surface is
// callable.
//
// We intentionally keep this as a single combined endpoint (comment + move)
// rather than asking the LLM to chain two tool calls. Rationale:
//   - Atomicity in the LLM's eyes: one tool call = one outcome.
//   - The two-step version was already racy in the postprocess heuristic
//     (comment could land but transition fail, leaving a confused ticket).
//   - Wave 3 will plug the `waitForEvent('human-reply', ticketId)` correlation
//     on the run side; this endpoint emits the same shape regardless.
//
// Auth: `x-devpilot-runner-key` header — same gate as `/api/runners/register`.
//
// Request body:  { ticketId: string, question: string, runnerId?: string }
// Response 200:  { commentId: string }
// Response 400:  { error } - missing/invalid fields, INCLUDING a question that is
//                absent, empty, or too short to be answerable. See
//                `lib/board/human-request-question.ts` for what that means and why
//                it is a refusal rather than a default: this endpoint parks the
//                ticket in the one state whose only exit is a human reply, so an
//                unanswerable ask stops the work instead of delaying it.
// Response 401:  { error } — bad runner key
// Response 404:  { error } — ticket not found
// Response 422:  { error } — current state can't transition to input_required
// Response 500:  { error } — DB write failed
//
// curl example:
//   curl -X POST http://localhost:3000/api/runners/tools/request-human \
//     -H 'Content-Type: application/json' \
//     -H "x-devpilot-runner-key: $DEVPILOT_RUNNER_REGISTRATION_KEY" \
//     -d '{"ticketId":"<uuid>","question":"Which auth provider should I wire?"}'

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { addComment, transitionTicket } from "@/lib/board/transitions";
import {
  describeEscalationBreadcrumb,
  normalizeHumanRequest,
} from "@/lib/board/human-request-question";

export const dynamic = "force-dynamic";

type RequestHumanBody = {
  ticketId?: string;
  question?: string;
  runnerId?: string;
  /** Post-F5 — role slug stamped on the question comment + system breadcrumb
   *  so the dispatcher's state machine + the F2 classifier see the real role
   *  identity. Optional; falls back to "claude" when absent. */
  role?: string;
};

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const body = (await request.json().catch(() => null)) as RequestHumanBody | null;
  // What counts as an answerable escalation lives in `human-request-question.ts`,
  // not here: this file cannot load under Vitest (it reaches `supabaseService`),
  // and validation that nothing can test is exactly the gap the empty-escalation
  // defect lived in. The refusal text it returns is the documentation for this
  // route - it is what the agent reads, and often the only text about this route
  // an operator ever sees - so it is passed through verbatim.
  const norm = normalizeHumanRequest({
    ticketId: body?.ticketId,
    question: body?.question,
    authorId: body?.role,
  });
  if (!norm.ok) {
    return NextResponse.json({ error: norm.error }, { status: 400 });
  }
  const { question, authorId } = norm;

  const supabase = supabaseService();
  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .select("id, tenant_id")
    .eq("id", norm.ticketId)
    .single();
  if (ticketErr || !ticket) {
    return NextResponse.json({ error: "ticket not found" }, { status: 404 });
  }

  // Comment first, then transition: if the transition is invalid (422) the
  // question still lands on the ticket — the operator sees what the agent
  // tried to ask. This is the same ordering `transitionTicket` uses for its
  // audit trail throughout the codebase.
  let commentId: string;
  try {
    const { data: inserted, error: insertErr } = await supabase
      .from("comments")
      .insert({
        ticket_id: ticket.id,
        tenant_id: ticket.tenant_id,
        author_type: "agent",
        author_id: authorId,
        body: question,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
    }
    commentId = inserted.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  try {
    await transitionTicket({
      ticketId: ticket.id,
      tenantId: ticket.tenant_id,
      to: "input_required",
      // Agent tool asking for human input mid-run — not a `→ in_review`, ungated.
      actor: "agent",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("invalid ticket transition")) {
      return NextResponse.json({ error: msg, commentId }, { status: 422 });
    }
    return NextResponse.json({ error: msg, commentId }, { status: 500 });
  }

  // Drop a system breadcrumb so the timeline shows *why* the ticket parked -
  // and, since 2026-08-04, WHAT was asked. It used to be the fixed literal
  // "Agent requested human input.", which is what three stranded tickets on
  // project `scoursh` left on the board. The excerpt is fenced inside
  // `describeEscalationBreadcrumb`: it is agent-authored text landing in a
  // `system`-authored comment, which reads as DevPilot speaking.
  // Non-fatal if it fails (e.g. RLS hiccup).
  try {
    await addComment({
      ticketId: ticket.id,
      tenantId: ticket.tenant_id,
      authorType: "system",
      authorId: "devpilot_request_human",
      body: describeEscalationBreadcrumb(question),
    });
  } catch (err) {
    console.error("[devpilot_request_human] system breadcrumb failed:", err);
  }

  return NextResponse.json({ commentId });
}
