// Which roles owe a VERDICT — the reviewer-side twin of `code-producing.ts`.
//
// A verdict role's whole deliverable is a decision, and it renders that decision
// in exactly one way: by calling `devpilot_move_ticket` (approve → `done`, request
// changes → `in_progress`). Nothing else it does — comments, handoffs, a long
// summary in its final text — advances the ticket, so a run that ends without
// that call has produced no outcome at all.
//
// `reconcile-policy.ts` already keys its verdictless park on exactly this
// property (`onSuccessStatus === "done"`), and this module exists so the runner
// seam that warns the reviewer WHILE IT CAN STILL ACT keys on the SAME property
// rather than a second hand-maintained list. Same argument as
// `isCodeProducingRole` being stamped rather than re-derived on the runner: the
// runner cannot import from `apps/web`, and a divergent copy of "who owes a
// verdict" would fire the nudge at a role that does not owe one.
//
// DERIVED, NEVER LISTED. `VERDICT_ROLES` is computed from the live `ROLES`
// catalog at module load, so a role whose `onSuccessStatus` changes — or a new
// reviewer role added tomorrow — is in or out of this set automatically. A
// hand-written allowlist is the shape that silently went stale for the twelve
// first-party skills, and there is no reason to repeat it when the catalog
// already carries the fact.
//
// THE ERROR IS ASYMMETRIC, AND IT POINTS THE OPPOSITE WAY FROM `code-producing`.
// There, an over-broad set wedges a role and an over-narrow one costs a missed
// refusal. Here, an over-broad set is the dangerous direction: a role wrongly
// told "you owe a verdict" is a role invited to call `devpilot_move_ticket` on
// work it produced itself — an engineer force-approving its own ticket, which is
// strictly worse than the park this feature exists to pre-empt. So the predicate
// is a plain equality on the role's own contract, with no heuristics, no name
// matching and no defaults that could widen it.

import { ROLES } from "@/lib/roles/index";
import type { TicketStatus } from "@/lib/board/state";

/**
 * Roles from the built-in catalog whose success state IS the verdict — today
 * `qa`, `verifier` and `release_engineer`. Exported for tests and for the
 * engine-side stamp; nothing at runtime should hard-code these slugs.
 */
export const VERDICT_ROLES: ReadonlySet<string> = new Set(
  Object.entries(ROLES)
    .filter(([, config]) => config.onSuccessStatus === "done")
    .map(([slug]) => slug),
);

/**
 * Does this role config describe a role that renders a verdict?
 *
 * Takes the CONFIG rather than the slug so a CUSTOM (JD-synthesized) reviewer
 * role is covered too: `loadRoleConfig` resolves built-in and custom alike, and
 * the reconciler parks on whichever one it loaded. A null config (role-less run,
 * unresolvable role, a failed lookup) is NOT a verdict role — an unknown role
 * must fall back to today's behaviour, never to a nudge we cannot justify.
 */
export function isVerdictRoleConfig(
  // Deliberately looser than `Pick<RoleConfig, "onSuccessStatus">`: a CUSTOM
  // role's config is decoded from `agents.config.role_config` jsonb, so a
  // missing or null status is a shape this really can be handed, and it must
  // narrow to "not a verdict role" rather than be unrepresentable at the type
  // level and then turn up at runtime.
  config: { onSuccessStatus?: TicketStatus | null } | null | undefined,
): boolean {
  return config?.onSuccessStatus === "done";
}
