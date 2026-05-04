// One-time (re-runnable) backfill of `agent_learnings` from a tenant's already
// recorded `agent_mistakes` — so the lesson queue is seeded with candidates
// extracted from the captain's real mistake history (the 84 prod rows PR 1
// backfilled), not only from mistakes recorded after this ships.
//
// Idempotent: it drives the SAME `extractMistakeLesson` the go-forward Inngest
// step uses. Per mistake it (1) skips if a lesson already points at it
// (`source_mistake_id`), and (2) body-dedupes a fresh draft against existing
// active + candidate lessons in the same (scope, role). Re-running — or running
// after the go-forward path already drafted some — inserts nothing new.
//
// Scoped per tenant, service-role with the tenant PRE-VALIDATED here (there is no
// session on the CLI). firstmate runs this against real prod data as the live
// check; --dry-run drafts + dedupes but writes nothing.
//
// ── server-only note (distinct from backfill-agent-mistakes.ts) ──
// This script legitimately needs the LLM, and the LLM layer
// (lib/llm/generate.server.ts) is `server-only` by construction (it reaches the
// tenant-scoped model factory / platform secrets). So — UNLIKE the mistakes
// backfill, whose server-only import was an accident PR 2 removed — this one is
// run WITH the react-server condition. That is not the PR-1 bug: the mistakes
// script has no reason to touch server-only code, this one inherently does.
//
// Usage:
//   pnpm --filter @devpilot/web tsx --conditions=react-server --env-file=.env.local \
//     scripts/backfill-agent-learnings.ts --tenant <tenant-uuid> [--dry-run]

import { backfillTenantLessons, defaultExtractDeps } from "@/lib/learning/extract.server";

function parseArgs(argv: string[]): { tenantId: string | null; dryRun: boolean } {
  let tenantId: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant" || a === "-t") tenantId = argv[++i] ?? null;
    else if (a?.startsWith("--tenant=")) tenantId = a.slice("--tenant=".length);
    else if (a === "--dry-run" || a === "--dry") dryRun = true;
  }
  return { tenantId, dryRun };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const { tenantId, dryRun } = parseArgs(process.argv.slice(2));
  if (!tenantId || !UUID_RE.test(tenantId)) {
    console.error(
      "usage: tsx --conditions=react-server --env-file=.env.local " +
        "scripts/backfill-agent-learnings.ts --tenant <uuid> [--dry-run]",
    );
    process.exit(2);
  }

  console.log(
    `[backfill-agent-learnings] tenant=${tenantId}${dryRun ? " (DRY RUN — no writes)" : ""}`,
  );

  const started = Date.now();
  const result = await backfillTenantLessons(defaultExtractDeps(tenantId), {
    tenantId,
    dryRun,
    onProgress: (scanned, total) => {
      if (scanned % 10 === 0 || scanned === total) {
        console.log(`  … ${scanned}/${total} mistakes scanned`);
      }
    },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(
    `[backfill-agent-learnings] done in ${secs}s — ` +
      `mistakes scanned: ${result.mistakesScanned}, ` +
      `candidate lessons ${dryRun ? "that WOULD be recorded" : "recorded"}: ${result.lessonsInserted}, ` +
      `skipped (dup / already-extracted / no-draft): ${result.skipped}, ` +
      `failures: ${result.failures}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-agent-learnings] fatal:", err);
  process.exit(1);
});
