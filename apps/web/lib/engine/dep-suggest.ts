// Phase 2.5+ / G3 — Haiku rerank: "which existing tickets block this new one?"
//
// Run in the background by `suggestTicketDepsFn` (via the `loadAndSuggestDeps`
// helper) after a ticket is created — it used to be an inline await in
// `createTicketCore`, but that blocked the create response on the model call
// and hung the "Creating…" button, so it moved off the request path. We load up
// to 30 in-scope candidate tickets, keyword-prefilter to 12, then hand them to
// Haiku to score how strongly each one blocks the new ticket. The operator
// confirms the picks in `SuggestedDepsModal` before any `ticket_dependencies`
// rows are written, so a sloppy LLM rank can't silently reshape the board.
//
// Mirrors the shape of `lib/skills/select.ts` (keyword pre-filter + Zod
// schema + graceful fallback) and the lazy anthropic-client pattern from
// `lib/engine/ticket-role-classifier.ts`. NEVER throws — every failure path
// returns `{ok: false, reason}` so the caller can no-op suggestion and let
// the operator wire deps manually.

import { z } from "zod";
import { generateObjectForTenant } from "@/lib/llm/generate.server";
import type { TicketStatus } from "@/lib/board/state";

// Cheap Haiku-tier call via the auth-mode-aware `generateObjectForTenant`
// (lib/llm/generate.server.ts): the local Claude Code runner in claude_code
// mode (the default), the tenant-resolved API key in api_key mode. Keeps the
// vendor SDK behind the adapter layer while still pinning the cost decision
// at this call site to the cheap tier: "thin cheap classification, not a
// thinking call."

// ─── public types ──────────────────────────────────────────────────────────

export type DepSuggestion = {
  ticketId: string;
  score: number;
  rationale: string;
  title: string;
  status: TicketStatus;
};

export type DepSuggestArgs = {
  tenantId: string;
  newTicket: { id: string; title: string; description: string | null };
  candidates: Array<{
    id: string;
    title: string;
    description: string | null;
    status: TicketStatus;
    updated_at: string;
  }>;
};

export type DepSuggestResult =
  | { ok: true; suggestions: DepSuggestion[] }
  | { ok: false; reason: string };

// ─── tuning constants ──────────────────────────────────────────────────────

const PREFILTER_CAP = 12;
const FINAL_CAP = 5;
const MIN_SCORE = 6;

// Stopwords (cheap version — enough to keep "the new password reset" and
// "implement password reset" from drowning the jaccard signal). Keep this
// short so generic ticket vocabulary like "add", "fix", "bug" stays in.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "to",
  "for",
  "in",
  "of",
  "this",
  "that",
  "is",
  "are",
  "be",
  "with",
  "on",
  "at",
  "or",
  "as",
  "by",
  "it",
]);

// ─── public entrypoint ─────────────────────────────────────────────────────

export async function suggestDependencies(args: DepSuggestArgs): Promise<DepSuggestResult> {
  try {
    // 1. Trivial path — nothing to suggest against.
    if (args.candidates.length === 0) {
      return { ok: true, suggestions: [] };
    }

    // 2. Keyword pre-filter. Jaccard similarity on tokenised title +
    //    description (lowercase, split on non-alphanum, drop stopwords).
    const newTokens = tokenise(args.newTicket.title, args.newTicket.description);
    const scored = args.candidates.map((c) => {
      const tokens = tokenise(c.title, c.description);
      const sim = jaccard(newTokens, tokens);
      return { c, sim };
    });
    scored.sort((a, b) => b.sim - a.sim);
    // If every candidate ties at zero (no token overlap at all), the prefilter
    // gave us nothing useful — fall back to recency so the LLM still has
    // *something* to consider rather than a deterministic-but-arbitrary slice.
    const allZero = scored.every((s) => s.sim === 0);
    const prefiltered = allZero
      ? args.candidates
          .slice()
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
          .slice(0, PREFILTER_CAP)
      : scored.slice(0, PREFILTER_CAP).map((s) => s.c);

    if (prefiltered.length === 0) {
      return { ok: true, suggestions: [] };
    }

    // 3. Render the candidates as a numbered list for the prompt. Cap each
    //    entry to ~200 chars so a long description can't blow the context
    //    budget when 12 candidates compound. Description is truncated to the
    //    first line + cap so the Haiku prompt stays tight.
    const candidateLines = prefiltered.map((c, i) => {
      const firstLine = (c.description ?? "").split(/\r?\n/)[0]!.trim();
      const remaining = Math.max(20, 200 - (c.id.length + c.title.length + c.status.length + 20));
      const truncDesc =
        firstLine.length > remaining ? `${firstLine.slice(0, remaining)}…` : firstLine;
      return `${i + 1}. ${c.id}: ${c.title} (${c.status}) — ${truncDesc}`;
    });
    const candidatesBlock = candidateLines.join("\n");

    // 4. Haiku call. temperature=0 + sharp Zod schema = highly deterministic
    //    rank. Schema caps the returned array at 5 and the rationale at 200
    //    chars to keep the modal readable.
    const schema = z.object({
      suggestions: z
        .array(
          z.object({
            ticketId: z.string().uuid(),
            score: z.number().int().min(0).max(10),
            rationale: z.string().max(200),
          }),
        )
        .max(5),
    });

    // Truncate the new ticket's description for the prompt the same way we
    // truncate candidates — long pasted logs shouldn't dominate the budget.
    const rawNewDesc = String(args.newTicket.description ?? "");
    const newDesc =
      rawNewDesc.length > 2_000 ? `${rawNewDesc.slice(0, 2_000)}…(truncated)` : rawNewDesc;
    const newTitle = String(args.newTicket.title ?? "").slice(0, 200);

    const result = await generateObjectForTenant({
      tenantId: args.tenantId,
      featureName: "Dependency suggestions",
      tier: "cheap",
      schema,
      schemaHint:
        '{"suggestions":[{"ticketId":"<candidate uuid verbatim>","score":<integer 0-10>,"rationale":"<one short sentence, max 200 chars>"}]}',
      system:
        "You are a router for an agent platform's ticket board. " +
        "Given a NEW ticket and a list of existing tickets in the same project, " +
        "pick up to 5 that should be DONE BEFORE the new one (i.e. that block it). " +
        "A ticket should only be suggested if it materially blocks the new one — " +
        "typo fixes don't block features; unrelated work doesn't block a new feature. " +
        "Return an empty array if no blockers fit. " +
        "Score: 10 = obvious blocker, 6 = plausible blocker, 0-5 = don't suggest.",
      prompt:
        `NEW ticket:\n` +
        `Title: ${newTitle}\n` +
        `Description:\n${newDesc}\n\n` +
        `Candidate existing tickets (number. id: title (status) — description):\n` +
        `${candidatesBlock}\n\n` +
        `Return up to 5 of these candidates as suggested blockers, scored 0-10.`,
      maxTokens: 800,
      temperature: 0,
      // Background dep-suggestion after ticket creation — bounded so a downed
      // runner drains this Inngest step quickly rather than hanging on the
      // bridge's full 2-min default (the create already returned; this no longer
      // blocks it, but a tight bound still frees the runner seat sooner).
      timeoutMs: 60_000,
    });
    if (!result.ok) {
      return { ok: false, reason: result.error.slice(0, 200) };
    }

    // 5. Post-process: validate every returned ticketId belongs to the
    //    candidate set (drop hallucinations), drop suggestions below the
    //    score threshold, sort by score DESC, cap at 5.
    const candidateById = new Map(prefiltered.map((c) => [c.id, c]));
    const ranked = result.object.suggestions
      .filter((s) => candidateById.has(s.ticketId))
      .filter((s) => s.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, FINAL_CAP);

    // 6. Cross-look-up title + status from the candidate set so the modal
    //    can render without a second DB round-trip.
    const suggestions: DepSuggestion[] = ranked.map((s) => {
      const src = candidateById.get(s.ticketId)!;
      return {
        ticketId: s.ticketId,
        score: s.score,
        rationale: s.rationale,
        title: src.title,
        status: src.status,
      };
    });

    return { ok: true, suggestions };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[dep-suggest] newTicketId=${args.newTicket.id} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function tokenise(title: string, description: string | null): Set<string> {
  const text = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  // Split on anything that isn't a-z0-9. Drops punctuation, whitespace, and
  // markdown syntax in one pass. We keep tokens that are 2+ chars and aren't
  // stopwords — single chars are pure noise for jaccard.
  const out = new Set<string>();
  for (const raw of text.split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  // Iterate the smaller set to keep the cost minimal.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) {
    if (large.has(t)) intersect++;
  }
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}
