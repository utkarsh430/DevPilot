// Reconcile a tenant's ALREADY-QUEUED candidate lessons against its ACTIVE ones.
//
// The candidates queued today were extracted BEFORE the semantic dedup stage
// existed, so some of them restate a lesson that is already active and already
// being fed to every run. Go-forward dedup cannot help them — nothing re-examines
// a row once it is queued.
//
// DRY RUN BY DEFAULT, and that is the point. This proposes rejections of the
// operator's own review backlog, which is precisely the judgement the queue exists
// to collect from a human. With no flags it prints every proposed pair — the
// queued body, the active body it restates, and the similarity that paired them —
// and writes NOTHING. `--apply` is a separate, deliberate second run. There is no
// hook, no cron, and nothing invokes this automatically.
//
// The matcher is the deterministic Jaccard `bodySimilarity` (no LLM), so the
// preview and the apply step act on the SAME list and re-running reproduces the
// same numbers. `--threshold` exists to eyeball the list at a stricter or looser
// line before committing; the default is the extractor's own 0.5.
//
// Usage:
//   pnpm --filter @devpilot/web tsx --env-file=.env.local \
//     scripts/reconcile-learning-queue.ts --tenant <tenant-uuid> [--apply] [--threshold 0.5]
//
// Imports NOTHING `server-only` — `lib/learning/reconcile.ts` is DI'd and
// `supabaseService()` is marker-free — so it runs under a plain `pnpm tsx` exactly
// as the usage line documents (see the PR-1 note in backfill-agent-mistakes.ts).

import { supabaseService } from "@/lib/db/server";
import { DEDUPE_SIMILARITY_THRESHOLD } from "@/lib/learning/extract";
import { reconcileTenantQueue } from "@/lib/learning/reconcile";

function parseArgs(argv: string[]): { tenantId: string | null; apply: boolean; threshold: number } {
  let tenantId: string | null = null;
  let apply = false;
  let threshold = DEDUPE_SIMILARITY_THRESHOLD;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant" || a === "-t") tenantId = argv[++i] ?? null;
    else if (a?.startsWith("--tenant=")) tenantId = a.slice("--tenant=".length);
    else if (a === "--apply") apply = true;
    else if (a === "--threshold") threshold = Number(argv[++i]);
    else if (a?.startsWith("--threshold=")) threshold = Number(a.slice("--threshold=".length));
  }
  return { tenantId, apply, threshold };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function truncate(s: string, n = 150): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function main() {
  const { tenantId, apply, threshold } = parseArgs(process.argv.slice(2));
  if (!tenantId || !UUID_RE.test(tenantId)) {
    console.error(
      "usage: tsx --env-file=.env.local scripts/reconcile-learning-queue.ts " +
        "--tenant <uuid> [--apply] [--threshold 0.5]",
    );
    process.exit(2);
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error(`[reconcile-learning-queue] --threshold must be in (0, 1]; got ${threshold}`);
    process.exit(2);
  }

  console.log(
    `[reconcile-learning-queue] tenant=${tenantId} threshold=${threshold} ` +
      `${apply ? "APPLY (will reject the matches below)" : "DRY RUN (writes nothing)"}`,
  );

  const result = await reconcileTenantQueue(supabaseService(), { tenantId, apply, threshold });

  console.log(
    `\nScanned ${result.candidatesScanned} queued candidate(s) against ` +
      `${result.activeCompared} active lesson(s).`,
  );
  if (result.matches.length === 0) {
    console.log("No candidate restates an active lesson. Nothing to do.");
    process.exit(0);
  }

  console.log(`\n${result.matches.length} candidate(s) restate an active lesson:\n`);
  result.matches.forEach((m, i) => {
    const scope = m.roleSlug ? `${m.scope}/${m.roleSlug}` : m.scope;
    console.log(`${i + 1}. [${scope}] similarity ${m.similarity.toFixed(2)}`);
    console.log(`   queued: ${truncate(m.candidateBody)}`);
    console.log(`   active: ${truncate(m.activeBody)}\n`);
  });

  if (!apply) {
    console.log(
      `Dry run — nothing was written. Re-run with --apply to reject these ` +
        `${result.matches.length} candidate(s).`,
    );
  } else {
    console.log(`Rejected ${result.rejected} candidate(s).`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[reconcile-learning-queue] fatal:", err);
  process.exit(1);
});
