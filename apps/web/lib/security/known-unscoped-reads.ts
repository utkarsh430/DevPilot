// The register of service-role reads in the cross-tenant class.
//
// IT IS EMPTY, AND THAT IS THE POINT. Keep it that way.
//
// ── What this file is now ──────────────────────────────────────────────────
// It began as a shrinking debt list: ~41 engine-internal reads that filtered on
// an attacker-controllable pointer (`ticket_id`, `project_id`, `run_id`, …) with
// no `tenant_id` predicate, parked here behind the schema-wide trigger invariant
// while the export surface was fixed first. Every one of them has since been
// resolved — nearly all by adding a real predicate, and a few by establishing
// that they were never in the class (see the runner note below) — so the list is
// empty and the detector reports ZERO violations across all of `app/**` and
// `lib/**`.
//
// The file survives its own debt because an empty register is a stronger
// statement than a deleted one: the suite asserts `scanForUnscopedReads` finds
// nothing OUTSIDE this list, so as long as it stays empty, CI fails the moment
// anyone writes a new read in the class. Deleting it would delete that gate.
//
// ── Why an unscoped read is a bug, not a style nit ─────────────────────────
// Every member write policy in this schema pins the row's OWN `tenant_id` and
// says nothing about the pointer. So a hostile tenant can legally write
// `{tenant_id: them, ticket_id: <our ticket>}` and any RLS-off read keyed on our
// ticket id hands their row back to us. A clean PARENT id does NOT imply a clean
// CHILD row. That inference — "the ids are already scoped, so the read is fine"
// — is what created this class, and it appeared verbatim in the comments of the
// code that had it.
//
// It is rarely just a leak. Across the pass the same shape turned out to be:
//   • a cross-tenant WRITE — pause cancelling another tenant's run, a discard
//     deleting their pending_pushes row, the push tracker writing OUR diff into
//     THEIR row, dev-server stop SIGKILLing a pid from a planted row;
//   • a DISARM — a planted "running" row or verdict comment making the
//     reconciler, the sweeper, or a resume stand down, stranding a ticket;
//   • a STEER — deciding which branch an agent works on, which role dispatches
//     next, or what text lands in another tenant's model context.
//
// ── But "unscoped" is not automatically "unsafe" ───────────────────────────
// The opposite error is just as real, and this branch made it. The
// runner-watchdog's `runs`-by-`runner_id` read was in this register, "fixed"
// with a tenant predicate, and that was WRONG: runners are shared across
// tenants, so the predicate hid exactly the cross-tenant runs the reap exists
// for. The pointer is now recorded in `CROSS_TENANT_BY_DESIGN`
// (lib/security/tenant-scope-scan.ts) and the detector no longer asks.
//
// So the question is never "does this read filter on a pointer?" but "does this
// read have an OWNING TENANT?". A ticket's comments do. A dead runner's runs do
// not — that is a question about compute, and every tenant's rows are the answer.
//
// ── The rule ───────────────────────────────────────────────────────────────
// A new read NEVER goes in here. If the detector trips your code, add the
// `.eq("tenant_id", <the authorised tenant>)`. Source that tenant from something
// already proven — an argument the caller verified, or a row looked up by
// PRIMARY KEY (which is not attacker-aimable). Never read the tenant back off
// the row you are about to filter with it: a row must not authorise its own
// read, because then the scope can never exclude it.
//
// Two things are genuinely NOT in the class and are handled elsewhere, asserted
// rather than listed here:
//   • marketplace PROVENANCE (`skills.installed_from_skill_id`,
//     `tool_packages.installed_from_tool_package_id`) — cross-tenant BY DESIGN;
//     installing a public skill points at the original, whose tenant is someone
//     else's. The trigger suite asserts these are deliberately unguarded.
//   • RLS-bound reads — the database already scopes them. The detector is
//     receiver-aware and skips them, but only when it can SEE the binding; an
//     ambiguous or unknown receiver is treated as service-role, because it only
//     ever guesses toward more work.

export type KnownUnscopedRead = { file: string; table: string };

/**
 * Empty by construction — see the header. This is the CI gate, not an escape
 * hatch: adding an entry to silence a failing detector run re-opens the class.
 *
 * Keyed by (file, table) rather than line, so that if an entry ever were needed
 * for a genuinely-blocked migration, ordinary edits above the site would not
 * churn it.
 */
export const KNOWN_UNSCOPED_READS: readonly KnownUnscopedRead[] = [];
