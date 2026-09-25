// The CSRF suite. This is the security-critical half of "Connect Vercel": a
// callback that accepts any inbound `code` lets an attacker bind THEIR Vercel
// account to the operator's DevPilot, after which every deploy and every
// environment variable DevPilot pushes goes to them.
//
// So these tests are written as REFUSALS, not as a happy path with some edge
// cases. Each one names the attack it forecloses, and the positive test exists
// mainly to prove the refusals are not vacuous — a `verify` that returned false
// unconditionally would pass every negative test in this file.

import { describe, expect, it } from "vitest";
import {
  describeStateFailure,
  issueVercelOAuthState,
  safeEqual,
  verifyVercelOAuthState,
  VERCEL_OAUTH_STATE_TTL_MS,
} from "@/lib/vercel/oauth-state";

const SECRET = "test-secret-value-at-least-32-bytes-long";
const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const NOW = 1_700_000_000_000;

function issue(over: Partial<Parameters<typeof issueVercelOAuthState>[0]> = {}): string {
  return issueVercelOAuthState({
    tenantId: TENANT,
    userId: USER,
    nonce: "nonce-abc",
    nowMs: NOW,
    secret: SECRET,
    ...over,
  });
}

function verify(over: Partial<Parameters<typeof verifyVercelOAuthState>[0]> = {}) {
  const state = over.state !== undefined ? over.state : issue();
  return verifyVercelOAuthState({
    state,
    cookie: state,
    expectTenantId: TENANT,
    expectUserId: USER,
    nowMs: NOW,
    secret: SECRET,
    ...over,
  });
}

describe("the happy path (so the refusals below are not vacuous)", () => {
  it("accepts a state it just issued, with the matching cookie", () => {
    const res = verify();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.t).toBe(TENANT);
      expect(res.payload.u).toBe(USER);
      expect(res.payload.n).toBe("nonce-abc");
    }
  });

  it("accepts within the TTL window", () => {
    expect(verify({ nowMs: NOW + VERCEL_OAUTH_STATE_TTL_MS - 1000 }).ok).toBe(true);
  });
});

describe("ATTACK: an inbound code with no flow started here", () => {
  // The core login-CSRF. The attacker installs the integration on their own
  // account and navigates the operator's browser to our callback with their
  // code. They cannot set our HttpOnly cookie, so there is nothing to match.
  it("refuses when the cookie is absent", () => {
    const state = issue();
    const res = verifyVercelOAuthState({
      state,
      cookie: null,
      expectTenantId: TENANT,
      expectUserId: USER,
      nowMs: NOW,
      secret: SECRET,
    });
    expect(res).toEqual({ ok: false, reason: "missing_cookie" });
  });

  it("refuses when no state is supplied at all", () => {
    const res = verify({ state: "", cookie: issue() });
    expect(res).toEqual({ ok: false, reason: "missing_state" });
  });

  it("refuses when the state and the cookie disagree", () => {
    const res = verify({ state: issue(), cookie: issue({ nonce: "different" }) });
    expect(res).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("ATTACK: forging a state, or planting both halves", () => {
  // Double-submit alone would fall here: an attacker able to WRITE a cookie on
  // the origin (a sibling subdomain, a cookie-tossing bug) could otherwise set
  // both the cookie and the query parameter to a value of their choosing. The
  // signature is what makes that unreachable.
  it("refuses a self-consistent pair that we never signed", () => {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, n: "x", t: TENANT, u: USER, iat: NOW }),
      "utf8",
    ).toString("base64url");
    const forged = `${payload}.not-a-real-signature`;
    const res = verify({ state: forged, cookie: forged });
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a state signed with a different secret", () => {
    const other = issue();
    const res = verifyVercelOAuthState({
      state: other,
      cookie: other,
      expectTenantId: TENANT,
      expectUserId: USER,
      nowMs: NOW,
      secret: "a-completely-different-signing-secret-value",
    });
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a tampered payload that keeps the original signature", () => {
    // Swapping the tenant in the body invalidates the MAC — this is the check
    // that stops an attacker rewriting `t` to point the credential elsewhere.
    const original = issue();
    const [body, sig] = original.split(".");
    expect(body).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    decoded.t = "99999999-9999-9999-9999-999999999999";
    const tampered = `${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${sig}`;
    const res = verify({ state: tampered, cookie: tampered });
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses garbage that is not our encoding", () => {
    for (const junk of ["nodot", ".leading", "trailing.", "%%%.%%%"]) {
      const res = verify({ state: junk, cookie: junk });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(["malformed", "bad_signature"]).toContain(res.reason);
    }
  });
});

describe("ATTACK: replaying a stale state", () => {
  it("refuses once the TTL has passed", () => {
    const res = verify({ nowMs: NOW + VERCEL_OAUTH_STATE_TTL_MS + 1 });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a state stamped in the future rather than trusting it", () => {
    // Clock skew is not a reason to widen the window in the replay direction.
    const res = verify({ nowMs: NOW - VERCEL_OAUTH_STATE_TTL_MS - 1 });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });
});

describe("ATTACK: cross-tenant / cross-user replay", () => {
  // A legitimately issued state, replayed in a different workspace or by a
  // different signed-in user. The signature is valid, so ONLY the identity
  // comparison against the live session catches it — which is why the callback
  // takes tenant and user from the session and never from the query string.
  it("refuses a validly signed state issued for another tenant", () => {
    const res = verify({ expectTenantId: "33333333-3333-3333-3333-333333333333" });
    expect(res).toEqual({ ok: false, reason: "wrong_tenant" });
  });

  it("refuses a validly signed state issued by another user", () => {
    const res = verify({ expectUserId: "44444444-4444-4444-4444-444444444444" });
    expect(res).toEqual({ ok: false, reason: "wrong_user" });
  });
});

describe("supporting properties", () => {
  it("issues a distinct state per nonce", () => {
    expect(issue({ nonce: "a" })).not.toBe(issue({ nonce: "b" }));
  });

  it("safeEqual is correct on equal, unequal and different-length inputs", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("every failure reason has operator-facing copy, and none names a crypto check", () => {
    const reasons = [
      "missing_state",
      "missing_cookie",
      "mismatch",
      "malformed",
      "bad_signature",
      "expired",
      "wrong_tenant",
      "wrong_user",
    ] as const;
    for (const r of reasons) {
      const copy = describeStateFailure(r);
      expect(copy.length).toBeGreaterThan(20);
      // A prober must not learn WHICH check they tripped.
      expect(copy.toLowerCase()).not.toContain("signature");
      expect(copy.toLowerCase()).not.toContain("hmac");
    }
  });
});
