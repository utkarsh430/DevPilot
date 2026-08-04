// Server wiring for the harvester: the real service client + role resolver.
//
// The DI'd orchestration (harvestTicketMistakes / backfillTenantMistakes) lives in
// `harvest-batch.ts` so it is unit-testable with a fake client — the same split
// ticket-audit.ts / ticket-audit.server.ts uses. This file is the `server-only`
// twin the go-forward Inngest hook imports.
//
// The deps BUILDER itself (`buildHarvestDeps`, re-exported here as
// `defaultHarvestDeps`) lives in `harvest-deps.ts` WITHOUT a server-only marker,
// so the backfill CLI can run under a plain `pnpm tsx`. See that file for the PR 1
// follow-up fix this split resolves: importing the builder from a server-only
// module made the documented `pnpm tsx` invocation throw at import time.

import "server-only";

/** Production deps: the service client + the role resolver (from the
 *  server-only-free `harvest-deps.ts`, so the CLI can import it directly). */
export { buildHarvestDeps as defaultHarvestDeps } from "@/lib/learning/harvest-deps";

export {
  harvestTicketMistakes,
  backfillTenantMistakes,
  type HarvestDeps,
  type HarvestResult,
  type BackfillResult,
} from "@/lib/learning/harvest-batch";
