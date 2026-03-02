import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Keeps the Supabase session cookies fresh so server components see a valid
 * auth state. Follows the @supabase/ssr cookie-bridge pattern, but validates
 * the JWT locally via `getClaims()` instead of round-tripping to the cloud
 * auth server on every request (see the comment at the call site).
 *
 * Boot guard: on an instance with no Supabase env at all, creating the client
 * below throws — which used to 500 EVERY request. So before touching Supabase
 * we check the two public boot vars (the middleware may run on the edge
 * runtime, where non-public vars aren't guaranteed visible — the full boot
 * check lives in the Node-side /setup status route) and route an unconfigured
 * instance to the first-run wizard at /setup instead.
 */
export async function middleware(request: NextRequest) {
  const bootEnvPresent = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
  const { pathname } = request.nextUrl;
  const isSetupPath = pathname === "/setup" || pathname.startsWith("/setup/");

  if (!bootEnvPresent) {
    // Unconfigured: let the setup surface through untouched (it needs no
    // session), send everything else there.
    if (isSetupPath) return NextResponse.next({ request });
    return NextResponse.redirect(new URL("/setup", request.url));
  }
  if (isSetupPath) {
    // Configured: skip the session refresh — the setup page/API do their own
    // Node-side "still unconfigured?" re-check and turn themselves off.
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Local JWT validation instead of a per-request auth-server round trip.
  // This project signs access tokens with an asymmetric key (ES256), so
  // getClaims() verifies signature + expiry via WebCrypto against the
  // project's JWKS (cached in-process for 10 min; refetches hit Supabase's
  // edge cache). The middleware's real job - refreshing the session cookie -
  // still happens: getClaims() loads the session first, and auth-js performs
  // the remote token refresh only when the access token is within its expiry
  // margin, writing the new cookies through the bridge above. Authoritative
  // user checks stay in server code (requireUser et al.). On an HS256 project
  // or a runtime without WebCrypto, getClaims() falls back to a remote
  // getUser() by itself, so this degrades to the old behavior, never to an
  // unvalidated session. Unlike getUser(), getClaims() throws (rather than
  // returning an error result) on a malformed/corrupted token - e.g. a
  // garbage session cookie - so swallow failures here: the result was always
  // discarded, and requireUser in server code is the authoritative gate that
  // redirects to /login.
  try {
    await supabase.auth.getClaims();
  } catch {
    // Ignore: proceed unauthenticated; downstream auth checks handle it.
  }
  return response;
}

export const config = {
  matcher: [
    // Skip Next internals, static, images, favicon, the health probe, and the
    // run-attach SSE bridge. The SSE bridge MUST NOT pass through this
    // middleware: it wraps every response in NextResponse.next({ request })
    // and writes cookies into it, which causes Next.js to buffer the entire
    // streaming body until the request closes — so EventSource on the
    // browser side sees zero events even though the route is happily
    // enqueuing chunks. The attach route owns its own auth gate (cookies
    // are already valid when the user clicks Open Terminal; no refresh
    // needed for the duration of the stream).
    "/((?!_next/static|_next/image|favicon.ico|health|api/runs/[^/]+/attach|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
