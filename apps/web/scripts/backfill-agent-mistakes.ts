// One-time (re-runnable) backfill of `agent_mistakes` from a tenant's existing
// run / verification / ticket / comment history — so the mistake record is
// populated with the captain's real agent history from day one, not only new
// events after this ships.
//
// Idempotent: it drives the SAME `harvestTicketMistakes` the go-forward Inngest
// hook uses, which derives every row's `dedupe_key` deterministically and upserts
// with `ignoreDuplicates`. Re-running it — or running it after the go-forward
// path has already recorded some rows — records nothing new.
//
// Scoped per tenant, service-role with the tenant PRE-VALIDATED here (there is no
// session on the CLI): pass the exact tenant uuid, and every read + the upsert is
// tenant-filtered (see harvest-batch.ts). firstmate runs this against real prod
// data as the live check; --dry-run previews the counts without writing.
//
// Usage:
//   pnpm --filter @devpilot/web tsx --env-file=.env.local \
//     scripts/backfill-agent-mistakes.ts --tenant <tenant-uuid> [--dry-run]
//
// Imports NOTHING `server-only`: the batch logic comes from the pure DI'd
// `harvest-batch.ts` and the deps from `harvest-deps.ts` (both marker-free), so
// this runs under a plain `pnpm tsx` exactly as the usage line documents — NOT
// `NODE_OPTIONS='--conditions=react-server'`. PR 1 imported these from the
// server-only `harvest.server.ts`, which threw at import time; that is fixed.

import { backfillTenantMistakes } from "@/lib/learning/harvest-batch";
import { buildHarvestDeps } from "@/lib/learning/harvest-deps";

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
      "usage: tsx --env-file=.env.local scripts/backfill-agent-mistakes.ts --tenant <uuid> [--dry-run]",
    );
    process.exit(2);
  }

  console.log(
    `[backfill-agent-mistakes] tenant=${tenantId}${dryRun ? " (DRY RUN — no writes)" : ""}`,
  );

  const started = Date.now();
  const result = await backfillTenantMistakes(buildHarvestDeps(), {
    tenantId,
    dryRun,
    onProgress: (scanned, total) => {
      if (scanned % 25 === 0 || scanned === total) {
        console.log(`  … ${scanned}/${total} tickets scanned`);
      }
    },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(
    `[backfill-agent-mistakes] done in ${secs}s — ` +
      `tickets scanned: ${result.ticketsScanned}, ` +
      `tickets with mistakes: ${result.ticketsWithMistakes}, ` +
      `mistakes ${dryRun ? "that WOULD be recorded" : "recorded"}: ${result.mistakesInserted}, ` +
      `ticket failures: ${result.failures}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-agent-mistakes] fatal:", err);
  process.exit(1);
});
