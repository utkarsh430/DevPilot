// POST /api/runners/tools/comment
//
// One of the three MCP-backed board tools that the local Claude Code runner
// invokes via `claude -p --mcp-config apps/runner/src/mcp/mcp-config.example.json`.
// Inserts an `agent`-authored comment on a ticket. Phase 1 / M1 Wave 2:
// infrastructure only; wave 3 will update role system prompts to actually
// call this tool instead of relying on the postprocess heuristic.
//
// Auth: `x-devpilot-runner-key` header, validated by `checkRunnerAuth` against
// `DEVPILOT_RUNNER_REGISTRATION_KEY` — the same gate as `/api/runners/register`.
//
// Request body:  { ticketId: string, body: string, runnerId?: string }
// Response 200:  { commentId: string }
// Response 400:  { error } — missing/invalid fields
// Response 401:  { error } — bad runner key
// Response 404:  { error } — ticket not found
// Response 500:  { error } — DB write failed
//
// curl example:
//   curl -X POST http://localhost:3000/api/runners/tools/comment \
//     -H 'Content-Type: application/json' \
//     -H "x-devpilot-runner-key: $DEVPILOT_RUNNER_REGISTRATION_KEY" \
//     -d '{"ticketId":"<uuid>","body":"Working on it.","runnerId":"<uuid>"}'

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";

export const dynamic = "force-dynamic";

type CommentBody = {
  ticketId?: string;
  body?: string;
  runnerId?: string;
  /** Post-F5 — the role slug for the calling agent (engineer/qa/verifier/…).
   *  Replaces the legacy hardcoded "claude" author_id. Injected by the
   *  runner via DEVPILOT_ROLE → MCP relay → here. Optional for backwards compat
   *  with smoke tests; falls back to "claude" when absent. */
  role?: string;
};

// Conservative shape gate so a typo in the env / payload doesn't leak as a
// fake author_id. Slugs are lowercase ascii + underscores, 1–64 chars.
const ROLE_SLUG_RE = /^[a-z][a-z0-9_]{0,63}$/;

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const body = (await request.json().catch(() => null)) as CommentBody | null;
  if (!body?.ticketId || typeof body.ticketId !== "string") {
    return NextResponse.json({ error: "ticketId required" }, { status: 400 });
  }
  if (!body.body || typeof body.body !== "string" || body.body.trim().length === 0) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }

  const supabase = supabaseService();

  // Look up tenant_id from the ticket — RLS-bypassing service client, but the
  // runner-key gate is the trust boundary for Phase 0/1.
  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .select("id, tenant_id")
    .eq("id", body.ticketId)
    .single();
  if (ticketErr || !ticket) {
    return NextResponse.json({ error: "ticket not found" }, { status: 404 });
  }

  // Post-F5 — author_id is the actual role slug when the runner provided it
  // (engineer/qa/verifier/…). The dispatcher's state-machine fallback
  // (decideNextRole's `agentAuthors.includes("engineer")` check) relies on
  // this; the legacy "claude" hardcode silently broke it.
  const authorId =
    typeof body.role === "string" && ROLE_SLUG_RE.test(body.role) ? body.role : "claude";
  const { data: inserted, error: insertErr } = await supabase
    .from("comments")
    .insert({
      ticket_id: ticket.id,
      tenant_id: ticket.tenant_id,
      author_type: "agent",
      author_id: authorId,
      body: body.body,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  return NextResponse.json({ commentId: inserted.id });
}
