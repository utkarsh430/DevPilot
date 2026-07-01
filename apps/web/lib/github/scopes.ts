// The GitHub OAuth scope set DevPilot requests, and the rules for reading the
// scopes a stored connection was actually GRANTED.
//
// This module is deliberately a LEAF: it imports nothing. That is what lets the
// server (`lib/github/oauth.ts`), the browser auth helper (`lib/auth/browser.ts`)
// and the "use client" settings UI all read ONE literal, and lets Vitest load
// the rules directly. Before it existed the scope string was copy-pasted in
// three modules plus a fourth hand-written copy as JSX badges in the settings
// card - four places to update and no test that would notice a miss. Adding
// `workflow` is exactly the kind of change that silently half-lands under that
// shape: request it in one flow, keep asking for the old set in another, and
// the operator's re-auth grants nothing.
//
// ─── Why `workflow` is in this list ───────────────────────────────────────
//
// GitHub REFUSES any push whose diff touches `.github/workflows/**` unless the
// OAuth grant carries `workflow`:
//
//   ! [remote rejected] … (refusing to allow an OAuth App to create or update
//   workflow '.github/workflows/ci.yml' without 'workflow' scope)
//
// `repo` does NOT imply it - that is precisely why a grant with full `repo`
// write access still gets rejected. DevPilot's agents set up CI, so this is not
// an edge case: without it, every ticket that adds or edits a workflow file is
// permanently unlandable.
//
// What it grants, plainly: the ability to create and modify GitHub Actions
// workflow files in any repository the token can already write to. Anyone who
// can edit CI can cause CI to run arbitrary code, with whatever secrets that
// repository's Actions have. That is a real widening of what a leaked or
// misused token could do, and it is why this list is short and closed.

/**
 * The requested scopes, in the order shown to the user.
 *
 * Keep this MINIMAL. Every entry needs a stated reason (see
 * `GITHUB_SCOPE_PURPOSE`); "while we're here" additions are how an integration
 * quietly accretes permissions nobody chose.
 */
export const GITHUB_OAUTH_SCOPE_LIST = ["repo", "workflow", "read:user", "user:email"] as const;

export type GithubOAuthScope = (typeof GITHUB_OAUTH_SCOPE_LIST)[number];

/** The space-separated form Supabase's `signInWithOAuth({ scopes })` wants. */
export const GITHUB_OAUTH_SCOPES: string = GITHUB_OAUTH_SCOPE_LIST.join(" ");

/**
 * Why each scope is requested - rendered in the settings UI so the operator can
 * re-read later why the integration asks for what it asks for.
 */
export const GITHUB_SCOPE_PURPOSE: Record<GithubOAuthScope, string> = {
  repo: "Clone, commit, and push to your private repositories.",
  workflow:
    "Create and edit GitHub Actions workflow files (.github/workflows). Without it GitHub rejects any push that touches CI. Note that this also means DevPilot can change what CI runs.",
  "read:user": "Read your public profile to show who is connected.",
  "user:email": "Attribute commits to you rather than a generic DevPilot bot.",
};

/**
 * Split a stored `scopes` value into individual scope tokens.
 *
 * The stored string comes from GitHub's `X-OAuth-Scopes` response header, which
 * is comma-separated (`"repo, workflow, user:email"`), but the value we request
 * is space-separated - so accept both rather than depending on which one wrote
 * the row.
 */
export function parseGrantedScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does this stored grant carry `workflow`?
 *
 * Exact token match, never a substring test: `workflow` must not be satisfied by
 * some future unrelated scope that merely contains those letters.
 */
export function hasWorkflowScope(raw: string | null | undefined): boolean {
  return parseGrantedScopes(raw).includes("workflow");
}

/**
 * What the settings page should tell the operator about a stored connection.
 *
 * Three outcomes, because they need three different sentences:
 *  - `not_connected`      - no token row at all. "Connect GitHub."
 *  - `reconnect_required` - a working connection whose grant predates a scope we
 *                           now need. "Your integration works, but reconnect to
 *                           add X." Conflating this with `not_connected` would
 *                           tell someone with a live connection that they have
 *                           none, and hide the fact that only ONE capability is
 *                           missing.
 *  - `ok`                 - nothing to say. Do NOT nag; a banner that shows when
 *                           everything is fine is a banner people stop reading.
 *
 * DIRECTION OF FAILURE, and it is a deliberate choice: when the stored scopes
 * are EMPTY we cannot prove the grant lacks `workflow` - but we cannot prove it
 * has it either, and the two mistakes do not cost the same. Wrongly prompting a
 * reconnect costs one click. Wrongly staying silent means the next CI ticket
 * fails at push time and the operator finds out the way he found out before:
 * from a rejected land, hours later. So an unknown grant reports
 * `reconnect_required` - but with `reason: "scopes_unknown"`, so the copy can
 * say "couldn't confirm" instead of asserting something we do not know.
 */
export type GithubConnectionAdvice =
  | { state: "not_connected" }
  | { state: "reconnect_required"; reason: "missing_scope" | "scopes_unknown"; missing: string[] }
  | { state: "ok" };

export function adviseGithubConnection(
  connection: { connected: boolean; scopes?: string | null } | null | undefined,
): GithubConnectionAdvice {
  if (!connection || !connection.connected) return { state: "not_connected" };

  const granted = parseGrantedScopes(connection.scopes);
  if (granted.length === 0) {
    // Row exists but recorded no scopes - pre-scope-capture rows, or a header
    // GitHub didn't send. Unprovable either way; see the note above.
    return { state: "reconnect_required", reason: "scopes_unknown", missing: [] };
  }

  const missing = GITHUB_OAUTH_SCOPE_LIST.filter((s) => !granted.includes(s));
  if (missing.length === 0) return { state: "ok" };
  return { state: "reconnect_required", reason: "missing_scope", missing: [...missing] };
}
