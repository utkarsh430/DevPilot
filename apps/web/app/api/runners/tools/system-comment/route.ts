// POST /api/runners/tools/system-comment
//
// Slice C — runner posts a `system`-authored comment on a ticket.
//
// Today the only caller is `apps/runner/src/workspace.ts` when it
// auto-stashes operator edits before the `git reset --hard HEAD && git
// clean -fdx` path. The breadcrumb tells the operator how to recover
// (`git stash apply`) and is the only signal a UI viewer has that
// anything in their workspace was stashed.
//
// Auth: `x-devpilot-runner-key` header — same gate as the other runner routes.
//
// Request body:  { ticketId: string, body: string }
// Response 200:  { ok: true }
// Response 400:  { error } — missing/invalid fields
// Response 401:  { error } — bad runner key
// Response 404:  { error } — ticket not found
// Response 500:  { error } — DB write failed

import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { addComment } from "@/lib/board/transitions";

export const dynamic = "force-dynamic";

type Body = {
  ticketId?: string;
  body?: string;
};

const MAX_BODY = 4_000;

export async function POST(request: Request) {
  const auth = checkRunnerAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 401 });

  const payload = (await request.json().catch(() => null)) as Body | null;
  if (!payload?.ticketId || typeof payload.ticketId !== "string") {
    return NextResponse.json({ error: "ticketId required" }, { status: 400 });
  }
  if (!payload.body || typeof payload.body !== "string" || payload.body.trim().length === 0) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  const truncated =
    payload.body.length > MAX_BODY
      ? `${payload.body.slice(0, MAX_BODY)}…(truncated)`
      : payload.body;

  const supabase = supabaseService();
  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .select("id, tenant_id")
    .eq("id", payload.ticketId)
    .maybeSingle();
  if (ticketErr || !ticket) {
    return NextResponse.json({ error: "ticket not found" }, { status: 404 });
  }

  try {
    await addComment({
      ticketId: ticket.id,
      tenantId: ticket.tenant_id,
      authorType: "system",
      authorId: "devpilot_runner",
      body: truncated,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
