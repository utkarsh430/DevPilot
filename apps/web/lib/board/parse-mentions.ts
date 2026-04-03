// Detect ticket mentions in free text (descriptions, acceptance criteria,
// comments) and idempotently materialise them as `related` rows in
// `ticket_dependencies`.
//
// Format: `#abcdef12` — 8 hex characters matching the leading prefix of a
// ticket UUID. Operators already see `id.slice(0, 6)` on cards and `id.slice(0, 8)`
// in the drawer header; we accept either 6, 7, or 8 leading hex chars and
// resolve them to a full ticket id by prefix-search within the same tenant.
//
// Why "related" specifically: it's the safest default in Linear's model
// (informational, no workflow gates). Operators can re-classify in the
// drawer's Relations panel if they want blocked-by / duplicate semantics.

import type { SupabaseClient } from "@supabase/supabase-js";

const MENTION_RE = /#([0-9a-f]{6,8})\b/gi;

export type LinkMentionsInput = {
  /** Service-role Supabase client — caller has already established the
   *  tenant via auth gates and we want to write across tickets without
   *  re-fighting RLS for this idempotent join-table write. */
  supabase: SupabaseClient;
  tenantId: string;
  /** Ticket the body was authored on (the source of the relation). */
  ticketId: string;
  /** Free-text body to scan. May be markdown. */
  body: string | null | undefined;
};

export async function linkMentionsInBody(input: LinkMentionsInput): Promise<{
  linkedCount: number;
}> {
  if (!input.body || input.body.length === 0) return { linkedCount: 0 };
  // Collect unique prefixes from the body.
  const prefixes = new Set<string>();
  for (const m of input.body.matchAll(MENTION_RE)) {
    const captured = m[1];
    if (typeof captured === "string") prefixes.add(captured.toLowerCase());
  }
  if (prefixes.size === 0) return { linkedCount: 0 };

  // Resolve each prefix to a full ticket id within the same tenant. Use
  // `ilike` with a wildcard suffix — cheap on small fleets, and we cap by
  // a reasonable upper bound so a malformed mention can't trigger a table
  // scan.
  const resolvedIds = new Set<string>();
  for (const prefix of prefixes) {
    const { data } = await input.supabase
      .from("tickets")
      .select("id")
      .eq("tenant_id", input.tenantId)
      .ilike("id", `${prefix}%`)
      .limit(2); // 2 to detect ambiguity; if 1 hit, use it; if 2+, skip.
    if (!data || data.length !== 1) continue;
    const id = data[0]?.id as string | undefined;
    if (!id || id === input.ticketId) continue; // never self-link
    resolvedIds.add(id);
  }

  if (resolvedIds.size === 0) return { linkedCount: 0 };

  // Idempotent INSERT … ON CONFLICT DO NOTHING via Supabase's onConflict.
  const rows = Array.from(resolvedIds).map((otherId) => ({
    ticket_id: input.ticketId,
    blocks_ticket_id: otherId,
    relation_type: "related",
  }));
  const { error } = await input.supabase.from("ticket_dependencies").upsert(rows, {
    onConflict: "ticket_id,blocks_ticket_id,relation_type",
    ignoreDuplicates: true,
  });
  if (error) {
    // Non-fatal — mention linking is a UX nicety, not a correctness gate.
    // Log via console for the dev server; the action that called us still
    // returns ok so the operator's comment/edit lands.
    console.warn(
      `[linkMentionsInBody] upsert failed for ticket ${input.ticketId}: ${error.message}`,
    );
    return { linkedCount: 0 };
  }
  return { linkedCount: rows.length };
}
