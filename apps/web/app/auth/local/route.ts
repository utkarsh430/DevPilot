// POST /auth/local — instant sign-in on a LOCAL install. See
// `lib/auth/local-signin.ts` for the gate and why it exists.
//
// Flow, all server-side, no email anywhere:
//   1. the gate (flag + loopback Supabase) - BEFORE anything else;
//   2. make sure the user exists (`admin.createUser`, email pre-confirmed;
//      "already registered" is the normal re-login case) - the
//      `handle_new_user` trigger mints the personal workspace on first sight;
//   3. `admin.generateLink({ type: "magiclink" })` for the token hash;
//   4. `verifyOtp({ token_hash })` on the SSR client, which writes the session
//      cookies exactly as /auth/callback's `exchangeCodeForSession` does;
//   5. 303 to the board.
//
// Refusals answer 404 so the route is indistinguishable from "no such page"
// anywhere it is not enabled.

import { NextResponse, type NextRequest } from "next/server";
import {
  isPlausibleEmail,
  localSigninFromEnv,
  originFromHeaders,
  safeNextPath,
} from "@/lib/auth/local-signin";
import { supabaseServer, supabaseService } from "@/lib/db/server";

export const dynamic = "force-dynamic";

// Redirects are built on the origin the BROWSER used (Host header), not on
// `request.url`: under `next dev --hostname 127.0.0.1` the latter reads
// `localhost:3000` for a request that arrived on 127.0.0.1, and the session
// cookie just written for 127.0.0.1 would not travel to it.
function origin(request: NextRequest): string {
  return originFromHeaders(request.headers, new URL(request.url).origin);
}

function back(request: NextRequest, message: string): NextResponse {
  const url = new URL("/login", origin(request));
  url.searchParams.set("local_error", message.slice(0, 200));
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const decision = localSigninFromEnv();
  if (!decision.allowed) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const form = await request.formData().catch(() => null);
  const email = String(form?.get("email") ?? "").trim();
  const next = safeNextPath(String(form?.get("next") ?? ""));
  if (!isPlausibleEmail(email)) return back(request, "Enter a valid email address.");

  const admin = supabaseService();
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !/already|exists/i.test(created.error.message)) {
    console.error("auth/local: createUser failed", created.error.message);
    return back(request, `Could not create the account: ${created.error.message}`);
  }

  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) {
    console.error("auth/local: generateLink failed", link.error?.message ?? "no token hash");
    return back(request, "Could not start the session (generateLink failed).");
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (error) {
    console.error("auth/local: verifyOtp failed", error.message);
    return back(request, `Could not start the session: ${error.message}`);
  }

  return NextResponse.redirect(new URL(next, origin(request)), 303);
}
