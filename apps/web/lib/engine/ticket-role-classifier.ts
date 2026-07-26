// Phase 2 / M5h — LLM-driven role classifier.
//
// Called from `decideNextRole` (dispatcher) when:
//   - `tickets.requested_role` IS null
//   - the ticket has NO prior agent comments (i.e. truly first dispatch)
//
// Reads the ticket title + description, asks the local-cc runner to pick the
// single best-fitting slug from `ROLE_CATALOG`, persists to
// `tickets.requested_role`. The dispatcher then honors it on the next
// pass via its existing M4 branch.
//
// Failure mode: if the bridge call fails (timeout, parse error) or returns a
// slug not in the catalog, this function no-ops (caller falls back to the
// state machine). It NEVER throws — classification failures are non-blocking.
//
// Why local-cc and not `@ai-sdk/anthropic` directly:
//
//   CLAUDE.md #1: "Local Claude Code Runner is the default. Never hardwire a
//   vendor SDK outside the runner/adapter layer." The previous implementation
//   called `generateObject` from `@ai-sdk/anthropic` directly, which billed
//   against a per-token API key. That key was revoked in dogfooding
//   (handoff §8b incident #12) and every classifier call started failing
//   silently — the dispatcher's state-machine fallback then mechanically
//   picked `pm` for every `ready` ticket. The smoke-test ("PM picked for
//   spike/security tickets") traced back to exactly this auth failure. The
//   classifier now rides the operator's Claude Pro/Max subscription via the
//   same Redis-queue + step-result pipeline `run-agent.ts` uses for ticket
//   agents — see `lib/engine/classifier-bridge.ts` for the bridge.
//
// Latency trade-off: ~6–15s per classification (claude -p over subscription)
// vs ~2s for the API path. Acceptable for routing — each dispatch waits a
// few seconds longer to pick the right role, dwarfed by the agent run time
// downstream.

import { z } from "zod";
import { supabaseService } from "@/lib/db/server";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import { classifyViaLocalCc, safeParseJsonBlock } from "@/lib/engine/classifier-bridge";

// Strict output spec appended to every classifier system prompt. The bridge
// gets raw text back from claude -p, so we have to tell the model how to
// frame the answer. Repeating the contract at the head AND tail of the
// system prompt mirrors the plan-mode panel pattern (PANEL_OUTPUT_HEADER /
// PANEL_OUTPUT_SPEC) — empirically the most reliable way to keep Sonnet/
// Haiku from prose-ifying the response.
const OUTPUT_SPEC_HEADER = [
  "# CRITICAL OUTPUT CONTRACT (read first, obey absolutely)",
  "",
  "Your ENTIRE response must be ONE JSON object and NOTHING else:",
  "- No markdown headings, no prose preamble, no commentary, no fences.",
  "- Start your reply with the literal character `{` and end with `}`.",
  "- All fields are required; do not add extra fields.",
  "",
].join("\n");

// Phase 2 / M5j — heuristic that determines whether the first-dispatch
// classifier should include `pm` in its candidate enum. The bar is high on
// purpose: we want PM to be reachable for genuinely bare tickets ("Add
// Payment Page") but NOT for terse-but-technical ones ("Spike: ANN
// benchmark", "Audit auth middleware") where the M5h smoke tests showed
// PM was over-eager. The enricher (lib/engine/ticket-enricher.ts) tries
// to populate description + AC before the dispatcher runs; this fallback
// only fires when that didn't happen (timed out / failed / operator
// dragged to ready before it finished).
//
// Rule: sparse iff (title + description).length < 60 chars AND
//       acceptance_criteria is empty/whitespace.
//
// Threshold rationale: "Add Payment Page" + "Add Payment Page and
// fucntionality" = 51 chars total → sparse, PM available. "Spike:
// investigate ANN benchmarks for vector search" = 51-char title alone
// → just under, but those tickets typically also have a description
// paragraph pushing total over 60. Tuning here is over time: if we see
// PM creeping back in on technical-but-terse tickets, raise the bar
// (or add a signal-word check).
function isSparseForPm(args: {
  title: string;
  description: string;
  acceptance_criteria: string;
}): boolean {
  const total = args.title.trim().length + args.description.trim().length;
  const acLen = args.acceptance_criteria.trim().length;
  return total < 60 && acLen < 10;
}

type ClassifyResult = { ok: true; slug: string } | { ok: false; reason: string };

type ClassifyArgs = {
  ticketId: string;
  tenantId: string;
};

/**
 * Best-effort: classify a new ticket's role with a single Haiku call and
 * persist the pick to `tickets.requested_role`. Never throws.
 *
 * Preconditions enforced inside (caller doesn't need to re-check, but the
 * caller's gating on `agentAuthors.length === 0` AND status is still the
 * primary defense against running this twice):
 *   - `tickets.requested_role` MUST be null (operator pick or earlier
 *     classification result wins).
 *   - `tickets.status` MUST be in {backlog, ready} (past first dispatch we
 *     don't want to override the state-machine path).
 */
export async function classifyTicketRoleIfNeeded(args: ClassifyArgs): Promise<ClassifyResult> {
  const { ticketId, tenantId } = args;
  try {
    // 1. Load the ticket. Use the service client because we're called from
    //    the dispatcher (Inngest function context) where there's no user
    //    session cookie.
    const supabase = supabaseService();
    const { data: ticket, error: ticketErr } = await supabase
      .from("tickets")
      .select("id, title, description, acceptance_criteria, status, requested_role")
      .eq("id", ticketId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (ticketErr || !ticket) {
      return { ok: false, reason: "ticket-not-found" };
    }

    // 2. Defensive: caller already gated on these, but if the row mutated
    //    between load and now (concurrent operator pick) we no-op so the
    //    operator's choice is never overwritten.
    if (ticket.requested_role) {
      return { ok: false, reason: "already-set" };
    }

    // 3. Only classify on truly fresh tickets. The dispatcher's gate (status
    //    + no agent comments) already ensures this; we double-check the
    //    status here so a future caller can't accidentally invoke us late.
    const status = ticket.status as string;
    if (status !== "backlog" && status !== "ready") {
      return { ok: false, reason: "past-first-dispatch" };
    }

    // 4. Schema: constrain the model's slug pick to known catalog slugs.
    //    Building the enum tuple from the catalog avoids drift — if a role
    //    is added later, the schema picks it up automatically.
    //
    //    Post-smoke iteration (M5h): EXCLUDE `pm` from the first-dispatch enum
    //    by default. With pm on the menu, Sonnet kept picking it for clear
    //    technical tickets ("Spike: …", "Audit …") by reasoning "well, any
    //    ticket benefits from scoping first". The prompt told it not to; it
    //    did anyway. Removing pm from the menu makes the wrong pick literally
    //    impossible.
    //
    //    M5j refinement: re-include `pm` ONLY when the ticket is GENUINELY
    //    sparse (title + description shorter than the heuristic AND no
    //    acceptance criteria). This is the safety net for cases where the
    //    M5j enricher (lib/engine/ticket-enricher.ts) failed/skipped — the
    //    ticket reaches the dispatcher still bare, and a specialist would
    //    just guess at scope. For sparse rows, PM-first is correct: it
    //    refines acceptance criteria so the next role has something to
    //    build against. We still tell the model in the prompt that PM is
    //    available only because the ticket is bare, to keep the pre-M5j
    //    over-eager-PM problem from coming back when the enricher does work.
    const title = String(ticket.title ?? "").slice(0, 200);
    const rawDescription = String(ticket.description ?? "");
    const rawAc = String(ticket.acceptance_criteria ?? "");
    const sparse = isSparseForPm({
      title,
      description: rawDescription,
      acceptance_criteria: rawAc,
    });
    const FIRST_DISPATCH_EXCLUDED = sparse ? new Set(["triage"]) : new Set(["pm", "triage"]);
    const slugs = ROLE_CATALOG.map((e) => e.slug).filter((s) => !FIRST_DISPATCH_EXCLUDED.has(s));
    if (slugs.length === 0) {
      return { ok: false, reason: "empty-catalog" };
    }
    const slugEnum = z.enum(slugs as [string, ...string[]]);
    const schema = z.object({
      slug: slugEnum,
      reasoning: z.string().max(500),
    });

    // 5. Render the catalog as a numbered list: `N. displayName (slug) — purpose`.
    //    Giving the model both the human label and the machine slug helps it
    //    reason about role overlap (e.g. "Engineer" vs "Backend Engineer").
    //    `triage` (and on non-sparse rows, `pm`) are excluded from the
    //    rendering too — they're not in the enum, so showing them would
    //    just tempt the model.
    const catalogList = ROLE_CATALOG.filter((e) => !FIRST_DISPATCH_EXCLUDED.has(e.slug))
      .map((e, i) => `${i + 1}. ${e.displayName} (${e.slug}) — ${e.purpose}`)
      .join("\n");

    // 6. Truncate the description so a giant pasted log doesn't blow up the
    //    Haiku context budget. 4 KB is plenty for a title + a paragraph of
    //    intent — the classifier doesn't need the full body to decide.
    const description =
      rawDescription.length > 4000
        ? rawDescription.slice(0, 4000) + "…(truncated)"
        : rawDescription;

    // 7. The LLM call via the local-cc bridge. claude -p over subscription
    //    returns free-text, so the system prompt sandwiches strict JSON-
    //    output requirements (head + tail) around the routing instructions.
    //
    //    The HARD RULES block is conditional: when the ticket is sparse
    //    (M5j), `pm` IS on the menu and the prompt frames it as the right
    //    pick for "nothing to build against yet" cases. When the ticket
    //    is well-spec'd, `pm` is NOT on the menu and the prompt retains
    //    the M5h-era anti-PM language for belt-and-suspenders.
    const pmRule = sparse
      ? "1. `pm` IS on the menu BECAUSE this ticket is sparse (terse title + little/no description + no acceptance criteria). " +
        "Pick `pm` if you cannot match a clear specialist — PM will refine the acceptance criteria so the next role has something concrete to build against. " +
        "Even when sparse, if the title contains an unmistakable domain word ('SQL', 'CSS', 'OAuth', 'Dockerfile', etc.), prefer the matching specialist over PM."
      : "1. `pm` is a refinement role for genuinely vague tickets that lack acceptance criteria or are unclear about goal/scope. " +
        "DO NOT pick `pm` if the ticket has a clear technical goal — even if it's terse. Phrases like " +
        "'Spike: …', 'Audit …', 'Add …', 'Fix …', 'Build …', 'Implement …', 'Migrate …', 'Refactor …', " +
        "'Optimise …', 'Benchmark …', 'Investigate …' signal a clear-enough technical intent — go straight to a specialist or `engineer`.";
    const systemPrompt = [
      OUTPUT_SPEC_HEADER,
      "Schema:",
      '{"slug":"<one of the catalog slugs listed in the user message>","reasoning":"<one-sentence rationale>"}',
      "",
      "# Routing instructions",
      "",
      "You are a router for an agent platform. Pick the SINGLE best role for the FIRST agent to work on this ticket.",
      "",
      "HARD RULES:",
      pmRule,
      "2. PREFER specialists over the generic `engineer` catchall. Match on domain words: " +
        "`security_engineer` for auth/oauth/token/csrf/xss/secrets; `staff_engineer` or `software_architect` for spikes/architecture/system design; " +
        "`frontend_engineer` for UI/component/css/react/accessibility; `backend_engineer` for API/route/handler/DB/server; " +
        "`devops` or `sre` for CI/deploy/infra/Docker/k8s/observability; `dba` for schema/migration/index/query-perf; " +
        "`data_engineer` for ETL/pipeline/warehouse; `product_designer` for UX/visual/wireframe.",
      "3. Only fall back to `engineer` when no specialist clearly matches AND the work is general-purpose coding.",
      "4. Never pick `triage` unless the ticket is explicitly a triage / classification task.",
      "",
      "# Reply format reminder",
      "",
      'Return ONE JSON object: {"slug":"...","reasoning":"..."}. First character MUST be `{`.',
    ].join("\n");
    const userPrompt =
      `Ticket title: ${title}\n` +
      `Description:\n${description}\n\n` +
      `Available roles:\n${catalogList}\n\n` +
      `Return the best-fitting slug.`;

    const bridge = await classifyViaLocalCc({
      tenantId,
      systemPrompt,
      prompt: userPrompt,
      ticketId,
    });
    if (!bridge.ok) {
      return { ok: false, reason: `bridge:${bridge.reason.slice(0, 120)}` };
    }

    // 7b. Parse + validate the JSON block claude -p returned.
    const parsed = safeParseJsonBlock<unknown>(bridge.text);
    if (!parsed) {
      console.warn(
        `[role-classifier] ticket=${ticketId} no JSON in claude reply: ${bridge.text.slice(0, 200)}`,
      );
      return { ok: false, reason: "no-json-in-reply" };
    }
    const valid = schema.safeParse(parsed);
    if (!valid.success) {
      console.warn(
        `[role-classifier] ticket=${ticketId} JSON failed schema: ${valid.error.issues[0]?.message ?? "invalid"}`,
      );
      return { ok: false, reason: "json-schema-failed" };
    }

    const pickedSlug = valid.data.slug;

    // 8. Defensive: Zod enum should have rejected unknown slugs already, but
    //    a future code path (e.g. structured-output retry mode) might let an
    //    invalid one through. Verify membership against the source of truth.
    if (!ROLE_CATALOG.some((e) => e.slug === pickedSlug)) {
      console.warn(
        `[role-classifier] ticket=${ticketId} model returned unknown slug="${pickedSlug}" — no-op`,
      );
      return { ok: false, reason: `unknown-slug:${pickedSlug.slice(0, 60)}` };
    }

    // 9. Persist. We use a CAS-style guard via `.is("requested_role", null)`
    //    so a concurrent operator pick (set between step 2 and step 9) wins
    //    over the classifier — we silently lose the race and the operator's
    //    choice stays.
    const { data: updated, error: updateErr } = await supabase
      .from("tickets")
      .update({ requested_role: pickedSlug })
      .eq("id", ticketId)
      .eq("tenant_id", tenantId)
      .is("requested_role", null)
      .select("id");
    if (updateErr) {
      console.warn(
        `[role-classifier] ticket=${ticketId} persist failed: ${updateErr.message.slice(0, 200)}`,
      );
      return { ok: false, reason: `persist-failed:${updateErr.message.slice(0, 120)}` };
    }
    if (!updated || updated.length === 0) {
      // Lost the race. The operator (or a parallel classifier invocation)
      // set `requested_role` first. Their pick wins — don't overwrite.
      return { ok: false, reason: "lost-race-to-operator" };
    }

    console.log(
      `[role-classifier] ticket=${ticketId} picked="${pickedSlug}" reasoning="${valid.data.reasoning.slice(0, 120)}"`,
    );
    return { ok: true, slug: pickedSlug };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[role-classifier] ticket=${args.ticketId} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2.5++ / F2 — classifier-on-every-dispatch with prior-role awareness.
//
// `classifyTicketRoleIfNeeded` (above) only runs on the truly FIRST dispatch —
// it persists its pick to `tickets.requested_role` so the dispatcher's M4 path
// honors the pick once on the next pass. After that single hop the dispatcher
// fell through to a deterministic state machine that only knew pm/engineer/qa,
// which meant specialist picks never got to chain — a security_engineer first
// dispatch was followed by a forced engineer/qa loop instead of (for example)
// security_engineer → qa → security_engineer.
//
// `classifyNextRole` is the per-dispatch sibling. It loads the ticket + last
// ~12 comments, asks Haiku to pick the next single best role (or `"done"`),
// and returns the pick to the dispatcher. CRITICALLY it does NOT persist the
// pick — `tickets.requested_role` is a one-shot signal that the M4 path
// consumes only on the first dispatch. Persisting from here would re-trigger
// that path on the next pass and stack-up two routing decisions per cycle.
//
// Cost trade-off (acknowledged): one extra Haiku call (~$0.0003–0.001, ~2-3s)
// per dispatch boundary. That's a small marginal cost compared to a missing
// specialist hand-off, and the dispatcher already eats a similar call on the
// first dispatch. The escape hatch (env DEVPILOT_CLASSIFIER_ON_EVERY_DISPATCH=0)
// is on the caller side in `dispatcher.ts`.

export type ClassifyNextResult =
  | { ok: true; pick: "done" | string; reasoning: string }
  | { ok: false; reason: string };

type ClassifyNextArgs = {
  ticketId: string;
  tenantId: string;
};

/**
 * Best-effort: pick the next role to advance a ticket given its current state
 * and the prior comment thread. Returns `"done"` when the model judges the
 * ticket terminal. Never throws — failures return `{ok: false, reason}` and the
 * caller falls back to the state-machine path.
 *
 * Defensive: when the ticket has no prior comments this returns
 * `{ok: false, reason: "no-history-use-first-dispatch-classifier"}` so the
 * caller can short-circuit to `classifyTicketRoleIfNeeded` (the first-dispatch
 * sibling) instead of duplicating its logic here.
 */
export async function classifyNextRole(args: ClassifyNextArgs): Promise<ClassifyNextResult> {
  const { ticketId, tenantId } = args;
  try {
    const supabase = supabaseService();

    // 1. Load the ticket. Service client because we're called from the
    //    dispatcher (Inngest function context, no user session).
    const { data: ticket, error: ticketErr } = await supabase
      .from("tickets")
      .select("id, title, description, status, requested_role")
      .eq("id", ticketId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (ticketErr || !ticket) {
      return { ok: false, reason: "ticket-not-found" };
    }

    // 2. Load the last ~12 comments oldest-first. We pull DESC with a limit
    //    then reverse so the prompt reads chronologically while still capping
    //    long-running threads.
    const HISTORY_LIMIT = 12;
    //    Tenant-scoped like the ticket read above: this window is what the
    //    router reasons over, so an unscoped read would let a planted comment on
    //    our ticket steer which role we dispatch next.
    const { data: rawComments, error: commentsErr } = await supabase
      .from("comments")
      .select("author_type, author_id, body, created_at")
      .eq("ticket_id", ticketId)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (commentsErr) {
      return {
        ok: false,
        reason: `comments-load-failed:${commentsErr.message.slice(0, 120)}`,
      };
    }
    const comments = (rawComments ?? []).slice().reverse();

    // 3. Short-circuit: if there's no history, defer to the first-dispatch
    //    classifier. Don't duplicate that logic here — the caller will see
    //    this reason and route to `classifyTicketRoleIfNeeded`.
    if (comments.length === 0) {
      return { ok: false, reason: "no-history-use-first-dispatch-classifier" };
    }

    // 4. Build the role catalog enum + `"done"` as an additional option.
    //    Reads `ROLE_CATALOG` at call time so newly-added slugs (e.g. F5's
    //    `verifier` shipped in the same wave) get picked up without code
    //    changes here.
    const slugs = ROLE_CATALOG.map((e) => e.slug);
    if (slugs.length === 0) {
      return { ok: false, reason: "empty-catalog" };
    }
    // Construct as `[head, ...rest]` so TS sees the non-empty-tuple shape that
    // z.enum requires. slugs.length === 0 is guarded above, so slugs[0] is
    // always defined here.
    const pickValues: [string, ...string[]] = [slugs[0]!, ...slugs.slice(1), "done"];
    const pickEnum = z.enum(pickValues);
    const schema = z.object({
      pick: pickEnum,
      // 500-char cap: Sonnet's reasoning routinely runs ~200-300 chars; the
      // earlier 200-char cap was rejecting valid replies and silently
      // forcing the dispatcher to the state-machine fallback.
      reasoning: z.string().max(500),
    });

    // 5. Render the catalog (`N. displayName (slug) — purpose`).
    const catalogList = ROLE_CATALOG.map(
      (e, i) => `${i + 1}. ${e.displayName} (${e.slug}) — ${e.purpose}`,
    ).join("\n");

    // 6. Build the transcript. Each line:
    //      [N] [author_type:author_id] body-excerpt
    //    Body capped at ~400 chars so a single huge comment can't blow the
    //    context budget. We also cap the whole transcript string at ~6 KB.
    const COMMENT_BODY_CAP = 400;
    const TRANSCRIPT_CAP = 6_000;
    const transcriptLines: string[] = [];
    let runningBytes = 0;
    for (let i = 0; i < comments.length; i += 1) {
      const c = comments[i]!;
      const rawBody = String(c.body ?? "");
      const body =
        rawBody.length > COMMENT_BODY_CAP
          ? `${rawBody.slice(0, COMMENT_BODY_CAP)}…(truncated)`
          : rawBody;
      const line = `[${i + 1}] [${c.author_type}:${c.author_id}] ${body}`;
      if (runningBytes + line.length > TRANSCRIPT_CAP) {
        transcriptLines.push(
          `[…${comments.length - i} earlier comments elided for prompt budget…]`,
        );
        break;
      }
      transcriptLines.push(line);
      runningBytes += line.length;
    }
    const transcript = transcriptLines.join("\n");

    // 7. Aggregate prior-role authorship counts so the model's "avoid loops"
    //    instruction is grounded in concrete numbers. Only agent authors
    //    count toward "this role already did N things".
    const agentCounts = new Map<string, number>();
    for (const c of comments) {
      if (c.author_type !== "agent") continue;
      const id = String(c.author_id ?? "").toLowerCase();
      if (!id) continue;
      agentCounts.set(id, (agentCounts.get(id) ?? 0) + 1);
    }
    const roleHistorySummary =
      agentCounts.size === 0
        ? "(no prior agent comments)"
        : Array.from(agentCounts.entries())
            .map(([role, n]) => `${role}=${n}`)
            .join(", ");

    // 7b. Render per-role counts as a numbered list with concrete numbers.
    //     Soft phrasing like "avoid repeats" reasons worse than literal
    //     counts the model can compare. Include zero-count slugs from the
    //     catalog so the model sees the FULL menu (not just roles that have
    //     already run) — this is what makes "pick something fresh" tractable.
    const roleCountsList = (() => {
      const lines: string[] = [];
      // Catalog order first (so the model sees the canonical set), then any
      // agent_id authors not in the catalog (custom roles) appended.
      const seen = new Set<string>();
      for (const e of ROLE_CATALOG) {
        const n = agentCounts.get(e.slug.toLowerCase()) ?? 0;
        lines.push(`- ${e.slug}: ${n}`);
        seen.add(e.slug.toLowerCase());
      }
      for (const [role, n] of agentCounts) {
        if (seen.has(role)) continue;
        lines.push(`- ${role}: ${n}`);
      }
      return lines.join("\n");
    })();

    // 7c. Surface the most-recent agent author so the HARD RULES below can
    //     reference "the role X that just ran". Empty string when the last
    //     comment is human/system.
    const mostRecentAgent = (() => {
      for (let i = comments.length - 1; i >= 0; i -= 1) {
        const c = comments[i]!;
        if (c.author_type === "agent") {
          return String(c.author_id ?? "").toLowerCase();
        }
      }
      return "";
    })();
    // Was the latest comment a QA reject? Soft heuristic: any agent=qa
    // comment whose body mentions reject / fail / not approved / blocked.
    // Used only to relax the "no same-role twice" rule (engineer-after-QA-
    // reject is the legitimate retry pattern).
    const lastQaWasReject = (() => {
      for (let i = comments.length - 1; i >= 0; i -= 1) {
        const c = comments[i]!;
        if (c.author_type !== "agent") continue;
        if (String(c.author_id ?? "").toLowerCase() !== "qa") return false;
        const body = String(c.body ?? "").toLowerCase();
        return /\b(reject|rejected|fail|failed|not approved|blocked|needs changes|nack|nacked)\b/.test(
          body,
        );
      }
      return false;
    })();

    // 8. Truncate ticket title + description for the prompt.
    const title = String(ticket.title ?? "").slice(0, 200);
    const rawDescription = String(ticket.description ?? "");
    const description =
      rawDescription.length > 2_000
        ? `${rawDescription.slice(0, 2_000)}…(truncated)`
        : rawDescription;
    const status = String(ticket.status ?? "");
    const currentRequested = (ticket.requested_role as string | null) ?? null;

    // 9. The LLM call via the local-cc bridge. Same rationale as the
    //    first-dispatch classifier above — runs over the operator's Claude
    //    subscription, not a vendor API key. The system prompt sandwiches
    //    strict JSON output requirements around the routing rules.
    const systemPrompt = [
      OUTPUT_SPEC_HEADER,
      "Schema:",
      '{"pick":"<one of the catalog slugs OR the literal string \\"done\\">","reasoning":"<one-sentence rationale>"}',
      "",
      "# Routing instructions",
      "",
      "You are the routing brain for an autonomous agent platform. " +
        "Given a ticket and its conversation history, pick the SINGLE best next role to advance it, " +
        'or return "done" if the ticket has reached its terminal goal and needs no more agent work.',
      "",
      "HARD RULES:",
      "- If the MOST RECENT agent comment is from role X and X has run >=1 time already with no QA reject " +
        'signal in the very next comment, X is DISQUALIFIED. Pick a different role OR return "done".',
      "- The only exception is when the most recent QA comment explicitly REJECTED — in that case the " +
        "engineer (or specialist who originally implemented) can run again as a retry.",
      "- Do NOT pick `pm` if `pm` already appears in the role counts above. PM is a one-shot " +
        "ticket-refinement role.",
      "- If the most recent comment is from `qa` with no reject signal, prefer `verifier` next (it runs " +
        "the build to confirm the code actually starts).",
      "- Prefer specialists over the generic `engineer`: when the ticket's subject domain clearly matches " +
        "a specialist slug (e.g. security_engineer, data_engineer, designer), pick the specialist over the " +
        "generic catchall.",
      '- Return "done" when: QA approved the work and there is nothing left to verify, or the ticket goal ' +
        "has been clearly met by the most recent agent comment.",
      "- Return the slug exactly as listed in the catalog.",
      "",
      "# Reply format reminder",
      "",
      'Return ONE JSON object: {"pick":"...","reasoning":"..."}. First character MUST be `{`.',
    ].join("\n");
    const userPrompt =
      `Ticket title: ${title}\n` +
      `Status: ${status}\n` +
      `Current requested_role: ${currentRequested ?? "(none)"}\n` +
      `Most recent agent comment role: ${mostRecentAgent || "(none)"}\n` +
      `Last QA comment was a reject signal: ${lastQaWasReject ? "yes" : "no"}\n` +
      `Prior agent participation (summary): ${roleHistorySummary}\n\n` +
      `Per-role comment counts so far:\n${roleCountsList}\n\n` +
      `Description:\n${description}\n\n` +
      `Conversation (oldest first):\n${transcript}\n\n` +
      `Available roles:\n${catalogList}\n\n` +
      `Pick the next role or "done".`;

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
        `[role-classifier:next] ticket=${ticketId} no JSON in claude reply: ${bridge.text.slice(0, 200)}`,
      );
      return { ok: false, reason: "no-json-in-reply" };
    }
    const valid = schema.safeParse(parsed);
    if (!valid.success) {
      console.warn(
        `[role-classifier:next] ticket=${ticketId} JSON failed schema: ${valid.error.issues[0]?.message ?? "invalid"}`,
      );
      return { ok: false, reason: "json-schema-failed" };
    }

    const pick = valid.data.pick;
    const reasoning = valid.data.reasoning;

    // 10. Defensive: Zod enum should have rejected anything not in the
    //     {slugs, "done"} set already, but a future structured-output retry
    //     mode might let an invalid one through. Verify membership against
    //     the source of truth.
    if (pick !== "done" && !ROLE_CATALOG.some((e) => e.slug === pick)) {
      console.warn(
        `[role-classifier:next] ticket=${ticketId} model returned unknown slug="${pick}" — falling back`,
      );
      return { ok: false, reason: `unknown-slug:${String(pick).slice(0, 60)}` };
    }

    return { ok: true, pick, reasoning };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[role-classifier:next] ticket=${args.ticketId} failed: ${msg.slice(0, 200)}`);
    return { ok: false, reason: msg.slice(0, 200) };
  }
}
