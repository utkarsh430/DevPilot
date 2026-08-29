// Audit-export aggregation for tickets — the Postgres read layer.
//
// ── The DI shape, and why this file has no `server-only` ────────────────────
// Every IO dependency arrives as an argument (`AuditDeps`): the client to read
// tenant data with, the tenant to scope it to, the service client for
// `integration_queue`, the image resolver, and the Langfuse config. Nothing is
// imported from `lib/db/server` or `images.server`, so this module loads under
// Vitest — which is the only way the N+1 guard AND the cross-tenant guards below
// can be TESTS rather than comments. `ticket-audit.server.ts` is the thin server
// wrapper that supplies the real dependencies. Same pure/`.server` split as
// `lib/projects/doc-extract.ts`.
//
// ── Tenant scoping is EXPLICIT here, never inherited from the client ────────
// `deps.db` is RLS-bound for the ticket route but SERVICE-ROLE (RLS off) for the
// background project job, which has no session. So this module must not assume
// the client filters anything: `deps.tenantId` is applied by hand to every read
// that could return a row we did not derive from an already-scoped id. See
// `loadRelationsByTicketIds` for the two vectors that made this necessary.
//
// ── Batch-first, and why it is the load-bearing decision ────────────────────
// Everything here is built on primitives keyed on `.in("ticket_id", ids)`. The
// single-ticket export is literally `loadTicketAuditBatch([id])[0]`, and the
// project export calls the SAME batch with up to `MAX_FULL_TICKETS` ids. That is
// what keeps the query count CONSTANT (~9 round trips) whether you export one
// ticket or thirty.
//
// The alternative — a per-ticket loader the project path calls in a loop —
// reads fine and is a latency bomb: 30 tickets × (ticket + comments + handoffs +
// relations + refs + attachments + runs + steps + verifications) is ~270 serial
// Supabase round trips against a cloud Postgres, which is minutes, not seconds,
// and it grows with the board. There is no version of this that gets fixed later
// without rewriting the loaders, so the batch shape is the starting point rather
// than an optimisation.
//
// ── Audit depth: narration + cost + evidence (Postgres only) ────────────────
// What an auditor gets from here: what each agent SAID (per-model-turn
// narration), what it COST (ledger cents + token counts, with pricing
// confidence), what it PROVED (the QA-gate verification record), and the
// conversation around it (comments + handoffs, merged). Tool-by-tool spans are
// NOT pulled — they live in Langfuse and each run carries a deep link instead.
// That is a deliberate scope line: Langfuse is an external service with its own
// availability and rate limits, and putting it on the export's critical path
// would make a download fail for reasons that have nothing to do with the
// record. Fetching spans is a deferred opt-in.
//
// ── Trust attribution ───────────────────────────────────────────────────────
// Every string that an agent or the engine wrote is boxed as `Untrusted` before
// it leaves this module, so the renderer literally cannot draw it unattributed.
// A ticket's own title/description is agent-authored exactly when `source_run_id`
// is set (WI-14 `devpilot_create_ticket`) — that column is the discriminator, not
// a guess.
//
// ── Fail loud where a silent gap would mislead ──────────────────────────────
// Most loaders in this repo degrade to `[]` on error, which is right for a UI
// panel. It is WRONG here for two reads:
//   • blocker land-state — an unreadable `integration_queue` must not render a
//     done-but-unlanded blocker as clean (the exact unsafe state WI-5 exists to
//     prevent, now printed on a document someone signs off against).
//   • run verification — an unreadable `run_verifications` must not render a
//     failing QA gate as "no evidence, all good".
// Both throw. A failed export is recoverable; a confidently wrong one is not.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TicketStatus } from "@/lib/board/state";
import { classifyBlocker, LAND_PENDING_QUEUE_STATES } from "@/lib/integration/landed";
import { langfuseTraceUrl } from "@/lib/tracing/url";
import { summarizeToolUse } from "@/lib/runs/terminal-feed";
import type { AttachmentRow } from "@/lib/board/attachment-delivery";
import { groupRelationIds, type InverseDepRow, type OwnDepRow } from "@/lib/export/relations";
import {
  emptyRelations,
  isUnpricedMarker,
  mergeThread,
  rollupCost,
  trustForAuthorType,
  untrusted,
  untrustedOrNull,
  type ExportAttachment,
  type ExportComment,
  type ExportHandoff,
  type ExportLandOpenness,
  type ExportRelationRef,
  type ExportRelations,
  type ExportTicket,
  type RunAudit,
  type RunNarrationTurn,
  type RunToolUse,
  type RunVerificationEvidence,
  type TicketAuditExport,
} from "@/lib/export/types";

/**
 * Everything this aggregator needs from the outside world. Supplied for real by
 * `ticket-audit.server.ts`, and faked by the unit tests.
 */
export type AuditDeps = {
  /**
   * The client tenant data is read with.
   *
   * DELIBERATELY named `db`, not `rls`: it is RLS-bound for the ticket route
   * (`supabaseServer()`) but SERVICE-ROLE for the background project job, which
   * has no session and therefore no RLS identity at all. The earlier name said
   * "rls" while the project path assigned a service client to it, which made the
   * tenant boundary look automatic when it was OFF — and that is exactly how a
   * cross-tenant leak got in (see `tenantId`).
   *
   * So: NEVER assume this client filters anything. Every read that can return a
   * row we did not derive from an already-scoped id must carry an explicit
   * `.eq("tenant_id", deps.tenantId)`.
   */
  db: SupabaseClient;
  /**
   * The tenant this whole aggregation is scoped to. Required, and applied
   * EXPLICITLY to every read that could otherwise surface a foreign row — so the
   * boundary holds identically whether `db` is RLS-bound or service-role.
   *
   * Callers derive it from a row they have already authorised: the ticket route
   * from the ticket's own `tenant_id` (after its 404 guard), the project job from
   * its `exports` job row's stamped tenant.
   */
  tenantId: string;
  /**
   * Service-role client, used ONLY for `integration_queue` — it exposes SELECT
   * to tenant members and the caller has already asserted membership.
   */
  service: SupabaseClient;
  /** Bounded signed-URL → bytes. Injected so this module stays IO-free. */
  resolveImages: (args: {
    supabase: SupabaseClient;
    tenantId: string;
    rows: readonly AttachmentRow[];
  }) => Promise<ExportAttachment[]>;
  langfuse: { baseUrl: string; projectId: string };
};

/**
 * Persisted takeover tool steps live in this idx band (ordinary think turns are
 * 0..N; engine audit markers sit at 99_99x). Mirrors the band the takeover path
 * writes into.
 */
const TAKEOVER_IDX_MIN = 50_000;
const TAKEOVER_IDX_MAX = 99_000;

/** Bound on narration turns rendered per run. */
const MAX_TURNS_PER_RUN = 60;
/** Bound on tool steps rendered per run. */
const MAX_TOOL_USES_PER_RUN = 40;
/** Bound on thread entries per ticket. */
const MAX_THREAD_ENTRIES = 300;

// ─── Full ticket rows ──────────────────────────────────────────────────────

/**
 * The columns the export needs. Deliberately NOT `loadBoardTickets`' select:
 * that one is the board card's subset and omits every column an audit turns on
 * (tenant/assignee/branch/land state/plan linkage/provenance). No existing
 * loader returns the full row, so this is the one place that does.
 */
const FULL_TICKET_COLUMNS =
  "id, tenant_id, project_id, ticket_number, title, description, acceptance_criteria, " +
  "status, priority, retry_count, safety_critical, plan_hold, plan_session_id, source_run_id, " +
  "assignee_agent_id, requested_role, git_branch_name, landed_sha, integrated_at, " +
  "parent_ticket_id, column_position, created_at, updated_at";

type FullTicketRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  ticket_number: number | null;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  status: string;
  priority: number | null;
  retry_count: number | null;
  safety_critical: boolean | null;
  plan_hold: boolean | null;
  plan_session_id: string | null;
  source_run_id: string | null;
  assignee_agent_id: string | null;
  requested_role: string | null;
  git_branch_name: string | null;
  landed_sha: string | null;
  integrated_at: string | null;
  parent_ticket_id: string | null;
  column_position: number | null;
  created_at: string;
  updated_at: string;
};

/**
 * Batch: full ticket rows by id, scoped to the tenant. Throws — a ticket we
 * cannot read is not a ticket with no data.
 *
 * The `.eq("tenant_id", …)` is what makes this the TRUST ROOT of the whole
 * aggregation: every other id downstream (`present`, and therefore the comment /
 * handoff / attachment / run reads keyed on it) is derived from what this
 * returns, so those inherit the scope by construction. Without it they would all
 * inherit a caller's mistake instead.
 */
export async function loadFullTicketsByIds(
  deps: AuditDeps,
  ids: readonly string[],
): Promise<Map<string, FullTicketRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await deps.db
    .from("tickets")
    .select(FULL_TICKET_COLUMNS)
    .eq("tenant_id", deps.tenantId)
    .in("id", ids as string[]);
  if (error) throw new Error(`export: ticket load failed: ${error.message}`);
  return new Map(((data ?? []) as unknown as FullTicketRow[]).map((r) => [r.id, r]));
}

function toExportTicket(
  row: FullTicketRow,
  labels: Map<string, ExportTicket["labels"]>,
): ExportTicket {
  // WI-14 — an agent-filed ticket's own title/description are agent text. The
  // column IS the discriminator; nothing else about the row distinguishes them.
  const authorTrust = row.source_run_id ? "agent" : "human";
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    ticketNumber: row.ticket_number,
    title: untrusted(authorTrust, row.title),
    description: untrustedOrNull(authorTrust, row.description),
    acceptanceCriteria: untrustedOrNull(authorTrust, row.acceptance_criteria),
    status: row.status as TicketStatus,
    priority: row.priority ?? 0,
    retryCount: row.retry_count ?? 0,
    safetyCritical: row.safety_critical === true,
    planHold: row.plan_hold === true,
    planSessionId: row.plan_session_id,
    sourceRunId: row.source_run_id,
    assigneeAgentId: row.assignee_agent_id,
    requestedRole: row.requested_role,
    gitBranchName: row.git_branch_name,
    landedSha: row.landed_sha,
    integratedAt: row.integrated_at,
    parentTicketId: row.parent_ticket_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    labels: labels.get(row.id) ?? [],
  };
}

// ─── Labels ────────────────────────────────────────────────────────────────

async function loadLabelsByTicketIds(
  supabase: SupabaseClient,
  ids: readonly string[],
): Promise<Map<string, ExportTicket["labels"]>> {
  const out = new Map<string, ExportTicket["labels"]>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("ticket_labels")
    .select("ticket_id, labels(name, color)")
    .in("ticket_id", ids as string[]);
  if (error) throw new Error(`export: label load failed: ${error.message}`);
  for (const row of (data ?? []) as unknown as Array<{
    ticket_id: string;
    labels: { name: string; color: string } | Array<{ name: string; color: string }> | null;
  }>) {
    const lbls = Array.isArray(row.labels) ? row.labels : row.labels ? [row.labels] : [];
    if (lbls.length === 0) continue;
    const list = out.get(row.ticket_id) ?? [];
    for (const l of lbls) list.push({ name: l.name, color: l.color });
    out.set(row.ticket_id, list);
  }
  return out;
}

// ─── Comments ──────────────────────────────────────────────────────────────

/** Batch twin of `loadTicketComments` (lib/board/queries.ts), `.in()`-keyed. */
export async function loadCommentsByTicketIds(
  deps: AuditDeps,
  ids: readonly string[],
): Promise<Map<string, ExportComment[]>> {
  const supabase = deps.db;
  const out = new Map<string, ExportComment[]>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("comments")
    .select("id, ticket_id, author_type, author_id, body, created_at")
    .in("ticket_id", ids as string[])
    // Same class as the `runs` read below: `comments_member_write` constrains
    // only the comment's own `tenant_id`, so a foreign tenant can comment on OUR
    // ticket and their body would render in our PDF.
    .eq("tenant_id", deps.tenantId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`export: comment load failed: ${error.message}`);
  for (const c of (data ?? []) as unknown as Array<{
    id: string;
    ticket_id: string;
    author_type: string;
    author_id: string;
    body: string;
    created_at: string;
  }>) {
    const list = out.get(c.ticket_id) ?? [];
    list.push({
      kind: "comment",
      id: c.id,
      authorType: c.author_type,
      authorId: c.author_id,
      createdAt: c.created_at,
      body: untrusted(trustForAuthorType(c.author_type), c.body),
    });
    out.set(c.ticket_id, list);
  }
  return out;
}

// ─── Handoffs ──────────────────────────────────────────────────────────────

/**
 * Batch handoff loader. `project_handoffs` has no drawer loader at all — the
 * only reader today is the prompt builder (`lib/roles/context.ts`), which walks
 * blocking ancestors. Here we want the ticket's OWN entries: what this ticket's
 * agents claimed they built/decided/assumed.
 */
export async function loadHandoffsByTicketIds(
  deps: AuditDeps,
  ids: readonly string[],
): Promise<Map<string, ExportHandoff[]>> {
  const supabase = deps.db;
  const out = new Map<string, ExportHandoff[]>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("project_handoffs")
    .select("id, ticket_id, run_id, role, kind, body, created_at")
    .in("ticket_id", ids as string[])
    // Same class: the row carries its own tenant_id, so scope on it rather than
    // trusting that a clean ticket_id implies a clean handoff.
    .eq("tenant_id", deps.tenantId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`export: handoff load failed: ${error.message}`);
  for (const h of (data ?? []) as unknown as Array<{
    id: string;
    ticket_id: string;
    run_id: string | null;
    role: string;
    kind: string;
    body: string;
    created_at: string;
  }>) {
    const list = out.get(h.ticket_id) ?? [];
    list.push({
      kind: "handoff",
      id: h.id,
      role: h.role,
      handoffKind: h.kind,
      runId: h.run_id,
      createdAt: h.created_at,
      // A handoff is written by an agent, by definition of the MCP tool.
      body: untrusted("agent", h.body),
    });
    out.set(h.ticket_id, list);
  }
  return out;
}

// ─── Relations ─────────────────────────────────────────────────────────────

/**
 * Batch relations. Six queries total regardless of N: own rows, inverse rows,
 * the referenced tickets, the land-pending queue, sub-issues — grouped through
 * the SAME pure `groupRelationIds` the drawer's route uses.
 *
 * ── This function is where a cross-tenant leak lived. Two vectors, both real ──
 * `ticket_dependencies` and `tickets.parent_ticket_id` are the only places the
 * aggregation reads rows it did NOT derive from an already-scoped id — a
 * relation edge and a parent pointer are both attacker-nominated ids. And the
 * write policies do not stop either one:
 *
 *   • `ticket_dependencies_member_write` (core.sql) constrains only `ticket_id`,
 *     NOT `blocks_ticket_id` — so a tenant-A member can point an edge from their
 *     own ticket at a KNOWN tenant-B ticket uuid, and the write passes.
 *   • `tickets_member_write` gates a row's own `tenant_id`, NOT its
 *     `parent_ticket_id` — so a foreign tenant can parent their ticket onto
 *     ours, and it comes back from the sub-issue read below.
 *
 * With the project job's service client (RLS off) either one rendered a FOREIGN
 * ticket's title/number/status — and, for a blocker, its land state — straight
 * into a downloadable PDF.
 *
 * So both reads are explicitly `.eq("tenant_id", deps.tenantId)` now. A foreign
 * id simply resolves to no row and is dropped by `resolve()` below, exactly as
 * if it had been deleted. The write policy is tightened too (migration
 * `20260729000000`), but that is defence in depth — THIS is the boundary,
 * because it holds for every row already in the table.
 */
export async function loadRelationsByTicketIds(
  deps: AuditDeps,
  ids: readonly string[],
): Promise<Map<string, ExportRelations>> {
  const supabase = deps.db;
  const out = new Map<string, ExportRelations>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, emptyRelations());

  const [ownRes, invRes, subRes] = await Promise.all([
    supabase
      .from("ticket_dependencies")
      .select("ticket_id, blocks_ticket_id, relation_type")
      .in("ticket_id", ids as string[]),
    supabase
      .from("ticket_dependencies")
      .select("ticket_id, blocks_ticket_id, relation_type")
      .in("blocks_ticket_id", ids as string[]),
    supabase
      .from("tickets")
      .select("id, ticket_number, title, status, source_run_id, parent_ticket_id")
      // LEAK VECTOR 2: `parent_ticket_id` is attacker-settable across tenants.
      .eq("tenant_id", deps.tenantId)
      .in("parent_ticket_id", ids as string[]),
  ]);
  if (ownRes.error) throw new Error(`export: relations load failed: ${ownRes.error.message}`);
  if (invRes.error) throw new Error(`export: relations load failed: ${invRes.error.message}`);
  if (subRes.error) throw new Error(`export: sub-issue load failed: ${subRes.error.message}`);

  type DepRow = { ticket_id: string; blocks_ticket_id: string; relation_type: string };
  const ownRows = (ownRes.data ?? []) as unknown as DepRow[];
  const invRows = (invRes.data ?? []) as unknown as DepRow[];

  // Every ticket referenced from either direction, resolved in ONE query.
  const refIds = new Set<string>();
  for (const r of ownRows) refIds.add(r.blocks_ticket_id);
  for (const r of invRows) refIds.add(r.ticket_id);

  type RefRow = {
    id: string;
    ticket_number: number | null;
    title: string;
    status: string;
    source_run_id: string | null;
    landed_sha: string | null;
  };
  let refsById = new Map<string, RefRow>();
  if (refIds.size > 0) {
    const { data, error } = await supabase
      .from("tickets")
      .select("id, ticket_number, title, status, source_run_id, landed_sha")
      // LEAK VECTOR 1: `blocks_ticket_id` is attacker-settable across tenants
      // (the write policy only constrains `ticket_id`). Without this the project
      // job's service client rendered a foreign ticket's title/status/land-state.
      .eq("tenant_id", deps.tenantId)
      .in("id", Array.from(refIds));
    if (error) throw new Error(`export: relation ref load failed: ${error.message}`);
    refsById = new Map(((data ?? []) as unknown as RefRow[]).map((r) => [r.id, r]));
  }

  // Only ask the land queue about refs that survived the tenant filter — a
  // foreign id is already dropped, and probing it would be a (tiny) existence
  // oracle for no benefit.
  const landPending = await loadLandPendingSet(deps, Array.from(refsById.keys()));

  const toRef = (row: RefRow, blocking: boolean): ExportRelationRef => ({
    id: row.id,
    ticketNumber: row.ticket_number,
    // A referenced ticket may itself have been filed by an agent.
    title: untrusted(row.source_run_id ? "agent" : "human", row.title),
    status: row.status as TicketStatus,
    landOpenness: blocking
      ? (classifyBlocker({
          status: row.status as TicketStatus,
          landedSha: row.landed_sha,
          landPending: landPending.has(row.id),
        }) as ExportLandOpenness)
      : null,
  });

  const resolve = (refIdList: readonly string[], blocking: boolean): ExportRelationRef[] =>
    refIdList
      .map((id) => refsById.get(id))
      .filter((r): r is RefRow => r !== undefined)
      .map((r) => toRef(r, blocking));

  for (const id of ids) {
    const own: OwnDepRow[] = ownRows
      .filter((r) => r.ticket_id === id)
      .map((r) => ({ blocks_ticket_id: r.blocks_ticket_id, relation_type: r.relation_type }));
    const inverse: InverseDepRow[] = invRows
      .filter((r) => r.blocks_ticket_id === id)
      .map((r) => ({ ticket_id: r.ticket_id, relation_type: r.relation_type }));

    const grouped = groupRelationIds({ own, inverse });
    // Land-state is resolved ONLY for the blocking flavours: a `related` ref
    // never gates readiness, so labelling it "awaiting land" would print a
    // constraint that does not exist.
    out.set(id, {
      blockedBy: resolve(grouped.blockedBy, true),
      blocks: resolve(grouped.blocks, false),
      buildsOn: resolve(grouped.buildsOn, true),
      builtOnBy: resolve(grouped.builtOnBy, false),
      related: resolve(grouped.related, false),
      duplicate: resolve(grouped.duplicate, false),
      subIssues: (
        (subRes.data ?? []) as unknown as Array<{
          id: string;
          ticket_number: number | null;
          title: string;
          status: string;
          source_run_id: string | null;
          parent_ticket_id: string;
        }>
      )
        .filter((s) => s.parent_ticket_id === id)
        .map((s) => ({
          id: s.id,
          ticketNumber: s.ticket_number,
          title: untrusted(s.source_run_id ? "agent" : "human", s.title),
          status: s.status as TicketStatus,
          landOpenness: null,
        })),
    });
  }

  return out;
}

/**
 * Which of these tickets still owe a landing? FAIL LOUD.
 *
 * `fetchLandPendingSet` (lib/board/dependencies.ts) degrades to "assume a
 * landing is owed" on error, which is the safe direction for a READINESS gate —
 * the dependent waits. It is the WRONG direction for a document: printing
 * "awaiting land" for every blocker because a query failed is a confidently
 * wrong record. An export that cannot establish land state must not be produced.
 *
 * Service-role for the same reason the dependency loader uses it:
 * `integration_queue` exposes SELECT to tenant members only, and the caller has
 * already asserted membership.
 */
async function loadLandPendingSet(
  deps: AuditDeps,
  ticketIds: readonly string[],
): Promise<Set<string>> {
  if (ticketIds.length === 0) return new Set();
  const { data, error } = await deps.service
    .from("integration_queue")
    .select("ticket_id")
    .in("ticket_id", ticketIds as string[])
    // Same class (integrity only here — this read yields a membership set of ids
    // we already hold, not content — but a foreign queue row for our ticket would
    // still flip a blocker to "awaiting land" in our document).
    .eq("tenant_id", deps.tenantId)
    .in("status", LAND_PENDING_QUEUE_STATES as unknown as string[]);
  if (error) {
    throw new Error(`export: integration_queue read failed (land state unknown): ${error.message}`);
  }
  return new Set((data ?? []).map((r) => r.ticket_id as string));
}

// ─── Attachments ───────────────────────────────────────────────────────────

/** Batch attachment rows + server-side byte resolve, so the PDF stands alone. */
export async function loadAttachmentsByTicketIds(
  deps: AuditDeps,
  tickets: readonly FullTicketRow[],
): Promise<Map<string, ExportAttachment[]>> {
  const supabase = deps.db;
  const out = new Map<string, ExportAttachment[]>();
  if (tickets.length === 0) return out;
  const ids = tickets.map((t) => t.id);

  const { data, error } = await supabase
    .from("ticket_attachments")
    .select("id, ticket_id, storage_key, mime, bytes")
    .in("ticket_id", ids)
    // Same class. (JWT inserts are denied on this table, so the attack needs a
    // service-role writer — but `selectDeliverableAttachments`' tenant-scoped
    // storage-key check is a second wall precisely because rows can be wrong.)
    .eq("tenant_id", deps.tenantId)
    .order("created_at", { ascending: true });
  // Not fail-loud: a missing image is visible in the artifact as a placeholder,
  // and cannot make the reader believe something false about the work.
  if (error) {
    console.error(`[export] attachment row load failed: ${error.message}`);
    return out;
  }

  const rowsByTicket = new Map<string, AttachmentRow[]>();
  for (const r of (data ?? []) as unknown as Array<{
    id: string;
    ticket_id: string;
    storage_key: string;
    mime: string;
    bytes: number;
  }>) {
    const list = rowsByTicket.get(r.ticket_id) ?? [];
    list.push({ id: r.id, storageKey: r.storage_key, mime: r.mime, bytes: r.bytes });
    rowsByTicket.set(r.ticket_id, list);
  }

  await Promise.all(
    tickets.map(async (t) => {
      const rows = rowsByTicket.get(t.id);
      if (!rows || rows.length === 0) return;
      // Tenant comes off the TICKET ROW — never a caller value. It is what
      // scopes the storage keys inside `selectDeliverableAttachments`.
      const images = await deps.resolveImages({
        supabase,
        tenantId: t.tenant_id,
        rows,
      });
      out.set(t.id, images);
    }),
  );

  return out;
}

// ─── Runs ──────────────────────────────────────────────────────────────────

type StepRow = {
  run_id: string;
  idx: number;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toTurn(step: StepRow): RunNarrationTurn {
  const p = step.payload ?? {};
  const usage = (p.usage ?? {}) as Record<string, unknown>;
  return {
    idx: step.idx,
    createdAt: step.created_at,
    // The agent's narration — untrusted by definition.
    text: untrusted("agent", typeof p.text === "string" ? p.text : ""),
    model: typeof p.model === "string" ? p.model : null,
    runnerKind: typeof p.runner_kind === "string" ? p.runner_kind : null,
    llmProvider: typeof p.llm_provider === "string" ? p.llm_provider : null,
    finishReason: typeof p.finish_reason === "string" ? p.finish_reason : null,
    costCents: num(p.cost_cents) ?? 0,
    // ONE shared rule with the project-wide unpriced scan (see
    // `isUnpricedMarker`): unpriced iff exactly `false`. Absent — a legacy step
    // written before WI-12 — is PRICED; those predate the unpriced-provider
    // concept and were all Anthropic. The two used to disagree about a JSON
    // `null`, which the runner cannot produce but which would have made a
    // project's headline contradict its own tickets.
    costPriced: !isUnpricedMarker(p.cost_priced),
    usage: {
      promptTokens: num(usage.promptTokens),
      completionTokens: num(usage.completionTokens),
      totalTokens: num(usage.totalTokens),
    },
  };
  // NOTE: `payload.prompt` is deliberately not read. See `RunNarrationTurn`.
}

function toToolUse(step: StepRow): RunToolUse {
  const p = step.payload ?? {};
  // Reuse the Run Inspector's summariser so the export words a tool step the
  // same way the live UI does — an auditor comparing the two must not have to
  // reconcile two vocabularies.
  const summary = summarizeToolUse(
    typeof p.name === "string" ? p.name : typeof p.tool === "string" ? p.tool : "tool",
    p.input ?? p.args ?? null,
  );
  return { idx: step.idx, createdAt: step.created_at, summary: untrusted("agent", summary) };
}

/**
 * Batch run audit. Five queries regardless of N: runs, their think steps, their
 * tool steps, agents (for role/name), and verifications.
 */
export async function loadRunsAuditByTicketIds(
  deps: AuditDeps,
  ids: readonly string[],
): Promise<Map<string, RunAudit[]>> {
  const supabase = deps.db;
  const langfuse = deps.langfuse;
  const out = new Map<string, RunAudit[]>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, []);

  type RunRow = {
    id: string;
    ticket_id: string | null;
    agent_id: string | null;
    status: string;
    status_reason: string | null;
    runner_kind: string | null;
    budget_cents: number;
    spent_cents: number;
    created_at: string;
    last_event_at: string;
    fan_out_group: string | null;
    fan_out_role: string | null;
    replay_of_run_id: string | null;
  };
  const { data: runData, error: runErr } = await supabase
    .from("runs")
    .select(
      "id, ticket_id, agent_id, status, status_reason, runner_kind, budget_cents, spent_cents, " +
        "created_at, last_event_at, fan_out_group, fan_out_role, replay_of_run_id",
    )
    .in("ticket_id", ids as string[])
    // A tenant-clean `ticket_id` does NOT make the RUN clean. `runs.ticket_id` is
    // a nullable FK to ANY ticket and `runs_member_write` constrains only the
    // run's own `tenant_id`, so tenant B can attach a run to tenant A's ticket
    // and it comes back from this scan — rendering B's NARRATION TEXT into A's
    // PDF. "The ids are already scoped, so reads keyed on them are safe" is the
    // reasoning that produced this bug: it holds only when the child's tenancy is
    // implied by the parent, and for `runs` it is not.
    .eq("tenant_id", deps.tenantId)
    .order("created_at", { ascending: true });
  if (runErr) throw new Error(`export: run load failed: ${runErr.message}`);
  const runs = (runData ?? []) as unknown as RunRow[];
  if (runs.length === 0) return out;

  const runIds = runs.map((r) => r.id);
  const agentIds = Array.from(
    new Set(runs.map((r) => r.agent_id).filter((v): v is string => v !== null)),
  );

  const [stepsRes, agentsRes, verifRes] = await Promise.all([
    supabase
      .from("run_steps")
      .select("run_id, idx, kind, payload, created_at")
      .in("run_id", runIds)
      .in("kind", ["think", "tool_call"])
      .order("idx", { ascending: true }),
    agentIds.length > 0
      ? supabase.from("agents").select("id, name, role").in("id", agentIds)
      : Promise.resolve({ data: [], error: null } as const),
    supabase
      .from("run_verifications")
      .select("run_id, command, exit_code, head_sha, base_sha, pushed, output_tail")
      .in("run_id", runIds)
      // LIVE HOLE, found by the fourth review: this sat inside the Promise.all
      // 22 lines below a `runs` read that HAS the predicate, and the round-3
      // source-scan missed it because its regex chunked to the next `;` and the
      // first table in this array is exempt — so the whole block was skipped.
      // A foreign run_verifications row attached to one of our runs renders
      // ATTACKER-CHOSEN `command` / `output_tail` / `exit_code: 0` / `pushed`
      // into an audit PDF as forged QA evidence: the document would assert a
      // check passed that never ran.
      .eq("tenant_id", deps.tenantId),
  ]);
  if (stepsRes.error) throw new Error(`export: run step load failed: ${stepsRes.error.message}`);
  if (agentsRes.error) throw new Error(`export: agent load failed: ${agentsRes.error.message}`);
  // FAIL LOUD. `loadRunVerification` fails OPEN (null → "no record → allow"),
  // which is right for the live gate: a DB hiccup must not strand a ticket. In a
  // document it is exactly backwards — "no record" prints as "nothing to see
  // here", so an unreadable table would silently launder a failing QA gate into
  // a clean audit trail.
  if (verifRes.error) {
    throw new Error(
      `export: verification read failed (QA evidence unknown): ${verifRes.error.message}`,
    );
  }

  const agentsById = new Map(
    ((agentsRes.data ?? []) as unknown as Array<{ id: string; name: string; role: string }>).map(
      (a) => [a.id, a],
    ),
  );

  const steps = (stepsRes.data ?? []) as unknown as StepRow[];
  const thinkByRun = new Map<string, StepRow[]>();
  const toolByRun = new Map<string, StepRow[]>();
  for (const s of steps) {
    if (s.kind === "think") {
      const list = thinkByRun.get(s.run_id) ?? [];
      list.push(s);
      thinkByRun.set(s.run_id, list);
    } else if (s.idx >= TAKEOVER_IDX_MIN && s.idx <= TAKEOVER_IDX_MAX) {
      // Only the takeover band. An ordinary tool_call step (idx 0..N) is part of
      // the think loop's own accounting and is covered by Langfuse; the takeover
      // band is human-driven work that exists nowhere else in Postgres.
      const list = toolByRun.get(s.run_id) ?? [];
      list.push(s);
      toolByRun.set(s.run_id, list);
    }
  }

  const verifByRun = new Map<string, RunVerificationEvidence>();
  for (const v of (verifRes.data ?? []) as unknown as Array<{
    run_id: string;
    command: string;
    exit_code: number;
    head_sha: string;
    base_sha: string | null;
    pushed: boolean;
    output_tail: string | null;
  }>) {
    verifByRun.set(v.run_id, {
      // The command and its output are produced inside the agent's workspace —
      // untrusted, and attributed as such wherever they are drawn.
      command: untrusted("system", v.command),
      exitCode: v.exit_code,
      headSha: v.head_sha,
      baseSha: v.base_sha,
      pushed: v.pushed,
      outputTail: untrusted("system", v.output_tail ?? ""),
    });
  }

  for (const r of runs) {
    if (!r.ticket_id) continue;
    const think = thinkByRun.get(r.id) ?? [];
    const agent = r.agent_id ? agentsById.get(r.agent_id) : undefined;
    // COALESCE(fan_out_role, agents.role, first think step's payload.role) —
    // Phase 0 runs persist no agent row, so the step payload is the only source.
    const stepRole = think
      .map((s) => (s.payload as { role?: unknown } | null)?.role)
      .find((v): v is string => typeof v === "string" && v.length > 0);
    const role = r.fan_out_role ?? agent?.role ?? stepRole ?? null;

    const audit: RunAudit = {
      id: r.id,
      status: r.status,
      statusReason: r.status_reason,
      runnerKind: r.runner_kind,
      role,
      agentName: agent?.name ?? null,
      budgetCents: r.budget_cents,
      spentCents: r.spent_cents,
      createdAt: r.created_at,
      lastEventAt: r.last_event_at,
      fanOutGroup: r.fan_out_group,
      fanOutRole: r.fan_out_role,
      replayOfRunId: r.replay_of_run_id,
      langfuseTraceUrl: langfuseTraceUrl(langfuse.baseUrl, langfuse.projectId, r.id),
      turns: think.slice(0, MAX_TURNS_PER_RUN).map(toTurn),
      toolUses: (toolByRun.get(r.id) ?? []).slice(0, MAX_TOOL_USES_PER_RUN).map(toToolUse),
      verification: verifByRun.get(r.id) ?? null,
    };
    const list = out.get(r.ticket_id);
    if (list) list.push(audit);
  }

  return out;
}

// ─── The batch ─────────────────────────────────────────────────────────────

/**
 * Load the full audit bundle for every id, in a CONSTANT number of queries.
 *
 * The query count does NOT grow with `ids.length` — that is the property the
 * whole module is shaped around, and `__tests__/ticket-audit.test.ts` asserts it
 * (1 id and 30 ids must issue the same number of round trips). Ordering follows
 * `ids`; an id that resolved to no row is omitted (RLS did its job, or the
 * ticket was deleted mid-export).
 */
export async function loadTicketAuditBatch(
  deps: AuditDeps,
  ids: readonly string[],
): Promise<TicketAuditExport[]> {
  if (ids.length === 0) return [];

  const ticketRows = await loadFullTicketsByIds(deps, ids);
  const present = ids.filter((id) => ticketRows.has(id));
  if (present.length === 0) return [];
  const rows = present.map((id) => ticketRows.get(id)!);

  const [labels, comments, handoffs, relations, attachments, runs] = await Promise.all([
    loadLabelsByTicketIds(deps.db, present),
    loadCommentsByTicketIds(deps, present),
    loadHandoffsByTicketIds(deps, present),
    loadRelationsByTicketIds(deps, present),
    loadAttachmentsByTicketIds(deps, rows),
    loadRunsAuditByTicketIds(deps, present),
  ]);

  return rows.map((row) => {
    const runList = runs.get(row.id) ?? [];
    return {
      ticket: toExportTicket(row, labels),
      thread: mergeThread(comments.get(row.id) ?? [], handoffs.get(row.id) ?? []).slice(
        0,
        MAX_THREAD_ENTRIES,
      ),
      relations: relations.get(row.id) ?? emptyRelations(),
      attachments: attachments.get(row.id) ?? [],
      runs: runList,
      cost: rollupCost(runList),
    };
  });
}
