// CSRF protection for the Vercel install callback. Pure over its inputs (the
// signing secret, the clock and the nonce are all injected), so every refusal
// below is provable by a test that never touches Next, a cookie jar, or a
// network.
//
// ── What this defends against, concretely ─────────────────────────────────
// The callback's job is to take an inbound `code`, exchange it for an access
// token, and store that token as THIS tenant's Vercel credential. A callback
// that accepts any inbound `code` is therefore a login-CSRF: an attacker
// installs the DevPilot integration on THEIR OWN Vercel account, keeps the
// resulting `code`, and gets the operator's browser to hit
// `/api/integrations/vercel/callback?code=<theirs>`. DevPilot stores the
// attacker's credential. From that moment every project DevPilot creates, every
// environment variable it pushes (PR 4 — those bodies are entirely secret
// values) and every deploy it makes lands in an account the attacker controls,
// while the settings page reports a healthy connection.
//
// That is a silent, total compromise of the deploy path, so the check is
// mandatory and fails closed on every ambiguity.
//
// ── The design: signed state + double submit, both required ───────────────
// `state` is an HMAC-SHA256-signed payload carrying the nonce, the tenant, the
// user, and the issue time. The SAME string is also set as an HttpOnly cookie.
// The callback requires all of:
//
//   1. the cookie is present                → an inbound code with no prior
//                                             issue from this browser is refused
//   2. cookie === query state (timing-safe) → the classic double-submit
//   3. the signature verifies               → the payload was issued by US, so
//                                             an attacker who can merely SET a
//                                             cookie on the origin (a
//                                             subdomain, an XSS-adjacent write)
//                                             still cannot forge a valid pair
//   4. not older than the TTL               → a state captured from a browser's
//                                             history/referer is not reusable
//                                             later
//   5. tenant AND user match the live session → the credential is stored for
//                                             the tenant that asked for it,
//                                             even if a state issued in another
//                                             workspace is replayed here
//
// (2) alone is the common textbook answer and is NOT sufficient here, because
// the value it protects is a credential rather than a form post; (3) and (5)
// are what make a planted cookie and a cross-tenant replay unreachable.
//
// The nonce is injected rather than generated here so the module stays pure;
// the server route supplies `randomBytes`.

import { createHmac, timingSafeEqual } from "node:crypto";

/** How long an issued state stays usable. The operator's part of the flow is a
 *  Vercel consent screen — a couple of minutes of real work. Ten gives room for
 *  a slow read or an account switch without leaving a replayable value lying
 *  around for the rest of the session. Vercel's `code` itself expires in 30
 *  minutes, so nothing here is the binding constraint on a legitimate install. */
export const VERCEL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Cookie name. `__Host-` is deliberately NOT used: it mandates `Secure`, and
 *  the operator's documented environment is `http://localhost:3000` (Vercel
 *  explicitly permits a localhost redirect URL), where a `Secure` cookie is
 *  dropped by the browser and every install would fail `missing_cookie`. The
 *  route sets `Secure` dynamically for https origins instead. */
export const VERCEL_OAUTH_STATE_COOKIE = "devpilot_vercel_oauth_state";

export type VercelOAuthStatePayload = {
  /** Schema version, so a future field addition can reject old states loudly
   *  rather than mis-parsing them. */
  v: 1;
  /** Random, from the caller. */
  n: string;
  /** Tenant the connection will be stored for. */
  t: string;
  /** User who started the flow. */
  u: string;
  /** Issued-at, epoch ms. */
  iat: number;
};

export type StateFailureReason =
  | "missing_state" // no `state` in the redirect
  | "missing_cookie" // no cookie — this browser never started a flow
  | "mismatch" // cookie and query state differ
  | "malformed" // not our encoding at all
  | "bad_signature" // right shape, wrong (or absent) signature
  | "expired"
  | "wrong_tenant"
  | "wrong_user";

export type StateVerification =
  | { ok: true; payload: VercelOAuthStatePayload }
  | { ok: false; reason: StateFailureReason };

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** Constant-time string compare that does not leak length through an early
 *  return. Node's `timingSafeEqual` THROWS on unequal lengths, so the lengths
 *  are compared first and the result folded in — returning early on a length
 *  mismatch is fine here because the compared values are not secrets whose
 *  length is sensitive (both are fixed-shape tokens). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Mint a state token. The returned value is used BOTH as the `state` query
 * parameter and as the cookie value — they are the same string by construction,
 * which removes any chance of the two drifting apart at the call site.
 */
export function issueVercelOAuthState(args: {
  tenantId: string;
  userId: string;
  nonce: string;
  nowMs: number;
  secret: string;
}): string {
  const payload: VercelOAuthStatePayload = {
    v: 1,
    n: args.nonce,
    t: args.tenantId,
    u: args.userId,
    iat: args.nowMs,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body, args.secret)}`;
}

function parsePayload(body: string): VercelOAuthStatePayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.n !== "string" || r.n.length === 0) return null;
  if (typeof r.t !== "string" || r.t.length === 0) return null;
  if (typeof r.u !== "string" || r.u.length === 0) return null;
  if (typeof r.iat !== "number" || !Number.isFinite(r.iat)) return null;
  return { v: 1, n: r.n, t: r.t, u: r.u, iat: r.iat };
}

/**
 * Verify an inbound callback's state.
 *
 * FAILS CLOSED on every branch: there is no input for which this returns `ok`
 * without a valid signature, a matching cookie, a live TTL, and an exact
 * tenant + user match against the session the callback is running in.
 */
export function verifyVercelOAuthState(args: {
  /** `state` from the redirect query. */
  state: string | null | undefined;
  /** Value of the state cookie on the callback request. */
  cookie: string | null | undefined;
  /** Tenant resolved from the LIVE session, never from the query. */
  expectTenantId: string;
  /** User resolved from the LIVE session, never from the query. */
  expectUserId: string;
  nowMs: number;
  secret: string;
  ttlMs?: number;
}): StateVerification {
  const state = (args.state ?? "").trim();
  const cookie = (args.cookie ?? "").trim();
  if (state.length === 0) return { ok: false, reason: "missing_state" };
  if (cookie.length === 0) return { ok: false, reason: "missing_cookie" };
  if (!safeEqual(state, cookie)) return { ok: false, reason: "mismatch" };

  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return { ok: false, reason: "malformed" };
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  // Signature BEFORE payload interpretation: nothing derived from an unverified
  // payload is allowed to influence a decision.
  if (!safeEqual(sig, sign(body, args.secret))) return { ok: false, reason: "bad_signature" };

  const payload = parsePayload(body);
  if (!payload) return { ok: false, reason: "malformed" };

  const ttl = args.ttlMs ?? VERCEL_OAUTH_STATE_TTL_MS;
  // A state stamped in the future is treated as expired rather than accepted —
  // clock skew is not a reason to widen the window in the replay direction.
  const age = args.nowMs - payload.iat;
  if (age > ttl || age < -ttl) return { ok: false, reason: "expired" };

  if (payload.t !== args.expectTenantId) return { ok: false, reason: "wrong_tenant" };
  if (payload.u !== args.expectUserId) return { ok: false, reason: "wrong_user" };

  return { ok: true, payload };
}

/** Operator-facing wording per refusal. Deliberately does NOT distinguish the
 *  cryptographic failures from each other in the UI copy — an attacker probing
 *  the callback learns nothing from the message, while the operator gets the
 *  one instruction that actually helps. The precise `reason` is still returned
 *  for the server log. */
export function describeStateFailure(reason: StateFailureReason): string {
  switch (reason) {
    case "missing_cookie":
      return "The connection could not be verified because the browser did not send the security cookie. Start the connection again in the same browser, and allow cookies for this site.";
    case "expired":
      return "The connection attempt took too long and expired. Start it again.";
    case "wrong_tenant":
      return "That connection was started for a different workspace. Switch back to it, or start the connection again here.";
    case "wrong_user":
      return "That connection was started by a different user. Start it again from this account.";
    default:
      return "The connection could not be verified and was refused. Start it again from DevPilot rather than from a link.";
  }
}
