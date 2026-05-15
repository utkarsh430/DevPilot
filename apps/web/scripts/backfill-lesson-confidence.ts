// One-time (re-runnable) confidence grading of a tenant's ALREADY-QUEUED
// candidate lessons — the reason this feature exists. The operator had ~40
// candidates queued with no way to tell the obviously-good ones from the few
// needing a real decision; go-forward grading only helps lessons extracted after
// it ships, so this grades the existing queue.
//
// Idempotent: it drives the SAME `gradeStoredLesson` the go-forward path grades
// with, and skips any row that already carries a confidence. Re-running costs
// nothing and grades nothing twice. `--regrade` deliberately overrides that (for
// a rubric change), and is the ONLY way to overwrite an existing grade.
//
// Fail-open, per row: a model failure/timeout leaves that row UNGRADED and the
// scan moves on. It never writes a placeholder grade — "not yet graded" (NULL)
// and "graded low" are different facts, and an ungraded lesson never
// auto-approves.
//
// Scoped per tenant, service-role with the tenant PRE-VALIDATED here (there is no
// session on the CLI). --dry-run grades but writes nothing, and prints each grade
// so the rubric can be eyeballed against real lessons before any write.
//
// ── server-only note ──
// Like backfill-agent-learnings.ts (and UNLIKE backfill-agent-mistakes.ts), this
// script legitimately needs the LLM, and the LLM layer
// (lib/llm/generate.server.ts) is `server-only` by construction. So it is run
// WITH the react-server condition. That is not the PR-1 accidental-server-only
// bug: this script inherently needs a server-only capability.
//
// Usage:
//   pnpm --filter @devpilot/web tsx --conditions=react-server --env-file=.env.local \
//     scripts/backfill-lesson-confidence.ts --tenant <tenant-uuid> [--dry-run] [--regrade]

import { backfillTenantConfidence, defaultConfidenceDeps } from "@/lib/learning/confidence.server";

function parseArgs(argv: string[]): { tenantId: string | null; dryRun: boolean; regrade: boolean } {
  let tenantId: string | null = null;
  let dryRun = false;
  let regrade = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant" || a === "-t") tenantId = argv[++i] ?? null;
    else if (a?.startsWith("--tenant=")) tenantId = a.slice("--tenant=".length);
    else if (a === "--dry-run" || a === "--dry") dryRun = true;
    else if (a === "--regrade") regrade = true;
  }
  return { tenantId, dryRun, regrade };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const { tenantId, dryRun, regrade } = parseArgs(process.argv.slice(2));
  if (!tenantId || !UUID_RE.test(tenantId)) {
    console.error(
      "usage: tsx --conditions=react-server --env-file=.env.local " +
        "scripts/backfill-lesson-confidence.ts --tenant <uuid> [--dry-run] [--regrade]",
    );
    process.exit(2);
  }

  console.log(
    `[backfill-lesson-confidence] tenant=${tenantId}` +
      `${dryRun ? " (DRY RUN — no writes)" : ""}${regrade ? " (REGRADE — overwrites existing grades)" : ""}`,
  );

  const started = Date.now();
  const counts: Record<string, number> = { high: 0, medium: 0, low: 0 };
  const result = await backfillTenantConfidence(defaultConfidenceDeps(tenantId), {
    tenantId,
    dryRun,
    regrade,
    onProgress: (scanned, total, r) => {
      if (r.ok && r.status === "graded") {
        counts[r.grade.confidence] = (counts[r.grade.confidence] ?? 0) + 1;
        console.log(`  [${scanned}/${total}] ${r.grade.confidence.padEnd(6)} — ${r.grade.reason}`);
      } else if (!r.ok) {
        console.log(`  [${scanned}/${total}] FAILED — ${r.reason}`);
      } else {
        console.log(`  [${scanned}/${total}] skipped (${r.reason})`);
      }
    },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(
    `[backfill-lesson-confidence] done in ${secs}s — ` +
      `candidates scanned: ${result.scanned}, ` +
      `${dryRun ? "would be graded" : "graded"}: ${result.graded} ` +
      `(high ${counts.high}, medium ${counts.medium}, low ${counts.low}), ` +
      `skipped (already graded / not graded): ${result.skipped}, ` +
      `failures: ${result.failures}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-lesson-confidence] fatal:", err);
  process.exit(1);
});
