// POST /api/runners/tools/request-secret
//
// Slice A — structured secret-request variant of `request-human`.
//
// What it does
// ────────────
// The agent's MCP relay calls this when it needs one or more env vars to
// proceed (e.g. `pnpm dev` failed because DATABASE_URL is missing).
//
// ── This route is now an AUTH WRAPPER, not the implementation ──────────────
// The body it used to hold — write one `secret_request` comment, park the ticket
// in `input_required`, post the breadcrumb — lives in
// `lib/board/request-secrets.ts` so the engine can raise the same request
// without going through a runner-key-authenticated HTTP endpoint. PR 3's Vercel
// env push is the first such caller. Extracting it is what keeps there being ONE
// way DevPilot asks a human for a secret: one comment shape, one resume signal,
// one `SecretRequestCard`.
//
// The operator-facing half is unchanged. The TicketDrawer looks for
// `metadata.kind === 'secret_request'` and renders masked inputs; submitting
// writes each value through `setProjectSecretAction` and posts a human comment,
// and that comment is what transitions the ticket back to `in_progress` and
// fires the dispatch.
//
// Auth: `x-devpilot-runner-key` header — same gate as other runner routes.
//
// Request body:  { ticketId, keys: string[], rationale, role?, runnerId? }
// Response 200:  { commentId }
// Response 400:  { error } — missing/invalid fields
// Response 401:  { error } — bad runner key
// Response 404:  { error } — ticket not found
// Response 422:  { error, commentId } — current state can't transition to input_required
// Response 500:  { error } — DB write failed

import { NextResponse } from "next/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { requestSecrets } from "@/lib/board/request-secrets";

export const dynamic = "force-dynamic";

type RequestSecretBody = {
  ticketId?: string;
  keys?: unknown;
  rationale?: string;
  runnerId?: string;
  /** Post-F5 — role slug. Falls back to "claude" when absent. */
  role?: string;
};

/** Result code → HTTP status. Kept as a table so the route's contract is
 *  readable in one place and the shared core stays transport-agnostic. */
const STATUS: Record<"invalid" | "not_found" | "bad_state" | "failed", number> = {
  invalid: 400,
  not_found: 404,
  bad_state: 422,
  failed: 500,
};

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const body = (await request.json().catch(() => null)) as RequestSecretBody | null;
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });

  const result = await requestSecrets({
    ticketId: body.ticketId ?? "",
    keys: Array.isArray(body.keys) ? (body.keys as string[]) : [],
    rationale: body.rationale ?? "",
    authorId: body.role,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.commentId ? { commentId: result.commentId } : {}) },
      { status: STATUS[result.code] },
    );
  }
  return NextResponse.json({ commentId: result.commentId });
}
