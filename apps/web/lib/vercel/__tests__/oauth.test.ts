// The OAuth mechanics: install URL, exchange request shape, response narrowing,
// and the exchange transport driven by an INJECTED fetch. No test here makes a
// network call.
//
// The leak assertions are the point of the second half. This exchange is the
// only request in the Vercel client whose BODY carries a secret and whose
// RESPONSE carries a token, so "the credential never appears in anything we
// surface" cannot be inherited from `vercelFetch`'s header-only invariant — it
// has to be asserted directly.

import { describe, expect, it, vi } from "vitest";
import { exchangeVercelOAuthCode } from "@/lib/vercel/api";
import {
  buildCallbackUrl,
  buildTokenExchangeRequest,
  buildVercelInstallUrl,
  isValidIntegrationSlug,
  parseTokenExchangeResponse,
  readInstallCallbackParams,
  resolveConnectionTeamId,
  VERCEL_OAUTH_CALLBACK_PATH,
} from "@/lib/vercel/oauth";

const CLIENT_ID = "oac_abc123";
const CLIENT_SECRET = "super-secret-client-value-9f8e7d6c";
const CODE = "code_0123456789abcdef";
const TOKEN = "vercel-access-token-abcdef0123456789";
const REDIRECT = "http://localhost:3000/api/integrations/vercel/callback";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("install URL", () => {
  it("targets the documented external installation path and carries the state", () => {
    const url = new URL(buildVercelInstallUrl({ slug: "devpilot", state: "st-1" }));
    expect(url.origin).toBe("https://vercel.com");
    expect(url.pathname).toBe("/integrations/devpilot/new");
    expect(url.searchParams.get("state")).toBe("st-1");
  });

  it("rejects a slug that is a URL or contains a path separator", () => {
    // A mis-pasted whole URL would otherwise be encoded into a 404 install page
    // the operator cannot diagnose.
    expect(isValidIntegrationSlug("devpilot")).toBe(true);
    expect(isValidIntegrationSlug("crew-ban-2")).toBe(true);
    expect(isValidIntegrationSlug("https://vercel.com/integrations/devpilot/new")).toBe(false);
    expect(isValidIntegrationSlug("crew/ban")).toBe(false);
    expect(isValidIntegrationSlug("DevPilot")).toBe(false);
    expect(isValidIntegrationSlug("")).toBe(false);
  });
});

describe("callback URL", () => {
  it("normalises a trailing slash so the registered and sent values match", () => {
    expect(buildCallbackUrl("http://localhost:3000/")).toBe(
      `http://localhost:3000${VERCEL_OAUTH_CALLBACK_PATH}`,
    );
    expect(buildCallbackUrl("https://crew.example.com")).toBe(
      `https://crew.example.com${VERCEL_OAUTH_CALLBACK_PATH}`,
    );
  });
});

describe("exchange request shape", () => {
  it("is form-urlencoded with the four documented fields", () => {
    const req = buildTokenExchangeRequest({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: CODE,
      redirectUri: REDIRECT,
    });
    expect(req.url).toBe("https://api.vercel.com/v2/oauth/access_token");
    expect(req.method).toBe("POST");
    expect(req.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(req.body);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(form.get("code")).toBe(CODE);
    expect(form.get("redirect_uri")).toBe(REDIRECT);
  });

  it("does NOT send the secret in the URL or a header", () => {
    const req = buildTokenExchangeRequest({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: CODE,
      redirectUri: REDIRECT,
    });
    expect(req.url).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(req.headers)).not.toContain(CLIENT_SECRET);
  });

  it("targets the INTEGRATION endpoint, not the sign-in-with-Vercel one", () => {
    // Mixing the two authorization servers produces code that looks right and
    // fails at runtime; `/login/oauth/token` is the wrong one.
    const req = buildTokenExchangeRequest({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: CODE,
      redirectUri: REDIRECT,
    });
    expect(req.url).not.toContain("/login/oauth/token");
  });
});

describe("response narrowing", () => {
  it("reads the token and a null team id (the Hobby-account case)", () => {
    const parsed = parseTokenExchangeResponse({ access_token: TOKEN, team_id: null });
    expect(parsed).toEqual({ accessToken: TOKEN, teamId: null, installationId: null });
  });

  it("reads a team id when the install was on a team", () => {
    const parsed = parseTokenExchangeResponse({ access_token: TOKEN, team_id: "team_x" });
    expect(parsed?.teamId).toBe("team_x");
  });

  it("returns null for every shape that carries no usable token", () => {
    for (const body of [null, undefined, {}, [], "str", 7, { access_token: "" }]) {
      expect(parseTokenExchangeResponse(body)).toBeNull();
    }
  });
});

describe("team id reconciliation", () => {
  it("prefers the token response over the redirect query", () => {
    // The query string is attacker-supplied input to our callback; the response
    // comes from an authenticated server-to-server exchange. Preferring the
    // query would let a crafted redirect scope every later call to their team.
    expect(resolveConnectionTeamId("team_real", "team_attacker")).toBe("team_real");
  });

  it("falls back to the query only when the response omits one", () => {
    expect(resolveConnectionTeamId(null, "team_q")).toBe("team_q");
    expect(resolveConnectionTeamId(null, null)).toBeNull();
  });
});

describe("callback params", () => {
  it("reads the documented redirect fields and tolerates missing optionals", () => {
    const p = readInstallCallbackParams(
      new URLSearchParams("code=c1&state=s1&teamId=t1&configurationId=cfg1&source=external"),
    );
    expect(p).toEqual({
      code: "c1",
      state: "s1",
      teamId: "t1",
      configurationId: "cfg1",
      source: "external",
    });
    const bare = readInstallCallbackParams(new URLSearchParams("code=c1"));
    expect(bare.configurationId).toBeNull();
    expect(bare.teamId).toBeNull();
  });
});

describe("exchange transport (injected fetch — no network)", () => {
  it("returns the token on a 200", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: TOKEN, team_id: null }));
    const res = await exchangeVercelOAuthCode(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: CODE, redirectUri: REDIRECT },
      { fetchImpl },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.token.accessToken).toBe(TOKEN);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("LEAK: a rejected exchange never echoes the client secret or the code", async () => {
    // Vercel commonly repeats the submitted parameters back in an error body.
    // Both are passed as scrubber needles for exactly this.
    const fetchImpl = async () =>
      jsonResponse(400, {
        error: {
          code: "bad_request",
          message: `client_secret ${CLIENT_SECRET} rejected for code ${CODE}`,
        },
      });
    const res = await exchangeVercelOAuthCode(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: CODE, redirectUri: REDIRECT },
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).not.toContain(CLIENT_SECRET);
      expect(res.error.message).not.toContain(CODE);
      expect(res.error.message).toContain("[redacted]");
    }
  });

  it("LEAK: a thrown fetch error never echoes the secret", async () => {
    const fetchImpl = async () => {
      throw new Error(`connect ECONNREFUSED while posting client_secret=${CLIENT_SECRET}`);
    };
    const res = await exchangeVercelOAuthCode(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: CODE, redirectUri: REDIRECT },
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).not.toContain(CLIENT_SECRET);
  });

  it("LEAK: a malformed 200 message is a fixed string, never derived from the body", async () => {
    // The body of a 200 here IS (or was meant to be) the access token, so
    // nothing from it may reach an operator-facing message.
    const fetchImpl = async () => jsonResponse(200, { unexpected: TOKEN });
    const res = await exchangeVercelOAuthCode(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: CODE, redirectUri: REDIRECT },
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("malformed_response");
      expect(res.error.message).not.toContain(TOKEN);
    }
  });

  it("reports a rejected exchange as its own kind, not as a dead token", async () => {
    // "Mint a new token" is advice for a problem the operator does not have:
    // at this point there is no token yet. The exchange-specific wording names
    // the two real causes (reused/expired code, redirect-URI mismatch).
    const fetchImpl = async () =>
      jsonResponse(403, { error: { code: "forbidden", message: "Not authorized" } });
    const res = await exchangeVercelOAuthCode(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: CODE, redirectUri: REDIRECT },
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("oauth_exchange_failed");
      expect(res.error.message).toContain("single-use");
      expect(res.error.message).toContain("Redirect URL");
    }
  });

  it("does not classify a 5xx as an exchange failure", async () => {
    const fetchImpl = async () => jsonResponse(503, { error: { message: "upstream down" } });
    const res = await exchangeVercelOAuthCode(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code: CODE, redirectUri: REDIRECT },
      { fetchImpl },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("server_error");
  });
});
