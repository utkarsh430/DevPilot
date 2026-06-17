// Zod schemas for plan input validation.
// Exported separately so they can be tested independently of the server action.

import { z } from "zod";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import { TEAM_TIERS, type TeamTier } from "@/lib/team-tiers/tiers";

const STACK_FLAVORS = ["industry", "mixed", "oss"] as const satisfies readonly string[];
const TEAM_TIER_ENUM = TEAM_TIERS as readonly TeamTier[] as [TeamTier, ...TeamTier[]];
const ROLE_SLUG_SET = new Set(ROLE_CATALOG.map((e) => e.slug));

export const StartPlanSessionInput = z.object({
  projectId: z.string().uuid(),
  stackFlavor: z.enum(STACK_FLAVORS),
  stackPreferences: z.string().max(2_000).default(""),
  openingMessage: z.string().min(1).max(65_536),
  /** Optional per-plan tier override. Null/omitted = inherit project default. */
  teamTier: z.enum(TEAM_TIER_ENUM).nullish(),
});

export const SendPlanMessageInput = z.object({
  sessionId: z.string().uuid(),
  content: z.string().min(1).max(65_536),
});

export const EditPlanMessageInput = z.object({
  messageId: z.string().uuid(),
  content: z.string().min(1).max(65_536),
});

// Re-export for convenience
export const PLAN_INPUT_SCHEMAS = {
  StartPlanSessionInput,
  SendPlanMessageInput,
  EditPlanMessageInput,
} as const;
