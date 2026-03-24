// Phase 2.5++ — Runner → engine env-catalog report for dev-server sessions.
//
// POST /api/runners/dev-servers/[sessionId]/env-catalog
//
// When the runner starts a localhost dev server it parses the workspace's
// `.env.example` (`.sample`/`.template`) into the set of env keys the project
// DECLARES — each classified required/optional with a short description pulled
// from the comment above the key. It reports that catalog here ONCE per start.
//
// We persist it onto the owning project (`projects.env_catalog`) so the
// project Secrets card can render every declared key — configured or not —
// with the right Required/Optional label + description, without the web server
// needing access to the workspace files (only the runner has those).
//
//   • Bad runner key    → 401
//   • Body fails Zod     → 400
//   • Session not found  → 404 (runner held a stale sessionId)
//   • DB error           → 500
//
// Best-effort from the runner's perspective: a failure here never blocks the
// dev server itself — the catalog is a convenience surface.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { supabaseService } from "@/lib/db/server";
import { checkRunnerAuth } from "@/lib/runners/auth";
import { getSessionById } from "@/lib/dev-servers/load";

export const dynamic = "force-dynamic";

const Body = z.object({
  catalog: z
    .array(
      z.object({
        // Conventional .env naming — same gate as project_secrets.secret_key.
        key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
        required: z.boolean(),
        description: z.string().max(500).nullable().optional(),
      }),
    )
    .max(200),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  // ── 1. Auth ────────────────────────────────────────────────────────────
  const auth = checkRunnerAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401 });
  }

  // ── 2. Params + body ──────────────────────────────────────────────────
  const { sessionId } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // ── 3. Resolve the session → project ──────────────────────────────────
  const session = await getSessionById(sessionId).catch(() => null);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  // Normalize: drop the optional `description` into an explicit null so the
  // stored shape is stable for the reader.
  const catalog = parsed.data.catalog.map((e) => ({
    key: e.key,
    required: e.required,
    description: e.description ?? null,
  }));

  // ── 4. Persist onto the project ───────────────────────────────────────
  const supabase = supabaseService();
  const { error } = await supabase
    .from("projects")
    .update({ env_catalog: catalog, env_catalog_at: new Date().toISOString() })
    .eq("id", session.projectId);
  if (error) {
    return NextResponse.json({ error: `update failed: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, count: catalog.length });
}
