"use server";

// The one server action behind the pre-install skill scan.
//
// Lives in `lib/` rather than in `app/(app)/marketplace/actions.ts` for two
// reasons. The first is the `lib/skills/authoring-actions.ts` precedent — the
// scan panel is mounted from the marketplace catalogue today and is not
// route-bound. The second is deliberate blast-radius control: the install path
// lives in that file and is owned elsewhere, and a read-only scan has no
// business sharing a module with the writer it exists to inform.
//
// ── Read-only, and that is the whole security posture ─────────────────────
//
// This action reads one row and returns a report. It installs nothing, edits
// nothing, and persists no result — there is no scan-results table and no
// migration, because a report is a function of a body the operator is looking
// at right now and storing it would only create a second thing that can go
// stale against the row it describes. Re-running is cheap and always current.
//
// `__tests__/skill-scan-write-scope.test.ts` asserts that by SOURCE SCAN rather
// than by observation: a test that exercises this path and sees no write proves
// only that THIS path did not write, and this file is `"use server"` so it
// cannot load under Vitest at all — which is precisely the gap a bug would live
// in.
//
// ── Tenant scope ───────────────────────────────────────────────────────────
//
// `tenantId` comes from the SESSION and is never accepted from the caller — the
// input schema is a single uuid and carries no tenant field. The row is fetched
// through `loadScannableSkill`, whose two predicates are the entire boundary:
// the scan renders the body back verbatim, so an unscoped read here would let
// any member read another workspace's standing agent instructions by pasting an
// id.

import { z } from "zod";
import { requireTenantId, requireUser } from "@/lib/auth";
import { supabaseService } from "@/lib/db/server";
import { defaultSkillScanDeps } from "@/lib/marketplace/skill-scan.server";
import { loadScannableSkill, type ScanStoreClient } from "@/lib/marketplace/skill-scan-store";
import { scanSkillBody, type SkillScanReport } from "@/lib/marketplace/skill-scan";

export type SkillScanActionResult =
  | { ok: true; skillName: string; report: SkillScanReport }
  | { ok: false; error: string };

const ScanInput = z.object({ skillId: z.string().uuid() });

/**
 * Scan a skill body before installing it.
 *
 * Returns the report for rendering. A skill the caller may not see is reported
 * as not found rather than as a permission error — there is nothing useful to
 * distinguish, and confirming that an id exists in some other workspace is
 * itself a small disclosure.
 */
export async function scanSkillAction(skillId: string): Promise<SkillScanActionResult> {
  await requireUser();
  const tenantId = await requireTenantId();

  const parsed = ScanInput.safeParse({ skillId });
  if (!parsed.success) return { ok: false, error: "That is not a skill id." };

  // Cast for the same reason `page.tsx` casts for `loadMarketplaceListings`:
  // the store declares the narrow slice of the client it uses so a test can
  // supply a filter-applying fake, and that slice is not structurally
  // assignable from Supabase's own builder types.
  const skill = await loadScannableSkill(supabaseService() as unknown as ScanStoreClient, {
    id: parsed.data.skillId,
    tenantId,
  });
  if (!skill) return { ok: false, error: "That skill is not in the catalogue or this workspace." };

  const report = await scanSkillBody(defaultSkillScanDeps(tenantId), { body: skill.body });
  return { ok: true, skillName: skill.name, report };
}
