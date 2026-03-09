// Which roles deliver COMMITTED SOURCE CODE as their work product.
//
// Why this exists (the empty-delivery hole, B2)
// ────────────────────────────────────────────
// `decideQaGate`'s no-commit no-op ("base_sha === head_sha → allow") exists to
// protect the ~48 producer roles that legitimately never commit — a PM refining
// a description, a designer writing a spec, a techwriter editing prose. Without
// it, gating all producers would false-park every one of them.
//
// But the same no-op is what let EIGHT prod hand-offs through with nothing
// behind them: "branch is empty vs origin/main (no code, no package.json)",
// "claimed commit 2628522 does not exist", "workspace branch has zero commits",
// "No implementation delivered". A role whose entire job is to write code and
// which committed nothing is not a comment-only producer — it is a failed one.
//
// So the gate needs to tell two facts apart, and they are genuinely different
// questions:
//
//   • "this role does not produce code"  — a PROPERTY OF THE ROLE, known
//     statically from this catalog, before the run even starts. Fine; allow.
//   • "this role produced no code"       — a property of the RUN, read from the
//     verification record. For a role in this set, a bug; refuse.
//
// This module answers only the first. It is a static allowlist and nothing
// derives it from run data, so no amount of agent behaviour can move a role in
// or out of it.
//
// THE DEFAULT IS "NOT CODE-PRODUCING", and that is the safety property.
// A role absent from this set — every non-code built-in, and every custom
// JD-synthesized role, which by definition cannot appear in a static list —
// keeps today's allow-on-no-commit behaviour byte-for-byte. Getting the
// membership wrong in the exclusive direction costs one missed empty delivery;
// getting it wrong in the inclusive direction wedges a whole role. The set is
// therefore deliberately TIGHT: it holds only roles whose deliverable IS
// committed source, not roles that merely commit sometimes.
//
// Deliberately NOT included, though they do sometimes commit: `devops`, `sre`,
// `platform_engineer`, `cloud_engineer`, `dba`, `dataeng`, `ml_engineer`,
// `qa_automation_engineer`, `sdet`, `staff_engineer`, `software_architect`.
// Each of these has a real "reviewed the topology / wrote a runbook / advised
// on the design and committed nothing" mode, and refusing those hand-offs would
// be exactly the ~48-role regression this feature must not cause. Widening the
// set later is a one-line change here, reviewable on its own evidence.
//
// Also not included by construction: `qa`, `verifier`, `release_engineer`,
// `pm`, `triage` — they are not producers at all (the runner's
// `isProducerRole` never records for them and their `onSuccessStatus` is not
// `in_review`), so they never reach this gate.

/**
 * Roles whose work product is committed source code. Membership is asserted by
 * `lib/roles/__tests__/code-producing.test.ts` against the live `ROLES` catalog
 * so a slug typo cannot silently disable the gate for a role.
 */
export const CODE_PRODUCING_ROLES: ReadonlySet<string> = new Set([
  "engineer",
  "frontend_engineer",
  "backend_engineer",
  "fullstack_engineer",
  "mobile_engineer",
  // Seeds an EMPTY repo (`auto_init:false`) — a scaffolder run that commits
  // nothing has delivered literally nothing, and every ticket rooted on it
  // then branches off an unseeded repo. This is the role the prod evidence
  // implicates second-most (6 records / 25 runs).
  "project_scaffolder",
]);

/**
 * Is `role` a role whose deliverable is committed source code?
 *
 * Null/undefined (a role-less run, or a run whose role could not be resolved)
 * is NOT code-producing: an unknown role must fall back to the permissive
 * pre-existing behaviour, never to a refusal we cannot justify.
 */
export function isCodeProducingRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return CODE_PRODUCING_ROLES.has(role);
}
