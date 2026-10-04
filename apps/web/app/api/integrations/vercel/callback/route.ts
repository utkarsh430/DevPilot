// Where Vercel sends the operator's browser after they install the DevPilot
// integration. This route's job is to turn a single-use `code` into a stored
// access token for THIS tenant — which makes it the most security-sensitive
// entry point added by this PR.
//
// ── Order of operations, and why it is this order ─────────────────────────
//   1. session      — who is asking, and for which tenant. Everything after is
//                     checked against the SESSION, never the query string.
//   2. operator     — the Vercel keys are `operatorOnly`; storing a deploy
//                     credential is at least as privileged as setting one.
//   3. CSRF state   — before ANY network call. An unverified code must never be
//                     exchanged: a successful exchange consumes it and, more to
//                     the point, produces a credential we would then have to
//                     decide what to do with.
//   4. exchange     — server-to-server, with the client secret.
//   5. identity     — one `GET /v2/user` so the stored row records what the
//                     credential actually resolved to rather than what the
//                     redirect claimed.
//   6. store        — encrypted, scoped to the session's tenant.
//
// ── Popup ─────────────────────────────────────────────────────────────────
// Vercel runs the install in a popup, so this route replies with a tiny HTML
// page that reports the outcome to the opener and closes itself, falling back
// to a visible message when there is no opener (an operator who opened the
// install URL in a normal tab). The message is posted to this app's OWN origin
// only — `postMessage(..., window.location.origin)` — never `"*"`.
//
// Vercel's docs note that an app sending `Cross-Origin-Opener-Policy` must use
// `unsafe-none` for the dashboard to observe the popup closing. This app sends
// NO COOP header (checked: none in next.config.ts, none in middleware.ts), so
// the default applies and nothing needs relaxing. Do not add a stricter COOP
// globally without re-testing this flow — and do not "fix" it by weakening COOP
// site-wide if you do; scope any exemption to this route.

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCurrentTenantId, getUser } from "@/lib/auth";
import { isInstanceOperator } from "@/lib/platform-secrets/operator";
import { exchangeVercelOAuthCode, getVercelUser } from "@/lib/vercel/api";
import {
  oauthStateSecret,
  resolveIntegrationConfig,
  saveVercelConnection,
  vercelCallbackUrl,
} from "@/lib/vercel/connection.server";
import { readInstallCallbackParams, resolveConnectionTeamId } from "@/lib/vercel/oauth";
import {
  describeStateFailure,
  verifyVercelOAuthState,
  VERCEL_OAUTH_STATE_COOKIE,
} from "@/lib/vercel/oauth-state";
import { invalidatePlatformSecrets } from "@/lib/platform-secrets/resolver";

export const dynamic = "force-dynamic";

/** Escape for interpolation into the HTML response. The only value that reaches
 *  it is one of OUR messages, but the messages embed scrubbed third-party detail
 *  from Vercel's error bodies, so it is escaped rather than trusted. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function respond(args: { ok: boolean; message: string; status?: number }): NextResponse {
  const payload = JSON.stringify({
    type: "devpilot:vercel-connect",
    ok: args.ok,
    message: args.message,
  });
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${args.ok ? "Vercel connected" : "Vercel connection failed"}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:34rem;padding:0 1rem;color:#222}
.b{padding:1rem 1.1rem;border-radius:8px;border:1px solid ${args.ok ? "#bbf7d0" : "#fecaca"};background:${args.ok ? "#f0fdf4" : "#fef2f2"}}
h1{font-size:15px;margin:0 0 .4rem}</style></head>
<body><div class="b"><h1>${args.ok ? "Vercel connected" : "Vercel connection failed"}</h1>
<p>${esc(args.message)}</p>
<p id="c">You can close this window and return to DevPilot.</p></div>
<script>
(function(){
  var payload = ${payload};
  try {
    if (window.opener && window.opener !== window) {
      // Same-origin target only. Never "*": this message reports the outcome of
      // a credential operation and a wildcard target would broadcast it to any
      // page that happened to open this one.
      window.opener.postMessage(payload, window.location.origin);
      window.close();
    }
  } catch (e) { /* opener gone or cross-origin — the visible message stands. */ }
})();
</script></body></html>`;
  return new NextResponse(html, {
    status: args.status ?? (args.ok ? 200 : 400),
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // This page reflects the outcome of a credential operation; it must never
      // be cached by a proxy or the browser's back/forward cache.
      "Cache-Control": "no-store, no-cache, must-revalidate",
      // Vercel's popup-close monitoring requires this NOT to be a restrictive
      // value. Stated explicitly on this route so a future global COOP policy
      // does not silently break the flow.
      "Cross-Origin-Opener-Policy": "unsafe-none",
    },
  });
}

/** Clear the state cookie. Called on EVERY outcome, success or failure: a state
 *  is single-use by design, and leaving a spent one behind widens the replay
 *  window for no benefit. */
async function clearStateCookie(): Promise<void> {
  const store = await cookies();
  store.set(VERCEL_OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const params = readInstallCallbackParams(url.searchParams);

  // 1. Session. A callback with no session cannot be attributed to a tenant,
  //    and guessing one is exactly the cross-tenant write this must not permit.
  const user = await getUser();
  const tenantId = await getCurrentTenantId();
  if (!user || !tenantId) {
    await clearStateCookie();
    return respond({
      ok: false,
      status: 401,
      message:
        "You are not signed in to DevPilot in this browser, so the connection could not be attributed to a workspace. Sign in and start the connection again.",
    });
  }

  // 2. Operator gate — same bar as setting VERCEL_TOKEN by hand.
  if (!(await isInstanceOperator(user.id))) {
    await clearStateCookie();
    return respond({
      ok: false,
      status: 403,
      message: "Only an instance operator can connect Vercel.",
    });
  }

  // 3. CSRF. BEFORE any network call — see the header.
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(VERCEL_OAUTH_STATE_COOKIE)?.value ?? null;
  let secret: string;
  try {
    secret = oauthStateSecret();
  } catch (err) {
    await clearStateCookie();
    return respond({
      ok: false,
      status: 500,
      message: err instanceof Error ? err.message : "The connection could not be verified.",
    });
  }
  const verified = verifyVercelOAuthState({
    state: params.state,
    cookie: cookieValue,
    expectTenantId: tenantId,
    expectUserId: user.id,
    nowMs: Date.now(),
    secret,
  });
  if (!verified.ok) {
    await clearStateCookie();
    // The precise reason goes to the log; the operator gets actionable wording
    // that does not narrate which cryptographic check a prober tripped.
    console.warn("[vercel-oauth] callback refused", { reason: verified.reason });
    return respond({ ok: false, status: 403, message: describeStateFailure(verified.reason) });
  }

  // The state is valid, so it is spent from here on regardless of outcome.
  await clearStateCookie();

  if (!params.code) {
    return respond({
      ok: false,
      message:
        "Vercel returned no installation code, so there was nothing to exchange. Start the connection again.",
    });
  }

  const config = await resolveIntegrationConfig(tenantId);
  if (!config.ok) return respond({ ok: false, message: config.error });

  // 4. Exchange. The client secret goes out here and the access token comes
  //    back; neither is logged (see `exchangeVercelOAuthCode`).
  const exchanged = await exchangeVercelOAuthCode(
    {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code: params.code,
      redirectUri: vercelCallbackUrl(),
    },
    { fetchImpl: (u, init) => fetch(u, init) },
  );
  if (!exchanged.ok) {
    console.warn("[vercel-oauth] exchange failed", { kind: exchanged.error.kind });
    return respond({ ok: false, message: exchanged.error.message });
  }

  const teamId = resolveConnectionTeamId(exchanged.token.teamId, params.teamId);

  // 5. Identity. Best-effort: a failure here must not discard a credential we
  //    have already obtained and cannot obtain again (the code is spent). The
  //    row simply stores no login, and the preflight — which re-reads the live
  //    identity on every render anyway — fills the gap on the next check.
  let accountLogin: string | null = null;
  try {
    const who = await getVercelUser({
      credential: { token: exchanged.token.accessToken, teamId },
      fetchImpl: (u, init) => fetch(u, init),
    });
    accountLogin = who.username ?? who.email ?? null;
  } catch {
    accountLogin = null;
  }

  // 6. Store, scoped to the SESSION's tenant.
  const saved = await saveVercelConnection(tenantId, {
    accessToken: exchanged.token.accessToken,
    teamId,
    configurationId: params.configurationId,
    accountLogin,
    accountKind: teamId ? "team" : "personal",
    connectedBy: user.id,
    connectedAt: new Date().toISOString(),
  });
  if (!saved.ok) {
    return respond({
      ok: false,
      status: 500,
      message: `Vercel authorised the connection but it could not be stored: ${saved.error}`,
    });
  }

  // The resolver caches the tenant's merged secret view; the connection is a
  // rung above it but the card re-reads through the same warm path, so drop it
  // to make the new state visible immediately rather than after the TTL.
  invalidatePlatformSecrets(tenantId);

  return respond({
    ok: true,
    message: accountLogin
      ? `Connected to Vercel as ${accountLogin}${teamId ? " (team)" : ""}.`
      : "Connected to Vercel.",
  });
}
