import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/db/server";
import { persistGithubTokenFromSession } from "@/lib/github/oauth";
import { classifyAuthError } from "@/lib/auth/oauth-errors";
import { originFromHeaders } from "@/lib/auth/local-signin";

/**
 * Post-auth landing target for BOTH magic-link OTP and GitHub OAuth flows.
 * Supabase appends `?code=...`; we exchange it for a session and forward.
 *
 * GitHub OAuth (Phase 2 / M5a) extension:
 *  - exchangeCodeForSession returns the session with `provider_token` +
 *    `provider_refresh_token` populated when the upstream provider is GitHub.
 *  - We mirror that token into our own `github_oauth_tokens` table so
 *    background agents can use it after the session expires.
 *  - Persistence errors do NOT fail the login — the user is signed in;
 *    we surface the error on the settings page.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  // Redirect on the origin the BROWSER used (Host header), not `request.url`:
  // under `next dev --hostname 127.0.0.1` the latter reads `localhost:3000`
  // for a request that arrived on 127.0.0.1, and the session cookies just
  // written for 127.0.0.1 would not travel to it - the user lands on /login
  // with no error although the exchange succeeded. See lib/auth/local-signin.
  const base = originFromHeaders(request.headers, url.origin);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/board";

  // Supabase can also land here with ?error=…&error_code=…&error_description=…
  // (no code at all) when the upstream provider or GoTrue rejects the attempt.
  const upstreamError = url.searchParams.get("error");
  const upstreamErrorCode = url.searchParams.get("error_code");
  const upstreamErrorDescription = url.searchParams.get("error_description");
  if (!code && (upstreamError || upstreamErrorCode)) {
    const friendly = classifyAuthError({
      code: upstreamErrorCode ?? upstreamError,
      description: upstreamErrorDescription,
    });
    return NextResponse.redirect(new URL(`/login?auth_error=${friendly.code}`, base));
  }

  if (code) {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      // Structured code, not a raw message — the login page owns the copy.
      const friendly = classifyAuthError({ message: error.message, code: error.code ?? null });
      console.error("auth/callback: exchangeCodeForSession failed", {
        code: friendly.code,
        raw: error.message,
      });
      return NextResponse.redirect(new URL(`/login?auth_error=${friendly.code}`, base));
    }

    // GitHub OAuth branch: if Supabase returned a provider_token, persist
    // it for background-agent use. Magic-link sessions have no
    // provider_token and this is a no-op.
    const session = data?.session;
    if (session?.provider_token && session.user?.id) {
      try {
        await persistGithubTokenFromSession({
          user: { id: session.user.id },
          provider_token: session.provider_token,
          provider_refresh_token: session.provider_refresh_token ?? null,
          expires_at: session.expires_at ?? null,
        });
      } catch (err) {
        // Don't fail the login — the user is authenticated. Surface the
        // problem on the settings page so they can retry.
        const msg = err instanceof Error ? err.message : String(err);
        console.error("auth/callback: persistGithubTokenFromSession failed", {
          userId: session.user.id,
          error: msg,
        });
        const friendly = classifyAuthError({ message: msg });
        return NextResponse.redirect(
          new URL(
            `/settings/github-integration?error_code=${friendly.code}&error=${encodeURIComponent(
              msg.slice(0, 200),
            )}`,
            base,
          ),
        );
      }
    }
  }
  return NextResponse.redirect(new URL(next, base));
}
