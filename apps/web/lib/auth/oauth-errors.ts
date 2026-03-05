// Friendly classification of auth/OAuth failures. PURE module (no server
// imports) — used by the auth callback route (server) to stamp structured
// params, and by the login / github-integration clients to render readable
// cards instead of raw Supabase messages or #error= URL fragments.
//
// `configClass: true` marks failures whose FIX is instance configuration (a
// wrong OAuth secret, a disabled provider) — those get a "Fix in setup" link
// to the matching wizard step. Everything else is user-recoverable (expired
// link, cancelled consent) and just offers a retry.

export type FriendlyAuthError = {
  /** Stable machine code carried in the redirect (?auth_error=…). */
  code: string;
  title: string;
  message: string;
  configClass: boolean;
};

const ERRORS: Record<string, Omit<FriendlyAuthError, "code">> = {
  oauth_exchange_failed: {
    title: "GitHub sign-in is misconfigured on this instance",
    message:
      "GitHub accepted you, but the code exchange failed — the OAuth client secret configured in Supabase is wrong, expired, or the callback URL doesn't match. An instance operator can fix it in a few minutes.",
    configClass: true,
  },
  provider_disabled: {
    title: "GitHub sign-in isn't enabled yet",
    message:
      "The Supabase project behind this instance doesn't have the GitHub provider turned on. An instance operator needs to enable it and paste in the OAuth app credentials.",
    configClass: true,
  },
  otp_expired: {
    title: "That sign-in link has expired",
    message: "Email links are single-use and time-limited. Enter your email again for a fresh one.",
    configClass: false,
  },
  access_denied: {
    title: "GitHub authorization was cancelled",
    message:
      "You (or GitHub) stopped the authorization, so nothing was connected. Try again whenever you're ready.",
    configClass: false,
  },
  stale_flow: {
    title: "That sign-in attempt went stale",
    message:
      "The browser lost the state for this sign-in (an old tab, cleared cookies, or a second attempt). Start again from this page.",
    configClass: false,
  },
  user_creation_failed: {
    title: "Couldn't create your account",
    message:
      "Sign-in succeeded but provisioning your workspace failed on the database side. Try again; if it repeats, an instance operator should check the Supabase logs.",
    configClass: true,
  },
  unknown: {
    title: "Sign-in failed",
    message: "Something went wrong completing the sign-in. Try again.",
    configClass: false,
  },
};

/** Map a raw Supabase/GoTrue error (message, error_code, description — any
 *  subset) onto a stable friendly code. */
export function classifyAuthError(input: {
  code?: string | null;
  description?: string | null;
  message?: string | null;
}): FriendlyAuthError {
  const code = (input.code ?? "").toLowerCase();
  const text = `${input.description ?? ""} ${input.message ?? ""}`.toLowerCase();

  let key: string = "unknown";
  if (code === "otp_expired" || /link is invalid or has expired|otp.*expired/.test(text)) {
    key = "otp_expired";
  } else if (code === "access_denied" || /access.denied|consent.*denied/.test(text)) {
    key = "access_denied";
  } else if (/unable to exchange external code|error exchanging.*code/.test(text)) {
    key = "oauth_exchange_failed";
  } else if (/provider is not enabled|unsupported provider/.test(text)) {
    key = "provider_disabled";
  } else if (
    code === "bad_oauth_state" ||
    code === "flow_state_not_found" ||
    code === "flow_state_expired" ||
    /flow.state|both auth code and code verifier|invalid request.*code/.test(text)
  ) {
    key = "stale_flow";
  } else if (/database error saving new user|error saving new user/.test(text)) {
    key = "user_creation_failed";
  } else if (Object.hasOwn(ERRORS, code)) {
    key = code;
  }

  const entry = ERRORS[key] ?? ERRORS.unknown!;
  return { code: key, ...entry };
}

/** Look up a friendly error by its stable code (the ?auth_error= param). Codes
 *  we don't recognize fall back to "unknown" rather than leaking raw values. */
export function friendlyAuthErrorByCode(code: string): FriendlyAuthError {
  const known = Object.hasOwn(ERRORS, code);
  const entry = known ? ERRORS[code]! : ERRORS.unknown!;
  return { code: known ? code : "unknown", ...entry };
}

/** Where the "Fix in setup" link points for config-class auth failures. */
export const AUTH_FIX_HREF = "/settings/setup#github-oauth";
