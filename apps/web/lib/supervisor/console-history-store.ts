// The supervisor console's conversation - the IO half. MARKER-FREE: the
// Supabase client arrives as an injected dep, with production wiring in
// `console-history-store.server.ts`. Same split, same reasoning, as
// `console-store.ts` next door.
//
// ── TENANT SCOPING IS THE ENTIRE BOUNDARY ─────────────────────────────────
// Every read and write here runs SERVICE-ROLE with RLS off, so the co-located
// `.eq("tenant_id", …)` on each one is the only thing separating boards. What a
// missing predicate produces here is not merely a disclosure:
//
//   • READ - another workspace's operator conversation is replayed into THIS
//     tenant's model context and rendered as this operator's own thread. Every
//     turn of it is untrusted text that was written about a different board.
//   • LINK - a commanded fix in this tenant is attributed to a message in
//     another one, i.e. an audit trail that is confidently wrong. The database
//     refuses that too (`assert_tenant_matches_parent` on
//     `console_message_id`), which is the second, unfakeable line.
//
// `tenantId` always comes from the caller's SESSION; `projectId` is a request
// field, and the project is validated by the console's own snapshot load before
// anything here runs.
//
// NOTHING HERE THROWS. A transcript is a record of a conversation, not the
// conversation: losing a row must never fail the question the operator asked,
// or take down a board recovery because the console could not write down that
// it happened.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  asConsoleMessageKind,
  asConsoleMessageRole,
  boundConsoleMessageBody,
  CONSOLE_THREAD_DISPLAY_LIMIT,
  type ConsoleMessage,
  type ConsoleMessageKind,
  type ConsoleMessageRole,
} from "@/lib/supervisor/console-history";

/**
 * NO `nowIso`, unlike every other store on this surface - and that is a
 * decision, not an omission.
 *
 * A turn's `created_at` is the DATABASE's `default now()`. One server action
 * writes up to three turns (a notice, then an answer, then an outcome), and a
 * single request-scoped timestamp stamps all of them identically - at which
 * point "oldest first" has no answer and a reloaded thread can render the
 * console's reply above the question that produced it. `now()` is transaction
 * time and each insert is its own transaction, so successive turns are strictly
 * ordered with no clock of ours involved. Found by reloading a real thread, not
 * by reasoning.
 */
export type ConsoleHistoryDeps = {
  db: SupabaseClient;
};

const TABLE = "supervisor_console_messages";

const SELECT_COLUMNS = "id, role, kind, body, created_at";

type MessageRow = {
  id: unknown;
  role: unknown;
  kind: unknown;
  body: unknown;
  created_at: unknown;
};

function mapRow(row: MessageRow): ConsoleMessage | null {
  const role = asConsoleMessageRole(row.role);
  if (!role) return null;
  const id = typeof row.id === "string" ? row.id : null;
  const body = typeof row.body === "string" ? row.body : "";
  if (!id || body.trim().length === 0) return null;
  return {
    id,
    role,
    kind: asConsoleMessageKind(row.kind, role),
    body,
    createdAtIso: typeof row.created_at === "string" ? row.created_at : "",
  };
}

/**
 * Append one turn. Returns its id so a command run in the same conversation can
 * be linked back to it.
 *
 * `{ ok: false }` on any failure, never a throw - see the file header. The
 * caller ignores it; the id simply is not available to link with, which
 * `decideConsoleMessageLink` reports as `no-id`.
 */
export async function appendConsoleMessage(
  deps: ConsoleHistoryDeps,
  args: {
    tenantId: string;
    projectId: string;
    role: ConsoleMessageRole;
    kind: ConsoleMessageKind;
    body: string;
    /** Who typed it. Operator turns only; a console turn was typed by nobody. */
    authorUserId?: string | null;
  },
): Promise<{ ok: true; id: string } | { ok: false }> {
  const body = boundConsoleMessageBody(args.body);
  if (body === null) return { ok: false };
  try {
    const { data, error } = await deps.db
      .from(TABLE)
      .insert({
        tenant_id: args.tenantId,
        project_id: args.projectId,
        role: args.role,
        kind: args.kind,
        body,
        author_user_id: args.role === "operator" ? (args.authorUserId ?? null) : null,
        // `created_at` is deliberately NOT sent - see `ConsoleHistoryDeps`.
      })
      .select("id")
      .maybeSingle();
    if (error || !data || typeof (data as { id?: unknown }).id !== "string") {
      if (error) {
        console.warn(
          `[supervisor-console] transcript write failed: ${error.message.slice(0, 200)}`,
        );
      }
      return { ok: false };
    }
    return { ok: true, id: (data as { id: string }).id };
  } catch (e) {
    console.warn(
      `[supervisor-console] transcript write threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { ok: false };
  }
}

/**
 * The project's thread, OLDEST FIRST.
 *
 * Read newest-first with a LIMIT and reversed in memory - that is the only way
 * to get "the last N" out of Postgres, and the index
 * (`tenant_id, project_id, created_at desc`) is built for exactly this shape.
 * The caller renders it in the order returned.
 *
 * A failed read is an EMPTY thread, not an error: a console that refuses to open
 * because it could not load a transcript would be broken by a bookkeeping
 * problem, and the deterministic board brief - the reason this surface exists -
 * needs none of it.
 */
export async function loadConsoleThread(
  deps: ConsoleHistoryDeps,
  args: { tenantId: string; projectId: string; limit?: number },
): Promise<ConsoleMessage[]> {
  const limit = Math.max(1, Math.min(args.limit ?? CONSOLE_THREAD_DISPLAY_LIMIT, 200));
  try {
    const { data, error } = await deps.db
      .from(TABLE)
      .select(SELECT_COLUMNS)
      // BOTH predicates. `tenant_id` is the security boundary (see the header);
      // `project_id` is a correctness one - a thread about another board would
      // be replayed as history for this one.
      .eq("tenant_id", args.tenantId)
      .eq("project_id", args.projectId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) {
      if (error) {
        console.warn(`[supervisor-console] transcript read failed: ${error.message.slice(0, 200)}`);
      }
      return [];
    }
    const mapped = (data as MessageRow[])
      .map(mapRow)
      .filter((m): m is ConsoleMessage => m !== null);
    return mapped.reverse();
  } catch (e) {
    console.warn(
      `[supervisor-console] transcript read threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

/**
 * One message by id, for the audit link.
 *
 * The id is CLIENT-SUPPLIED, which is why this read carries both predicates and
 * why `decideConsoleMessageLink` then compares the stored body against the
 * question: a foreign or wrong-project id resolves to nothing here, and a
 * same-project id naming a different message is caught by the text comparison.
 * Returns null on any failure - a link that cannot be proven is not written.
 */
export async function loadConsoleMessageById(
  deps: ConsoleHistoryDeps,
  args: { tenantId: string; projectId: string; messageId: string },
): Promise<ConsoleMessage | null> {
  const id = (args.messageId ?? "").trim();
  if (id.length === 0) return null;
  try {
    const { data, error } = await deps.db
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .eq("tenant_id", args.tenantId)
      .eq("project_id", args.projectId)
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return mapRow(data as MessageRow);
  } catch {
    return null;
  }
}
