// The pure mechanics of Vercel's INTEGRATION OAuth flow: the install URL, the
// token-exchange request shape, and the response narrowing. No fetch, no
// server-only, no credential resolution — same split as `client.ts` vs
// `api.server.ts`, and for the same reason: the exchange is the single highest-
// risk request in this codebase and its shape must be assertable by tests that
// never touch a network.
//
// ── Which OAuth flow this is, and why the distinction matters ─────────────
// Vercel has TWO authorization servers and mixing them up produces code that
// looks right and fails at runtime:
//
//   * "Sign in with Vercel" — `https://vercel.com/oauth/authorize` +
//     `https://api.vercel.com/login/oauth/token`. Standards-shaped: PKCE,
//     refresh tokens, 1-hour access tokens. It is IDENTITY ONLY — its
//     API-request permissions are in private beta — so it cannot create a
//     project and is not what this file implements.
//
//   * The INTEGRATION flow (this file) — install at
//     `https://vercel.com/integrations/<slug>/new`, exchange at
//     `https://api.vercel.com/v2/oauth/access_token`. Non-OIDC, form-encoded,
//     and it yields a LONG-LIVED token with NO refresh token and NO expiry.
//
// The second point is load-bearing for what this PR does NOT build: there is no
// refresh machinery anywhere, and none should be added. If you find yourself
// reading `expires_in` from the response, you are on the wrong flow.
//
// ── The redirect the exchange must echo ───────────────────────────────────
// `redirect_uri` in the exchange body is not a redirect — nothing is redirected
// at that point. It is an authenticity binding: it must equal the URL the code
// was issued against, which must equal the single Redirect URL registered in
// the Integration Console. Getting it subtly wrong (a trailing slash, http vs
// https, a proxy rewriting the host) produces an opaque rejection, which is why
// `buildCallbackUrl` is the ONE place it is constructed and both the start and
// the exchange call it.

/** Vercel's integration token-exchange endpoint. NOT `/login/oauth/token` —
 *  that is the Sign-in-with-Vercel server. See the header. */
export const VERCEL_OAUTH_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";

/** Path of the callback route. Exported so the install URL, the exchange body
 *  and the operator-facing setup instructions all read the same constant — a
 *  mismatch between any two of them is an unexplainable rejection. */
export const VERCEL_OAUTH_CALLBACK_PATH = "/api/integrations/vercel/callback";

/**
 * The exact Redirect URL to register in Vercel's Integration Console, derived
 * from the instance's own base URL.
 *
 * Normalised: no trailing slash on the origin, path appended verbatim. The
 * settings UI renders the result so the operator copies the string this code
 * will actually send, rather than retyping it.
 */
export function buildCallbackUrl(appBaseUrl: string): string {
  const base = appBaseUrl.trim().replace(/\/+$/, "");
  return `${base}${VERCEL_OAUTH_CALLBACK_PATH}`;
}

/**
 * Where to send the operator's browser to install the integration.
 *
 * This is Vercel's documented "external installation flow". The redirect back
 * carries `code`, `teamId`, `configurationId`, `state` and `source=external`.
 * Note that `redirect_uri` is NOT a parameter here — the Console's registered
 * Redirect URL is used — so `state` is the only thing we control on the way
 * out, which is precisely why the CSRF design in `oauth-state.ts` puts the
 * whole binding inside it.
 */
export function buildVercelInstallUrl(args: { slug: string; state: string }): string {
  const slug = args.slug.trim();
  const url = new URL(`https://vercel.com/integrations/${encodeURIComponent(slug)}/new`);
  url.searchParams.set("state", args.state);
  return url.toString();
}

/** A slug is a URL path segment on vercel.com. Validated before it is
 *  interpolated so a mis-pasted value (a whole URL, a slash, a space) fails
 *  here with a clear message instead of producing a 404 install page the
 *  operator cannot diagnose. */
export function isValidIntegrationSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug.trim());
}

export type TokenExchangeRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
};

/**
 * Build the token-exchange request.
 *
 * FORM-URLENCODED, not JSON — Vercel's integration endpoint documents
 * `application/x-www-form-urlencoded` and a JSON body is rejected.
 *
 * ⚠️ THE HIGHEST-RISK OBJECT IN THIS PR. This request body contains the client
 * SECRET, and the response to it contains the ACCESS TOKEN. It is the one place
 * in the Vercel client where a credential travels in a body rather than a
 * header, which defeats the "the token is only ever in the Authorization
 * header, so a logged URL and a logged body are always safe" invariant every
 * other call in `api.ts` relies on. Consequences, all enforced by the caller in
 * `api.ts`: this body is NEVER logged, NEVER echoed into an error, and both the
 * secret and the token are passed as scrubber needles for any message derived
 * from the attempt.
 */
export function buildTokenExchangeRequest(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): TokenExchangeRequest {
  const form = new URLSearchParams();
  form.set("client_id", args.clientId);
  form.set("client_secret", args.clientSecret);
  form.set("code", args.code);
  form.set("redirect_uri", args.redirectUri);
  return {
    url: VERCEL_OAUTH_TOKEN_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  };
}

export type VercelOAuthToken = {
  accessToken: string;
  /** Vercel's `team_id`. NULL for a personal/Hobby account — per Vercel's own
   *  docs, "if team_id is not null, you know that this integration was
   *  installed on a team". The null case is the operator's, so it is the
   *  well-trodden path here, not a fallback. */
  teamId: string | null;
  /** `installation_id` when present. Informational; the redirect's
   *  `configurationId` is what we actually key diagnosis off. */
  installationId: string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Narrow the exchange response.
 *
 * TOTAL: any shape that does not carry a usable access token returns null, and
 * the caller turns that into a refusal. Never invent a token, and never treat a
 * 200 with an unexpected body as success — storing a garbage credential would
 * present as a working connection that fails on the first real call.
 *
 * `team_id` is read from both snake_case and camelCase: the documented field is
 * `team_id`, but this is a legacy non-OIDC endpoint and the cost of accepting
 * both is nil against the cost of silently dropping a team scope (every
 * subsequent call would then quietly act on the personal account instead).
 */
export function parseTokenExchangeResponse(body: unknown): VercelOAuthToken | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  const accessToken = str(r.access_token) ?? str(r.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    teamId: str(r.team_id) ?? str(r.teamId),
    installationId: str(r.installation_id) ?? str(r.installationId),
  };
}

/** What the install redirect gives us, narrowed. Every field except `code` is
 *  optional on purpose: they come from a third party's query string, and a
 *  missing `configurationId` must degrade to "stored what we got" rather than
 *  refusing an otherwise valid install. */
export type VercelInstallCallbackParams = {
  code: string | null;
  state: string | null;
  teamId: string | null;
  configurationId: string | null;
  source: string | null;
};

export function readInstallCallbackParams(params: URLSearchParams): VercelInstallCallbackParams {
  return {
    code: str(params.get("code")),
    state: str(params.get("state")),
    teamId: str(params.get("teamId")),
    configurationId: str(params.get("configurationId")),
    source: str(params.get("source")),
  };
}

/**
 * Reconcile the team id from the two places it arrives.
 *
 * The TOKEN RESPONSE wins. Both the redirect query and the exchange response
 * carry a team id, and they are not equally trustworthy: the query string is
 * attacker-supplied input to our callback, while the response comes from an
 * authenticated server-to-server exchange we initiated. Preferring the query
 * would let a crafted redirect scope every one of DevPilot's subsequent calls to
 * a team of the attacker's choosing.
 *
 * The query value is used ONLY when the response omits one — and even then it
 * is just a scope hint that a wrong value makes calls fail loudly (403) rather
 * than succeed somewhere unintended.
 */
export function resolveConnectionTeamId(
  fromToken: string | null,
  fromQuery: string | null,
): string | null {
  return fromToken ?? fromQuery ?? null;
}
