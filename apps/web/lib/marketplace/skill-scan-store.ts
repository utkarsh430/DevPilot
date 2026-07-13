// The one read the pre-install scan performs.
//
// Kept free of `server-only` and of any Next import on purpose — the caller
// supplies the client, which is what lets `__tests__/skill-scan-store.test.ts`
// drive a filter-applying fake with a control for every predicate. Same shape,
// and the same reason, as `lib/marketplace/listings.ts`.
//
// ── Why the tenant predicate matters more here than the row count suggests ──
//
// This is a SERVICE-ROLE read (the action passes `supabaseService()`), so RLS is
// off and the co-located predicates below are the ENTIRE boundary.
//
// What the scan does with the row it gets is RENDER THE BODY BACK TO THE
// OPERATOR — quoted verbatim, as the evidence beside every finding. So a
// missing predicate here is not an abstract data-integrity concern: it is a
// route by which one workspace reads another workspace's private operating
// guidance by pasting a skill id into a scan. Skill bodies are exactly the kind
// of thing a tenant does not expect to be readable — they are the standing
// instructions its agents run under.
//
// ── What "scannable" means, and why it is two queries rather than one ──────
//
// A skill is scannable by this tenant iff it is PUBLIC (`tenant_id IS NULL`, the
// marketplace catalogue everyone can see and install) or OWNED by this tenant.
// Anything else must come back null.
//
// That could be one query with an `.or(...)`, and it is deliberately not: an
// `.or` is a single string whose contents no filter-applying fake meaningfully
// applies, so the test would end up asserting that a string was passed rather
// than that a foreign row is excluded. Two queries, each carrying ONE explicit
// predicate of its own, are individually auditable and individually testable —
// and neither of them can return a foreign row even if the other is wrong.
//
// The public read uses `.is("tenant_id", null)` and NOT `.eq`: `= NULL` is never
// true in SQL, so an `.eq` there silently finds nothing and every marketplace
// skill becomes unscannable.

import type { SkillRow } from "@/lib/skills/types";

const TABLE = "skills";

const COLUMNS =
  "id, tenant_id, name, version, manifest, body, targets, triggers, installed_from_skill_id, created_at";

/** The narrow slice of the Supabase client this module uses. */
export type ScanQuery = {
  eq(column: string, value: string): ScanQuery;
  is(column: string, value: null): ScanQuery;
  maybeSingle(): Promise<{ data: unknown | null }>;
};

export type ScanStoreClient = {
  from(table: string): { select(columns: string): ScanQuery };
};

/**
 * Load a skill this tenant is allowed to scan: one it owns, or a public
 * marketplace row.
 *
 * The owned row wins when both somehow resolve. Ids are unique so that cannot
 * happen today; preferring the tenant's own copy is the safe direction anyway,
 * since it is the row whose body its agents would actually receive.
 */
export async function loadScannableSkill(
  db: ScanStoreClient,
  args: { id: string; tenantId: string },
): Promise<SkillRow | null> {
  const [owned, publicRow] = await Promise.all([
    db.from(TABLE).select(COLUMNS).eq("id", args.id).eq("tenant_id", args.tenantId).maybeSingle(),
    db.from(TABLE).select(COLUMNS).eq("id", args.id).is("tenant_id", null).maybeSingle(),
  ]);

  const row = (owned?.data ?? publicRow?.data ?? null) as SkillRow | null;
  if (!row) return null;

  // Second, independent statement of the same rule, positioned so it holds even
  // if a future caller hands this module a row it loaded some other way. The
  // predicates above are the boundary; this is the assertion that they held.
  if (row.tenant_id !== null && row.tenant_id !== args.tenantId) return null;

  return row;
}
