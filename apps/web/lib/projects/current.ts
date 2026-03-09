// Phase 2 / M5a — Current-project resolution from the request cookie.
//
// The sidebar project switcher writes the active project id into the
// `devpilot_active_project_id` cookie via a server action. Pages that filter by
// project read it here.
//
// PROJECT-FIRST model: a null/empty cookie no longer means "All projects"
// (that mode was removed). It just means "nothing picked yet", which
// `resolveActiveProjectId` reconciles to the tenant's most-recent project so
// every page scopes to exactly one repo. A tenant with ZERO projects resolves
// to null → the caller sends them to onboarding (`/welcome`).
//
// This module is server-only: it pulls from `next/headers#cookies()` which
// is unavailable in client components.

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadProjectsForTenant } from "@/lib/projects/load";

const COOKIE = "devpilot_active_project_id" as const;

// Pre-rename name of the same cookie. Read-through only: an operator who picked
// a project before the rename keeps that selection instead of being silently
// bounced to the most-recent project. Never written; cleared on the first write
// of the new cookie, so the migration converges the moment they switch project.
const LEGACY_COOKIE = "ace_active_project_id" as const;

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

/**
 * Read the active project id from the request cookies. Returns null if the
 * cookie is absent or empty (= "nothing picked yet").
 */
export async function getCurrentProjectIdFromCookie(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(COOKIE)?.value || store.get(LEGACY_COOKIE)?.value;
  if (!raw || raw.length === 0) return null;
  return raw;
}

/**
 * Persist the active project id into the response cookies. Pass `null` to
 * clear the cookie (= switch back to "All projects").
 *
 * Intended to be invoked from a server action — Next.js disallows writing
 * cookies from Server Components.
 */
export async function setCurrentProjectIdCookie(projectId: string | null): Promise<void> {
  const store = await cookies();
  // Always drop the legacy cookie: if it outlived the new one it would win the
  // read-through above and resurrect a stale selection after a clear.
  store.delete(LEGACY_COOKIE);
  if (projectId == null || projectId.length === 0) {
    store.delete(COOKIE);
    return;
  }
  store.set({
    name: COOKIE,
    value: projectId,
    httpOnly: false, // the client switcher needs to read it for the highlight state
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * Throw if no project is selected. Use on routes that REQUIRE a current
 * project (e.g. `/projects/[id]/scaffold-status`, `/changes/[pendingPushId]`).
 *
 * The caller is expected to `redirect()` from a higher-level layout if it
 * wants a friendlier UX than the thrown error.
 */
export async function getCurrentProjectIdOrThrow(): Promise<string> {
  const id = await getCurrentProjectIdFromCookie();
  if (!id) {
    throw new Error(
      "No active project selected. Switch to a project from the topbar before visiting this page.",
    );
  }
  return id;
}

/**
 * Pure picker shared by `resolveActiveProjectId` and the app layout (which
 * already has the project list loaded, so it avoids a second query).
 *
 *   1. The cookie id, IF it still points at one of the tenant's projects
 *      (a stale cookie — e.g. a since-deleted project — is ignored).
 *   2. Otherwise the most-recent project (`loadProjectsForTenant` is
 *      created_at-ascending, so the last element).
 *   3. `null` only when there are no projects.
 */
export function pickActiveProjectId(
  projects: { id: string }[],
  cookieId: string | null,
): string | null {
  if (projects.length === 0) return null;
  if (cookieId && projects.some((p) => p.id === cookieId)) return cookieId;
  return projects.at(-1)?.id ?? null;
}

/**
 * Resolve the active project for the current request (project-first). Returns
 * null ONLY when the tenant has no projects yet — callers on project-scoped
 * surfaces should use {@link requireActiveProjectId} to bounce to onboarding.
 *
 * React.cache: resolved once per request no matter how many loaders ask.
 * (`loadProjectsForTenant` is itself request-cached, so layout + page share
 * the underlying project-list query too.)
 */
export const resolveActiveProjectId = cache(async (tenantId: string): Promise<string | null> => {
  const [projects, cookieId] = await Promise.all([
    loadProjectsForTenant(tenantId),
    getCurrentProjectIdFromCookie(),
  ]);
  return pickActiveProjectId(projects, cookieId);
});

/**
 * Like {@link resolveActiveProjectId} but redirects a project-less tenant to
 * the guided onboarding screen. Use on every project-scoped page (board,
 * changes, …) so a fresh user is never dropped onto an empty, unusable surface.
 */
export async function requireActiveProjectId(tenantId: string): Promise<string> {
  const id = await resolveActiveProjectId(tenantId);
  if (!id) redirect("/welcome");
  return id;
}
