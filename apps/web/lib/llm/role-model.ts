// The per-agent (role) MODEL override — the top rungs of the model precedence
// chain: agent+project » agent-global » project » tenant » instance » env.
//
// An `agent_project_models` row with `projectId === null` is the AGENT-WIDE
// default: it applies to every project in the tenant, including ones created
// later. A row naming a project overrides it FOR THAT PROJECT and is never
// cleared by setting a global — more specific always wins, and the per-project
// choices an operator made are surfaced in the UI rather than silently deleted.
//
// PURE: no `server-only`, no DB, no env. Imported by the server resolver, the
// metrics rollup, and the client pickers alike. The DB-backed loader lives in
// `role-model.server.ts`.
//
// ── Why this is a SEPARATE AXIS, not a fourth layer in `selectProvider` ─────
// `selectProvider` (provider.ts) is deliberately WHOLE-LAYER and never
// field-merged: a project that says `openai_compatible` must not inherit the
// tenant's Anthropic key, and a project on `anthropic` must not inherit a tenant
// base URL that would redirect Claude traffic elsewhere. Provider + endpoint +
// credential are ONE atomic decision.
//
// A role model is a different question — "which model, given the provider we
// already decided" — so folding it in as a fourth layer would either weaken that
// atomicity or force a role row to carry an endpoint and a credential it has no
// business naming. It is applied AFTER, as a narrow model-only override.
//
// ── The compatibility rule (load-bearing) ──────────────────────────────────
// The provider is decided FIRST. A role override applies ONLY when its provider
// matches the winning one. A Claude model on an `openai_compatible` project is
// IGNORED, and the run continues on the project's own model.
//
// This is not defensive tidiness. Without it the override flows into
// `resolveApiModelId` verbatim — which, for `openai_compatible`, returns any
// non-empty string with NO allowlist check — and the endpoint 404s mid-run on a
// model it does not serve. That is strictly WORSE than the no-op this feature
// exists to fix: a silent no-op costs nothing, a broken run costs a ticket.
//
// The shadowed case is never silent. The resolver logs it, and
// `describeEffectiveModel` has a dedicated `shadowed` outcome so a UI showing
// the stored value cannot assert a model that never takes effect.

import type { LlmProvider } from "@/lib/llm/provider";

/** One `agent_project_models` row, provider-qualified. */
export type RoleModelOverride = {
  roleSlug: string;
  provider: LlmProvider;
  model: string;
};

/**
 * What happened to the role override, so callers can log it and the UI can tell
 * the truth about it.
 *
 *   none     — no override row for this (project, role). The overwhelmingly
 *              common case; the project/tenant model answers, exactly as today.
 *   applied  — the override's provider matches the winning provider, so its
 *              model wins over the project's.
 *   shadowed — an override EXISTS but names a different provider than the one
 *              this run resolved to. Ignored: the project's own model is used.
 *              Surfaced, never swallowed.
 */
export type RoleModelOutcome =
  | { kind: "none" }
  | { kind: "applied"; model: string }
  | { kind: "shadowed"; stored: string; storedProvider: LlmProvider; provider: LlmProvider };

/**
 * Apply the role override to an already-decided provider selection.
 *
 * `provider` and `projectModel` come from `selectProvider` — this function never
 * changes the provider, only which model runs on it.
 */
export function applyRoleModelOverride(args: {
  provider: LlmProvider;
  /** The model the project » tenant » default chain resolved to. */
  projectModel: string | null;
  /** The override row for this (project, role), if any. */
  override: RoleModelOverride | null | undefined;
}): { model: string | null; outcome: RoleModelOutcome } {
  const override = args.override ?? null;
  if (!override) return { model: args.projectModel, outcome: { kind: "none" } };

  if (override.provider !== args.provider) {
    // THE compatibility rule. Never forward; fall back to the project's model.
    return {
      model: args.projectModel,
      outcome: {
        kind: "shadowed",
        stored: override.model,
        storedProvider: override.provider,
        provider: args.provider,
      },
    };
  }

  const model = override.model.trim();
  // An empty stored model is schema-impossible (a CHECK forbids it) and clearing
  // deletes the row, so this is defensive only — and it degrades to the project
  // model rather than to "no model", which would silently downgrade the project.
  if (model.length === 0) return { model: args.projectModel, outcome: { kind: "none" } };

  return { model, outcome: { kind: "applied", model } };
}

/** A stored row: `projectId === null` is the agent-wide default. */
export type RoleModelRow = RoleModelOverride & { projectId: string | null };

/** Which scope answered a lookup - what the UI needs to say "inherits" vs
 *  "overrides", and what a log line needs to be intelligible. */
export type RoleModelScope = "project" | "global" | "none";

export type RoleModelLookup = {
  override: RoleModelOverride | null;
  scope: RoleModelScope;
};

/**
 * A tenant's override rows, split by scope.
 *
 * Two maps rather than one: the project rows and the global rows are looked up
 * by DIFFERENT keys and answer different questions, and collapsing them into one
 * namespace is how a global would end up shadowing a project row on a key
 * collision.
 */
export type RoleModelIndex = {
  /** `roleModelKey(projectId, roleSlug)` -> the row. */
  byProject: Map<string, RoleModelOverride>;
  /** `roleSlug` -> the agent-wide default. */
  byRole: Map<string, RoleModelOverride>;
};

export function indexRoleModels(rows: readonly RoleModelRow[]): RoleModelIndex {
  const byProject = new Map<string, RoleModelOverride>();
  const byRole = new Map<string, RoleModelOverride>();
  for (const row of rows) {
    if (row.projectId === null) byRole.set(row.roleSlug, row);
    else byProject.set(roleModelKey(row.projectId, row.roleSlug), row);
  }
  return { byProject, byRole };
}

/**
 * THE precedence between the two agent rungs: agent+project beats agent-global.
 *
 * Pure and shared, so the engine's resolution and both screens' labels cannot
 * disagree about which row wins. It deliberately does NOT consult the provider -
 * the compatibility rule is `applyRoleModelOverride`'s job and stays in one
 * place. A per-project row that turns out to be shadowed does not fall back to
 * the global: the operator pinned that project specifically, and quietly
 * substituting a different model there would be a second silent surprise.
 *
 * `projectId === null` (a ticket-less run) has no per-project row by
 * construction, so the global answers - which is what "agent-wide" means.
 */
export function lookupRoleModel(
  index: RoleModelIndex,
  projectId: string | null,
  roleSlug: string,
): RoleModelLookup {
  if (projectId !== null) {
    const scoped = index.byProject.get(roleModelKey(projectId, roleSlug));
    if (scoped) return { override: scoped, scope: "project" };
  }
  const global = index.byRole.get(roleSlug);
  if (global) return { override: global, scope: "global" };
  return { override: null, scope: "none" };
}

/** Pick the winner from an already-narrowed pair - the same rule as
 *  `lookupRoleModel`, for the engine's per-run read, which fetches the two rows
 *  directly rather than indexing a whole tenant. */
export function pickRoleModelOverride(args: {
  projectOverride: RoleModelOverride | null | undefined;
  globalOverride: RoleModelOverride | null | undefined;
}): RoleModelLookup {
  if (args.projectOverride) return { override: args.projectOverride, scope: "project" };
  if (args.globalOverride) return { override: args.globalOverride, scope: "global" };
  return { override: null, scope: "none" };
}

export function roleModelKey(projectId: string, roleSlug: string): string {
  return `${projectId} ${roleSlug}`;
}
