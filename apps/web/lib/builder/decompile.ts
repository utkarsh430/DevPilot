// Phase 1 / M16 — `agents.config` JSON → canvas decompiler.
//
// Phase 2.5 / M6 update: cohort plan synthesis + JD-synth seeding.
//
// Inverse of `compile.ts`. The compile path embeds the entire canvas verbatim
// under `config.builder`, so the happy-path decompile is "return the embedded
// canvas". The decompiler also handles legacy / hand-written agents.config
// payloads that have NO embedded canvas — in that case it synthesises a
// canvas from whatever signal it can find:
//
//   • `config.role_config`             → entry role node populated with the
//                                        operator-set displayName / model /
//                                        runner. Pre-Phase-2.5 behavior.
//   • `agents.row.name + agents.role`  → Phase 2.5 / M6 fix for the JD-synth
//                                        empty-canvas case. Agents created
//                                        outside the builder (e.g. the M5h
//                                        JD synthesiser) write `name` / `role`
//                                        on the row but leave `config` mostly
//                                        empty. The synthesised canvas seeds
//                                        an entry role node using those so
//                                        operators see a starter card instead
//                                        of an empty grid.
//   • `config.cohort_plan`             → Phase 2.5 / M6 cohort containers +
//                                        member role nodes wired to the entry
//                                        role. When the plan is present in
//                                        a config that doesn't have an
//                                        embedded canvas, we materialise it.
//   • legacy `config.fan_out`          → Phase 1 sibling fan-out cohort.
//                                        Still synthesised so pre-M6 saved
//                                        agents render correctly.
//
// The `synthesised: true` flag tells the client this canvas wasn't authored
// by the operator — UI can toast a "Starter canvas, review and save" hint.

import type {
  BuilderCanvas,
  BuilderCompiledConfig,
  BuilderEdge,
  BuilderNode,
  CohortPlan,
  CohortPlanEntry,
} from "@/lib/builder/types";

export type DecompileResult =
  | { ok: true; canvas: BuilderCanvas; synthesised: boolean }
  | { ok: false; error: string };

export type DecompileOpts = {
  /** agents.role column. Used as the entry slug when no role_config is present. */
  fallbackRoleSlug?: string;
  /**
   * Phase 2.5 / M6 — agents.name column. When no role_config carries a
   * displayName, we fall back to this so JD-synthesised agents show their
   * "Backend Engineer" / "Data Scientist" label instead of the raw slug.
   */
  fallbackDisplayName?: string;
};

export function decompileConfig(
  config: BuilderCompiledConfig | Record<string, unknown>,
  fallbackRoleSlugOrOpts?: string | DecompileOpts,
): DecompileResult {
  const c = config as BuilderCompiledConfig;

  // Resolve options for back-compat with the original (slug-only) signature.
  const opts: DecompileOpts =
    typeof fallbackRoleSlugOrOpts === "string"
      ? { fallbackRoleSlug: fallbackRoleSlugOrOpts }
      : (fallbackRoleSlugOrOpts ?? {});

  // Embedded happy path.
  if (c.builder && typeof c.builder === "object") {
    const canvas = c.builder;
    if (canvas.version !== 1) {
      return {
        ok: false,
        error: `embedded canvas version ${canvas.version} not supported`,
      };
    }
    return { ok: true, canvas, synthesised: false };
  }

  // Synthesise a minimal canvas from the legacy / Phase-2.5 fields.
  const roleSlug =
    opts.fallbackRoleSlug && opts.fallbackRoleSlug.length > 0
      ? opts.fallbackRoleSlug
      : "custom_role";

  // Display name precedence: role_config.displayName → fallbackDisplayName
  // (agents.name from the row) → role slug as a last resort.
  const displayName = c.role_config?.displayName ?? opts.fallbackDisplayName ?? roleSlug;

  const nodes: BuilderNode[] = [];
  const edges: BuilderEdge[] = [];

  const entryId = "n_entry";
  nodes.push({
    id: entryId,
    type: "role",
    position: { x: 160, y: 200 },
    data: {
      kind: "role",
      roleSlug,
      displayName,
      modelTier: c.role_config?.modelTier ?? "default",
      runnerPolicy: c.role_config?.runnerPolicy ?? "local-cc",
      ...(typeof c.budget_cents === "number" ? { budgetCents: c.budget_cents } : {}),
    },
  });

  let nextY = 60;
  const addLeaf = (id: string, type: BuilderNode["type"], data: BuilderNode["data"]) => {
    nodes.push({
      id,
      type,
      position: { x: 480, y: nextY },
      data,
    });
    edges.push({
      id: `e_${entryId}_${id}`,
      source: entryId,
      target: id,
      data: { kind: "linear" },
    });
    nextY += 120;
  };

  for (const sid of c.skill_ids ?? []) {
    addLeaf(`n_skill_${sid}`, "skill", { kind: "skill", skillId: sid, name: sid });
  }
  for (const tid of c.tool_package_ids ?? []) {
    addLeaf(`n_tool_${tid}`, "tool", { kind: "tool", toolPackageId: tid, name: tid });
  }
  for (const did of c.data_source_ids ?? []) {
    addLeaf(`n_ds_${did}`, "data_source", {
      kind: "data_source",
      dataSourceId: did,
      name: did,
    });
  }
  if (typeof c.budget_cents === "number") {
    addLeaf(`n_budget`, "budget", {
      kind: "budget",
      budgetCents: c.budget_cents,
      label: `${(c.budget_cents / 100).toFixed(2)}`,
    });
  }

  // Branches → conditional edges to placeholder role nodes downstream of the
  // entry. The decompile target role nodes are synthesised with the same
  // slug-as-id; the operator can edit them after opening the canvas.
  let branchY = 320;
  for (const [key, targetSlug] of Object.entries(c.role_config?.branches ?? {})) {
    const targetId = `n_branch_${key}`;
    nodes.push({
      id: targetId,
      type: "role",
      position: { x: 800, y: branchY },
      data: {
        kind: "role",
        roleSlug: targetSlug,
        displayName: targetSlug,
        modelTier: "default",
        runnerPolicy: "local-cc",
      },
    });
    edges.push({
      id: `e_${entryId}_${targetId}`,
      source: entryId,
      target: targetId,
      data: { kind: "conditional", branchKey: key },
    });
    branchY += 140;
  }

  // ── Phase 2.5 / M6 — cohort_plan synthesis ────────────────────────────
  // When a saved config has a `cohort_plan` but no embedded canvas (e.g. the
  // engine wrote the plan, or a different tool authored the row), materialise
  // each cohort as a container node + member role children. This keeps the
  // builder usable for legacy / API-authored agents.
  const cohortPlan = isCohortPlan(c.cohort_plan) ? c.cohort_plan : null;
  if (cohortPlan) {
    materialiseCohortPlan(cohortPlan, entryId, nodes, edges);
  } else if (c.fan_out && Array.isArray(c.fan_out.cohort)) {
    // Legacy edge-based fan-out → sibling role nodes off the entry.
    const cohortKey = "cohort_0";
    let foY = 520;
    for (const sibSlug of c.fan_out.cohort) {
      const sibId = `n_fanout_${sibSlug}`;
      nodes.push({
        id: sibId,
        type: "role",
        position: { x: 800, y: foY },
        data: {
          kind: "role",
          roleSlug: sibSlug,
          displayName: sibSlug,
          modelTier: "default",
          runnerPolicy: "local-cc",
        },
      });
      edges.push({
        id: `e_${entryId}_${sibId}`,
        source: entryId,
        target: sibId,
        data: {
          kind: "fanout",
          cohortKey,
          acceptanceStrategy: c.fan_out.acceptance_strategy,
        },
      });
      foY += 140;
    }
  }

  const canvas: BuilderCanvas = {
    version: 1,
    entryNodeId: entryId,
    nodes,
    edges,
  };
  return { ok: true, canvas, synthesised: true };
}

function isCohortPlan(value: unknown): value is CohortPlan {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<CohortPlan>;
  return v.version === 1 && Array.isArray(v.cohorts);
}

/**
 * Materialise a `CohortPlan` into the synthesised canvas. Each cohort becomes
 * a container node positioned in a column; its members are role nodes nested
 * inside via `parentNodeId`. A linear edge wires the trigger_role (or the
 * agent entry, for top-level cohorts) to the cohort container.
 *
 * The layout is intentionally simple — operators are expected to re-arrange
 * after opening the canvas. Auto-layout for cohort containers is a follow-up.
 */
function materialiseCohortPlan(
  plan: CohortPlan,
  entryNodeId: string,
  nodes: BuilderNode[],
  edges: BuilderEdge[],
): void {
  // Two-pass: shells first (so cohort keys can resolve), then members + edges.
  const cohortNodeIdByKey = new Map<string, string>();

  const COHORT_COL_X = 800;
  const COHORT_COL_GAP = 360;
  const COHORT_ROW_GAP = 280;
  const COHORT_W = 320;
  const HEADER_PAD = 56;
  const MEMBER_W = 200;
  const MEMBER_H = 96;
  const MEMBER_GAP = 24;

  // Lay out by depth (parent_cohort_key chain length) — top-level cohorts in
  // column 0, depth-1 children in column 1, etc.
  const depthOf = (key: string): number => {
    let d = 0;
    let cur: string | undefined = key;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) return d; // cycle guard — should never hit since compile validates
      seen.add(cur);
      const entry = plan.cohorts.find((c) => c.cohort_key === cur);
      if (!entry || entry.parent_cohort_key === null) return d;
      d += 1;
      cur = entry.parent_cohort_key;
    }
    return d;
  };

  const indexAtDepth = new Map<number, number>();

  for (const entry of plan.cohorts) {
    const depth = depthOf(entry.cohort_key);
    const idx = indexAtDepth.get(depth) ?? 0;
    indexAtDepth.set(depth, idx + 1);

    const cohortNodeId = `n_cohort_${entry.cohort_key}`;
    cohortNodeIdByKey.set(entry.cohort_key, cohortNodeId);

    const memberCount = Math.max(1, entry.members.length);
    const innerHeight = HEADER_PAD + memberCount * (MEMBER_H + MEMBER_GAP);
    const cohortPos = {
      x: COHORT_COL_X + depth * COHORT_COL_GAP,
      y: 100 + idx * COHORT_ROW_GAP,
    };

    nodes.push({
      id: cohortNodeId,
      type: "cohort",
      position: cohortPos,
      data: {
        kind: "cohort",
        cohortKey: entry.cohort_key,
        label: entry.cohort_key,
        acceptanceStrategy: entry.acceptance_strategy,
        fanInRole: entry.fan_in_role ?? undefined,
        width: COHORT_W,
        height: innerHeight,
      },
    });

    // Member role nodes — positioned relative to the cohort container so RF's
    // parentNode keeps them clipped inside the frame.
    let memberY = HEADER_PAD;
    for (const slug of entry.members) {
      const memberId = `n_cohort_${entry.cohort_key}_member_${slug}`;
      nodes.push({
        id: memberId,
        type: "role",
        position: { x: (COHORT_W - MEMBER_W) / 2, y: memberY },
        data: {
          kind: "role",
          roleSlug: slug,
          displayName: slug,
          modelTier: "default",
          runnerPolicy: "local-cc",
          parentNodeId: cohortNodeId,
        },
      });
      memberY += MEMBER_H + MEMBER_GAP;
    }
  }

  // Trigger edges: each cohort node gets exactly one inbound edge from its
  // trigger_role. For nested cohorts the trigger role is itself a member of
  // the parent cohort — locate that member node id. For top-level cohorts the
  // trigger usually IS the agent's entry role; if it's anything else we just
  // attach from the entry node (the cohort plan's authority is the engine).
  for (const entry of plan.cohorts) {
    const targetId = cohortNodeIdByKey.get(entry.cohort_key)!;
    let sourceId: string | null = null;

    if (entry.parent_cohort_key) {
      // Trigger is a sibling-leaf of the parent cohort. Look for a member of
      // the parent cohort whose slug equals trigger_role.
      const parentEntry = plan.cohorts.find((c) => c.cohort_key === entry.parent_cohort_key);
      if (parentEntry && parentEntry.members.includes(entry.trigger_role)) {
        sourceId = `n_cohort_${parentEntry.cohort_key}_member_${entry.trigger_role}`;
      }
    }

    if (sourceId === null) {
      // Top-level (or trigger not found among parent members) — wire from
      // the agent entry node.
      sourceId = entryNodeId;
    }

    edges.push({
      id: `e_${sourceId}_${targetId}`,
      source: sourceId,
      target: targetId,
      data: { kind: "linear" },
    });
  }
}
