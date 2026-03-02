// Server shell for the login page. The form itself is `login-client.tsx`
// (browser-side: the magic-link request sets a PKCE cookie). This wrapper
// exists for two server-only facts:
//
//   • whether "Continue with GitHub" can work on this install - on a local
//     Supabase with no GitHub OAuth App configured, GoTrue redirects to GitHub
//     with a literal `client_id=env(...)` and the visitor lands on a GitHub
//     404, so the button is not offered until `pnpm setup:local
//     --github-client-id … --github-client-secret …` has run
//     (`lib/github/provider-readiness.ts`);
//   • whether this is a local install with instant sign-in enabled, in which
//     case the email form signs the visitor in directly instead of sending a
//     magic link nobody receives (`lib/auth/local-signin.ts`).

import { localSigninFromEnv } from "@/lib/auth/local-signin";
import { githubProviderReadinessFromEnv } from "@/lib/github/provider-readiness";
import { LoginClient } from "./login-client";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ local_error?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  return (
    <LoginClient
      githubSignIn={githubProviderReadinessFromEnv().ready}
      localSignin={localSigninFromEnv().allowed}
      localError={sp.local_error ?? null}
    />
  );
}
