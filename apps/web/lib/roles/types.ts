// Role configuration. Phase 0 shipped PM / Engineer / QA. Phase 1 / M4 adds
// DevOps, Tech Writer, Designer, and Data Engineer. Phase 1 / M6 adds
// Security — a sibling reviewer used by the parallel fan-out demo. Phase 1 / M7
// adds Triage + Tech Lead and the optional `branches` map for conditional
// routing. Phase 2 (post-M0 reaper) widens the role catalog to 39 additional
// specialized roles covering leadership/product, engineering specializations,
// data, infrastructure, quality, security, design, GTM, and operations — see
// `apps/web/lib/roles/index.ts` for the full ROLES map. Each role is a system
// prompt + model tier + runner policy + the status the ticket lands in when
// the agent's run completes successfully.

import type { ModelTier } from "@/lib/llm/models";
import type { TicketStatus } from "@/lib/board/state";
import type { RunnerKind } from "@/lib/runners/types";

export type Role =
  // Phase 0 + M4 + M6 + M7 — original built-in roles.
  | "pm"
  | "engineer"
  | "qa"
  | "devops"
  | "techwriter"
  | "designer"
  | "dataeng"
  | "security"
  | "triage"
  | "tech_lead"
  // Phase 2 — Leadership / Product.
  | "cto"
  | "vp_engineering"
  | "product_manager"
  | "technical_product_manager"
  | "product_owner"
  | "engineering_manager"
  // Phase 2 — Engineering specialists.
  | "frontend_engineer"
  | "backend_engineer"
  | "fullstack_engineer"
  | "mobile_engineer"
  | "staff_engineer"
  | "software_architect"
  // Phase 2 — Data.
  | "data_scientist"
  | "data_analyst"
  | "ml_engineer"
  | "analytics_engineer"
  // Phase 2 — Infrastructure / Ops.
  | "sre"
  | "cloud_engineer"
  | "platform_engineer"
  | "dba"
  // Phase 2 — Quality + Security.
  | "qa_automation_engineer"
  | "sdet"
  | "security_engineer"
  | "appsec_engineer"
  | "compliance_grc"
  // Phase 2 — Design specialists.
  | "ux_designer"
  | "ui_designer"
  | "ux_researcher"
  | "product_designer"
  // Phase 2 — Go-to-Market / Customer.
  | "sales_account_executive"
  | "solutions_engineer"
  | "customer_success_manager"
  | "implementation_specialist"
  | "technical_support_engineer"
  | "marketing_manager"
  // Phase 2 — Operations / Support.
  | "project_program_manager"
  | "scrum_master"
  | "business_analyst"
  | "it_admin"
  // Phase 2 / M5b — Project scaffolder (auto-files on new-project create-flow).
  | "project_scaffolder"
  // Phase 2 / F5 — final-gate verifier (post-QA build/smoke-check).
  | "verifier"
  // Phase 2.5+ / Slice IB-B — auto-spawned merge-conflict resolver.
  | "release_engineer";

export type RoleConfig = {
  role: Role;
  displayName: string;
  /**
   * The role's working STYLE: method, deliverable shape, tone, what "good" looks
   * like. Operator-OVERRIDABLE once the role carries a `safetyContract` — see
   * `lib/roles/safety-contract.ts` for why the split has to land before the
   * precedence flip, and per role rather than globally.
   */
  systemPrompt: string;
  /**
   * The role's INVIOLABLE half: the ticket state-machine contract, the MCP tool
   * contract, safety rules and approval gates. Appended beneath `systemPrompt`
   * by `composeRoleSystemPrompt` inside its own fence, and never overridable by
   * an operator overlay, an installed skill, or ticket content.
   *
   * OPTIONAL, and omitting it is a provable no-op: `applySafetyContract` returns
   * the style half unchanged byte for byte, and the overlay keeps BASE-WINS
   * precedence. That is deliberately what every custom JD-synthesized role and
   * every not-yet-split built-in gets — the pre-split behaviour, unchanged.
   */
  safetyContract?: string;
  modelTier: ModelTier;
  runnerPolicy: RunnerKind;
  /** Where the ticket moves on a normal successful completion. */
  onSuccessStatus: TicketStatus;
  /**
   * Phase 1 / M7 — conditional branching map. When the role emits a structured
   * `next: <branchKey>` token in its final assistant text, the dispatcher
   * looks up `branches[branchKey]` to pick the next role and routes the ticket
   * there instead of falling through to the state-machine default.
   *
   * Backwards-compatible: roles that omit this field (every Phase 0 / M4 / M5
   * / M6 role except triage) ignore branching entirely. A missing or invalid
   * branch key falls back to the state machine. Cycle guard:
   * `tickets.branch_hops` caps total branch routes per ticket (default 4).
   */
  branches?: Record<string, string>;
};
