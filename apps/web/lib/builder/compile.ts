// Phase 1 / M16 — Canvas → `agents.config` JSON compiler.
//
// Phase 2.5 / M6 update: cohort plan emission.
//
// Determinism contract: same canvas in, same JSON out — order-stable and
// shape-stable so round-trip equality holds (proved by the acceptance script).
//
// Compile rules
// ─────────────
// 1. The entry role node's identity becomes the agent's `role_config` payload
//    (displayName, modelTier, runnerPolicy, onSuccessStatus). The role slug
//    itself is stored on the `agents.role` column (the caller's responsibility,
//    not the compiler's).
// 2. Skill / tool / data_source nodes attached to the entry role contribute
//    their ids to `config.skill_ids[]`, `config.tool_package_ids[]`,
//    `config.data_source_ids[]`. They attach via a linear edge from the
//    entry node to the leaf (kind=skill|tool|data_source).
// 3. A budget node attached directly to the entry role sets
//    `config.budget_cents` (the engine-respected per-run cap).
// 4. Conditional edges from the entry role to a downstream role node compile
//    into a `branches: { branchKey -> targetRoleSlug }` map under
//    `role_config.branches`. This is exactly what M7's dispatcher reads.
// 5. Phase 2.5 / M6 — every cohort node on the canvas becomes one entry in
//    `config.cohort_plan.cohorts[]`:
//
//      • cohort_key         = cohort node's `data.cohortKey`
//      • members            = role slugs whose `data.parentNodeId` matches
//                             this cohort node's id, in canvas-position order
//      • acceptance_strategy= cohort node's `data.acceptanceStrategy`
//      • fan_in_role        = cohort node's `data.fanInRole ?? null`
//      • trigger_role       = role slug whose outbound linear/conditional
//                             edge feeds this cohort node. Top-level cohorts
//                             with no inbound edge fall back to the agent's
//                             entry role.
//      • parent_cohort_key  = when the trigger role itself is a member of
//                             another cohort, that cohort's key. Else null.
//
//    Cycles, missing members, orphan parent references, and conflicting
//    triggers all return a compile error so the operator can't save a canvas
//    the engine would refuse.
//
//    When the canvas has exactly ONE cohort with `parent_cohort_key == null`
//    AND no nested cohorts, the compiler ALSO emits the legacy scalar
//    `fan_out` field for back-compat with older engine read paths. Otherwise
//    `fan_out` is omitted.
//
// 6. Legacy fan-out EDGES (from pre-Phase-2.5 canvases) still compile into the
//    `fan_out` scalar so old saved agents continue to round-trip. New canvases
//    should use cohort nodes instead.
// 7. Unknown / dangling nodes are surfaced as a compile error so the operator
//    can't accidentally save a canvas that drops state on the way to JSON.
//
// The compiler does NOT generate the role's systemPrompt. For built-in roles
// (pm/engineer/qa/…) the systemPrompt comes from `loadRoleConfig` at dispatch
// time, NOT from the agents.config — Builder-published built-in roles inherit
// the canonical prompt. Only custom-role nodes carry their own systemPrompt
// (handled when the entry role is a custom slug — the caller passes it in).

import type {
  BuilderCanvas,
  BuilderCohortNodeData,
  BuilderCompiledConfig,
  BuilderNode,
  BuilderRoleNodeData,
  CohortPlanEntry,
} from "@/lib/builder/types";

export type CompileInput = {
  canvas: BuilderCanvas;
  /**
   * Custom-role nodes need a systemPrompt (and onSuccessStatus) to round-trip
   * into `agents.config.role_config`. Built-in roles do NOT — their prompt
   * lives in the in-memory ROLES map. The caller passes the prompts in via
   * this map keyed by role slug; the compiler only consumes entries for slugs
   * present in the canvas.
   */
  customRolePrompts?: Record<
    string,
    {
      systemPrompt: string;
      onSuccessStatus: string;
    }
  >;
  /**
   * Phase 2.5 / M6 — Runners gate passthrough. The compiler embeds whatever
   * the caller supplies into `config.allowed_runner_user_ids`; default is
   * the literal `"all"` (no restriction).
   */
  allowedRunnerUserIds?: string[] | "all";
  /**
   * The role_config ALREADY STORED on the agents row, when updating one.
   *
   * The canvas cannot represent a systemPrompt: `decompileConfig` never reads
   * one into the canvas, and no UI surface populates `customRolePrompts`. So
   * without this, a compile of a faithfully round-tripped canvas emits no
   * prompt — and `saveAgentCanvasAction` writes `config` as a whole-object
   * overwrite, destroying the stored prompt of any JD-synthesized agent on
   * the only CTA its card has.
   *
   * The compiler therefore carries the stored prompt forward when the canvas
   * did not supply one. A genuine edit (via `customRolePrompts`) still wins,
   * and an agent with no stored prompt still gains none.
   */
  existingRoleConfig?: BuilderCompiledConfig["role_config"];
};

export type CompileResult =
  | { ok: true; config: BuilderCompiledConfig; entryRoleSlug: string }
  | { ok: false; error: string };

export function compileCanvas(input: CompileInput): CompileResult {
  const { canvas } = input;
  if (canvas.version !== 1) {
    return { ok: false, error: `unsupported canvas version ${canvas.version}` };
  }
  if (!canvas.entryNodeId) {
    return { ok: false, error: "canvas has no entryNodeId" };
  }

  const byId = new Map<string, BuilderNode>(canvas.nodes.map((n) => [n.id, n]));
  const entry = byId.get(canvas.entryNodeId);
  if (!entry) {
    return { ok: false, error: `entry node ${canvas.entryNodeId} not found` };
  }
  if (entry.data.kind !== "role") {
    return {
      ok: false,
      error: `entry node ${canvas.entryNodeId} is kind=${entry.data.kind}; must be a role node`,
    };
  }
  const entryRole = entry.data as BuilderRoleNodeData;

  // Group outbound edges from the entry node by kind.
  const outbound = canvas.edges.filter((e) => e.source === entry.id);

  // 1. Skill / tool / data_source ids — linear edges from entry to a leaf.
  const skillIds: string[] = [];
  const toolPackageIds: string[] = [];
  const dataSourceIds: string[] = [];

  // 2. Budget node directly attached to entry.
  let budgetCents: number | undefined;

  // 3. Conditional branches.
  const branches: Record<string, string> = {};

  // 4. Legacy fan-out cohort buckets keyed by cohortKey (compiled from
  //    fan-out EDGES on the canvas — superseded by cohort nodes in M6 but
  //    still understood for back-compat with pre-M6 saved canvases).
  const legacyFanOutBuckets = new Map<string, { strategy: string; roles: string[] }>();

  for (const edge of outbound) {
    const target = byId.get(edge.target);
    if (!target) {
      return {
        ok: false,
        error: `edge ${edge.id} references missing target node ${edge.target}`,
      };
    }
    switch (edge.data.kind) {
      case "linear": {
        switch (target.data.kind) {
          case "skill":
            skillIds.push(target.data.skillId);
            break;
          case "tool":
            toolPackageIds.push(target.data.toolPackageId);
            break;
          case "data_source":
            dataSourceIds.push(target.data.dataSourceId);
            break;
          case "budget":
            if (typeof budgetCents === "number") {
              return {
                ok: false,
                error: `multiple budget nodes attached to entry role ${entry.id}`,
              };
            }
            budgetCents = target.data.budgetCents;
            break;
          case "role":
            // Linear edge entry-role -> downstream role. The canvas allows
            // this for visual chaining; the runtime fall-through is the
            // state machine, so we don't materialise it in the config. (M7
            // conditional edges are how the canvas pins a specific next
            // role; linear is "let the engine decide".)
            break;
          case "cohort":
            // Linear edge entry-role -> cohort node. Handled by the
            // cohort-plan pass below — we don't need to emit anything here.
            break;
        }
        break;
      }
      case "conditional": {
        if (target.data.kind !== "role") {
          return {
            ok: false,
            error: `conditional edge ${edge.id} must target a role node (got ${target.data.kind})`,
          };
        }
        const key = edge.data.branchKey;
        if (!key) {
          return { ok: false, error: `conditional edge ${edge.id} missing branchKey` };
        }
        if (branches[key] !== undefined) {
          return {
            ok: false,
            error: `duplicate conditional branch key "${key}" on entry role ${entry.id}`,
          };
        }
        branches[key] = target.data.roleSlug;
        break;
      }
      case "fanout": {
        // Legacy edge-based fan-out (pre-M6 canvases). New canvases use
        // cohort nodes; we keep this path so older saved agents continue to
        // round-trip without forcing the operator to re-build.
        if (target.data.kind !== "role") {
          return {
            ok: false,
            error: `fan-out edge ${edge.id} must target a role node (got ${target.data.kind})`,
          };
        }
        const bucket = legacyFanOutBuckets.get(edge.data.cohortKey) ?? {
          strategy: edge.data.acceptanceStrategy,
          roles: [],
        };
        if (bucket.strategy !== edge.data.acceptanceStrategy) {
          return {
            ok: false,
            error: `fan-out cohort "${edge.data.cohortKey}" has conflicting strategies (${bucket.strategy} vs ${edge.data.acceptanceStrategy})`,
          };
        }
        bucket.roles.push(target.data.roleSlug);
        legacyFanOutBuckets.set(edge.data.cohortKey, bucket);
        break;
      }
    }
  }

  // Sort id arrays for deterministic round-trip. The order of skill_ids /
  // tool_package_ids / data_source_ids is semantically irrelevant at runtime
  // (selectSkillsForDispatch loads them as a set). Branch keys and the
  // fan-out cohort role order ARE semantically meaningful (M6/M7) and so are
  // preserved in insertion order.
  skillIds.sort();
  toolPackageIds.sort();
  dataSourceIds.sort();

  // Build the role_config payload.
  //
  // For built-in roles there is no systemPrompt to emit — the dispatcher's
  // `loadRoleConfig` short-circuits to the canonical prompt in the ROLES map.
  // For custom (JD-synthesized) roles the prompt is the ONLY thing that makes
  // the agent dispatchable, and it lives nowhere but this column.
  //
  // Precedence, in order:
  //   1. `customRolePrompts` — an explicit edit from the caller. Always wins,
  //      so an operator who genuinely rewrites a prompt can still do so.
  //   2. the stored prompt — carried forward untouched when the canvas had
  //      nothing to say about it. This is what makes Save non-destructive.
  //   3. nothing — an agent with no stored prompt never gains an invented one.
  //
  // `systemPrompt` is omitted rather than written as `""` in case 3: an empty
  // string is indistinguishable from a missing prompt at every consumer, so
  // storing one only disguises the absence.
  let role_config: BuilderCompiledConfig["role_config"] | undefined;
  const customPrompt = input.customRolePrompts?.[entryRole.roleSlug];
  const existing = input.existingRoleConfig;
  const preservedPrompt =
    typeof existing?.systemPrompt === "string" && existing.systemPrompt.length > 0
      ? existing.systemPrompt
      : undefined;
  const hasBranches = Object.keys(branches).length > 0;

  if (customPrompt) {
    role_config = {
      displayName: entryRole.displayName,
      systemPrompt: customPrompt.systemPrompt,
      modelTier: entryRole.modelTier,
      runnerPolicy: entryRole.runnerPolicy,
      onSuccessStatus: customPrompt.onSuccessStatus,
      ...(hasBranches ? { branches } : {}),
    };
  } else if (preservedPrompt !== undefined) {
    // The canvas carries the identity (displayName / modelTier / runnerPolicy
    // all round-trip through `decompileConfig`), so canvas edits to those are
    // honoured. The prompt and its onSuccessStatus do NOT round-trip, so they
    // come from the stored row. Branches are canvas-authoritative: they DO
    // round-trip, so an operator deleting a branch edge must delete it here.
    role_config = {
      displayName: entryRole.displayName,
      systemPrompt: preservedPrompt,
      modelTier: entryRole.modelTier,
      runnerPolicy: entryRole.runnerPolicy,
      onSuccessStatus: existing?.onSuccessStatus ?? "in_review",
      ...(hasBranches ? { branches } : {}),
    };
  } else if (hasBranches) {
    // Built-in role with branches and no prompt anywhere: stamp the branches
    // so future "publish workflow" exports are lossless. No systemPrompt key
    // at all — see the note above on why `""` is not written.
    role_config = {
      displayName: entryRole.displayName,
      modelTier: entryRole.modelTier,
      runnerPolicy: entryRole.runnerPolicy,
      onSuccessStatus: existing?.onSuccessStatus ?? "in_review",
      branches,
    };
  }

  // ─── Phase 2.5 / M6: cohort-plan emission ─────────────────────────────
  //
  // Discover every cohort node on the canvas, derive its members via
  // `parentNodeId`, and walk the topology to set `trigger_role` /
  // `parent_cohort_key`.

  const cohortNodes = canvas.nodes.filter(
    (n): n is BuilderNode & { data: BuilderCohortNodeData } => n.data.kind === "cohort",
  );

  // Members per cohort, sorted by canvas y-position for deterministic order.
  const membersByCohort = new Map<string, BuilderNode[]>();
  for (const c of cohortNodes) membersByCohort.set(c.id, []);
  for (const n of canvas.nodes) {
    if (n.data.kind !== "role") continue;
    const parentId = n.data.parentNodeId;
    if (!parentId) continue;
    const bucket = membersByCohort.get(parentId);
    if (!bucket) {
      return {
        ok: false,
        error: `role node ${n.id} has parentNodeId=${parentId} but no cohort node with that id exists`,
      };
    }
    bucket.push(n);
  }

  // Map cohort node id -> CohortPlanEntry. Built in two passes: first the
  // entry shells (so we can resolve parent_cohort_key by walking trigger
  // edges back to a cohort member), then the trigger / parent linkage.
  const cohortEntries = new Map<string, CohortPlanEntry>();
  const cohortKeyToNodeId = new Map<string, string>();
  for (const c of cohortNodes) {
    const cd = c.data;
    if (!cd.cohortKey || cd.cohortKey.length === 0) {
      return {
        ok: false,
        error: `cohort node ${c.id} is missing a cohort_key`,
      };
    }
    if (cohortKeyToNodeId.has(cd.cohortKey)) {
      return {
        ok: false,
        error: `duplicate cohort_key "${cd.cohortKey}" on the canvas`,
      };
    }
    cohortKeyToNodeId.set(cd.cohortKey, c.id);
    const members = (membersByCohort.get(c.id) ?? []).slice().sort((a, b) => {
      // Deterministic member order = y-position ascending. Ties broken by id.
      const dy = a.position.y - b.position.y;
      if (dy !== 0) return dy;
      return a.id.localeCompare(b.id);
    });
    if (members.length === 0) {
      return {
        ok: false,
        error: `cohort "${cd.cohortKey}" has no member roles`,
      };
    }
    const memberSlugs = members.map((m) => (m.data as BuilderRoleNodeData).roleSlug);
    if (new Set(memberSlugs).size !== memberSlugs.length) {
      return {
        ok: false,
        error: `cohort "${cd.cohortKey}" has duplicate member role slugs`,
      };
    }
    cohortEntries.set(c.id, {
      cohort_key: cd.cohortKey,
      members: memberSlugs,
      acceptance_strategy: cd.acceptanceStrategy,
      fan_in_role: cd.fanInRole && cd.fanInRole.length > 0 ? cd.fanInRole : null,
      parent_cohort_key: null,
      // Placeholder — overwritten in the trigger pass below.
      trigger_role: entryRole.roleSlug,
    });
  }

  // Trigger / parent linkage: walk inbound edges of each cohort node.
  //
  // Inbound predecessor of a cohort node = the source of any edge whose
  // target is the cohort node. If the predecessor is a role node:
  //   - record its slug as the cohort's trigger_role
  //   - if that role itself is a member of a cohort, record that cohort's
  //     key as parent_cohort_key.
  // If there is no inbound edge, the cohort is top-level and trigger_role
  // defaults to the agent's entry role (set above).
  const roleToCohortKey = new Map<string, string>();
  for (const [nodeId, entry] of cohortEntries) {
    // member role slugs may not be unique across cohorts in pathological
    // canvases — `compileCanvas` checked dedupe within a cohort, but we also
    // need to fail on cross-cohort overlap because parent_cohort_key would
    // become ambiguous. Detect here.
    for (const member of membersByCohort.get(nodeId) ?? []) {
      const slug = (member.data as BuilderRoleNodeData).roleSlug;
      const prior = roleToCohortKey.get(slug);
      if (prior && prior !== entry.cohort_key) {
        return {
          ok: false,
          error: `role "${slug}" appears as a member of multiple cohorts ("${prior}" and "${entry.cohort_key}")`,
        };
      }
      roleToCohortKey.set(slug, entry.cohort_key);
    }
  }

  for (const [nodeId, entry] of cohortEntries) {
    const inbound = canvas.edges.filter((e) => e.target === nodeId);
    if (inbound.length === 0) {
      // Top-level. trigger_role stays as the agent entry slug.
      continue;
    }
    if (inbound.length > 1) {
      return {
        ok: false,
        error: `cohort "${entry.cohort_key}" has ${inbound.length} inbound edges; expected exactly one trigger`,
      };
    }
    const trigEdge = inbound[0]!;
    const src = byId.get(trigEdge.source);
    if (!src) {
      return {
        ok: false,
        error: `cohort "${entry.cohort_key}" trigger edge ${trigEdge.id} references missing source ${trigEdge.source}`,
      };
    }
    if (src.data.kind !== "role") {
      return {
        ok: false,
        error: `cohort "${entry.cohort_key}" trigger must be a role node (got ${src.data.kind})`,
      };
    }
    entry.trigger_role = (src.data as BuilderRoleNodeData).roleSlug;
    const parentKey = roleToCohortKey.get(entry.trigger_role);
    if (parentKey && parentKey !== entry.cohort_key) {
      entry.parent_cohort_key = parentKey;
    }
  }

  // Cycle guard: walk parent_cohort_key chain and fail on revisit.
  for (const entry of cohortEntries.values()) {
    const seen = new Set<string>();
    let cur: string | null = entry.parent_cohort_key;
    while (cur) {
      if (seen.has(cur)) {
        return {
          ok: false,
          error: `cohort_plan contains a cycle through "${cur}"`,
        };
      }
      seen.add(cur);
      const parentNodeId = cohortKeyToNodeId.get(cur);
      if (!parentNodeId) {
        return {
          ok: false,
          error: `cohort "${entry.cohort_key}" references unknown parent_cohort_key "${cur}"`,
        };
      }
      const parentEntry = cohortEntries.get(parentNodeId);
      cur = parentEntry?.parent_cohort_key ?? null;
    }
  }

  // Order cohorts for determinism: top-level first (alphabetical by key),
  // then by parent_cohort_key + own key. Engine doesn't depend on this order
  // but stable output keeps round-trip equality cheap.
  const cohortList = Array.from(cohortEntries.values()).sort((a, b) => {
    const ap = a.parent_cohort_key ?? "";
    const bp = b.parent_cohort_key ?? "";
    if (ap !== bp) return ap.localeCompare(bp);
    return a.cohort_key.localeCompare(b.cohort_key);
  });

  let cohort_plan: BuilderCompiledConfig["cohort_plan"] | undefined;
  if (cohortList.length > 0) {
    cohort_plan = { version: 1, cohorts: cohortList };
  }

  // Build legacy fan_out hint.
  //
  // Two sources, in priority order:
  //   1. cohort_plan with exactly ONE top-level cohort and NO children
  //      → mirror its members + strategy into fan_out for engine back-compat.
  //   2. canvas has legacy fan-out EDGES (no cohort nodes)
  //      → keep the original Phase 1 behavior: pick the (single) bucket.
  //
  // Else: omit fan_out entirely.

  let fan_out: BuilderCompiledConfig["fan_out"] | undefined;
  const topLevelCohorts = cohortList.filter((c) => c.parent_cohort_key === null);
  const onlyOneCohort = cohortList.length === 1 && topLevelCohorts.length === 1;
  if (onlyOneCohort) {
    const c = topLevelCohorts[0]!;
    fan_out = {
      cohort: [...c.members],
      acceptance_strategy: c.acceptance_strategy,
    };
  } else if (cohortList.length === 0) {
    if (legacyFanOutBuckets.size > 1) {
      return {
        ok: false,
        error: `canvas defines ${legacyFanOutBuckets.size} legacy fan-out cohorts via edges; use cohort nodes for multi-cohort DAGs`,
      };
    }
    for (const bucket of legacyFanOutBuckets.values()) {
      fan_out = {
        cohort: [...bucket.roles],
        acceptance_strategy: bucket.strategy,
      };
    }
  }
  // When cohort_plan has more than one cohort OR a nested cohort, the engine
  // reads cohort_plan exclusively and fan_out is intentionally omitted.

  // ─── Runners gate ────────────────────────────────────────────────────
  // Normalise the empty array to the literal `"all"` so downstream code only
  // ever sees one shape that means "no restriction".
  let allowed_runner_user_ids: BuilderCompiledConfig["allowed_runner_user_ids"];
  if (input.allowedRunnerUserIds === undefined) {
    allowed_runner_user_ids = "all";
  } else if (input.allowedRunnerUserIds === "all") {
    allowed_runner_user_ids = "all";
  } else if (Array.isArray(input.allowedRunnerUserIds) && input.allowedRunnerUserIds.length === 0) {
    allowed_runner_user_ids = "all";
  } else {
    // Dedupe + sort the explicit allow-list for deterministic output.
    allowed_runner_user_ids = Array.from(
      new Set(input.allowedRunnerUserIds.filter((s) => typeof s === "string" && s.length > 0)),
    ).sort();
    if (allowed_runner_user_ids.length === 0) {
      allowed_runner_user_ids = "all";
    }
  }

  const config: BuilderCompiledConfig = {
    ...(role_config ? { role_config } : {}),
    ...(skillIds.length > 0 ? { skill_ids: skillIds } : {}),
    ...(toolPackageIds.length > 0 ? { tool_package_ids: toolPackageIds } : {}),
    ...(dataSourceIds.length > 0 ? { data_source_ids: dataSourceIds } : {}),
    ...(typeof budgetCents === "number" ? { budget_cents: budgetCents } : {}),
    ...(fan_out ? { fan_out } : {}),
    ...(cohort_plan ? { cohort_plan } : {}),
    allowed_runner_user_ids,
    source: "builder",
    builder: canvas,
  };

  return { ok: true, config, entryRoleSlug: entryRole.roleSlug };
}

/**
 * Normalise a compiled config into a comparable form for round-trip equality.
 * Strips the `builder` blob (it's the input we're round-tripping FROM) and
 * sorts object keys recursively.
 */
export function normaliseCompiled(c: BuilderCompiledConfig): Record<string, unknown> {
  const { builder: _ignored, ...rest } = c;
  return sortKeys(rest) as Record<string, unknown>;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Normalise a canvas into a comparable form for round-trip equality. Sorts
 * nodes and edges by id (their positions and data shape are fixed-key so the
 * deep sortKeys handles the rest).
 */
export function normaliseCanvas(c: BuilderCanvas): Record<string, unknown> {
  const sortedNodes = [...c.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const sortedEdges = [...c.edges].sort((a, b) => a.id.localeCompare(b.id));
  return sortKeys({
    version: c.version,
    entryNodeId: c.entryNodeId,
    nodes: sortedNodes,
    edges: sortedEdges,
  }) as Record<string, unknown>;
}
