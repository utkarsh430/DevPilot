// Production wiring for the console transcript's injected deps.
//
// The ONLY file on the transcript path that touches a `server-only` module -
// `console-history.ts` and `console-history-store.ts` are both marker-free and
// therefore loadable under Vitest, which is where every rule about this
// transcript is asserted.
//
// Service-role, because the table denies every JWT write: the transcript is the
// provenance of a commanded fix, and a browser-writable one would let a client
// forge the message an action is attributed to (and, worse, delete the record of
// what was asked before a sweep). The tenant boundary is therefore entirely the
// co-located `.eq("tenant_id", …)` in the store.

import "server-only";

import { supabaseService } from "@/lib/db/server";
import type { ConsoleHistoryDeps } from "@/lib/supervisor/console-history-store";

export function defaultConsoleHistoryDeps(): ConsoleHistoryDeps {
  return { db: supabaseService() };
}
