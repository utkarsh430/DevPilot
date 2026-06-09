// The marketplace's four listing reads, extracted out of the page so their
// tenant scoping is something a test can drive.
//
// This is a SERVICE-ROLE read (the page passes `supabaseService()`), so RLS is
// off and the co-located `.eq("tenant_id", tenantId)` on each tenant-scoped
// query is the ENTIRE boundary. It matters more here than the row count
// suggests: a leaked row on this page is not merely disclosed, it is rendered
// with an Install button and — for anything whose `tenant_id` happened to match
// — an Edit link, i.e. another tenant's prompt text offered for adoption into
// this one's dispatches.
//
// The two public reads use `.is("tenant_id", null)` rather than an `.eq`, which
// is not interchangeable: `= NULL` is never true in SQL, so an `.eq` there
// silently returns an empty catalog.
//
// Kept free of `server-only` and of any Next import on purpose — the caller
// supplies the client, which is what lets `__tests__/listings.test.ts` drive a
// filter-applying fake.

import type { SkillRow, ToolPackageRow } from "@/lib/skills/types";

const SKILL_COLUMNS =
  "id, tenant_id, name, version, manifest, body, targets, triggers, installed_from_skill_id, created_at";
const TOOL_PACKAGE_COLUMNS =
  "id, tenant_id, name, version, manifest, body, installed_from_tool_package_id, created_at";

export type LoadedListings = {
  publicSkills: SkillRow[];
  installedSkills: SkillRow[];
  publicToolPackages: ToolPackageRow[];
  installedToolPackages: ToolPackageRow[];
};

/** The narrow slice of the Supabase client this module uses. */
export type ListingsClient = {
  from(table: string): {
    select(columns: string): {
      is(
        column: string,
        value: null,
      ): { order(column: string): Promise<{ data: unknown[] | null }> };
      eq(
        column: string,
        value: string,
      ): { order(column: string): Promise<{ data: unknown[] | null }> };
    };
  };
};

export async function loadMarketplaceListings(
  db: ListingsClient,
  tenantId: string,
): Promise<LoadedListings> {
  const [publicSkills, installedSkills, publicTools, installedTools] = await Promise.all([
    db.from("skills").select(SKILL_COLUMNS).is("tenant_id", null).order("name"),
    db.from("skills").select(SKILL_COLUMNS).eq("tenant_id", tenantId).order("name"),
    db.from("tool_packages").select(TOOL_PACKAGE_COLUMNS).is("tenant_id", null).order("name"),
    db.from("tool_packages").select(TOOL_PACKAGE_COLUMNS).eq("tenant_id", tenantId).order("name"),
  ]);

  return {
    publicSkills: (publicSkills.data ?? []) as SkillRow[],
    installedSkills: (installedSkills.data ?? []) as SkillRow[],
    publicToolPackages: (publicTools.data ?? []) as ToolPackageRow[],
    installedToolPackages: (installedTools.data ?? []) as ToolPackageRow[],
  };
}
