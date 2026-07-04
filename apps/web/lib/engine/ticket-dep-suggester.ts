// Async dependency suggester.
//
// Why this exists:
//   The board's "New ticket" create used to run the Haiku dep-suggestion rerank
//   INLINE inside `createTicketCore` (loadAndSuggestDeps → suggestDependencies →
//   the local-cc one-shot runner) and `await` it before the create action
//   returned. That call takes seconds and can stall for the runner-bridge's full
//   timeout when the subscription runner is busy (concurrency cap, other agents
//   running), so the "Creating…" button looked frozen for what should be an
//   instant Backlog insert.
//
//   This module moves that work off the request path. After the insert,
//   `createTicketCore` emits `ticket/suggest-deps.requested`; the Inngest
//   function below loads candidates, runs the same rerank via the shared
//   `loadAndSuggestDeps` helper, and parks the ranked result on
//   `tickets.suggested_dependencies`. The board subscribes to `tickets` realtime,
//   so a "review suggested dependencies" chip lights up on the card the moment
//   the row updates — the operator then accepts/skips through the SAME modal the
//   old synchronous flow showed. This mirrors the `ticket/auto-enrich.requested`
//   → `ticketAutoEnrichFn` pattern one field over.
//
// Design choices:
//
//  • Best-effort, never throws. Mirrors the enricher / role-classifier
//    contract: a suggestion is a quality-of-life feature; a downed runner, a
//    timeout, or a parse miss must not affect ticket-creation success (the
//    create already returned) and must not clutter the Inngest dashboard with
//    red runs — we RETURN {ok:false, reason} rather than throw.
//
//  • Pre-dispatch gate. We only park suggestions while the new ticket is still
//    in `backlog`/`ready` — once the agent loop has started, "which existing
//    tickets should be done before this one" is moot and the operator has
//    already moved on. This also guards the rare race where the operator
//    promoted the ticket during the ~seconds-long Haiku call.
//
//  • Only write when there's something to show. An empty rank leaves the column
//    NULL (its default), so no chip appears — identical to a ticket the job
//    never ran for.

import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { loadAndSuggestDeps } from "@/lib/board/create-ticket";
import type { DepSuggestion } from "@/lib/engine/dep-suggest";

export type SuggestDepsArgs = {
  ticketId: string;
  tenantId: string;
  projectId: string;
  title: string;
  description: string;
};

export type SuggestDepsResult = { ok: true; parked: number } | { ok: false; reason: string };

/**
 * Best-effort background dep-suggestion. Re-checks the ticket is still
 * pre-dispatch, runs the shared Haiku rerank, and parks any suggestions on
 * `tickets.suggested_dependencies` for the operator to accept/skip. Never throws.
 */
export async function suggestTicketDepsInBackground(
  args: SuggestDepsArgs,
): Promise<SuggestDepsResult> {
  const { ticketId, tenantId, projectId, title, description } = args;
  try {
    const supabase = supabaseService();

    // Confirm the ticket still exists, is in this tenant, and hasn't been
    // dispatched. Loading it also scopes the later write by (id, tenant_id).
    const { data: ticket, error: loadErr } = await supabase
      .from("tickets")
      .select("id, status")
      .eq("id", ticketId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (loadErr || !ticket) {
      return { ok: false, reason: "ticket-not-found" };
    }
    const status = String(ticket.status);
    if (status !== "backlog" && status !== "ready") {
      return { ok: false, reason: `past-pre-dispatch-status:${status}` };
    }

    // The SAME rerank the create path used to await inline. loadAndSuggestDeps
    // never throws — it returns [] on any failure and logs a warning.
    const suggestions: DepSuggestion[] = await loadAndSuggestDeps({
      tenantId,
      projectId,
      newTicketId: ticketId,
      title,
      description,
    });
    if (suggestions.length === 0) {
      // Nothing to surface — leave the column NULL so no chip appears.
      return { ok: true, parked: 0 };
    }

    // Park the ranked suggestions. Re-check the status in the WHERE clause so a
    // promotion during the Haiku call means the update matches no row rather
    // than stamping suggestions on an already-dispatched ticket.
    const { error: updErr } = await supabase
      .from("tickets")
      .update({ suggested_dependencies: suggestions })
      .eq("id", ticketId)
      .eq("tenant_id", tenantId)
      .in("status", ["backlog", "ready"]);
    if (updErr) {
      console.warn(
        `[ticket-dep-suggester] ticket=${ticketId} persist failed: ${updErr.message.slice(0, 200)}`,
      );
      return { ok: false, reason: `persist-failed:${updErr.message.slice(0, 120)}` };
    }

    console.log(
      `[ticket-dep-suggester] ticket=${ticketId} parked ${suggestions.length} suggestion(s)`,
    );
    return { ok: true, parked: suggestions.length };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ticket-dep-suggester] ticket=${args.ticketId} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

// Inngest entry point. `createTicketCore` emits `ticket/suggest-deps.requested`
// after a successful insert; this function consumes it.
//
// Concurrency: keyed per tenant so a burst of creates doesn't pile several
// `claude -p` one-shots on the same workstation (the local-cc runner in the
// default claude_code auth-mode). Limit 2 matches the subscription-runner sweet
// spot called out in AGENTS.md ("~1–3 steady concurrent agents") and the sibling
// auto-enrich function. retries: 1 — the rerank is best-effort; one transient
// retry is enough, more wastes seats.
//
// We RETURN the SuggestDepsResult (including {ok:false} no-ops like
// "past-pre-dispatch-status") rather than throwing, so expected non-events don't
// show as red runs in the Inngest dashboard.
export const suggestTicketDepsFn = inngest.createFunction(
  {
    id: "ticket-suggest-deps",
    retries: 1,
    concurrency: {
      limit: 2,
      key: "event.data.tenantId + '_depsuggest'",
    },
  },
  { event: "ticket/suggest-deps.requested" },
  async ({ event, step }) => {
    const { ticketId, tenantId, projectId, title, description } = event.data;
    return await step.run("suggest-deps", async () =>
      suggestTicketDepsInBackground({ ticketId, tenantId, projectId, title, description }),
    );
  },
);
