// Is "Continue with GitHub" going to work on THIS install?
//
// On a LOCAL Supabase the GitHub provider is enabled in `supabase/config.toml`
// with its two values read via `env()` from `supabase/.env` - and when that
// file does not exist the CLI passes the LITERAL string `env(…)` through to
// GoTrue (measured: blank values behave the same). GoTrue cannot tell, so it
// redirects to GitHub with `client_id=env(SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID)`
// and the operator lands on a GitHub 404 with no idea why. This module is the
// app-side detection that turns that dead end into instructions.
//
// The signal is `GITHUB_OAUTH_CLIENT_ID`: `pnpm setup:local` writes it into
// `.env.local` in the same step that writes `supabase/.env`, so on a local
// install the two are in lockstep. A HOSTED Supabase configures the provider
// in its dashboard and may legitimately leave that variable blank (it only
// drives the refresh-token path there), so the check applies ONLY when the
// Supabase URL is a loopback host - hostname comparison, never a prefix match,
// the `guide-capture.mjs` rule. Fails OPEN: an unparseable URL is "ready".
//
// Pure, no `server-only`: the login page and the settings page both read it
// on the server, and a test can hold the rule still.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type GithubProviderReadiness =
  | { ready: true }
  | {
      ready: false;
      kind: "local-unconfigured";
      /** What GitHub must be told as the OAuth App's callback: the LOCAL GoTrue. */
      callbackUrl: string;
      /** The one command that wires the app in. */
      command: string;
    };

export const GITHUB_SETUP_COMMAND =
  "pnpm setup:local --github-client-id <Client ID> --github-client-secret <Client secret>";

export function isLoopbackSupabaseUrl(supabaseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(supabaseUrl).hostname);
  } catch {
    return false;
  }
}

export function decideGithubProviderReadiness(input: {
  supabaseUrl: string;
  githubOauthClientId: string;
}): GithubProviderReadiness {
  if (!isLoopbackSupabaseUrl(input.supabaseUrl)) return { ready: true };
  if (input.githubOauthClientId.trim().length > 0) return { ready: true };
  return {
    ready: false,
    kind: "local-unconfigured",
    callbackUrl: `${input.supabaseUrl.replace(/\/+$/, "")}/auth/v1/callback`,
    command: GITHUB_SETUP_COMMAND,
  };
}

/** The server-side call sites read the two variables from `process.env`. */
export function githubProviderReadinessFromEnv(
  env: Record<string, string | undefined> = process.env,
): GithubProviderReadiness {
  return decideGithubProviderReadiness({
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    githubOauthClientId: env.GITHUB_OAUTH_CLIENT_ID ?? "",
  });
}
