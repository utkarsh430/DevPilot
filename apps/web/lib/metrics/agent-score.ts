// PR 5 of the "Agent Learning + Scoreboard" system — the pure scoring core.
//
// No IO, no `server-only`, no DB types. `lib/metrics/agents.ts` does the reads
// and hands the facts here; this file owns every ranking decision so all of them
// are unit-testable without a database.
//
// ── The captain's locked decisions (plan: "Scoring design") ─────────────────
//
// 1. Base metric = SUCCESS RATE = clean work / total work, where "clean" means a
//    run with ZERO score-counting mistakes attributed to it.
//
// 2. Only `agent_mistakes.counts_against_score = true` counts. `human_correction`
//    is stored with that flag FALSE by the harvester and is therefore excluded
//    here by construction — an agent is never penalised because the captain
//    changed direction or supplied new information. Human corrections are still
//    COUNTED and SHOWN (`mistakesByType.human_correction`, `mistakeCount`) as
//    context; they just never reach `cleanRuns`.
//
// 3. Confidence-adjusted, so a tiny sample cannot top the board.
// 4. Below a minimum volume an agent is not ranked at all.
//
// ── Why Bayesian smoothing rather than a Wilson lower bound ─────────────────
// Both satisfy the requirement. Smoothing was chosen because it is a single
// legible formula — `(clean + α) / (total + α + β)`, "start everyone at the prior
// and let evidence move them" — that an operator reading the page can reason
// about and that we can re-tune by editing two numbers. Wilson's normal-
// approximation interval is strictly harder to explain, and it degrades oddly at
// the very small n (2–5 runs) this board is full of today, which is exactly the
// regime the adjustment exists to handle.
//
// ── The prior: α = 3, β = 1 (mean 0.75, weight 4 pseudo-runs) ───────────────
// A 0.5-mean prior (Laplace α=β=1) reads as "we assume an agent fails half the
// time", which is both wrong and demoralising as a default; 0.75 is a neutral
// "probably fine, prove it" starting point. Weight 4 is what makes the ordering
// the captain asked for come out right:
//
//     2 runs, 100% clean  → (2+3)/(2+4)     = 0.833
//     5 runs, 100% clean  → (5+3)/(5+4)     = 0.889   ← "approaches the top"
//    100 runs,  95% clean → (95+3)/(100+4)  = 0.942   ← still ahead of both
//     20 runs, 100% clean → (20+3)/(20+4)   = 0.958
//
// i.e. a lucky 2-run agent cannot outrank a proven high-volume one, ~5 clean runs
// already sit near the top of the band, and volume keeps paying off after that.
// A never-worked agent scores the bare prior (0.75) and is additionally excluded
// from the ranked list by MIN_RANKED_RUNS, so it can never be #1 by either route.

/** The closed `agent_mistakes.type` vocabulary (migration 20260734000000). */
export const MISTAKE_TYPES = [
  "verification_fail",
  "qa_reject",
  "run_failed",
  "gate_refusal",
  "human_correction",
] as const;

export type MistakeType = (typeof MISTAKE_TYPES)[number];

export type MistakeTypeCounts = Record<MistakeType, number>;

/** Prior successes. See the header for why 3/1. */
export const SCORE_PRIOR_ALPHA = 3;
/** Prior failures. */
export const SCORE_PRIOR_BETA = 1;

/**
 * Minimum runs before an agent is RANKED. Below this it is listed under
 * "not enough data yet" instead, so a 1-for-1 agent never sits at #1 next to one
 * with a hundred runs behind it. The plan proposes ~5; tune here.
 */
export const MIN_RANKED_RUNS = 5;

export function emptyMistakeCounts(): MistakeTypeCounts {
  return {
    verification_fail: 0,
    qa_reject: 0,
    run_failed: 0,
    gate_refusal: 0,
    human_correction: 0,
  };
}

export function isMistakeType(value: unknown): value is MistakeType {
  return typeof value === "string" && (MISTAKE_TYPES as readonly string[]).includes(value);
}

/** A run, reduced to what scoring needs. */
export type RunFact = {
  id: string;
  /**
   * COALESCE(runs.fan_out_role, agents.role) — resolved by the loader.
   *
   * NULL means UNATTRIBUTABLE: the run resolved to no role at all. Such runs are
   * real work and are summarised separately (`summarizeUnattributed`), but they
   * are NEVER bucketed into a scored row — see `buildRoleScoreRows`.
   */
  role: string | null;
  ticketId: string | null;
  /** Project the run's ticket belongs to, when it has one. Used for the model
   *  column only; never for scoring. */
  projectId?: string | null;
};

/** A harvested mistake, reduced to what scoring needs. */
export type MistakeFact = {
  /** `agent_mistakes.role` — already the COALESCE-resolved producer role.
   *  NULL/blank = unattributable, same treatment as an unattributable run. */
  role: string | null;
  type: MistakeType;
  /** `agent_mistakes.counts_against_score`. The ONLY gate on scoring. */
  countsAgainstScore: boolean;
  /** Nullable: comment-derived mistakes are correlated by phase, not by FK. */
  runId: string | null;
  ticketId: string | null;
};

// ── Synthetic platform runs are NOT agent work ─────────────────────────────
//
// `invokeLocalCcOneShot` (lib/runners/local-cc-oneshot.server.ts) and the plan
// runner bridge (lib/plan/runner-bridge.ts) each insert a `runs` row for a single
// internal LLM call — lesson extraction, semantic dedup, dependency suggestion,
// capability inference, dispatch classifiers, plan distill. They exist so the
// spend is metered and the operator has a record; they are platform plumbing, not
// an agent doing a ticket.
//
// Counting them was the bug this predicate fixes: 638 of them resolved to no
// role, pooled into a pseudo-agent called "unassigned", and — because a trivial
// one-shot LLM call essentially always succeeds — that pseudo-agent scored 99.4%
// and sat at #1 on both the Custom-agents board and the overall list.
//
// The predicate is the exact insert signature those two paths share, and every
// clause earns its place by excluding something that IS real work:
//   • runner_kind = 'local-cc'  — the queue those rows are written for.
//   • agent_id IS NULL          — a configured agent's run is real work.
//   • ticket_id IS NULL         — a ticket-bound run is real work. (`invoke…`
//                                 accepts an optional audit-only ticketId; when
//                                 it is set the run is attributable and stays.)
//   • fan_out_role IS NULL      — a fan-out sibling carries its role here.
//   • parent_run_id IS NULL     — a SUPERVISOR CHILD (app/api/runners/tools/
//                                 spawn) is also ticket-less and agent-less but
//                                 is genuine agent work; its parent pointer is
//                                 the only thing distinguishing it, so this
//                                 clause is load-bearing, not belt-and-braces.
export type RunShape = {
  agentId: string | null;
  ticketId: string | null;
  fanOutRole: string | null;
  parentRunId: string | null;
  runnerKind: string | null;
};

export function isSyntheticPlatformRun(run: RunShape): boolean {
  return (
    run.runnerKind === "local-cc" &&
    run.agentId == null &&
    run.ticketId == null &&
    run.fanOutRole == null &&
    run.parentRunId == null
  );
}

/** Normalise a raw role value; blank/absent means "no role resolved". */
export function normalizeRole(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Runs that survived the synthetic filter but still resolve to no role.
 *
 * These are REAL (they carry a ticket, or a supervisor parent) and worth showing
 * — but they are not an agent, so they get a flat informational summary with no
 * score, no rank and no display name. Nothing here can be sorted onto a
 * leaderboard because it is not a `RoleScoreRow` at all: the type system is what
 * makes "unattributed can't be #1" structural rather than a convention.
 */
export type UnattributedSummary = {
  runs: number;
  ticketsTouched: number;
  mistakes: number;
  scoringMistakes: number;
};

export function summarizeUnattributed(
  runs: readonly RunFact[],
  mistakes: readonly MistakeFact[],
): UnattributedSummary {
  const runIds = new Set<string>();
  const ticketIds = new Set<string>();
  for (const r of runs) {
    if (r.role != null) continue;
    runIds.add(r.id);
    if (r.ticketId) ticketIds.add(r.ticketId);
  }
  let mistakeCount = 0;
  let scoringMistakes = 0;
  for (const m of mistakes) {
    if (m.role != null) continue;
    mistakeCount += 1;
    if (m.countsAgainstScore) scoringMistakes += 1;
    if (m.ticketId) ticketIds.add(m.ticketId);
  }
  return {
    runs: runIds.size,
    ticketsTouched: ticketIds.size,
    mistakes: mistakeCount,
    scoringMistakes,
  };
}

export type RoleScoreRow = {
  /** Role slug — the attribution unit (see agents.ts on identity). */
  role: string;
  displayName: string;
  /** Catalog category, or null for a custom/unknown slug. */
  category: string | null;
  totalRuns: number;
  cleanRuns: number;
  /** Runs carrying at least one score-counting mistake. */
  faultedRuns: number;
  ticketsTouched: number;
  /** Distinct projects this role's runs touched, ascending. The model column is
   *  resolved from these — a role is tenant-wide, but the model is per project,
   *  so a role that ran in two differently-configured projects must say so
   *  rather than pick one and look authoritative. */
  projectIds: string[];
  /** Every mistake attributed to this role, human corrections included. */
  mistakeCount: number;
  /** Only `counts_against_score = true`. */
  scoringMistakeCount: number;
  mistakesByType: MistakeTypeCounts;
  /** cleanRuns / totalRuns — the honest, unsmoothed number, shown as detail. */
  rawSuccessRate: number;
  /** The confidence-adjusted ranking key. */
  score: number;
  /** False when totalRuns < MIN_RANKED_RUNS. */
  ranked: boolean;
};

/**
 * Confidence-adjusted success rate: `(clean + α) / (total + α + β)`.
 *
 * Defined for total = 0 (returns the bare prior mean) so a never-worked agent has
 * a number rather than a NaN; MIN_RANKED_RUNS is what keeps it off the podium.
 */
export function smoothedScore(cleanRuns: number, totalRuns: number): number {
  const clean = Math.max(0, cleanRuns);
  const total = Math.max(clean, totalRuns);
  return (clean + SCORE_PRIOR_ALPHA) / (total + SCORE_PRIOR_ALPHA + SCORE_PRIOR_BETA);
}

/** The unsmoothed rate, for display beside the score. 0 runs → 0. */
export function rawSuccessRate(cleanRuns: number, totalRuns: number): number {
  if (totalRuns <= 0) return 0;
  return Math.max(0, Math.min(1, cleanRuns / totalRuns));
}

export function isRanked(totalRuns: number): boolean {
  return totalRuns >= MIN_RANKED_RUNS;
}

/**
 * Ranking order: score desc, then volume desc (more evidence wins a tie), then
 * slug asc so the order is stable across renders.
 */
export function compareRoleScoreRows(a: RoleScoreRow, b: RoleScoreRow): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.totalRuns !== a.totalRuns) return b.totalRuns - a.totalRuns;
  return a.role.localeCompare(b.role);
}

/**
 * Build one scored row per ROLE from raw run + mistake facts.
 *
 * Bucketing is by the COALESCE-resolved role slug on BOTH sides: runs use
 * `COALESCE(fan_out_role, agents.role)` (the lib/metrics/project.ts rule, applied
 * by the loader) and mistakes use `agent_mistakes.role`, which the harvester
 * derived with that same rule. So the two sides agree by construction.
 *
 * "Clean" is computed per RUN: a run is faulted iff at least one score-counting
 * mistake names it. A mistake with a null `run_id` (comment-derived — comments
 * carry no run FK) therefore cannot mark any run faulted. That is deliberate and
 * conservative in the agent's favour: guessing which run it belonged to would
 * invent a failure. Such mistakes still appear in `mistakeCount` /
 * `mistakesByType`, so they are visible without silently moving the score.
 *
 * UNATTRIBUTABLE facts (`role === null`) are DROPPED here, not bucketed under a
 * placeholder slug. That is the structural half of the "unassigned can never be
 * #1" fix: with no bucket there is no row, so there is nothing for the sorter,
 * the category leaderboards or the "Top agent" tile to pick up. They are surfaced
 * by `summarizeUnattributed` instead, whose type carries no score and no rank.
 */
export function buildRoleScoreRows(input: {
  runs: readonly RunFact[];
  mistakes: readonly MistakeFact[];
  /** slug → human label (agents.name, else the catalog display name). */
  displayNameFor: (role: string) => string;
  /** slug → catalog category, or null for custom roles. */
  categoryFor: (role: string) => string | null;
}): RoleScoreRow[] {
  const { runs, mistakes, displayNameFor, categoryFor } = input;

  type Acc = {
    role: string;
    runIds: Set<string>;
    ticketIds: Set<string>;
    projectIds: Set<string>;
    faultedRunIds: Set<string>;
    mistakeCount: number;
    scoringMistakeCount: number;
    mistakesByType: MistakeTypeCounts;
  };

  const buckets = new Map<string, Acc>();
  const bucketFor = (role: string): Acc => {
    const existing = buckets.get(role);
    if (existing) return existing;
    const fresh: Acc = {
      role,
      runIds: new Set(),
      ticketIds: new Set(),
      projectIds: new Set(),
      faultedRunIds: new Set(),
      mistakeCount: 0,
      scoringMistakeCount: 0,
      mistakesByType: emptyMistakeCounts(),
    };
    buckets.set(role, fresh);
    return fresh;
  };

  for (const run of runs) {
    if (run.role == null) continue; // unattributable — never a scored bucket
    const acc = bucketFor(run.role);
    acc.runIds.add(run.id);
    if (run.ticketId) acc.ticketIds.add(run.ticketId);
    if (run.projectId) acc.projectIds.add(run.projectId);
  }

  for (const m of mistakes) {
    if (m.role == null) continue; // unattributable — never a scored bucket
    // A mistake can name a role that has no runs left in the window (its run row
    // was deleted, say). It still gets a bucket, with zero volume — which lands
    // it in "not enough data yet" rather than dropping the record.
    const acc = bucketFor(m.role);
    acc.mistakeCount += 1;
    acc.mistakesByType[m.type] += 1;
    if (m.ticketId) acc.ticketIds.add(m.ticketId);
    if (!m.countsAgainstScore) continue;
    acc.scoringMistakeCount += 1;
    // Only a mistake that names a run can mark that run faulted — and only if
    // the run is actually in this window, or `faultedRuns` could exceed
    // `totalRuns` and drive a negative clean count.
    if (m.runId && acc.runIds.has(m.runId)) acc.faultedRunIds.add(m.runId);
  }

  const rows: RoleScoreRow[] = [];
  for (const acc of buckets.values()) {
    const totalRuns = acc.runIds.size;
    const faultedRuns = acc.faultedRunIds.size;
    const cleanRuns = Math.max(0, totalRuns - faultedRuns);
    rows.push({
      role: acc.role,
      displayName: displayNameFor(acc.role),
      category: categoryFor(acc.role),
      totalRuns,
      cleanRuns,
      faultedRuns,
      ticketsTouched: acc.ticketIds.size,
      projectIds: [...acc.projectIds].sort(),
      mistakeCount: acc.mistakeCount,
      scoringMistakeCount: acc.scoringMistakeCount,
      mistakesByType: acc.mistakesByType,
      rawSuccessRate: rawSuccessRate(cleanRuns, totalRuns),
      score: smoothedScore(cleanRuns, totalRuns),
      ranked: isRanked(totalRuns),
    });
  }

  rows.sort(compareRoleScoreRows);
  return rows;
}

/** One comparable-peers leaderboard: the roles inside a single catalog category. */
export type CategoryLeaderboard = {
  category: string;
  /** Ranked members only, best first. */
  rows: RoleScoreRow[];
  /** The category's top agent, or null when nobody in it clears MIN_RANKED_RUNS. */
  top: RoleScoreRow | null;
  /** Members below MIN_RANKED_RUNS, shown but not ranked. */
  unranked: RoleScoreRow[];
};

/** Bucket for roles with no catalog entry (JD-synthesized customs). */
export const CUSTOM_LEADERBOARD_CATEGORY = "Custom agents";

/**
 * Split scored rows into per-category leaderboards — the REAL ranking.
 *
 * Why category and not one board per role slug: the attribution unit is the role,
 * and a tenant has ~one agent config per role, so a per-slug board would be a
 * list of one. The comparability the captain is protecting is "a QA's job is to
 * catch problems, an engineer's is to ship — don't rank them against each other",
 * and that boundary is exactly the catalog's category grouping (Engineering vs
 * Quality + Security vs Leadership / Product …). So each board ranks genuinely
 * comparable peers, and QA never competes with Engineer.
 *
 * `categoryOrder` fixes section order (the catalog's own declaration order);
 * anything outside it sorts last, alphabetically.
 */
export function groupIntoCategoryLeaderboards(
  rows: readonly RoleScoreRow[],
  categoryOrder: readonly string[],
): CategoryLeaderboard[] {
  const byCategory = new Map<string, RoleScoreRow[]>();
  for (const row of rows) {
    const key = row.category ?? CUSTOM_LEADERBOARD_CATEGORY;
    const list = byCategory.get(key) ?? [];
    list.push(row);
    byCategory.set(key, list);
  }

  const boards: CategoryLeaderboard[] = [];
  for (const [category, members] of byCategory) {
    const sorted = [...members].sort(compareRoleScoreRows);
    const ranked = sorted.filter((r) => r.ranked);
    boards.push({
      category,
      rows: ranked,
      top: ranked[0] ?? null,
      unranked: sorted.filter((r) => !r.ranked),
    });
  }

  boards.sort((a, b) => {
    const ai = categoryOrder.indexOf(a.category);
    const bi = categoryOrder.indexOf(b.category);
    if (ai !== bi)
      return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
    return a.category.localeCompare(b.category);
  });
  return boards;
}
