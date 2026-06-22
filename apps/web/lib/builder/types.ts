// Phase 1 / M16 — Agent Builder canvas types.
//
// Phase 2.5 / M6 (this iteration) extends the canvas to author true multi-stage
// DAGs that the runtime fans out across cohorts of siblings. The locked
// contract is `agents.config.cohort_plan` — see `CohortPlan` below. Where
// Phase 1 emitted a scalar `fan_out` hint that the dispatcher cross-checked
// against `tickets.acceptance_strategy`, Phase 2.5 emits a versioned
// `cohort_plan` the dispatcher reads directly so the visual contract on the
// canvas matches runtime behavior.
//
// Back-compat: when a canvas has exactly one top-level cohort and no children
// the compiler ALSO emits a legacy scalar `fan_out` so older engine read paths
// keep working. Once the engine cuts over to `cohort_plan` everywhere the
// compiler can drop the `fan_out` emit entirely.
//
// The CRITICAL invariant from CLAUDE.md and the M16 spec is:
//
//   The canvas MUST only produce `agents.config` shapes the runtime
//   (loadRoleConfig + dispatcher + aggregator) already handles, OR the
//   `cohort_plan` shape the M6/Phase 2.5 dispatcher branch handles.
//
// Concretely that means everything the canvas can express has a runtime
// equivalent:
//
//   • role nodes        → resolve the role slug via `loadRoleConfig`
//   • skill nodes       → join into `config.skill_ids[]`
//   • data_source nodes → join into `config.data_source_ids[]`
//   • tool nodes        → join into `config.tool_package_ids[]`
//   • budget node       → caps every spawned run via `config.budget_cents`
//   • cohort nodes      → emit a `CohortPlanEntry` in `config.cohort_plan`
//   • linear edge       → state-machine fallthrough
//   • conditional edge  → emits a `branches` entry on the source role's
//                         `role_config.branches` map (M7)
//   • fan-out edge      → legacy; superseded by cohort nodes. Still understood
//                         on decompile so existing canvases load.
//
// The canvas state itself is serialisable. No live function refs. This keeps
// it future-proof for the M11 marketplace "publish a workflow" follow-up.

export type ModelTier = "default" | "heavy" | "cheap";
export type RunnerKind = "api" | "local-cc";

export type BuilderNodeKind = "role" | "skill" | "tool" | "data_source" | "budget" | "cohort";

export type BuilderRoleNodeData = {
  kind: "role";
  /** Slug — built-in (pm/engineer/qa/security/…) or custom (agents.role text). */
  roleSlug: string;
  displayName: string;
  modelTier: ModelTier;
  runnerPolicy: RunnerKind;
  /**
   * Per-leaf budget. When this node is the agent's entrypoint we copy this
   * into `config.budget_cents`. When the node is a downstream branch leaf the
   * budget is ignored (a separate budget node attached to that branch sets
   * the leaf cap).
   */
  budgetCents?: number;
  /**
   * Phase 2.5 / M6 — visual nesting. When this role belongs to a cohort the
   * client sets React Flow's `parentNode` to the cohort node's id. We mirror
   * that into the canvas state so compile + decompile stay self-contained
   * (no React Flow internals leaking into the contract).
   */
  parentNodeId?: string;
};

export type BuilderSkillNodeData = {
  kind: "skill";
  skillId: string;
  name: string;
};

export type BuilderToolNodeData = {
  kind: "tool";
  toolPackageId: string;
  name: string;
};

export type BuilderDataSourceNodeData = {
  kind: "data_source";
  dataSourceId: string;
  name: string;
};

export type BuilderBudgetNodeData = {
  kind: "budget";
  /** Leaf-branch cap. Translates into `runs.budget_cents` on the spawned run. */
  budgetCents: number;
  label?: string;
};

/**
 * Phase 2.5 / M6 — cohort container node.
 *
 * A cohort node groups N member role nodes that the dispatcher should fan out
 * in parallel under a shared acceptance strategy. The cohort node itself is
 * NOT a role — it has no slug, no runner, no model tier. It exists purely to
 * model the cohort in the canvas + Inspector and emit a `CohortPlanEntry` at
 * compile time.
 *
 * Member roles are attached visually via React Flow's `parentNode` mechanism
 * (the role node's `parentNodeId` field). Trigger / fan-in roles are derived
 * from the canvas topology at compile time:
 *
 *   • `trigger_role`     = the role node whose linear/conditional edge feeds
 *                          this cohort. Top-level cohorts have the agent's
 *                          entry role as their trigger. Nested cohorts have
 *                          a sibling-leaf of the parent cohort as their
 *                          trigger (and `parent_cohort_key` is set to that
 *                          parent's key).
 *   • `parent_cohort_key`= when the predecessor role of this cohort is a
 *                          member of another cohort, that parent cohort's key
 *                          is recorded here. Otherwise null (= top-level).
 */
export type BuilderCohortNodeData = {
  kind: "cohort";
  /** Stable id consumed by `CohortPlanEntry.cohort_key`. */
  cohortKey: string;
  /** Operator-facing label rendered in the cohort container header. */
  label?: string;
  /** Acceptance strategy applied to the cohort. */
  acceptanceStrategy: "single" | "all" | string; // 'quorum(N)' permitted as a string
  /**
   * Role slug downstream of this cohort that picks up after acceptance
   * resolves. Optional — when omitted the dispatcher falls through to the
   * state machine for the next role.
   */
  fanInRole?: string;
  /**
   * Visual size of the container. The client recomputes this on every member
   * add/remove so children clip cleanly inside the cohort frame; serialising
   * it keeps undo/redo and round-trip lossless.
   */
  width?: number;
  height?: number;
};

export type BuilderNodeData =
  | BuilderRoleNodeData
  | BuilderSkillNodeData
  | BuilderToolNodeData
  | BuilderDataSourceNodeData
  | BuilderBudgetNodeData
  | BuilderCohortNodeData;

export type BuilderNode = {
  id: string;
  type: BuilderNodeKind;
  position: { x: number; y: number };
  data: BuilderNodeData;
};

export type BuilderEdgeKind = "linear" | "conditional" | "fanout";

export type BuilderLinearEdgeData = {
  kind: "linear";
};

export type BuilderConditionalEdgeData = {
  kind: "conditional";
  /** Branch key consumed by M7's `branches` map on the source role. */
  branchKey: string;
};

export type BuilderFanOutEdgeData = {
  kind: "fanout";
  /** Cohort identifier — every edge in a single fan-out shares this key. */
  cohortKey: string;
  /** Acceptance strategy applied to the shared cohort. */
  acceptanceStrategy: "single" | "all" | string; // 'quorum(N)' permitted as a string
};

export type BuilderEdgeData =
  | BuilderLinearEdgeData
  | BuilderConditionalEdgeData
  | BuilderFanOutEdgeData;

export type BuilderEdge = {
  id: string;
  source: string;
  target: string;
  data: BuilderEdgeData;
};

/**
 * The complete serialisable canvas state. Round-trip target: compile →
 * decompile MUST be lossless modulo the field-order normalisation applied in
 * `normalise()` (used by the acceptance script).
 */
export type BuilderCanvas = {
  /** Schema marker. Bumps on incompatible shape changes. */
  version: 1;
  /**
   * Entry node id — the role node where dispatch starts. Required: a saved
   * canvas with no entrypoint can't actually be dispatched.
   */
  entryNodeId: string;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
};

// ─── Phase 2.5 / M6 cohort plan contract ──────────────────────────────────
//
// The `cohort_plan` field on `agents.config` is the runtime-facing shape.
// The dispatcher copies it onto `tickets.cohort_plan` at ticket creation;
// `decideFanOut` then reads cohort entries by key. The contract is locked
// between the UI and engine tracks — any change ships as `version: 2`.

export type CohortAcceptanceStrategy = "single" | "all" | string; // 'quorum(N)'

export type CohortPlanEntry = {
  /** Stable, canvas-derived identifier. UTF-8, slug-safe. */
  cohort_key: string;
  /** Role slugs the dispatcher fans out in parallel. Order-stable. */
  members: string[];
  /** Acceptance strategy at fan-in. */
  acceptance_strategy: CohortAcceptanceStrategy;
  /**
   * Role slug that picks up after this cohort decides. Null = fall through
   * to the state machine (engine default).
   */
  fan_in_role: string | null;
  /**
   * Null = top-level cohort. Otherwise the `cohort_key` of the parent cohort
   * whose sibling-leaf completion triggers THIS cohort.
   */
  parent_cohort_key: string | null;
  /**
   * Top-level: the dispatcher pick that fires this cohort (usually the agent's
   * entry role).
   * Nested: the sibling-leaf role of the parent cohort whose completion drops
   * into this child cohort.
   */
  trigger_role: string;
};

export type CohortPlan = {
  version: 1;
  cohorts: CohortPlanEntry[];
};

/**
 * The `agents.config` JSON shape the builder emits. Compatible with every
 * existing runtime consumer — adds nothing the dispatcher doesn't already
 * read (or that the M6 cohort-plan branch reads from Phase 2.5 onward).
 */
export type BuilderCompiledConfig = {
  // Standard agents.config fields the dispatcher already honors.
  role_config?: {
    displayName: string;
    /**
     * OPTIONAL, and the empty string is never written. `loadCustomRoleConfig`
     * treats an empty `systemPrompt` exactly like a missing one (it returns
     * null, and the dispatcher then throws `no RoleConfig for slug`), so a
     * stored `""` reads like a valid value while behaving like a missing one.
     * That ambiguity is what turned a builder Save into a silent break — a
     * branches-only role_config stamped `systemPrompt: ""` over a synthesized
     * agent's real prompt. Absent means absent; say so in the shape.
     */
    systemPrompt?: string;
    modelTier: ModelTier;
    runnerPolicy: RunnerKind;
    onSuccessStatus: string;
    branches?: Record<string, string>;
  };
  // M11 selectors.
  skill_ids?: string[];
  tool_package_ids?: string[];
  // M10 selectors.
  data_source_ids?: string[];
  // M16 — engine-respected per-run cap from a budget node on the entry leaf.
  budget_cents?: number;
  // Phase 1 / M6 legacy hint. The compiler keeps emitting it ONLY when the
  // canvas defines exactly one top-level cohort (so old engine read paths
  // continue to work). With cohort_plan present the dispatcher prefers that.
  fan_out?: {
    cohort: string[];
    acceptance_strategy: "single" | "all" | string; // 'quorum(N)'
  };
  // Phase 2.5 / M6 — multi-stage DAG plan. See CohortPlan above.
  cohort_plan?: CohortPlan;
  // Phase 2.5 / M6 — runners gate. `"all"` (literal string) = open to every
  // tenant member. Otherwise: an array of `auth.users.id` values explicitly
  // allowed to file tickets against this workflow. The empty array is
  // normalised to `"all"` at the action boundary so the field always carries
  // an unambiguous "no restriction" sentinel.
  allowed_runner_user_ids?: string[] | "all";
  // Tagged so future loaders know this config came from the builder.
  source?: "builder";
  // Builder canvas serialised verbatim. Decompile reads this.
  builder?: BuilderCanvas;
};
