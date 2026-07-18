// Phase 2 / M5j — sparse-ticket auto-enricher.
//
// Why this exists:
//   The board's "New Ticket" dialog accepts a bare title (and optional
//   description). Tickets that come through the planning flow already get a
//   rich description + 2–4 acceptance-criteria bullets from the multi-agent
//   panel + consolidator. Tickets created directly on the board did not,
//   so terse asks like "Add Payment Page" landed with empty `description`
//   and the "No acceptance criteria yet" placeholder.
//
//   This module fills that gap. After a sparse ticket is inserted, the
//   create action emits `ticket/auto-enrich.requested`. The Inngest function
//   below loads the row, re-confirms it's sparse (no race with operator
//   edits), runs one Haiku call through the local-cc bridge, and writes the
//   generated description / acceptance_criteria back to the row.
//
// Design choices:
//
//  • Async via Inngest, not inline in the server action. The local-cc
//    bridge takes ~6–15 s (claude -p over subscription). Awaiting that in
//    the create action would make the "New Ticket" button feel laggy AND
//    risk the serverless function being torn down on Vercel before the
//    promise settles. The board re-renders on Supabase realtime — the
//    operator sees the enriched ticket flow in seconds after the row is
//    updated.
//
//  • Best-effort, never throws. Mirrors the role-classifier's contract.
//    Enrichment is a quality-of-life feature; a Haiku 5xx, a parse miss,
//    or a timeout must not affect ticket-creation success.
//
//  • Sparseness rule (computed both at emit time and re-checked inside):
//      descriptionEmpty = trim(description).length < 40
//      acEmpty           = trim(acceptance_criteria).length < 10
//    Enrich iff (descriptionEmpty || acEmpty). The check is re-done inside
//    the function so an operator edit between event-emit and event-process
//    wins — we never overwrite content the operator typed.
//
//  • The prompt receives the current title + description + AC and asks
//    Haiku to FILL THE MISSING field(s). If description is already rich
//    we leave it alone and only generate AC. If AC is already populated
//    we leave it alone and only generate description.
//
//  • Routes via classifier-bridge.ts (CLAUDE.md #1: no vendor SDK outside
//    the runner/adapter layer). Same Redis-queue + step-result plumbing
//    that the role classifier uses, billed against the operator's
//    subscription not a per-token key.

import { z } from "zod";
import { inngest } from "@/lib/engine/inngest";
import { supabaseService } from "@/lib/db/server";
import { classifyViaLocalCc, safeParseJsonBlock } from "@/lib/engine/classifier-bridge";

// Input thresholds — below this we treat the operator's content as "needs
// expansion / generation". Bumped 2026-06-05 from 40 → 400 chars: the
// original bar meant a one-sentence description like "Build the user-facing
// checkout summary page" (45 chars) was already considered "rich" and got
// echoed verbatim. Operators want short typed-in-the-dialog descriptions
// EXPANDED into concrete specs; the 400-char bar means anything shorter
// than a small paragraph qualifies, while longer carefully-typed specs
// are still preserved.
const DESCRIPTION_SPARSE_THRESHOLD = 400;
const AC_SPARSE_THRESHOLD = 10;

// Output-quality gates — minimum length the model must produce before we
// write the field. Prevents a model that hiccuped or refused from blowing
// away the operator's content with something useless. These are
// deliberately LOWER than the sparse thresholds: the model should produce
// something at least as substantial as a sentence (description) or a
// single bullet (AC), but we shouldn't reject a tight 200-char description
// just because it's not 400.
const DESCRIPTION_MIN_WRITE_LEN = 80;
const AC_MIN_WRITE_LEN = 20;

const MAX_DESCRIPTION_CHARS = 1_200;
const MAX_AC_CHARS = 600;

const OUTPUT_SPEC_HEADER = [
  "# CRITICAL OUTPUT CONTRACT (read first, obey absolutely)",
  "",
  "Your ENTIRE response must be ONE JSON object and NOTHING else:",
  "- No markdown headings, no prose preamble, no commentary, no fences.",
  "- Start your reply with the literal character `{` and end with `}`.",
  "- All fields are required; do not add extra fields.",
  "",
].join("\n");

const enrichmentSchema = z.object({
  description: z.string().max(MAX_DESCRIPTION_CHARS),
  acceptance_criteria: z.string().max(MAX_AC_CHARS),
});

type EnrichArgs = {
  ticketId: string;
  tenantId: string;
};

export type EnrichResult =
  | { ok: true; wrote: { description: boolean; acceptance_criteria: boolean } }
  | { ok: false; reason: string };

/**
 * Pure sparseness predicate — callers (incl. the create action) use this
 * to decide whether to emit the auto-enrich event at all, so the function
 * doesn't get woken up for tickets that already came in populated (e.g.
 * via the planning-commit flow).
 */
export function isTicketSparse(args: {
  description: string | null | undefined;
  acceptance_criteria: string | null | undefined;
}): boolean {
  const desc = (args.description ?? "").trim();
  const ac = (args.acceptance_criteria ?? "").trim();
  return desc.length < DESCRIPTION_SPARSE_THRESHOLD || ac.length < AC_SPARSE_THRESHOLD;
}

/**
 * Best-effort ticket enrichment. Loads the ticket, re-checks sparseness,
 * runs one Haiku call to fill in description / acceptance_criteria, and
 * UPDATEs the row. Never throws.
 */
export async function enrichTicketIfNeeded(args: EnrichArgs): Promise<EnrichResult> {
  const { ticketId, tenantId } = args;
  try {
    const supabase = supabaseService();

    const { data: ticket, error: loadErr } = await supabase
      .from("tickets")
      .select("id, title, description, acceptance_criteria, status, requested_role")
      .eq("id", ticketId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (loadErr || !ticket) {
      return { ok: false, reason: "ticket-not-found" };
    }

    // Don't enrich after the agent loop has started — past `backlog`/`ready`
    // an operator decision to move forward implies they accept the row as-is.
    const status = String(ticket.status);
    if (status !== "backlog" && status !== "ready") {
      return { ok: false, reason: `past-pre-dispatch-status:${status}` };
    }

    const currentDescription = String(ticket.description ?? "");
    const currentAc = String(ticket.acceptance_criteria ?? "");
    const descEmpty = currentDescription.trim().length < DESCRIPTION_SPARSE_THRESHOLD;
    const acEmpty = currentAc.trim().length < AC_SPARSE_THRESHOLD;
    if (!descEmpty && !acEmpty) {
      return { ok: false, reason: "no-longer-sparse" };
    }

    const title = String(ticket.title ?? "").slice(0, 200);

    // Per-field action: EXPAND when sparse, ECHO when already substantial.
    // The original prompt mixed "fields to fill" + a generic "if populated,
    // echo verbatim" rule — Haiku read the latter and played safe, echoing
    // short user-typed descriptions like "Add Payment Page and fucntionality"
    // instead of expanding them. Splitting per-field action and DROPPING the
    // generic echo rule makes the contract unambiguous.
    const descriptionAction = descEmpty ? "EXPAND" : "ECHO";
    const acAction = acEmpty ? "GENERATE" : "ECHO";

    const systemPrompt = [
      OUTPUT_SPEC_HEADER,
      "Schema:",
      '{"description":"<plain-text 1-3 paragraphs>","acceptance_criteria":"<plain-text bulleted checklist>"}',
      "",
      "# Your job",
      "",
      "You are finalizing fields on a freshly-created Kanban ticket. The operator typed a brief " +
        "title (and sometimes a short description) and submitted, expecting the system to flesh " +
        "out a well-specified work item. You will produce the final `description` and " +
        "`acceptance_criteria` for the ticket — each field has a specific ACTION listed in the " +
        "user message: EXPAND, GENERATE, or ECHO.",
      "",
      "ACTIONS:",
      "- `EXPAND` — the operator typed something but it's terse. Take their wording as a seed, " +
        "PRESERVE every fact, term, technology, and constraint they mentioned, and grow it into " +
        "1–3 short paragraphs of plain text that describe the end-state an engineer should build. " +
        "Add concrete implementation context only when DIRECTLY IMPLIED by their wording or by " +
        "the title — never invent unrelated features.",
      "- `GENERATE` — the field is empty. Write it from scratch using the title and the description " +
        "as the only source of truth.",
      "- `ECHO` — return the operator's existing content character-for-character. Do not paraphrase, " +
        "condense, reformat, or 'polish'. Whitespace included.",
      "",
      "HARD RULES:",
      "1. STAY GROUNDED. Only describe work directly implied by the title and any user-provided " +
        "description. Never invent unrelated features, integrations, third-party vendors, " +
        "frameworks, or design constraints the operator didn't mention.",
      "2. `description` (when EXPAND or GENERATE) — 1–3 short paragraphs, plain text, no headings, " +
        "no bullets. Describe WHAT needs to be built (the end-state), not step-by-step HOW. ≤1200 chars.",
      "3. `acceptance_criteria` (when GENERATE) — 2–4 bullets using `- ` markers, plain text. Each " +
        "bullet is a verifiable end-state condition (what 'done' looks like from a user / reviewer " +
        "perspective). ≤600 chars total.",
      "4. If the title is genuinely ambiguous (e.g. 'Investigate X', 'Spike Y'), the AC bullets " +
        "should describe the investigation deliverables (a doc, a recommendation, evidence) — " +
        "not pretend a feature exists.",
      "",
      "# Reply format reminder",
      "",
      'Return ONE JSON object: {"description":"...","acceptance_criteria":"..."}. First character MUST be `{`.',
    ].join("\n");

    const userPrompt = [
      `Ticket title: ${title}`,
      "",
      `Action for \`description\`: ${descriptionAction}`,
      `Action for \`acceptance_criteria\`: ${acAction}`,
      "",
      "Existing description (operator-typed, may be empty):",
      currentDescription || "(empty)",
      "",
      "Existing acceptance_criteria (operator-typed, may be empty):",
      currentAc || "(empty)",
      "",
      "Apply the ACTION for each field per the rules. Reply with the JSON object only.",
    ].join("\n");

    const bridge = await classifyViaLocalCc({
      tenantId,
      systemPrompt,
      prompt: userPrompt,
      ticketId,
    });
    if (!bridge.ok) {
      return { ok: false, reason: `bridge:${bridge.reason.slice(0, 120)}` };
    }

    const parsed = safeParseJsonBlock<unknown>(bridge.text);
    if (!parsed) {
      console.warn(
        `[ticket-enricher] ticket=${ticketId} no JSON in claude reply: ${bridge.text.slice(0, 200)}`,
      );
      return { ok: false, reason: "no-json-in-reply" };
    }
    const valid = enrichmentSchema.safeParse(parsed);
    if (!valid.success) {
      console.warn(
        `[ticket-enricher] ticket=${ticketId} JSON failed schema: ${valid.error.issues[0]?.message ?? "invalid"}`,
      );
      return { ok: false, reason: "json-schema-failed" };
    }

    // Decide what we'll actually write. Only touch fields we were asked
    // to fill AND where the model returned something non-trivial. This
    // protects us from a model that ignored "echo verbatim" and emitted
    // a blank — the original value stays put.
    const update: Record<string, string> = {};
    const newDesc = valid.data.description.trim();
    const newAc = valid.data.acceptance_criteria.trim();
    let wroteDesc = false;
    let wroteAc = false;
    if (descEmpty && newDesc.length >= DESCRIPTION_MIN_WRITE_LEN) {
      update.description = newDesc;
      wroteDesc = true;
    }
    if (acEmpty && newAc.length >= AC_MIN_WRITE_LEN) {
      update.acceptance_criteria = newAc;
      wroteAc = true;
    }

    if (Object.keys(update).length === 0) {
      return { ok: false, reason: "model-returned-empty" };
    }

    // Re-fetch right before write and re-check sparseness on the fields
    // we're about to overwrite. The race we're guarding against is rare
    // (operator opens edit modal + saves during the ~10s Haiku call) but
    // a JS-side check is simpler than a PostgREST OR filter and avoids
    // any "null vs empty string" subtleties on column defaults.
    const { data: fresh } = await supabase
      .from("tickets")
      .select("description, acceptance_criteria, status")
      .eq("id", ticketId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!fresh) {
      return { ok: false, reason: "ticket-disappeared" };
    }
    const freshStatus = String(fresh.status);
    if (freshStatus !== "backlog" && freshStatus !== "ready") {
      return { ok: false, reason: `past-pre-dispatch-status:${freshStatus}` };
    }
    const freshDescLen = String(fresh.description ?? "").trim().length;
    const freshAcLen = String(fresh.acceptance_criteria ?? "").trim().length;
    if (wroteDesc && freshDescLen >= DESCRIPTION_SPARSE_THRESHOLD) {
      delete update.description;
      wroteDesc = false;
    }
    if (wroteAc && freshAcLen >= AC_SPARSE_THRESHOLD) {
      delete update.acceptance_criteria;
      wroteAc = false;
    }
    if (Object.keys(update).length === 0) {
      return { ok: false, reason: "lost-race-to-operator" };
    }

    const { error: updateErr } = await supabase
      .from("tickets")
      .update(update)
      .eq("id", ticketId)
      .eq("tenant_id", tenantId);
    if (updateErr) {
      console.warn(
        `[ticket-enricher] ticket=${ticketId} persist failed: ${updateErr.message.slice(0, 200)}`,
      );
      return { ok: false, reason: `persist-failed:${updateErr.message.slice(0, 120)}` };
    }

    console.log(
      `[ticket-enricher] ticket=${ticketId} wrote description=${wroteDesc} ac=${wroteAc}`,
    );
    return { ok: true, wrote: { description: wroteDesc, acceptance_criteria: wroteAc } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ticket-enricher] ticket=${args.ticketId} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

// Inngest entry point. `createTicketAction` emits `ticket/auto-enrich.requested`
// after a successful insert; this function consumes it.
//
// Concurrency: keyed per tenant so a burst of ticket creates doesn't pile
// 20 simultaneous claude -p subprocesses on the same workstation. Limit
// matches the subscription-runner sweet spot called out in CLAUDE.md
// ("~1–3 steady concurrent agents"). retries: 1 — Haiku is mostly
// deterministic; one transient retry is enough, more wastes seats.
//
// We deliberately RETURN the EnrichResult (including {ok:false} cases) instead
// of throwing. Expected no-ops ("no-longer-sparse", "lost-race-to-operator",
// "model-returned-empty") are not failures — throwing would clutter the
// Inngest dashboard with red runs that aren't actionable.
export const ticketAutoEnrichFn = inngest.createFunction(
  {
    id: "ticket-auto-enrich",
    retries: 1,
    concurrency: {
      limit: 2,
      key: "event.data.tenantId + '_enrich'",
    },
  },
  { event: "ticket/auto-enrich.requested" },
  async ({ event, step }) => {
    const { ticketId, tenantId } = event.data;
    return await step.run("enrich", async () => enrichTicketIfNeeded({ ticketId, tenantId }));
  },
);
