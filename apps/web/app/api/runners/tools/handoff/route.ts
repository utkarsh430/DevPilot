// POST /api/runners/tools/handoff
//
// The write half of WI-6. An MCP-backed board tool (`devpilot_handoff`) the local
// Claude Code runner invokes to append a handoff note about the ticket it is
// working on: what it BUILT, what it DECIDED, what it ASSUMED, or what
// INTERFACE it exposed. Dependent tickets (the ones whose blocking-relation
// ancestors include this one) get those notes injected into their dispatch
// prompt — see `lib/roles/context.ts` — which is the only way a sibling
// dispatched in the same drain window can learn anything about this work before
// it lands on the integration branch.
//
// Modelled on `../comment/route.ts` (same auth gate, same role relay), with two
// deliberate differences:
//
//   • It resolves `project_id` as well as `tenant_id` from the ticket, and
//     REFUSES a project-less ticket (400): handoffs are read per project, so an
//     entry with no project could never be read back — storing it would be a
//     silent black hole.
//   • It enforces a per-entry body cap (HANDOFF_BODY_MAX_CHARS, 400 on
//     overflow). The comment route only checks non-empty; inheriting that hole
//     here would let one agent's runaway note eat the whole context budget of
//     every dependent ticket's prompt. Rejecting at WRITE time is the honest
//     place for it — truncating at read time would silently swallow half a note
//     with no way for the author to know.
//
// Writes are plain INSERTs (append-only, no read-modify-write), so concurrent
// agents on different tickets — or the same ticket across retries — can never
// clobber each other. Staleness is resolved at READ time by taking the latest
// entry per (ticket, kind).
//
// Auth: `x-devpilot-runner-key`, validated by `checkRunnerAuth` — same gate as the
// other runner-tool routes.
//
// Request body:  { ticketId, kind, body, role?, runId?, runnerId? }
// Response 200:  { handoffId: string }
// Response 400:  { error } — missing/invalid fields, oversized body, no project
// Response 401:  { error } — bad runner key
// Response 404:  { error } — ticket not found
// Response 500:  { error } — DB write failed

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { HANDOFF_BODY_MAX_CHARS, HANDOFF_KINDS, isHandoffKind } from "@/lib/roles/handoff";

export const dynamic = "force-dynamic";

type HandoffRequestBody = {
  ticketId?: string;
  kind?: string;
  body?: string;
  /** Role slug for the calling agent, relayed by the runner via DEVPILOT_ROLE. */
  role?: string;
  /** The authoring run, relayed via DEVPILOT_RUN_ID. Optional — a smoke test has none. */
  runId?: string;
  runnerId?: string;
};

/** Same shape gate the comment route uses, so a typo in the relay env can't
 *  leak as a fake author. Slugs are lowercase ascii + underscores, 1–64 chars. */
const ROLE_SLUG_RE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const payload = (await request.json().catch(() => null)) as HandoffRequestBody | null;
  if (!payload?.ticketId || typeof payload.ticketId !== "string") {
    return NextResponse.json({ error: "ticketId required" }, { status: 400 });
  }
  if (!isHandoffKind(payload.kind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${HANDOFF_KINDS.join(", ")}` },
      { status: 400 },
    );
  }
  if (typeof payload.body !== "string" || payload.body.trim().length === 0) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  // The token ceiling. Measured on the raw string (what actually costs context),
  // not the trimmed one.
  if (payload.body.length > HANDOFF_BODY_MAX_CHARS) {
    return NextResponse.json(
      {
        error:
          `body exceeds ${HANDOFF_BODY_MAX_CHARS} characters (got ${payload.body.length}). ` +
          `A handoff note is a summary for the next agent, not a transcript — post one entry ` +
          `per point (built / decision / assumption / interface) and keep each concise.`,
      },
      { status: 400 },
    );
  }

  const supabase = supabaseService();

  // Resolve tenant AND project from the ticket — never from the request. The
  // runner-key gate is the trust boundary, but the *scope* of the write is the
  // ticket's, so a compromised or buggy relay cannot cross-write another tenant.
  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .select("id, tenant_id, project_id")
    .eq("id", payload.ticketId)
    .single();
  if (ticketErr || !ticket) {
    return NextResponse.json({ error: "ticket not found" }, { status: 404 });
  }
  if (!ticket.project_id) {
    return NextResponse.json(
      { error: "ticket has no project; handoff notes are project-scoped" },
      { status: 400 },
    );
  }

  const role =
    typeof payload.role === "string" && ROLE_SLUG_RE.test(payload.role) ? payload.role : "claude";
  // A malformed run id would fail the FK and 500 the whole tool call; the note
  // is worth more than the provenance, so drop it to null instead.
  const runId =
    typeof payload.runId === "string" && UUID_RE.test(payload.runId) ? payload.runId : null;

  const { data: inserted, error: insertErr } = await supabase
    .from("project_handoffs")
    .insert({
      tenant_id: ticket.tenant_id,
      project_id: ticket.project_id,
      ticket_id: ticket.id,
      run_id: runId,
      role,
      kind: payload.kind,
      body: payload.body,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  return NextResponse.json({ handoffId: inserted.id });
}
