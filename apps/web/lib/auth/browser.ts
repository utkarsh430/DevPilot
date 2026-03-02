// Browser-only auth helpers. Keep this file free of any server-only imports
// (`@/lib/db/server`, `next/headers`, `next/navigation`'s `redirect`, etc.) so
// "use client" components can import from it without dragging the server
// bundle through Next's module resolution.

import { supabaseBrowser } from "@/lib/db/browser";
// `lib/github/scopes` is a leaf module with no imports, so a "use client"
// component can pull it in without dragging the server bundle along — which is
// why the scope literal no longer needs a browser-side copy.
import { GITHUB_OAUTH_SCOPES } from "@/lib/github/scopes";

/**
 * Browser-side wrapper around Supabase's GitHub OAuth flow. Kicks off the
 * upstream authorize redirect; control returns to `/auth/callback` which
 * persists the captured `provider_token` via `persistGithubTokenFromSession`.
 *
 * MUST be called from a "use client" component — Supabase sets a PKCE cookie
 * before redirecting.
 *
 * @param redirectTo Absolute URL the OAuth flow returns to (usually
 *                   `${window.location.origin}/auth/callback`).
 */
export async function signInWithGithub(redirectTo: string): Promise<void> {
  const supabase = supabaseBrowser();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      scopes: GITHUB_OAUTH_SCOPES,
      redirectTo,
    },
  });
  if (error) {
    throw new Error(`signInWithGithub: ${error.message}`);
  }
}
