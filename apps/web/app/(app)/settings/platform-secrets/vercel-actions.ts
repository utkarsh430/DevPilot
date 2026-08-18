"use server";

// Server action behind the Vercel preflight card.
//
// Every export in a `"use server"` file is a browser-reachable endpoint, so the
// two things this must not do are: take a tenant id from the caller (it derives
// one from the session), and return anything derived from the token beyond the
// boolean "is one configured". `PreflightReport` is built by pure rules from
// already-scrubbed error messages, so it is safe to send to a client component —
// `api.test.ts` asserts the token never appears anywhere in a rendered report.

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireTenantId, requireUser } from "@/lib/auth";
import { isInstanceOperator } from "@/lib/platform-secrets/operator";
import { runVercelPreflightForTenant } from "@/lib/vercel/api.server";
import {
  appBaseUrl,
  loadVercelConnectionStatus,
  oauthStateSecret,
  removeVercelConnection,
  resolveIntegrationConfig,
  vercelCallbackUrl,
} from "@/lib/vercel/connection.server";
import type { VercelConnectionStatus } from "@/lib/vercel/connection";
import { buildVercelInstallUrl } from "@/lib/vercel/oauth";
import {
  issueVercelOAuthState,
  VERCEL_OAUTH_STATE_COOKIE,
  VERCEL_OAUTH_STATE_TTL_MS,
} from "@/lib/vercel/oauth-state";
import type { PreflightReport } from "@/lib/vercel/preflight";

type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Run the Vercel preflight for the caller's tenant.
 *
 * Operator-gated to match the keys it reports on: the three Vercel keys are
 * `operatorOnly`, and this probes the credential they hold. It performs no
 * write, but "which Vercel account is this token for, and what can it see" is
 * still information about a credential a non-operator may not manage.
 */
export async function runVercelPreflightAction(): Promise<ActionResult<PreflightReport>> {
  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await isInstanceOperator(user.id))) {
    return { ok: false, error: "Only an instance operator can check the Vercel connection" };
  }
  try {
    const report = await runVercelPreflightForTenant(tenantId);
    return { ok: true, value: report };
  } catch (err) {
    // runVercelPreflight is documented never to throw; this is the belt for a
    // failure in credential RESOLUTION (a DB blip), which is upstream of it.
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not run the Vercel check",
    };
  }
}

// ── PR 3: Connect / Disconnect ──────────────────────────────────────────────

export type StartConnectValue = {
  /** Where to open the popup. */
  installUrl: string;
  /** The Redirect URL this instance expects, so the card can show the operator
   *  the exact string to register in Vercel's Integration Console — a mismatch
   *  there is the single most likely cause of a failed exchange, and it is
   *  invisible from Vercel's error message. */
  callbackUrl: string;
};

/**
 * Begin the connect flow: mint the CSRF state, set it as an HttpOnly cookie,
 * and return the install URL for the client to open in a popup.
 *
 * The cookie is set HERE rather than in the popup's own navigation because the
 * cookie and the `state` must be issued together, from one server call, and by
 * code that has already established WHO is asking. Splitting them would create
 * a window in which one exists without the other.
 *
 * `SameSite=Lax` is required and load-bearing: the browser returns from
 * vercel.com to our callback as a TOP-LEVEL GET navigation, which `Lax` sends
 * the cookie on and `Strict` does not. `Strict` here would make every install
 * fail `missing_cookie`.
 */
export async function startVercelConnectAction(): Promise<ActionResult<StartConnectValue>> {
  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await isInstanceOperator(user.id))) {
    return { ok: false, error: "Only an instance operator can connect Vercel" };
  }

  const config = await resolveIntegrationConfig(tenantId);
  if (!config.ok) return { ok: false, error: config.error };

  let secret: string;
  try {
    secret = oauthStateSecret();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const state = issueVercelOAuthState({
    tenantId,
    userId: user.id,
    nonce: randomBytes(24).toString("base64url"),
    nowMs: Date.now(),
    secret,
  });

  const store = await cookies();
  store.set(VERCEL_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    // `Lax`, not `Strict` — see the doc comment.
    sameSite: "lax",
    // Only on https. The operator's documented environment is
    // http://localhost:3000, where a `Secure` cookie is silently dropped and
    // every connect would fail on the cookie check.
    secure: appBaseUrl().startsWith("https://"),
    path: "/",
    maxAge: Math.floor(VERCEL_OAUTH_STATE_TTL_MS / 1000),
  });

  return {
    ok: true,
    value: {
      installUrl: buildVercelInstallUrl({ slug: config.slug, state }),
      callbackUrl: vercelCallbackUrl(),
    },
  };
}

/**
 * Drop the stored connection.
 *
 * LOCAL ONLY. Vercel's REST API exposes no endpoint to revoke an integration
 * access token or uninstall a configuration on the account's behalf, so this
 * removes DevPilot's copy and nothing more — the grant on Vercel remains until
 * the operator uninstalls it there. The UI states that rather than implying a
 * revocation this cannot perform.
 *
 * After disconnecting, credential resolution falls back to a pasted
 * VERCEL_TOKEN if one is configured — which is why the paste field is kept.
 */
export async function disconnectVercelAction(): Promise<ActionResult<void>> {
  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await isInstanceOperator(user.id))) {
    return { ok: false, error: "Only an instance operator can disconnect Vercel" };
  }
  const res = await removeVercelConnection(tenantId);
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/settings/platform-secrets");
  return { ok: true, value: undefined };
}

/** Connection metadata for the card. Never returns the token. */
export async function getVercelConnectionStatusAction(): Promise<
  ActionResult<VercelConnectionStatus>
> {
  const user = await requireUser();
  const tenantId = await requireTenantId();
  if (!(await isInstanceOperator(user.id))) {
    return { ok: false, error: "Only an instance operator can view the Vercel connection" };
  }
  return { ok: true, value: await loadVercelConnectionStatus(tenantId) };
}
