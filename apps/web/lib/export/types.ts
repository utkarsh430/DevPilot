// Audit-grade PDF export — the PURE, IO-free data model.
//
// This module is the contract between the aggregators (`*-audit.server.ts`,
// which read Postgres) and the renderer (`*-document.tsx`, which draws glyphs).
// It holds ONLY types + total, dependency-free helpers, so every rule that
// matters for an audit — what counts as untrusted, how a thread is ordered, how
// cost rolls up — is unit-testable without a live Supabase or a PDF runtime.
//
// ── The `Untrusted` carrier (AGENTS.md principle 6) ─────────────────────────
// An export bundles content written by three different kinds of author: the
// operator (human), an agent (`claude -p` narration, agent comments, handoff
// notes, an agent-filed ticket's own title/description), and the engine
// (system/reconciler comments, verification command + output tail). Agent and
// system text is DATA, never instructions — and in a document that a compliance
// reader will treat as a record, it must also be visibly attributed.
//
// So every such string is carried as `Untrusted`, a branded box. The brand is a
// real runtime field, not a phantom type: `untrusted()` is the only constructor,
// so a raw `string` can never be passed where the renderer expects attributed
// text (it is a compile error), and a reviewer can grep for the constructor to
// find every place agent text enters the document.
//
// Note what this is NOT: react-pdf draws text as glyphs — there is no HTML, no
// DOM, and no script channel in a PDF content stream — so the injection class
// that a HTML-renderer export would have is absent BY CONSTRUCTION, not by
// escaping. `Untrusted` therefore exists for ATTRIBUTION and for the prompt-
// injection reader (a human deciding whether to trust what they read), not as an
// XSS defence. The markdown allowlist (`markdown.ts`) is the separate guard that
// keeps raw HTML and `javascript:` links out of the AST in the first place.

import type { TicketStatus } from "@/lib/board/state";

/** Who authored a string. Drives both attribution chrome and reader trust. */
export type Trust = "human" | "agent" | "system";

/**
 * A string whose author is recorded alongside it. Constructed ONLY via
 * `untrusted()`; the `__untrusted` brand makes a bare string unassignable, so
 * the renderer cannot accidentally draw unattributed agent text.
 */
export type Untrusted = {
  readonly __untrusted: true;
  readonly trust: Trust;
  readonly value: string;
};

/** The sole constructor for `Untrusted`. */
export function untrusted(trust: Trust, value: string): Untrusted {
  return { __untrusted: true, trust, value };
}

/** Convenience: box `value` unless it is null/empty, in which case null. */
export function untrustedOrNull(trust: Trust, value: string | null | undefined): Untrusted | null {
  if (value === null || value === undefined) return null;
  if (value.trim().length === 0) return null;
  return untrusted(trust, value);
}

/**
 * Map a `comments.author_type` onto a trust level. Anything that is not
 * explicitly a human is treated as untrusted — the default leans safe, so a new
 * author_type added later is attributed as `system` rather than silently
 * inheriting the human's credibility.
 */
export function trustForAuthorType(authorType: string): Trust {
  if (authorType === "human" || authorType === "user") return "human";
  if (authorType === "agent") return "agent";
  return "system";
}

// ─── Thread ────────────────────────────────────────────────────────────────

export type ExportComment = {
  kind: "comment";
  id: string;
  /** Raw `comments.author_type` — kept for display ("agent", "system", …). */
  authorType: string;
  /** Raw `comments.author_id` — a role slug or a tool name (`devpilot_move_ticket`). */
  authorId: string;
  createdAt: string;
  body: Untrusted;
};

export type ExportHandoff = {
  kind: "handoff";
  id: string;
  /** Author role slug. */
  role: string;
  /** Closed vocabulary: built | decision | assumption | interface. */
  handoffKind: string;
  runId: string | null;
  createdAt: string;
  body: Untrusted;
};

export type ExportThreadEntry = ExportComment | ExportHandoff;

/**
 * Merge comments + handoffs into ONE chronological narrative.
 *
 * The audit reader wants a single timeline ("what was said, in what order"),
 * not two parallel lists they have to zipper mentally. Ordering is `created_at`
 * ASC with a stable tiebreak on `kind` then `id`, so a comment and a handoff
 * written in the same millisecond (the agent posts both at the end of a turn)
 * land in a deterministic order — a re-export of an unchanged ticket must be
 * byte-identical, or the artifact is not a record.
 */
export function mergeThread(
  comments: readonly ExportComment[],
  handoffs: readonly ExportHandoff[],
): ExportThreadEntry[] {
  const merged: ExportThreadEntry[] = [...comments, ...handoffs];
  merged.sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    // An unparseable timestamp sorts last rather than poisoning the comparator
    // with NaN (which would make the sort order implementation-defined).
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na !== nb) return na ? 1 : -1;
    if (!na && ta !== tb) return ta - tb;
    if (a.kind !== b.kind) return a.kind === "comment" ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return merged;
}

// ─── Runs ──────────────────────────────────────────────────────────────────

/** Token counts as reported by the runner for one model turn. */
export type TurnUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

/**
 * One model turn (`run_steps.kind = 'think'`), reduced to what an audit needs.
 *
 * Deliberately ABSENT: `payload.prompt`. It is the composed role system prompt
 * plus every fenced untrusted context block the agent was handed — re-emitting
 * it into a downloadable artifact would republish the platform's prompt IP and
 * bloat the PDF by orders of magnitude, for no audit value that `text` (what the
 * agent actually concluded) does not already carry.
 */
export type RunNarrationTurn = {
  idx: number;
  createdAt: string;
  /** The agent's own narration for this turn. Untrusted by definition. */
  text: Untrusted;
  model: string | null;
  runnerKind: string | null;
  llmProvider: string | null;
  finishReason: string | null;
  costCents: number;
  /**
   * WI-12 — `false` means "we cannot price this" (a self-hosted / OpenAI-
   * compatible endpoint we have no price table for), NOT "free". The rollup
   * propagates it so a zero is never read as a bargain.
   */
  costPriced: boolean;
  usage: TurnUsage;
};

/** A persisted takeover tool step (idx band 50_000–99_000), summarised. */
export type RunToolUse = {
  idx: number;
  createdAt: string;
  summary: Untrusted;
};

/** QA-gate evidence for a run (`run_verifications`), the L1 hand-off record. */
export type RunVerificationEvidence = {
  command: Untrusted;
  exitCode: number;
  headSha: string;
  baseSha: string | null;
  pushed: boolean;
  outputTail: Untrusted;
};

/**
 * What a verification record actually says. THREE states, not two.
 *
 * This mirrors `decideQaGate` (`lib/board/qa-gate.ts`) exactly, and the middle
 * state is the whole point:
 *
 *   • `passed`        — `exitCode === 0`. "The only true pass" (that gate's words).
 *   • `failed`        — `exitCode > 0`. A definite failure.
 *   • `indeterminate` — `exitCode < 0`. The check timed out, was killed, or could
 *     not be spawned at all; producers write `code ?? -1` for exactly this. The
 *     live gate FAILS OPEN here on purpose — a stalled check must not strand a
 *     ticket — but "we allowed the ticket through" is not the same fact as "the
 *     check passed", and a document that renders a green PASSED badge next to
 *     `exit -1` launders a check that never ran onto a signed-off audit record.
 *
 * A `> 0` test alone silently folds `indeterminate` into `passed`, which is the
 * unsafe direction. Hence a named classifier with its own tests rather than an
 * inline comparison at the render site.
 */
export type VerificationOutcome = "passed" | "failed" | "indeterminate";

export function classifyVerification(exitCode: number): VerificationOutcome {
  // A non-finite/NaN code is not evidence of anything — treat it as we treat a
  // killed check rather than letting `NaN > 0 === false` read as a pass.
  if (!Number.isFinite(exitCode)) return "indeterminate";
  if (exitCode < 0) return "indeterminate";
  if (exitCode > 0) return "failed";
  return "passed";
}

export type RunAudit = {
  id: string;
  status: string;
  statusReason: string | null;
  runnerKind: string | null;
  /** COALESCE(runs.fan_out_role, agents.role, first think step's payload.role). */
  role: string | null;
  agentName: string | null;
  budgetCents: number;
  spentCents: number;
  createdAt: string;
  lastEventAt: string;
  fanOutGroup: string | null;
  fanOutRole: string | null;
  replayOfRunId: string | null;
  /**
   * Deep link to the run's Langfuse trace, or null when LANGFUSE_PROJECT_ID
   * isn't configured. Tool-by-tool spans are deliberately NOT pulled into this
   * artifact (a deferred opt-in) — the link is the escape hatch to them.
   */
  langfuseTraceUrl: string | null;
  turns: RunNarrationTurn[];
  toolUses: RunToolUse[];
  verification: RunVerificationEvidence | null;
};

// ─── Cost ──────────────────────────────────────────────────────────────────

export type CostRollup = {
  /** Authoritative ledger total — summed from `runs.spent_cents`. */
  totalCents: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** False when ANY contributing turn was unpriced. See `RunNarrationTurn`. */
  costPriced: boolean;
  /** How many turns could not be priced. Rendered so the gap is legible. */
  unpricedTurns: number;
  runCount: number;
};

/**
 * Roll a ticket's runs up into one cost + token total.
 *
 * Two sources on purpose, and they are not interchangeable:
 *
 *  • CENTS come from `runs.spent_cents` — the ledger `recordSpend` writes and
 *    the budget gate reads. Re-deriving cents by summing per-step `cost_cents`
 *    would silently disagree with the ledger the moment a step is written
 *    outside the think loop.
 *
 *  • TOKENS come from the per-step `payload.usage`, because `runs` carries no
 *    token column at all.
 *
 * `costPriced` is the AND across every turn: one unpriced turn makes the whole
 * total unpriced, because a partially-priced sum is not a number an auditor can
 * act on. It is the conservative direction — we under-claim confidence.
 */
export function rollupCost(runs: readonly RunAudit[]): CostRollup {
  let totalCents = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let unpricedTurns = 0;

  for (const run of runs) {
    totalCents += Number.isFinite(run.spentCents) ? run.spentCents : 0;
    for (const turn of run.turns) {
      promptTokens += turn.usage.promptTokens ?? 0;
      completionTokens += turn.usage.completionTokens ?? 0;
      // Prefer the reported total; fall back to the parts so a runner that omits
      // `totalTokens` still contributes rather than reading as zero.
      totalTokens +=
        turn.usage.totalTokens ??
        (turn.usage.promptTokens ?? 0) + (turn.usage.completionTokens ?? 0);
      if (!turn.costPriced) unpricedTurns += 1;
    }
  }

  return {
    totalCents,
    promptTokens,
    completionTokens,
    totalTokens,
    costPriced: unpricedTurns === 0,
    unpricedTurns,
    runCount: runs.length,
  };
}

// ─── Relations ─────────────────────────────────────────────────────────────

/**
 * How a blocker is holding this ticket back. Mirrors `classifyBlocker`
 * (lib/integration/landed.ts) — `awaiting_land` is the WI-5 state where the
 * blocker is `done` but its commits are not on the integration branch yet.
 */
export type ExportLandOpenness = "closed" | "working" | "awaiting_land";

export type ExportRelationRef = {
  id: string;
  ticketNumber: number | null;
  /** A title may be agent-authored (an agent-filed ticket) — always attributed. */
  title: Untrusted;
  status: TicketStatus;
  /** Present only for blocking refs (blocked_by / builds_on). */
  landOpenness: ExportLandOpenness | null;
};

export type ExportRelations = {
  blockedBy: ExportRelationRef[];
  blocks: ExportRelationRef[];
  buildsOn: ExportRelationRef[];
  builtOnBy: ExportRelationRef[];
  related: ExportRelationRef[];
  duplicate: ExportRelationRef[];
  subIssues: ExportRelationRef[];
};

export function emptyRelations(): ExportRelations {
  return {
    blockedBy: [],
    blocks: [],
    buildsOn: [],
    builtOnBy: [],
    related: [],
    duplicate: [],
    subIssues: [],
  };
}

// ─── Attachments ───────────────────────────────────────────────────────────

/**
 * A ticket image, resolved to bytes so the PDF is SELF-CONTAINED (an audit
 * artifact that fetches an expiring signed URL at view time is not a record).
 *
 * `dataUri` is null when the fetch failed or the row was rejected; the renderer
 * draws an "image unavailable" placeholder carrying `unavailableReason`. An
 * image is evidence, but a missing image must never fail the export — the rest
 * of the record is still worth having.
 */
export type ExportAttachment = {
  id: string;
  mime: string;
  bytes: number;
  dataUri: string | null;
  unavailableReason: string | null;
};

// ─── Ticket ────────────────────────────────────────────────────────────────

export type ExportLabel = { name: string; color: string };

export type ExportTicket = {
  id: string;
  tenantId: string;
  projectId: string | null;
  ticketNumber: number | null;
  /**
   * Agent-authored when `sourceRunId` is set (WI-14 `devpilot_create_ticket`),
   * human-authored otherwise. The aggregator decides; the renderer just
   * attributes what it is handed.
   */
  title: Untrusted;
  description: Untrusted | null;
  acceptanceCriteria: Untrusted | null;
  status: TicketStatus;
  priority: number;
  retryCount: number;
  safetyCritical: boolean;
  planHold: boolean;
  planSessionId: string | null;
  /** WI-14 — the run that filed this ticket. Non-null ⇒ title/description are agent text. */
  sourceRunId: string | null;
  assigneeAgentId: string | null;
  requestedRole: string | null;
  gitBranchName: string | null;
  landedSha: string | null;
  integratedAt: string | null;
  parentTicketId: string | null;
  createdAt: string;
  updatedAt: string;
  labels: ExportLabel[];
};

export type TicketAuditExport = {
  ticket: ExportTicket;
  thread: ExportThreadEntry[];
  relations: ExportRelations;
  attachments: ExportAttachment[];
  runs: RunAudit[];
  cost: CostRollup;
};

// ─── Project ───────────────────────────────────────────────────────────────

/**
 * The project's LLM configuration, REDACTED for export.
 *
 * `llm_credential_ref` (an opaque pointer to a vault entry) and `llm_base_url`
 * (an operator's private endpoint, and the SSRF-sensitive value the provider
 * seam guards) are NEVER emitted. `customEndpoint` carries the only fact an
 * auditor needs from the base URL: that one was configured at all.
 */
export type ExportLlmConfig = {
  provider: string | null;
  model: string | null;
  customEndpoint: boolean;
};

export type ExportProject = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  repoUrl: string | null;
  defaultBranch: string;
  integrationBranch: string | null;
  autoLandEnabled: boolean;
  agentTicketCreation: boolean;
  /** The per-project ticket ceiling, or NULL when the project inherits it.
   *  Recorded because "agents may file tickets" and "how many per run" are
   *  two halves of one autonomy setting, and an audit that states only the
   *  first understates what the project permits. */
  agentTicketMaxPerRun: number | null;
  projectType: string;
  teamTier: string;
  stackEcosystem: string;
  createdAt: string;
  llm: ExportLlmConfig;
};

/**
 * One durable, operator-confirmed stack pick.
 *
 * Every string here is CATALOG-OWNED — re-derived from the stored key through
 * `getCapability`/`getServiceEntry`, never the DB row's denormalized label and
 * never a repo string. That is the same property the plan prompt's stack frame
 * relies on, and it is why this block needs no fence.
 */
export type ExportStackRow = {
  capability: string;
  service: string;
  provider: string;
  /** The `FreeTier` discriminant (`none` | `free_forever` | `limited_free` | …). */
  freeTier: string;
  /** The catalog's one-line note for the tier. Absent for `none`. */
  freeTierNote: string | null;
  overridden: boolean;
};

/** A ticket rendered as one summary line (beyond the full-detail cap). */
export type TicketSummary = {
  id: string;
  ticketNumber: number | null;
  title: Untrusted;
  status: TicketStatus;
  role: string | null;
  totalCents: number;
  /**
   * False when any of this ticket's turns was unpriced. Carried per-row for the
   * same reason the ticket scope carries it: a `$0.00` in a spend column is a
   * claim, and it must not be made for work we cannot price.
   */
  costPriced: boolean;
  runs: number;
  retries: number;
  updatedAt: string;
};

export type ProjectRollups = {
  totalSpendCents: number;
  /**
   * Model turns across the WHOLE project (not just the full-detail window) that
   * ran on a provider with no price table. Counted from `run_steps` rather than
   * derived from the exported tickets on purpose: deriving it from the capped
   * detail set would UNDER-report on exactly the boards big enough to be capped,
   * and under-reporting is the unsafe direction for this flag.
   */
  unpricedTurns: number;
  /**
   * False when ANY contributing turn was unpriced — same semantics, and the same
   * conservative AND, as `CostRollup.costPriced`. A project whose runs went to a
   * self-hosted endpoint has `totalSpendCents: 0`, and printing that headline
   * without this caveat says "free" when the truth is "we cannot price it".
   */
  costPriced: boolean;
  totalRuns: number;
  totalTickets: number;
  ticketsDone: number;
  ticketsFailed: number;
  ticketsInFlight: number;
  totalRetries: number;
  totalRunTimeMs: number;
  avgTicketConvergenceMs: number;
  lastActivityAt: string | null;
  byRole: Array<{
    role: string;
    displayName: string;
    runs: number;
    doneRuns: number;
    failedRuns: number;
    totalCents: number;
    avgDurationMs: number;
  }>;
};

/**
 * Why the export does not contain every ticket in full. Rendered verbatim in
 * the document: a bounded artifact that does not SAY it is bounded reads as a
 * complete record, which is the one thing an audit export must never do.
 */
export type ExportBounding = {
  totalTickets: number;
  fullCount: number;
  summaryCount: number;
  cap: number;
  truncated: boolean;
};

export type ProjectAuditExport = {
  project: ExportProject;
  stack: ExportStackRow[];
  rollups: ProjectRollups;
  /** Full per-ticket detail, up to `bounding.cap`. */
  tickets: TicketAuditExport[];
  /** One line per ticket beyond the cap. */
  summaries: TicketSummary[];
  bounding: ExportBounding;
  generatedAt: string;
};

// ─── Formatting helpers (pure; shared by both documents) ────────────────────

export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The caveat that must accompany a spend figure, or null when the figure stands
 * on its own.
 *
 * Pure and separate from the component because it encodes a CLAIM, not a style:
 * "this number is complete" versus "this number is a lower bound". PDF text is
 * drawn as subsetted glyph ids, so a rendered document cannot be grepped for its
 * own words — a test can only hold this line if the decision lives somewhere it
 * can be called. Both scopes render through this, so they cannot drift into
 * saying different things about the same situation.
 */
export function spendCaveat(rollup: { costPriced: boolean; unpricedTurns: number }): string | null {
  if (rollup.costPriced) return null;
  const turns = rollup.unpricedTurns;
  return (
    `${turns} model turn${turns === 1 ? "" : "s"} ran against a provider with no price table ` +
    "(a self-hosted or OpenAI-compatible endpoint). Their cost is NOT included in the totals " +
    "above and is not zero — the spend figures are a LOWER BOUND."
  );
}

/** The short form of `spendCaveat`, for a tile or a table cell. */
export const SPEND_CAVEAT_SHORT = "partially unpriced";

/**
 * Is a think step's `payload.cost_priced` an UNPRICED marker?
 *
 * ONE rule, used by both scopes — `toTurn` (ticket) and the project-wide
 * unpriced scan — because they previously disagreed and a divergence here means
 * a project's headline says "priced" while its tickets say otherwise.
 *
 * The rule is: **unpriced iff the value is exactly `false`.** Anything else,
 * including an ABSENT key, counts as priced. Absent is the important case and it
 * is not an edge: every step written before WI-12 has no `cost_priced` key at
 * all, and those were all Anthropic runs that we could price.
 *
 * Why not the more conservative "null is also unpriced": PostgREST cannot tell
 * an absent key from a JSON `null` — `payload->cost_priced` and
 * `payload->>cost_priced` both come back as `null` for either (verified). The
 * only SQL that separates them is jsonb containment (`payload @> '{"cost_priced":
 * null}'`), and this project's unpriced scan FAILS LOUD, so a mis-formed exotic
 * filter would break every project export to fix a case the runner cannot
 * produce (`run-agent.ts` writes `cost_priced: cost.priced`, always a boolean).
 * Treating null as unpriced in TS alone would have been worse than the
 * divergence: it would silently reclassify every legacy step as unpriced and
 * flag healthy old projects as "partially unpriced".
 *
 * So both sides agree on the runner's actual contract, and the agreement lives
 * here rather than in two expressions that happen to match.
 */
export function isUnpricedMarker(costPriced: unknown): boolean {
  return costPriced === false;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n.toLocaleString("en-US");
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** ISO → "2026-07-16 14:03 UTC". UTC always: an audit needs one clock. */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}
