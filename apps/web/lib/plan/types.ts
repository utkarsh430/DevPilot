// Phase 2.5+ / M7 — UI-facing TS types for the plan-mode surface.
//
// Mirrors the snake_case columns in
// `supabase/migrations/20260603200000_phase2_5_planning_sessions.sql` but
// exposed as camelCase to the React tree. The Realtime hook
// (`use-plan-messages.ts`) takes raw rows from PostgREST/Realtime and folds
// them into `PlanMessage` via `rowToPlanMessage`.
//
// Why a dedicated file (not co-located with the actions): three different
// components need these shapes (PlanSheet, PlanMessageList,
// ProposedTicketsReview, PlanningCard) and the actions file owns mutation
// shapes — keeping the public types here avoids a circular import when a
// component depends on the types but not the actions.
//
// Agent S's server-action file (`apps/web/app/(app)/plan/actions.ts`) returns
// these same shapes via its `loadPlanSession`/`loadPlanMessages` helpers
// (whatever they end up named). If Agent S's shapes drift, this file is the
// one place the UI re-aligns from.

import type { CapabilityKey } from "@/lib/stack/capabilities";

/** Locked-in 3-position toggle from the plan. */
export type StackFlavor = "industry" | "mixed" | "oss";

// ─── Stack tags (WI-15) ─────────────────────────────────────────────────────
//
// The HARD counterpart to the soft `StackFlavor` prose knob above: a durable,
// operator-confirmed set of services the project actually commits to, stored
// one row per service in `public.project_stack_tags` and rendered as a hard
// frame at the top of every plan prompt. Where the two disagree, the tags win
// (see `stackTagsBlock` in lib/plan/prompts.ts) — which is why the create form
// seeds the session's flavor FROM the tags rather than hardcoding one.

/** Cloud/OSS provider bucket. Matches the CHECK constraint in migration 20260718000000. */
export type StackProvider = "aws" | "azure" | "gcp" | "oss";

/**
 * How a tag got onto the project. `detected` rows came from fingerprinting the
 * connected repo's manifests - attacker-controlled input - so they are
 * pre-ticked in the create form for the operator to confirm or drop, never
 * auto-trusted. `manual` - the operator ticked it themselves. Stack advisor
 * (a later stage) adds two more: `ai_suggested` - the advisor proposed the
 * capability and the operator accepted the ranker's top pick; `user_override`
 * - the advisor proposed the capability and the operator swapped the service
 * (`StackTag.overridden` mirrors this on the camelCased shape). Provenance
 * only: it never changes how a tag renders.
 */
export type StackTagSource = "detected" | "manual" | "ai_suggested" | "user_override";

/**
 * What the create form submits: a ticked service key + how it got ticked. The
 * server re-derives `provider` and `label` from the static catalog, so this is
 * the whole trusted surface of a stack-tag write.
 */
export type StackTagInput = { serviceKey: string; source: StackTagSource };

/** One row of `public.project_stack_tags`, camelCased for the React tree + prompts. */
export type StackTag = {
  provider: StackProvider;
  /** Stable key into the static catalog (lib/stack/service-catalog.ts). */
  serviceKey: string;
  /** Display label. Always the CATALOG's label — never a string lifted from a repo file. */
  label: string;
  source: StackTagSource;
  /** Stack advisor - which capability slot (lib/stack/capabilities.ts) this
   *  tag fills. `null`/absent for pre-advisor or manually-picked tags outside
   *  the taxonomy (the manual picker's "extra services"). */
  capability?: CapabilityKey | null;
  /** Stack advisor - true when the operator swapped away from the ranker's
   *  recommended service for this capability (`source === "user_override"`). */
  overridden?: boolean;
};

/** Planning-session lifecycle. Strings match the CHECK constraint in the migration. */
export type PlanStatus = "discussing" | "planning" | "planned" | "committed" | "discarded";

/** Which panel agent emitted an assistant/system message. null on user rows. */
export type PlanAgentRole = "lead" | "pm" | "tech_lead" | "devops" | "consolidator";

/** Stack advisor engagement status for a planning session — mirrors the
 *  `planning_sessions.stack_advice_status` CHECK constraint
 *  (`supabase/migrations/20260722000000_stack_advisor.sql`). */
export type StackAdviceStatus = "unrun" | "inferring" | "ready" | "accepted" | "skipped";

/**
 * One row from `public.planning_sessions`. The actions file (`startPlanSessionAction`,
 * etc.) is the source of truth on field names; if Agent S adds/removes fields,
 * this is the only file the UI re-aligns from.
 */
export type PlanSession = {
  id: string;
  tenantId: string;
  projectId: string;
  createdBy: string | null;
  /** One-line headline updated by the lead agent each turn (Haiku, M5h pattern). */
  goalSummary: string | null;
  status: PlanStatus;
  stackFlavor: StackFlavor;
  /** Free-form refinement on top of `stackFlavor` ("Postgres OK, no AWS"). */
  stackPreferences: string;
  /** Cumulative LLM spend for this session in cents. */
  spentCents: number;
  /** Nightly Stripe aggregator timestamp; null until billed. */
  billedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Optional — only populated by loaders that select the column (currently
   *  just PlanSheet's own snapshot load + its Realtime sync). Used to decide
   *  whether the Stack advisor panel has already been engaged for this
   *  session, so a session that already ran/accepted/skipped it doesn't get
   *  retroactively hidden. Absent (not just `"unrun"`) on loaders that never
   *  selected the column, e.g. the Plans history page. */
  stackAdviceStatus?: StackAdviceStatus;
};

/**
 * One row from `public.planning_messages`. user = operator-typed,
 * assistant = LLM reply (carries `agentRole`), system = stage transition
 * markers ("PM panel started", "Consolidator finished") used to drive the
 * progress-pill animation.
 */
export type PlanMessage = {
  id: string;
  sessionId: string;
  tenantId: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Which panel agent emitted this. null on user messages. */
  agentRole: PlanAgentRole | string | null;
  /** Token usage / latency / model id, same shape as `run_steps.payload`. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

/**
 * One row from `public.planning_proposed_tickets`. These are the panel
 * output before the operator hits "Create selected" — at that point the
 * commit action copies the selected rows into `tickets` and writes the
 * resulting ticket id back into `committedTicketId` for audit.
 */
export type ProposedTicket = {
  id: string;
  sessionId: string;
  tenantId: string;
  /** Display + dependency-resolution order (Consolidator decides). */
  ordinal: number;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  /** Slug from `lib/roles/catalog.ts`; null = auto-pick at commit. */
  requestedRole: string | null;
  /**
   * References other rows in the same session by `ordinal`. commitPlanAction
   * resolves these into `ticket_dependencies` rows using `committedTicketId`.
   */
  dependsOnOrdinals: number[];
  selected: boolean;
  /** Null until commit; set once `commitPlanAction` lands the ticket. */
  committedTicketId: string | null;
  createdAt: string;
};

// ─── Raw row shapes (Realtime/PostgREST snake_case) ─────────────────────────
// Used internally by `rowToPlanMessage` in the realtime hook. Not part of the
// public component API — components see `PlanMessage` shape only.

export type RealtimePlanMessageRow = {
  id: string;
  session_id: string;
  tenant_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  agent_role: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};
