// Phase 1 / M12 — "candidate gold set" capture endpoint.
//
// Purpose: a debug-only sink for failed-run signals that an operator may
// later triage into the real gold set under `tests/evals/<role>.eval.yaml`.
//
// Why a debug endpoint instead of an Inngest cross-cut?
//   • M12's spec calls this the lowest-cost first cut. A handler-side
//     cross-cut would touch `lib/engine/run-agent.ts` / `supervision.ts`,
//     both of which are explicitly out-of-bounds for M12.
//   • A debug endpoint makes the signal SOURCE explicit (operator script,
//     manual curl, future Langfuse webhook) and keeps the failure path
//     untouched.
//   • The file is gitignored and never read by the eval runner — auto-
//     promotion is intentionally NOT a feature. See
//     `tests/evals/README.md` §"Candidate gold set pipeline" for the
//     manual triage flow.
//
// Hard gating:
//   • Returns 404 unless `DEVPILOT_DEBUG_EVAL_CANDIDATES=1`. No NODE_ENV check
//     because we want the operator to be able to enable it temporarily on
//     a staging Vercel preview without a code change.
//   • In a hosted environment with no writable filesystem (Vercel), the
//     write will fail with EROFS — the endpoint returns 503 and the
//     operator gets a clean signal that they need to run this locally.

import { NextResponse } from "next/server";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const runtime = "nodejs";

const CandidateSchema = z.object({
  role: z.string().min(1).max(64),
  ticketId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  finalText: z.string().max(64_000),
  expected: z.string().max(8_000).optional(),
  observed: z.string().max(8_000).optional(),
  notes: z.string().max(2_000).optional(),
});

// `tests/evals/candidates.jsonl` lives at the repo root, NOT inside
// apps/web. We resolve from the cwd via a known relative anchor so this
// route works under both `pnpm dev` (cwd=apps/web) and a CLI invocation.
function candidatesPath(): string {
  // From apps/web/app/api/debug/eval-candidate/route.ts back up to repo
  // root is six levels. process.cwd() during `pnpm dev` is apps/web — go
  // up two levels from there.
  const cwd = process.cwd();
  // Heuristic: if cwd ends with apps/web, we're in dev; otherwise assume
  // cwd is repo root.
  const repoRoot = cwd.endsWith("/apps/web") ? resolve(cwd, "..", "..") : cwd;
  return resolve(repoRoot, "tests/evals/candidates.jsonl");
}

export async function POST(req: Request) {
  if (process.env.DEVPILOT_DEBUG_EVAL_CANDIDATES !== "1") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let parsed;
  try {
    const body = await req.json();
    parsed = CandidateSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: "invalid body", detail: String(err) }, { status: 400 });
  }

  const record = {
    captured_at: new Date().toISOString(),
    ...parsed,
  };

  const path = candidatesPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    return NextResponse.json(
      {
        error: "could not write candidates.jsonl",
        detail: String(err),
        path,
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    appended_to: path,
    dry_run: true,
    note: "Operator triages tests/evals/candidates.jsonl manually; see tests/evals/README.md.",
  });
}

export async function GET() {
  // Health probe. Returns 404 when disabled so it's indistinguishable
  // from a non-existent route.
  if (process.env.DEVPILOT_DEBUG_EVAL_CANDIDATES !== "1") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    enabled: true,
    path: candidatesPath(),
    note: "POST to append a candidate record (DRY-RUN — file is never auto-promoted).",
  });
}
