// Team-tier presets. Each tier defines:
//
//   • the SUBSET of the role catalog the planner is allowed to assign,
//   • the MAX number of proposed tickets the consolidator may emit,
//   • a one-line BUNDLING guidance string injected into the consolidator
//     and panel prompts so the LLM merges cross-role work into fewer
//     generalist tickets when the tier is low.
//
// The tier lives on `projects.team_tier` (the operator-chosen default) and
// optionally on `planning_sessions.team_tier` (a per-plan override; null =
// inherit from project). `resolveEffectiveTier` does the inherit dance.
//
// Single source of truth: bump the table here and every surface that imports
// it (TierPicker UI, planner prompts, consolidator slice cap, dispatcher
// role-clamp) picks up the new shape on next build.
//
// Why these tiers (not "low/medium/high"): the user-facing framing is
// outcome-focused — speed/cost vs review depth — rather than vague
// intensity. "Quick" => one-person prototype; "Thorough" => full studio.

import type { Role } from "@/lib/roles/types";

export type TeamTier = "quick" | "standard" | "thorough";

export const TEAM_TIERS: ReadonlyArray<TeamTier> = ["quick", "standard", "thorough"];

export const DEFAULT_TEAM_TIER: TeamTier = "standard";

export type TeamTierConfig = {
  /** Operator-facing label. */
  displayName: string;
  /** One-sentence "what changes" pitch shown in the picker. */
  description: string;
  /**
   * Allow-list of role slugs the consolidator may assign on a ticket. `null`
   * means "no restriction — full catalog allowed". When the tier restricts,
   * planner output that names a disallowed role is silently rewritten to the
   * tier's `bundleInto` role at persist time (see lib/plan/inngest.ts) — this
   * is gentler than failing Zod validation outright.
   */
  allowedRoles: ReadonlyArray<Role> | null;
  /** Hard cap on tickets the consolidator may emit. */
  maxTickets: number;
  /**
   * Generalist role disallowed-role assignments fall back to. Also used by
   * the dispatcher to clamp role handoffs that would otherwise leave the
   * tier's allowed set. Must be a member of `allowedRoles` (or any role
   * when `allowedRoles` is null).
   */
  bundleInto: Role;
  /**
   * Free-form text injected into the consolidator + panel prompts. Tells the
   * model HOW to compress work into the tier's roster.
   */
  bundlingGuidance: string;
};

export const TEAM_TIER_CONFIG: Record<TeamTier, TeamTierConfig> = {
  quick: {
    displayName: "Quick",
    description:
      "Solo generalist — PM refines, one engineer wears every hat, QA reviews. Smallest plan, lowest cost.",
    allowedRoles: ["pm", "engineer", "qa"],
    maxTickets: 6,
    bundleInto: "engineer",
    bundlingGuidance:
      "Bundle aggressively. One ticket may cover work that a larger team would split across multiple roles (design, devops, security). Assign these bundled tickets to `engineer` and call out the cross-cutting sub-tasks inside the acceptance criteria rather than splitting them out as separate tickets.",
  },
  standard: {
    displayName: "Standard",
    description:
      "Core specialist team — PM, tech lead, front/back/full engineers, QA, devops, security, designer, tech writer.",
    allowedRoles: [
      "pm",
      "tech_lead",
      "engineer",
      "frontend_engineer",
      "backend_engineer",
      "fullstack_engineer",
      "qa",
      "devops",
      "security",
      "designer",
      "techwriter",
    ],
    maxTickets: 15,
    bundleInto: "fullstack_engineer",
    bundlingGuidance:
      "Group related sub-tasks. Prefer one ticket per vertical slice; only split when two roles genuinely need to hand off (e.g. design system tokens before frontend wiring). Skip niche specialists — your peers will pick up adjacent work.",
  },
  thorough: {
    displayName: "Thorough",
    description:
      "Full specialist studio — every role in the catalog is available. Use for projects that benefit from deep specialist review.",
    allowedRoles: null,
    maxTickets: 30,
    bundleInto: "engineer",
    bundlingGuidance:
      "Split work along role boundaries when it helps reviewability. Specialists exist; use them where their lens is load-bearing.",
  },
};

/**
 * Resolve which tier should drive a given planner run. Session-level overrides
 * win; otherwise fall back to the project default; if neither is set (legacy
 * row from before the migration applied), fall back to the global default.
 */
export function resolveEffectiveTier(
  projectTier: TeamTier | null | undefined,
  sessionTier: TeamTier | null | undefined,
): TeamTier {
  return sessionTier ?? projectTier ?? DEFAULT_TEAM_TIER;
}

/**
 * Returns the allow-list as a `Set<string>` for fast membership checks.
 * Returns `null` when the tier imposes no restriction (Thorough).
 */
export function getAllowedRoleSet(tier: TeamTier): ReadonlySet<string> | null {
  const allowed = TEAM_TIER_CONFIG[tier].allowedRoles;
  return allowed === null ? null : new Set<string>(allowed);
}

export function isRoleAllowedForTier(tier: TeamTier, slug: string): boolean {
  const set = getAllowedRoleSet(tier);
  return set === null ? true : set.has(slug);
}

/**
 * Clamp a role slug to the tier's allow-list. Returns the input if it's
 * already allowed (or the tier is unrestricted); otherwise returns the
 * tier's `bundleInto` generalist.
 */
export function clampRoleToTier(tier: TeamTier, slug: string): string {
  if (isRoleAllowedForTier(tier, slug)) return slug;
  return TEAM_TIER_CONFIG[tier].bundleInto;
}

export function getMaxTicketsForTier(tier: TeamTier): number {
  return TEAM_TIER_CONFIG[tier].maxTickets;
}

export function getBundlingGuidanceForTier(tier: TeamTier): string {
  return TEAM_TIER_CONFIG[tier].bundlingGuidance;
}
