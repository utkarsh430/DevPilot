// Role system-prompt composition — the single seam every dispatch path uses to
// turn a stored `RoleConfig` into the systemPrompt an agent actually sees.
//
// Order matters, and it encodes a precedence:
//
//     <role prompt — STYLE>    ← from code (built-in) or agents.config (custom)
//     <SAFETY CONTRACT>        ← the role's inviolable half, when it has one
//     <reviewer awareness>     ← belongs to the role contract
//     <OPERATOR INSTRUCTIONS>  ← the operator's overlay (`lib/roles/overlay.ts`)
//     <installed skills>       ← guidance for the body of the work
//
// The SAFETY CONTRACT (`lib/roles/safety-contract.ts`) sits directly beneath the
// style half and above everything else, so by the time the overlay fence claims
// subordination to it, it is already in the prompt for that claim to mean
// something. It is also what decides the overlay's PRECEDENCE: a role that has
// one gets the "operator outranks style" wording, a role that does not keeps
// base-wins. That derivation happens HERE, from `hasSafetyContract`, and not
// from a boolean a caller supplies — the split must land before the flip, per
// role, and reading it off the config makes the wrong order inexpressible
// rather than merely discouraged.
//
// The reviewer-awareness note belongs to the role contract, so it lands before
// anything the operator or an installed bundle contributes. The operator's
// overlay sits ABOVE the skill fence — his explicit instruction should outrank a
// bundle he installed but did not write — and BELOW the role contract, which
// nothing outranks.
//
// Every layer is merged fresh here at dispatch time and never baked into
// `role_config.systemPrompt`, and every one is idempotent (fence-marker guarded
// / no-op on an empty input), so paths that compose without skill context — the
// supervisor's ad-hoc spawn, replay's prompt reconstruction — get the same role
// contract as the dispatcher without acquiring a second copy of anything.
//
// `hasTicket` is explicit rather than inferred because only the caller knows:
// the reviewer-awareness note describes the ticket → in_review → QA lifecycle,
// so a ticket-less run (supervisor spawn, replay of a ticket-less original)
// must pass `false` or the agent is told about a review gate it will never
// reach. Skill merging and the overlay are unaffected by the flag.
//
// `overlay` is likewise REQUIRED, not optional, and that is the point: making it
// a required parameter turns every compose site into a compile error until it
// decides what to pass, so "forgot to load the overlay here" is not expressible.
// An override that lands in some dispatch paths and not others is the failure
// class PR #110 was written to end. Pass `null` deliberately (there is no
// tenant, no role, or the caller is not a dispatch) — never by omission.

import type { TicketStatus } from "@/lib/board/state";
import type { SelectedSkill } from "@/lib/skills/select";
import { mergeSkillsIntoSystemPrompt } from "@/lib/skills/merge";
import { applyReviewerAwareness } from "@/lib/roles/reviewer-awareness";
import { applyOperatorOverlay } from "@/lib/roles/overlay";
import { applySafetyContract, hasSafetyContract } from "@/lib/roles/safety-contract";

export type ComposableRoleConfig = {
  systemPrompt: string;
  /**
   * The role's inviolable half. OPTIONAL, and absent is the whole no-op case: a
   * role without one (every custom JD-synthesized role, and every built-in not
   * yet split) composes byte-identically to Phase 2 and keeps base-wins overlay
   * precedence.
   */
  safetyContract?: string;
  onSuccessStatus: TicketStatus;
};

export function composeRoleSystemPrompt(
  config: ComposableRoleConfig,
  skills: SelectedSkill[],
  hasTicket: boolean,
  overlay: string | null,
): string {
  const base = applySafetyContract(config.systemPrompt, config.safetyContract);
  return mergeSkillsIntoSystemPrompt(
    applyOperatorOverlay(
      applyReviewerAwareness(base, config.onSuccessStatus, hasTicket),
      overlay,
      hasSafetyContract(config.safetyContract),
    ),
    skills,
  );
}
