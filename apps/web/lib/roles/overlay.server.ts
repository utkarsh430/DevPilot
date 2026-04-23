import "server-only";

// Wiring twin for `overlay-store.ts` — supplies the service client. All decision
// logic and every tenant predicate live in the marker-free module so they stay
// Vitest-loadable; this file only does IO.
//
// `loadOverlayForDispatch` is the ONE function the compose paths call. Keeping
// it here (rather than letting each dispatch site build its own read) is the
// same discipline `composeRoleSystemPrompt` itself enforces: an override that
// lands in more than one place reaches some runs and not others, which is the
// failure class PR #110 was written to end.

import { supabaseService } from "@/lib/db/server";
import { loadRoleOverlay, loadRoleOverlayBody, type RoleOverlay } from "@/lib/roles/overlay-store";

/**
 * The overlay body for a dispatch of `roleSlug`, or null.
 *
 * Never throws: `loadRoleOverlayBody` swallows its own failures. A dispatch that
 * cannot read the overlay composes without one, which is byte-identical to
 * pre-overlay behaviour — the safe direction, since the alternative is failing a
 * ticket over an enrichment.
 */
export async function loadOverlayForDispatch(
  tenantId: string,
  roleSlug: string,
): Promise<string | null> {
  return loadRoleOverlayBody(supabaseService(), tenantId, roleSlug);
}

/** The full row, for the inspector page (needs `updatedAt` for the byline). */
export async function loadOverlayForRole(
  tenantId: string,
  roleSlug: string,
): Promise<RoleOverlay | null> {
  return loadRoleOverlay(supabaseService(), tenantId, roleSlug);
}
