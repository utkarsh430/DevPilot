// Agent prompt inspection — the read-only "what is this agent actually told to
// do" view behind `/agents/[slug]`.
//
// This file is deliberately MARKER-FREE (no `server-only`) and takes its
// Supabase client by injection, so the tenant-scope guard below is reachable
// from Vitest. `prompt-inspection.server.ts` is the thin wiring twin that
// supplies `supabaseService()` and the role/skill loaders. Same split, and the
// same reason, as `lib/learning/bulk.ts` / `lib/learning/write.ts`.
//
// ── TWO PROMPTS, not one. Conflating them is the easy way to lie here ───────
//
// A dispatched agent receives two distinct things, and this page must not blur
// them, because only one of them is a property of the ROLE:
//
//   A. the SYSTEM prompt (`lib/roles/compose-prompt.ts`) — the agent's standing
//      instructions, the same on every ticket it picks up:
//        1. the role's base prompt      — from code (built-in) or
//                                         `agents.config.role_config` (custom)
//        2. the reviewer-awareness note — appended iff the run is ticket-bound
//                                         AND `onSuccessStatus === "in_review"`
//        3. the installed-skill fence   — top-N skills selected AT DISPATCH
//                                         against the specific ticket's text
//
//   B. the TICKET prompt (`renderTicketPrompt`, `lib/roles/context.ts`) — built
//      per ticket, and among its blocks:
//        4. approved LESSONS (`agent_learnings`, status='active') selected by
//           `selectLearningsForDispatch` and rendered inside
//           `fenceUntrustedOutput` as recalled data, never as directives.
//
// Layers 1 and 2 are DETERMINISTIC: given the role, byte-identical on every
// ticket-bound dispatch. Layers 3 and 4 are NOT — both are selected per ticket
// (skills keyword-filter then LLM-rank; lessons keyword-rank and are capped at
// MAX_LEARNINGS / LEARNINGS_CHAR_BUDGET), so neither is a fixed list.
//
// So this module composes and displays layers 1+2 ONLY, through the same
// `composeRoleSystemPrompt` seam dispatch uses, with an empty skill list —
// which `mergeSkillsIntoSystemPrompt` returns unchanged by construction
// (`if (skills.length === 0) return base`). Layers 3 and 4 are surfaced
// ALONGSIDE it as named ELIGIBILITY lists, never spliced into the displayed
// prompt.
//
// That asymmetry is the whole point: understating what dispatch sends, with an
// explicit label saying so, is safe. OVERstating it — printing a skill body or
// a lesson that this ticket's dispatch would not have selected — would make the
// page a confident lie, which is worse than not having the page.

import type { RoleConfig } from "@/lib/roles/index";
import type { SelectedSkill } from "@/lib/skills/select";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LessonScope } from "@/lib/learning/extract";
import { LEARNINGS_CHAR_BUDGET, MAX_LEARNINGS, type LearningEntry } from "@/lib/learning/select";
import { composeRoleSystemPrompt } from "@/lib/roles/compose-prompt";
import { hasSafetyContract } from "@/lib/roles/safety-contract";
import {
  REVIEWER_AWARENESS_FENCE_HEADER,
  renderReviewerAwarenessBlock,
} from "@/lib/roles/reviewer-awareness";
import { SKILL_FENCE_HEADER } from "@/lib/skills/merge";
import { OVERLAY_FENCE_HEADER, renderOverlayBlock } from "@/lib/roles/overlay";

/**
 * The inspector always composes for a TICKET-BOUND run. That is the shape the
 * operator is asking about ("what does this agent do when it picks up a
 * ticket"), and it is the only shape all four dispatcher sites, `replay.ts`
 * and the supervisor spawn produce with `hasTicket: true`.
 */
export const INSPECTED_RUN_HAS_TICKET = true;

export type PromptLayerKind =
  | "base"
  | "safety_contract"
  | "reviewer_awareness"
  | "operator_overlay";

export type PromptLayer = {
  kind: PromptLayerKind;
  /** Section heading in the layer breakdown. */
  title: string;
  /** One plain-English sentence — the operator is not a prompt engineer. */
  explainer: string;
  /** Where this text lives, so the operator knows what could change it. */
  origin: string;
  chars: number;
};

export type EligibleSkill = {
  id: string;
  name: string;
  version: string;
};

/**
 * An approved lesson (`agent_learnings`, status='active') that is in scope for
 * this role. Body INCLUDED — unlike a skill body, a lesson is short by
 * construction (bounded at `LEARNING_RENDER_BODY_CHARS`), operator-approved,
 * and is the whole substance of what it adds; naming it without showing it
 * would leave the operator's question unanswered. It is still UNTRUSTED text:
 * React escapes it on render, and it must never be presented as a directive.
 */
export type EligibleLesson = {
  id: string;
  scope: LessonScope;
  roleSlug: string | null;
  category: string;
  body: string;
};

export type AgentPromptInspection = {
  slug: string;
  /** The agent row's name when there is one, else the RoleConfig's. */
  displayName: string;
  /** `builtin` = base prompt lives in code; `custom` = in `agents.config`. */
  source: "builtin" | "custom";
  /** `config.source` off the agents row (`jd-synth`, `builder`, …) when set. */
  agentSource: string | null;
  onSuccessStatus: RoleConfig["onSuccessStatus"];
  modelTier: RoleConfig["modelTier"];
  runnerPolicy: RoleConfig["runnerPolicy"];
  /**
   * SYSTEM-prompt layers 1+2, composed through the dispatch seam.
   * Byte-identical to what a ticket-bound dispatch sends before skill
   * selection runs. NOT the whole of what the model receives — the ticket
   * prompt is a separate channel (see the module header).
   */
  composed: string;
  layers: PromptLayer[];
  reviewerAwarenessApplies: boolean;
  /**
   * The operator's own instructions for this role, raw as stored — this is what
   * the editor loads, so it must be the stored body and NOT the fenced render.
   * Null when there is none, which is the state every role starts in.
   */
  overlayBody: string | null;
  /** When it was last saved, for the byline. Null when there is no overlay. */
  overlayUpdatedAt: string | null;
  /**
   * Skills installed in this tenant that are ELIGIBLE for this role (their
   * `targets` list names it, or is empty). Not a claim about any particular
   * run — see the module header.
   */
  eligibleSkills: EligibleSkill[];
  /**
   * Active lessons in scope for this role (`global` + `user` always, `role`
   * when the slug matches). Again ELIGIBILITY, not a per-run selection.
   */
  eligibleLessons: EligibleLesson[];
  /** The per-run caps, surfaced so the eligibility list is not read as fixed. */
  lessonCaps: { maxPerRun: number; charBudget: number };
};

export type AgentRowSummary = {
  name: string;
  /** `config.source` — `jd-synth`, `builder`, `builtin`, … */
  source: string | null;
};

/**
 * The one NEW read this feature adds, and the only one whose tenant predicate
 * is not already inherited from an existing loader (`loadCustomRoleConfig` and
 * `selectSkillsForDispatch` each carry their own `.eq("tenant_id", …)`).
 *
 * Runs on the SERVICE client, so RLS is off and the co-located
 * `.eq("tenant_id", tenantId)` IS the entire boundary. Without it a foreign
 * tenant's agent row would supply the display name and source badge for a slug
 * this tenant may not even have — i.e. disclosure of another workspace's agent
 * naming, on a page whose whole job is to be believed.
 */
export async function loadAgentRowForRole(
  db: SupabaseClient,
  tenantId: string,
  slug: string,
): Promise<AgentRowSummary | null> {
  const { data, error } = await db
    .from("agents")
    .select("name, config")
    .eq("tenant_id", tenantId)
    .eq("role", slug)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;

  const cfg = (data.config ?? {}) as Record<string, unknown>;
  const source = typeof cfg.source === "string" && cfg.source.length > 0 ? cfg.source : null;
  return { name: typeof data.name === "string" ? data.name : slug, source };
}

/** Does the reviewer-awareness note apply to a ticket-bound run of this role? */
export function reviewerAwarenessApplies(config: Pick<RoleConfig, "onSuccessStatus">): boolean {
  return config.onSuccessStatus === "in_review";
}

/**
 * Layers 1+2 (+ the operator's overlay when there is one), composed through the
 * SAME seam dispatch calls, with an empty skill list. Passing `[]` is what makes
 * this byte-exact rather than approximate: `mergeSkillsIntoSystemPrompt`
 * short-circuits on an empty list, so the result is
 * `applyOperatorOverlay(applyReviewerAwareness(base, …), overlay)` verbatim.
 *
 * The overlay IS included, deliberately. It is deterministic — the same on every
 * ticket, exactly like layers 1 and 2 — so it belongs in the pane rather than
 * beside it, and a page answering "what is this agent actually told to do" that
 * omitted the operator's own standing instructions would be the precise class of
 * confident lie the module header exists to prevent. Passing `null` returns the
 * pre-overlay composition byte for byte.
 */
export function composeInspectedPrompt(config: RoleConfig, overlay: string | null): string {
  return composeRoleSystemPrompt(config, [], INSPECTED_RUN_HAS_TICKET, overlay);
}

/**
 * The layer breakdown shown beside the composed prompt. Kept as data (not JSX)
 * so the explainer copy is testable and cannot drift from what is composed.
 */
export function describePromptLayers(
  config: RoleConfig,
  source: "builtin" | "custom",
  overlay: string | null,
): PromptLayer[] {
  const layers: PromptLayer[] = [
    {
      kind: "base",
      title: "Role prompt",
      explainer:
        "The agent's job description — how it works, what a good deliverable " +
        "looks like, what to prioritise. This is the bulk of what it is told, " +
        "and it is the part your own instructions below can overrule.",
      origin:
        source === "builtin"
          ? "Ships with DevPilot, in code. Updates arrive with each deploy."
          : "Stored on this agent (agents.config.role_config), from the JD synthesizer or the builder.",
      chars: config.systemPrompt.length,
    },
  ];

  if (hasSafetyContract(config.safetyContract)) {
    layers.push({
      kind: "safety_contract",
      title: "Safety contract",
      explainer:
        "The rules this agent cannot be talked out of: how the ticket moves, " +
        "which board tools it calls and when, and anything needing a human's " +
        "say-so. Your instructions below never override this.",
      origin:
        source === "builtin"
          ? "Ships with DevPilot, in code. Nothing you or an installed skill can write changes it."
          : "This agent has no safety contract — see the note on the role prompt above.",
      chars: (config.safetyContract ?? "").length,
    });
  }

  if (reviewerAwarenessApplies(config)) {
    layers.push({
      kind: "reviewer_awareness",
      title: "Reviewer awareness",
      explainer:
        "A short note telling the agent its work is checked by QA before it is " +
        "accepted, so it holds its output to that bar.",
      origin:
        'Added automatically at dispatch because this role hands finished tickets to QA (on success it moves them to "in review").',
      chars: renderReviewerAwarenessBlock().length,
    });
  }

  if (overlay && overlay.trim().length > 0) {
    layers.push({
      kind: "operator_overlay",
      title: "Your instructions",
      explainer: hasSafetyContract(config.safetyContract)
        ? "What you have told this agent, on top of everything above. Where it " +
          "disagrees with the role prompt's working style, YOURS WINS. It never " +
          "overrides the safety contract."
        : "What you have told this agent, on top of everything above. It refines " +
          "how the agent works — never what it does to the ticket.",
      origin:
        "Written by you, stored in this workspace. Clearing it puts the agent back to exactly the prompt above.",
      chars: renderOverlayBlock(overlay.trim(), hasSafetyContract(config.safetyContract)).length,
    });
  }

  return layers;
}

/** Name + version only — see `describeSkillDisclosure` for why not the bodies. */
export function toEligibleSkills(skills: SelectedSkill[]): EligibleSkill[] {
  return skills.map((s) => ({ id: s.id, name: s.name, version: s.version }));
}

/**
 * The honest caption for the skills section. Stated as a constant rather than
 * inline JSX so a test can pin that the page says the selection is per-ticket —
 * that sentence is the entire reason the section is safe to show at all.
 */
export const SKILL_DISCLOSURE =
  "These skills are installed in this workspace and eligible for this role. " +
  "At dispatch, DevPilot re-selects the most relevant few against the specific " +
  "ticket's text, so which of them are appended — if any — varies per ticket. " +
  "The system prompt above does not.";

/** Name + scope + body. See `EligibleLesson` for why the body is included. */
export function toEligibleLessons(entries: readonly LearningEntry[]): EligibleLesson[] {
  return entries.map((e) => ({
    id: e.id,
    scope: e.scope,
    roleSlug: e.roleSlug,
    category: e.category,
    body: e.body,
  }));
}

export const LESSON_CAPS = {
  maxPerRun: MAX_LEARNINGS,
  charBudget: LEARNINGS_CHAR_BUDGET,
} as const;

/**
 * The honest caption for the lessons section. Two facts it must carry, both
 * load-bearing: this is a DIFFERENT channel from the system prompt (it lands in
 * the per-ticket prompt, fenced as recalled data rather than as directives),
 * and the per-run set is SELECTED and CAPPED, so this list is not what any one
 * run sees.
 */
export const LESSON_DISCLOSURE =
  `These are approved lessons this workspace has learned that apply to this ` +
  `role. They reach the agent by a different route from the prompt above: ` +
  `DevPilot adds them to the individual ticket's brief, fenced as recalled ` +
  `notes to weigh rather than as orders — the role prompt always wins. ` +
  `Selection is per ticket and capped at ${MAX_LEARNINGS} lessons ` +
  `(${LEARNINGS_CHAR_BUDGET.toLocaleString()} characters), so a given run sees ` +
  `some of these, not all of them.`;

/** Human-readable scope label. `role` names the slug it is bound to. */
export function describeLessonScope(lesson: EligibleLesson): string {
  if (lesson.scope === "role") return `this role`;
  if (lesson.scope === "user") return "your preference";
  return "all agents";
}

/** Fence markers, surfaced so the operator can find each layer in the text. */
export const LAYER_FENCE_MARKERS = {
  reviewerAwareness: REVIEWER_AWARENESS_FENCE_HEADER,
  operatorOverlay: OVERLAY_FENCE_HEADER,
  skills: SKILL_FENCE_HEADER,
} as const;

/**
 * The honest caption for the overlay editor. Three facts it must carry, and all
 * three are the reason the feature is safe to offer at all: the shipped prompt
 * above is NOT edited, these instructions are SUBORDINATE to it, and clearing
 * them is a complete reset because nothing was overwritten to begin with.
 */
export const OVERLAY_DISCLOSURE =
  "These are added beneath the prompt above on every run of this agent — board " +
  "tickets, API runs and the embedded widget alike — and the prompt above is " +
  "never changed. Use them for how you want the agent to work: tone, priorities, " +
  "conventions, house rules. They cannot change how tickets move on the board, " +
  "which board tools the agent uses, or any safety rule, and where they disagree " +
  "with the prompt above, the prompt above wins. Clearing them puts the agent " +
  "back to exactly its shipped instructions.";
