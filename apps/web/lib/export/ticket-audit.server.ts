import "server-only";

// The IO half of the ticket audit aggregation: supplies the REAL dependencies to
// the DI'd `loadTicketAuditBatch` in `ticket-audit.ts`.
//
// Same shape as `lib/projects/doc-extract.server.ts` — the wrapper owns the
// server-only imports (the service client, the image fetcher, the env), so the
// aggregation logic itself stays Vitest-loadable and its N+1 property is a test
// rather than a promise.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseService } from "@/lib/db/server";
import { resolveAttachmentImages } from "@/lib/export/images.server";
import { loadTicketAuditBatch, type AuditDeps } from "@/lib/export/ticket-audit";
import type { TicketAuditExport } from "@/lib/export/types";

function langfuseConfig(): AuditDeps["langfuse"] {
  return {
    baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://us.cloud.langfuse.com",
    // Empty → `langfuseTraceUrl` returns null → the document hides the link
    // rather than printing a URL that 404s.
    projectId: process.env.LANGFUSE_PROJECT_ID ?? "",
  };
}

/**
 * Build the real dependency set.
 *
 * `db` is the client tenant data is read with — RLS-bound `supabaseServer()` for
 * the ticket route, service-role for the background project job (which has no
 * session). `tenantId` is REQUIRED and is what actually scopes the aggregation:
 * it is applied explicitly to every read that could return a foreign row, so the
 * boundary does not depend on which client got passed. Callers must derive it
 * from a row they have already authorised, never from a request parameter.
 */
export function ticketAuditDeps(db: SupabaseClient, tenantId: string): AuditDeps {
  return {
    db,
    tenantId,
    service: supabaseService() as unknown as SupabaseClient,
    resolveImages: resolveAttachmentImages,
    langfuse: langfuseConfig(),
  };
}

/** Batch audit bundle. Constant query count regardless of `ids.length`. */
export async function loadTicketAuditBatchServer(
  db: SupabaseClient,
  tenantId: string,
  ids: readonly string[],
): Promise<TicketAuditExport[]> {
  return loadTicketAuditBatch(ticketAuditDeps(db, tenantId), ids);
}

/** Single-ticket export. Literally the batch of one — same primitives, same bounds. */
export async function loadTicketAuditExport(
  db: SupabaseClient,
  tenantId: string,
  id: string,
): Promise<TicketAuditExport | null> {
  const [only] = await loadTicketAuditBatchServer(db, tenantId, [id]);
  return only ?? null;
}
