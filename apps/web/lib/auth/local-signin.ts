// Instant sign-in for a LOCAL install: enter an email, you are signed in.
//
// On a local Supabase the magic link is theatre - the "mail" lands in Mailpit
// on the same machine, so anyone at the keyboard can already sign in as
// anyone; clicking through it adds a step and no protection. This path mints
// the session directly (admin `generateLink` → `verifyOtp` with the token
// hash, server-side, no email anywhere).
//
// IT MUST BE IMPOSSIBLE TO ENABLE BY ACCIDENT ANYWHERE ELSE, so three things
// gate it, and the route checks the decision BEFORE touching the admin API:
//
//   1. `DEVPILOT_LOCAL_PASSWORDLESS` is exactly `1`/`true`. Only `setup:local`
//      writes it; no deployment pipeline does.
//   2. `NEXT_PUBLIC_SUPABASE_URL` is a loopback host - a property of the
//      deployment, not of the request (a Host header is attacker-chosen).
//   3. (not here, but part of the posture) `dev:local` binds the app to
//      127.0.0.1 unless asked for `--lan`, so "anyone at the keyboard" stays
//      literal rather than "anyone on the Wi-Fi".
//
// Pure, no `server-only`: the login page reads the decision on the server to
// choose which form to show, and a test holds the gate still.

import { isLoopbackSupabaseUrl } from "@/lib/github/provider-readiness";

export const LOCAL_PASSWORDLESS_FLAG = "DEVPILOT_LOCAL_PASSWORDLESS";

export type LocalSigninDecision =
  | { allowed: true }
  | { allowed: false; reason: "flag-off" | "supabase-not-loopback" };

export function decideLocalSignin(input: {
  flag: string | undefined;
  supabaseUrl: string;
}): LocalSigninDecision {
  const flag = (input.flag ?? "").trim().toLowerCase();
  if (flag !== "1" && flag !== "true") return { allowed: false, reason: "flag-off" };
  if (!isLoopbackSupabaseUrl(input.supabaseUrl)) {
    return { allowed: false, reason: "supabase-not-loopback" };
  }
  return { allowed: true };
}

export function localSigninFromEnv(
  env: Record<string, string | undefined> = process.env,
): LocalSigninDecision {
  return decideLocalSignin({
    flag: env[LOCAL_PASSWORDLESS_FLAG],
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  });
}

export function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** The origin the BROWSER used, from the Host header. A route handler's
 *  `request.url` under `next dev --hostname 127.0.0.1` reads `localhost:3000`
 *  whatever the browser typed (measured), and a redirect there after setting
 *  cookies on 127.0.0.1 lands on a host with no session - i.e. back on /login
 *  with no error. Same-host by construction: a Host header can only move the
 *  redirect to the host the request already reached. */
export function originFromHeaders(
  headers: { get(name: string): string | null },
  fallback: string,
): string {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").trim();
  if (!/^[a-z0-9.\-[\]:]+$/i.test(host)) return fallback;
  const proto = headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

/** Where to land after sign-in: a same-origin path only. Anything else - an
 *  absolute URL, a protocol-relative `//host` - falls back to the board. */
export function safeNextPath(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (v.startsWith("/") && !v.startsWith("//") && !v.includes("\\")) return v;
  return "/board";
}
