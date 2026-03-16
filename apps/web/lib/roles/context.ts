// Build the prompt context an agent sees when picking up a ticket.
// Phase 0: include the ticket fields + the last N comments (the NEWEST N,
// rendered chronologically oldest-first) so each role has the prior agents'
// work in view.
//
// The comment window MUST select the newest N, not the first N: a human reply
// on an `input_required` ticket fires a FRESH dispatch (board/actions.ts ~986)
// — there is no durable waitForEvent resume — and by then the ticket already
// has >N comments, so the operator's reply is always the newest comment. An
// ascending `.limit(N)` drops exactly that comment, silently truncating the
// instruction out of the prompt while the role classifier (which reads DESC,
// ticket-role-classifier.ts ~377) still sees it. Both readers now take the
// newest N over the same thread; keep them in sync.
//
// WI-6: also include the handoff notes agents wrote on this ticket's blocking
// ancestors (`project_handoffs`). Under the parallel drain, siblings are in
// flight at the same time, so an ancestor's work is not on the dependent's base
// branch — and its comments are not in the dependent's context — when the
// dependent is dispatched. Selection + rendering (dedup, caps, the untrusted
// fence) are pure and live in `./handoff.ts`; this module is only the IO.
//
// Plan brief: a ticket released by a plan commit carries `plan_session_id`, and
// this module injects that session's confirmed stack + discussion tail into its
// prompt. Today exactly one ticket per project ever carries the link (the held
// `project_scaffolder` released by `commitPlanAction`), but nothing here is
// scaffolder-specific - the link is the trigger, so any future plan-informed
// ticket inherits it. Selection + rendering (caps, the untrusted fence, the
// catalog-owned stack labels) are pure and live in `lib/plan/scaffolder-brief.ts`;
// this module is only the IO.
//
// Learnings (PR 4 of the Agent-Learning system): the `status='active'` lessons
// and standing operator preferences in `agent_learnings` are recalled into the
// prompt here - the step that closes the loop, since until this existed an
// approved lesson reached nothing. Selection (scope rules, relevance, the
// count/char bounds) and rendering (the untrusted fence) are pure and live in
// `lib/learning/select.ts`; this module is only the IO, exactly as for handoffs.
// Lesson bodies are recalled DATA, so they render in the TICKET prompt and are
// deliberately NOT routed into `composeRoleSystemPrompt`, where trusted role
// directives live.
//
// Both dispatch paths (`dispatcher.ts` fan-out + single) build their prompt
// through the buildTicketContext / renderTicketPrompt pair, so they inherit
// this automatically. Do not add a second injection path.

import { supabaseService } from "@/lib/db/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BLOCKING_RELATION_TYPES } from "@/lib/board/dependencies";
import { fenceUntrustedOutput } from "@/lib/board/qa-gate";
import {
  MAX_PLAN_DECISIONS,
  renderPlanBriefBlock,
  selectPlanDecisions,
  type PlanBrief,
  type PlanDecision,
} from "@/lib/plan/scaffolder-brief";
import { loadProjectStackTags } from "@/lib/stack/persist.server";
import { DEFAULT_ECOSYSTEM, isEcosystemChoice } from "@/lib/stack/rank";
import {
  MAX_HANDOFF,
  isHandoffKind,
  renderHandoffBlock,
  selectHandoffEntries,
  type HandoffEntry,
} from "@/lib/roles/handoff";
import {
  renderLearningsBlock,
  selectLearningsForDispatch,
  type LearningEntry,
  type LearningReader,
} from "@/lib/learning/select";

const MAX_COMMENTS = 12;

/**
 * Budget for the dedicated operator-reply block. Comfortably above any realistic
 * single instruction so the operator's latest word is rendered in full; the
 * fence keeps the tail if it is ever exceeded.
 */
const OPERATOR_REPLY_MAX_CHARS = 4000;

/**
 * How deep to walk the blocking-relation graph for ancestors. A `builds_on`
 * stack is the deep case in practice and is rarely more than 2–3 tickets; the
 * bound exists so a pathological (or cyclic) graph cannot turn one dispatch
 * into an unbounded fan of queries.
 */
const MAX_ANCESTOR_DEPTH = 4;

/** Hard cap on ancestors visited, for the same reason. */
const MAX_ANCESTORS = 25;

/**
 * How many rows to pull before the pure selector dedups + caps them. Larger
 * than MAX_HANDOFF because dedup happens after the fetch: N retries of one
 * ancestor collapse to one entry per kind, and we want the survivors to be the
 * newest, not whichever 12 rows the DB happened to return first.
 */
const HANDOFF_FETCH_LIMIT = 100;

export type TicketContext = {
  ticketId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: string;
  retryCount: number;
  comments: Array<{ authorType: string; authorId: string; body: string; createdAt: string }>;
  /**
   * The single newest HUMAN comment on this ticket, surfaced as its own framed
   * block so the operator's latest instruction can never be buried in — or
   * truncated out of — the MAX_COMMENTS window. Null when no human has commented.
   * UNTRUSTED (rendered inside a fence by `renderTicketPrompt`).
   */
  operatorReply: { authorId: string; body: string; createdAt: string } | null;
  /** Handoff notes from blocking ancestors. Already deduped + capped; UNTRUSTED
   *  (rendered inside a fence by `renderHandoffBlock`). */
  handoffs: HandoffEntry[];
  /**
   * The committed plan this ticket came out of (`tickets.plan_session_id`), or
   * null for the ~every ticket that has no such link. The stack half is
   * catalog-derived; the session half is UNTRUSTED (fenced by
   * `renderPlanBriefBlock`).
   */
  planBrief: PlanBrief | null;
  /**
   * Active lessons + standing operator preferences recalled for this dispatch
   * (`agent_learnings`, PR 4 of the Agent-Learning system). Already scope-
   * filtered, ranked and bounded; UNTRUSTED (rendered inside a fence by
   * `renderLearningsBlock`) - bodies are LLM-drafted from untrusted evidence or
   * operator-typed, so they are recalled DATA, never directives. That is also
   * why they render here and not in `composeRoleSystemPrompt`.
   */
  learnings: LearningEntry[];
};

/**
 * Options for the ticket context.
 *
 * `roles` exists solely for lesson scoping: a `role`-scoped lesson only applies
 * to the role(s) actually being dispatched. Single dispatch passes one slug; a
 * fan-out cohort shares ONE rendered prompt across its siblings, so it passes
 * the whole cohort. Omitted/empty (a replay whose original role cannot be
 * resolved) simply means no role-scoped lesson applies - `global` and `user`
 * lessons still do, and every other part of the context is unchanged.
 */
export type TicketContextOptions = {
  roles?: readonly string[];
};

export async function buildTicketContext(
  ticketId: string,
  tenantId: string,
  options: TicketContextOptions = {},
): Promise<TicketContext> {
  const supabase = supabaseService();
  const { data: ticket, error: tErr } = await supabase
    .from("tickets")
    .select(
      "id, project_id, title, description, acceptance_criteria, status, retry_count, plan_session_id",
    )
    .eq("id", ticketId)
    .eq("tenant_id", tenantId)
    .single();
  if (tErr || !ticket) throw new Error(`ticket ${ticketId} not found`);

  // Newest MAX_COMMENTS, then reverse so the prompt reads oldest-first. This
  // mirrors the role classifier (ticket-role-classifier.ts) so the router's
  // pick and the prompt's comment window are drawn from the SAME slice — see
  // the module docblock for why the old ascending `.limit()` dropped the
  // operator's reply.
  const { data: comments, error: cErr } = await supabase
    .from("comments")
    .select("author_type, author_id, body, created_at")
    .eq("ticket_id", ticketId)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(MAX_COMMENTS);
  if (cErr) throw new Error(`comments load failed: ${cErr.message}`);

  const ordered = (comments ?? [])
    .slice()
    .reverse()
    .map((c) => ({
      authorType: c.author_type as string,
      authorId: c.author_id as string,
      body: c.body as string,
      createdAt: c.created_at as string,
    }));

  // Hardening: guarantee the operator's latest reply survives. Even with the
  // newest-N window, a burst of system comments after a human reply could push
  // it out of the MAX_COMMENTS slots, so fetch the single newest human comment
  // directly. It is (a) surfaced as its own framed block by renderTicketPrompt
  // and (b) spliced back into the chronological history here if the window
  // dropped it — never a second injection path (see the module docblock).
  const { data: humanRows, error: hErr } = await supabase
    .from("comments")
    .select("author_type, author_id, body, created_at")
    .eq("ticket_id", ticketId)
    .eq("tenant_id", tenantId)
    .eq("author_type", "human")
    .order("created_at", { ascending: false })
    .limit(1);
  if (hErr) throw new Error(`comments load failed: ${hErr.message}`);
  const newestHuman = (humanRows ?? [])[0];
  const operatorReply = newestHuman
    ? {
        authorId: newestHuman.author_id as string,
        body: newestHuman.body as string,
        createdAt: newestHuman.created_at as string,
      }
    : null;

  if (
    operatorReply &&
    !ordered.some((c) => c.createdAt === operatorReply.createdAt && c.body === operatorReply.body)
  ) {
    ordered.push({
      authorType: "human",
      authorId: operatorReply.authorId,
      body: operatorReply.body,
      createdAt: operatorReply.createdAt,
    });
    ordered.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  const projectId = (ticket.project_id as string | null) ?? null;
  const handoffs = await loadAncestorHandoffs(
    supabase as unknown as SupabaseClient,
    ticketId,
    projectId,
    tenantId,
  );
  const planBrief = await loadPlanBrief(
    supabase as unknown as SupabaseClient,
    (ticket.plan_session_id as string | null) ?? null,
    projectId,
    tenantId,
  );
  // Relevance is scored against the ticket's OWN text - title/description/AC -
  // not the fully rendered prompt. The rendered prompt is not available yet
  // (this builds it), and it would be the wrong input anyway: it carries the
  // comment history and peer handoff notes, so scoring against it would let an
  // untrusted peer's wording steer which lessons a run recalls.
  const learnings = await selectLearningsForDispatch({
    supabase: supabase as unknown as LearningReader,
    tenantId,
    roles: options.roles ?? [],
    ticketText: [ticket.title, ticket.description, ticket.acceptance_criteria]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n"),
  });

  return {
    ticketId,
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptance_criteria,
    status: ticket.status,
    retryCount: ticket.retry_count ?? 0,
    comments: ordered,
    operatorReply,
    handoffs,
    planBrief,
    learnings,
  };
}

/**
 * Load the plan brief for a ticket released by a plan commit.
 *
 * Null in, null out - a ticket with no `plan_session_id` (i.e. all of them
 * except the plan-released scaffolder) renders byte-for-byte the prompt it
 * rendered before this existed. That includes a scaffolder released by the
 * abandonment fallback: no plan was committed, so there is no confirmed context
 * to carry, and it runs on base context exactly as a plain create's does.
 *
 * The session is re-scoped to the ticket's own project. The link is only ever
 * written by `commitPlanAction` from a tenant-checked session, so this is
 * defence in depth rather than the primary control - but the alternative is a
 * service-role read keyed on an id alone, and "trust the FK" is how a
 * cross-project prompt leak gets written.
 *
 * Every failure degrades to null: the brief is an enrichment, and losing it is
 * strictly better than not running the agent (same posture as the handoff
 * loader above).
 */
async function loadPlanBrief(
  supabase: SupabaseClient,
  planSessionId: string | null,
  projectId: string | null,
  tenantId: string,
): Promise<PlanBrief | null> {
  if (!planSessionId || !projectId) return null;

  const { data: session, error: sErr } = await supabase
    .from("planning_sessions")
    .select("id, tenant_id, project_id, goal_summary")
    .eq("id", planSessionId)
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (sErr || !session) return null;

  // The operator↔lead discussion only. The panel drafts (`pm`/`tech_lead`/
  // `devops`) and the consolidator's output are NOT decisions - they are
  // proposals, and the ones that survived are already on the board as the
  // committed tickets. Injecting them here would hand the scaffolder a second,
  // longer copy of the backlog it can already see.
  const { data: messages, error: mErr } = await supabase
    .from("planning_messages")
    .select("role, agent_role, content, created_at")
    .eq("session_id", planSessionId)
    .eq("tenant_id", tenantId)
    .or("role.eq.user,agent_role.eq.lead")
    .order("created_at", { ascending: false })
    .limit(MAX_PLAN_DECISIONS);

  const decisions: PlanDecision[] = [];
  if (!mErr && messages) {
    for (const row of messages) {
      const role = row.role as string;
      // `system` rows are engine bookkeeping, not discussion.
      if (role !== "user" && role !== "assistant") continue;
      decisions.push({
        speaker: role === "user" ? "operator" : "lead",
        body: (row.content as string | null) ?? "",
        createdAt: row.created_at as string,
      });
    }
  }

  // The DISPATCHED ticket's tenant, not `session.tenant_id`. Reading the tenant
  // back off a row we just looked up would make the row authorise its own read:
  // whatever session came back would define the scope, so the scope could never
  // exclude it. The session read above is now `.eq("tenant_id", tenantId)`, so
  // the two agree by construction — but the argument is the one that is true
  // independently of what the query returned.
  const stackTags = await loadProjectStackTags({ tenantId, projectId });

  const { data: project } = await supabase
    .from("projects")
    .select("stack_ecosystem")
    .eq("id", projectId)
    .maybeSingle();
  const rawEcosystem = project?.stack_ecosystem;
  const stackEcosystem = isEcosystemChoice(rawEcosystem) ? rawEcosystem : DEFAULT_ECOSYSTEM;

  return {
    goalSummary: (session.goal_summary as string | null) ?? null,
    decisions: selectPlanDecisions(decisions),
    stackTags,
    stackEcosystem,
  };
}

/**
 * Walk this ticket's BLOCKING ancestors — transitively, so a `builds_on` stack
 * A ← B ← C gives C both B's and A's notes.
 *
 * The `.in("relation_type", BLOCKING_RELATION_TYPES)` filter is load-bearing,
 * not defensive tidiness: `ticket_dependencies` is a multi-flavour relations
 * table and an @mention in a comment auto-creates a `related` row
 * (`parse-mentions.ts`). An unfiltered walk would therefore pull the handoff
 * notes of every ticket anyone happened to @mention — noise at best, and the
 * same bug class that once wedged tickets out of `ready` (see
 * BLOCKING_RELATION_TYPES' own docs).
 *
 * The dispatched ticket itself is never in the result, so its own rows can
 * never be injected back into its prompt.
 */
async function loadBlockingAncestorIds(
  supabase: SupabaseClient,
  ticketId: string,
): Promise<string[]> {
  const seen = new Set<string>([ticketId]);
  const ancestors: string[] = [];
  let frontier = [ticketId];

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && frontier.length > 0; depth++) {
    const { data, error } = await supabase
      .from("ticket_dependencies")
      .select("blocks_ticket_id")
      .in("ticket_id", frontier)
      .in("relation_type", BLOCKING_RELATION_TYPES as unknown as string[]);
    // A failed lookup must not fail the dispatch — handoff context is an
    // enrichment, and losing it is strictly better than not running the agent.
    if (error || !data) break;

    const next: string[] = [];
    for (const row of data) {
      const id = row.blocks_ticket_id as string | null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ancestors.push(id);
      next.push(id);
      if (ancestors.length >= MAX_ANCESTORS) return ancestors;
    }
    frontier = next;
  }
  return ancestors;
}

/**
 * Load the handoff rows written about this ticket's blocking ancestors, then
 * hand them to the pure selector for dedup + capping.
 *
 * Scoped to the ticket's own project: handoffs are a project-local artifact
 * (the board the siblings share). A ticket with no project has no such board,
 * so it gets nothing.
 */
async function loadAncestorHandoffs(
  supabase: SupabaseClient,
  ticketId: string,
  projectId: string | null,
  tenantId: string,
): Promise<HandoffEntry[]> {
  if (!projectId) return [];

  const ancestorIds = await loadBlockingAncestorIds(supabase, ticketId);
  if (ancestorIds.length === 0) return [];

  // Tenant-scoped: these rows are injected verbatim into the dispatched agent's
  // prompt, so this is the shortest path from a planted row to another tenant's
  // model context. `project_handoffs`' member write policy pins only the row's
  // own `tenant_id` — never the `project_id`/`ticket_id` it names.
  const { data: rows, error } = await supabase
    .from("project_handoffs")
    .select("ticket_id, role, kind, body, created_at")
    .eq("project_id", projectId)
    .eq("tenant_id", tenantId)
    .in("ticket_id", ancestorIds)
    .order("created_at", { ascending: false })
    .limit(HANDOFF_FETCH_LIMIT);
  if (error || !rows || rows.length === 0) return [];

  // Ticket keys are `DevPilot-<N>` (tickets.ticket_number), never the uuid or
  // column_position — see lib/board/ticket-key.ts.
  const { data: ticketRows } = await supabase
    .from("tickets")
    .select("id, ticket_number, title")
    .in("id", ancestorIds)
    .eq("tenant_id", tenantId);
  const meta = new Map<string, { number: number | null; title: string | null }>(
    (ticketRows ?? []).map((t) => [
      t.id as string,
      {
        number: (t.ticket_number as number | null) ?? null,
        title: (t.title as string | null) ?? null,
      },
    ]),
  );

  const entries: HandoffEntry[] = [];
  for (const row of rows) {
    // A row whose `kind` is outside the vocabulary can only come from a future
    // schema this build doesn't know how to render — skip it rather than
    // splicing an unlabelled blob into the prompt.
    if (!isHandoffKind(row.kind)) continue;
    const id = row.ticket_id as string;
    entries.push({
      ticketId: id,
      ticketNumber: meta.get(id)?.number ?? null,
      ticketTitle: meta.get(id)?.title ?? null,
      role: (row.role as string | null) ?? "agent",
      kind: row.kind,
      body: (row.body as string | null) ?? "",
      createdAt: row.created_at as string,
    });
  }
  return selectHandoffEntries(entries, MAX_HANDOFF);
}

/**
 * Serialize a ticket + comment history into a single prompt block for the
 * agent. Lightweight and deterministic so the trace stays readable.
 */
export function renderTicketPrompt(ctx: TicketContext): string {
  const parts: string[] = [];
  parts.push(`## Ticket\nID: ${ctx.ticketId}\nTitle: ${ctx.title}`);
  if (ctx.description) parts.push(`Description:\n${ctx.description}`);
  if (ctx.acceptanceCriteria) parts.push(`Acceptance Criteria:\n${ctx.acceptanceCriteria}`);
  parts.push(`Retry count: ${ctx.retryCount}`);
  // The operator's latest reply gets its own framed block BEFORE the general
  // comment history so it is never one anonymous line competing for a
  // MAX_COMMENTS slot. UNTRUSTED (principle 6) — fenced like every other
  // injected comment body.
  if (ctx.operatorReply) {
    const fenced = fenceUntrustedOutput(
      "operator reply",
      `[human:${ctx.operatorReply.authorId}] ${ctx.operatorReply.body}`,
      OPERATOR_REPLY_MAX_CHARS,
    );
    if (fenced) {
      parts.push(
        "## Operator reply (answer to the agent's question)\n" +
          "The most recent human instruction on this ticket — treat it as the " +
          "authoritative answer to any open question." +
          fenced,
      );
    }
  }
  if (ctx.comments.length > 0) {
    const history = ctx.comments
      .map((c) => `[${c.authorType}:${c.authorId}] ${c.body}`)
      .join("\n\n---\n\n");
    parts.push(`## Prior comments\n${history}`);
  }
  // The committed plan this ticket came out of. Placed before the handoff notes
  // because it is the frame the rest of the context sits in (what the operator
  // decided this project IS), and - like the handoffs - before "Your task" so
  // the final instruction is ours. The session-authored half is fenced inside
  // renderPlanBriefBlock; the stack half is catalog-derived, not repo/model text.
  const planBriefBlock = renderPlanBriefBlock(ctx.planBrief);
  if (planBriefBlock) parts.push(planBriefBlock);
  // UNTRUSTED peer content — renderHandoffBlock fences it. Placed AFTER the
  // ticket's own text and comments so the trusted material anchors the context
  // first, and BEFORE "Your task" so the final instruction is ours, not a peer's.
  const handoffBlock = renderHandoffBlock(ctx.handoffs);
  if (handoffBlock) parts.push(handoffBlock);
  // Recalled lessons + standing operator preferences. UNTRUSTED -
  // renderLearningsBlock fences them (bodies are LLM-drafted from untrusted
  // mistake evidence, or operator-typed). Placed LAST of the injected blocks
  // and still BEFORE "Your task" so: the ticket's own text anchors the context
  // first, a lesson cannot be mistaken for the ticket's requirements, and the
  // final instruction in the prompt is always ours. This is also the reason
  // lessons render HERE and never in composeRoleSystemPrompt - the system
  // prompt is where TRUSTED directives live, and an approved-but-wrong lesson
  // promoted to a directive would silently outrank the actual role contract.
  const learningsBlock = renderLearningsBlock(ctx.learnings);
  if (learningsBlock) parts.push(learningsBlock);
  parts.push("## Your task\nProduce your output now, following the format in the system prompt.");
  return parts.join("\n\n");
}
