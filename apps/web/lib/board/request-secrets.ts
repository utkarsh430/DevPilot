// The one way DevPilot asks a human for a secret value.
//
// This body used to live inline in `app/api/runners/tools/request-secret/route.ts`,
// behind `checkRunnerAuth`. That made it reachable only by the runner, so any
// other part of the system that needed a value had to grow its own asking
// mechanism — and a second ask path means a second comment shape, a second
// resume signal, and a second thing to keep in step with `SecretRequestCard`.
//
// So the core is extracted here and the route becomes a thin auth wrapper around
// it. Same move, and the same reason, as `createTicketCore` (`lib/board/create-ticket.ts`):
// the shared body takes its tenant/project from arguments and the callers supply
// the right client and the right gate.
//
// ── The contract this preserves ────────────────────────────────────────────
// One `agent`-authored comment with `metadata.kind = "secret_request"` and
// `metadata.keys` (NAMES ONLY — no value has ever been in this comment and none
// may be added), then the ticket parked in `input_required`. The TicketDrawer
// renders `SecretRequestCard` off that metadata; the operator's submit writes
// each value through `setProjectSecretAction` and posts a human comment, which
// is what resumes the ticket.
//
// The comment is written BEFORE the transition on purpose: if the ticket's
// current state cannot legally reach `input_required`, the request still lands
// on the timeline so the operator can see what was asked rather than the ask
// vanishing with the 422.

import { supabaseService } from "@/lib/db/server";
import { addComment, transitionTicket } from "@/lib/board/transitions";
import { normalizeSecretRequest } from "@/lib/board/secret-request-keys";

export type RequestSecretsInput = {
  ticketId: string;
  /** UPPER_SNAKE_CASE env var names. Validated here. */
  keys: string[];
  /** Why they are needed — rendered above the form. Never contains a value. */
  rationale: string;
  /** Comment author id. A role slug for the agent path; callers on the engine
   *  side pass their own stable author (e.g. `devpilot_vercel_env`) so the
   *  timeline attributes the ask to the feature that raised it. */
  authorId?: string;
};

export type RequestSecretsResult =
  | { ok: true; commentId: string; keys: string[] }
  | {
      ok: false;
      /** `invalid` → 400-shaped, `not_found` → 404, `bad_state` → 422 (the
       *  comment landed; the transition did not), `failed` → 500. */
      code: "invalid" | "not_found" | "bad_state" | "failed";
      error: string;
      /** Present for `bad_state`: the ask is on the ticket even though the
       *  parking failed. */
      commentId?: string;
    };

/**
 * Ask a human for one or more env var values, on a ticket.
 *
 * Returns a result union rather than throwing so both callers (an HTTP route
 * that must map to a status code, and a server action that must render a
 * message) branch on the same value.
 */
export async function requestSecrets(input: RequestSecretsInput): Promise<RequestSecretsResult> {
  const norm = normalizeSecretRequest(input);
  if (!norm.ok) return { ok: false, code: "invalid", error: norm.error };
  const { keys: cleanKeys, rationale, authorId } = norm;

  const supabase = supabaseService();
  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .select("id, tenant_id, project_id")
    .eq("id", norm.ticketId)
    .single();
  if (ticketErr || !ticket) {
    return { ok: false, code: "not_found", error: "ticket not found" };
  }

  let commentId: string;
  try {
    const { data: inserted, error: insertErr } = await supabase
      .from("comments")
      .insert({
        ticket_id: ticket.id,
        tenant_id: ticket.tenant_id,
        author_type: "agent",
        author_id: authorId,
        body: rationale,
        metadata: {
          kind: "secret_request",
          // NAMES ONLY. A value here would be readable by every agent that
          // reads the ticket thread.
          keys: cleanKeys,
          project_id: ticket.project_id ?? null,
        },
      })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      return { ok: false, code: "failed", error: insertErr?.message ?? "insert failed" };
    }
    commentId = inserted.id;
  } catch (err) {
    return { ok: false, code: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  try {
    await transitionTicket({
      ticketId: ticket.id,
      tenantId: ticket.tenant_id,
      to: "input_required",
      // Not a `→ in_review` and not a `→ done`, so no gate applies. Kept as
      // `agent` for the runner path's semantics; an engine caller asking for a
      // value on behalf of an operator is still not a human MOVING the ticket.
      actor: "agent",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: msg.startsWith("invalid ticket transition") ? "bad_state" : "failed",
      error: msg,
      commentId,
    };
  }

  // System breadcrumb so the timeline shows *why* the ticket parked.
  try {
    await addComment({
      ticketId: ticket.id,
      tenantId: ticket.tenant_id,
      authorType: "system",
      authorId: "devpilot_request_secret",
      body: `Agent requested ${cleanKeys.length} env var${cleanKeys.length === 1 ? "" : "s"}: ${cleanKeys.join(", ")}`,
    });
  } catch (err) {
    console.error("[devpilot_request_secret] system breadcrumb failed:", err);
  }

  return { ok: true, commentId, keys: cleanKeys };
}
