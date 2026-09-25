// Preflight: the pure decision rules that turn raw Vercel API results into a
// truthful, specific report for the operator. No fetch, no server-only — the IO
// half is `api.server.ts`, which gathers the inputs and hands them here.
//
// ── What this screen is FOR ────────────────────────────────────────────────
// The operator's actual complaint was "I don't see anywhere to put the
// credential and I don't know what's missing". A generic "not connected" would
// be a failure of this feature's whole purpose. So every negative outcome below
// names the specific thing that is wrong AND the specific place that fixes it,
// and the rules distinguish cases that a lazier design would collapse:
//
//   - no token configured        vs  token configured but rejected
//   - GitHub App absent          vs  installed but access-restricted
//   - team id set but wrong      vs  no team (the expected default)
//
// The one that matters most is `restricted_namespace_access`. A "Selected
// repositories" App install is not an error — everything works — but it costs a
// manual click per new project FOREVER, and it is chosen once in a browser
// dialog months before the consequence shows up. Detecting it is the difference
// between a five-second fix and an undiagnosable recurring annoyance.

import type { VercelCredentialSource } from "@/lib/vercel/connection";
import type { VercelApiError } from "@/lib/vercel/errors";
import type { VercelGitNamespace, VercelTeam, VercelUser } from "@/lib/vercel/types";

export type PreflightLevel = "ok" | "warn" | "error" | "unknown";

export type PreflightCheck = {
  id: string;
  label: string;
  level: PreflightLevel;
  /** One line stating what IS, in plain terms. */
  detail: string;
  /** Present whenever `level` is not "ok": what to actually do. */
  remedy?: string;
  /** The exact page that fixes it. Generic docs links are not a remedy. */
  remedyHref?: string;
};

/** What the credential resolves to. Reported explicitly because "which Vercel
 *  account is this?" is unanswerable from the token alone, and creating
 *  projects in the wrong scope is this feature's worst silent failure. */
export type PreflightScope =
  | { kind: "none" }
  | { kind: "personal"; username: string | null; email: string | null }
  | { kind: "team"; teamId: string; name: string | null; slug: string | null };

export type PreflightInput = {
  /** HOW the credential arrived. Reported because the operator's stated reason
   *  for wanting "Connect Vercel" was to stop handling tokens by hand — a
   *  connection they cannot see is one they cannot trust. It also makes the
   *  SHADOWING visible: an OAuth connection outranks a pasted token, so an
   *  operator with both must be told which is in effect rather than editing a
   *  field that does nothing. */
  credentialSource: VercelCredentialSource;
  /** Is a credential configured at all (any scope/source)? Values never come
   *  here. */
  tokenConfigured: boolean;
  /** Is a PASTED VERCEL_TOKEN configured, independently of what won? Only ever
   *  used to detect the shadowing case; never a value, just a boolean. */
  pastedTokenConfigured: boolean;
  /** The configured VERCEL_TEAM_ID, trimmed; null/empty = personal account. */
  configuredTeamId: string | null;
  /** The configured VERCEL_GIT_NAMESPACE, trimmed; null/empty = unset. */
  configuredNamespace: string | null;
  /** `GET /v2/user` result, or the error it failed with. */
  user: VercelUser | null;
  userError: VercelApiError | null;
  /** `GET /v2/teams/{id}` result — only attempted when a team id is set. */
  team: VercelTeam | null;
  teamError: VercelApiError | null;
  /** git-namespaces result. `null` (not `[]`) means the call itself failed —
   *  those are different facts and collapsing them would report a network blip
   *  as "your GitHub App is missing", sending the operator to redo a browser
   *  grant that was never broken. */
  namespaces: VercelGitNamespace[] | null;
  namespacesError: VercelApiError | null;
};

export type PreflightReport = {
  /** True only when nothing blocks a deploy being built on top of this. */
  ready: boolean;
  /** Echoed for the card's badge. Never carries a value, only a provenance. */
  credentialSource: VercelCredentialSource;
  scope: PreflightScope;
  checks: PreflightCheck[];
  /** Namespace slugs the Vercel GitHub App can see, for display. */
  namespaceSlugs: string[];
};

const TOKENS_URL = "https://vercel.com/account/tokens";
const GITHUB_APP_URL = "https://github.com/apps/vercel/installations/new";
const TEAM_SETTINGS_URL = "https://vercel.com/account";
const INTEGRATIONS_URL = "https://vercel.com/dashboard/integrations";

/** One label for the two credential paths, so every row below states which one
 *  it is talking about instead of saying "the token" and leaving the operator to
 *  guess which of two configured things is in play. */
function credentialLabel(source: VercelCredentialSource): string {
  return source === "oauth" ? "Vercel connection" : "Vercel API token";
}

function tokenCheck(input: PreflightInput): PreflightCheck {
  const label = credentialLabel(input.credentialSource);
  if (!input.tokenConfigured) {
    return {
      id: "token",
      label,
      level: "error",
      detail: "No Vercel credential is configured — no connection, and no VERCEL_TOKEN.",
      remedy:
        'Click "Connect Vercel" above to install the integration, or mint a token on the Vercel account you want DevPilot to deploy from and paste it into the Vercel API token field below.',
      remedyHref: TOKENS_URL,
    };
  }
  if (input.userError) {
    // The error message is already scrubbed and operator-facing (errors.ts).
    const level = input.userError.kind === "network" ? "unknown" : "error";
    // A DISABLED integration configuration is not a bad credential, and telling
    // the operator to replace one sends them round a loop that cannot succeed
    // (a reinstall is not what the dashboard's re-enable toggle does). The
    // classifier already separates the two; this keeps the remedy separated too.
    if (input.userError.kind === "integration_disabled") {
      return {
        id: "token",
        label,
        level: "error",
        detail: input.userError.message,
        remedy:
          "Re-enable the DevPilot integration on Vercel — do NOT reconnect or paste a new token, neither will clear this. Vercel removes a configuration left disabled for 30 days, along with the environment variables it created.",
        remedyHref: INTEGRATIONS_URL,
      };
    }
    return {
      id: "token",
      label,
      level,
      detail: input.userError.message,
      remedy:
        level === "unknown"
          ? "Could not reach Vercel, so the credential could not be checked. Retry when connectivity is restored."
          : input.credentialSource === "oauth"
            ? "Disconnect and connect Vercel again to obtain a fresh credential."
            : "Replace VERCEL_TOKEN with a freshly minted token.",
      remedyHref: level === "unknown" ? undefined : TOKENS_URL,
    };
  }
  if (!input.user) {
    return {
      id: "token",
      label,
      level: "unknown",
      detail: "Vercel accepted the credential but returned no identity.",
      remedy: "Re-run the check. If it persists, reconnect or mint a new token.",
      remedyHref: TOKENS_URL,
    };
  }
  const who = input.user.username ?? input.user.email ?? input.user.id;
  return {
    id: "token",
    label,
    level: "ok",
    detail:
      input.credentialSource === "oauth"
        ? `Connected via the DevPilot Vercel integration. Authenticated as ${who}.`
        : `Valid pasted token. Authenticated as ${who}.`,
  };
}

/**
 * The SHADOWING row: a pasted token exists but an OAuth connection outranks it.
 *
 * Emitted only for that exact combination. Without it the settings page shows a
 * populated "Vercel API token" field that has no effect on anything — the same
 * class of silent lie as a per-agent model badge for a model that never
 * reaches the runner, which is why this follows the `shadowed` posture rather
 * than quietly preferring one. Informational (`ok`), not a warning: having a
 * fallback configured is a good state, it just is not the one in use.
 */
function shadowedPasteCheck(input: PreflightInput): PreflightCheck | null {
  if (input.credentialSource !== "oauth") return null;
  if (!input.pastedTokenConfigured) return null;
  return {
    id: "shadowed_token",
    label: "Pasted token (not in use)",
    level: "ok",
    detail:
      "A VERCEL_TOKEN is also configured, but the connection above takes precedence, so the pasted token is not being used.",
    remedy:
      "Keep it as a fallback — it takes over automatically if you disconnect — or clear it below if it is a leftover.",
  };
}

function scopeOf(input: PreflightInput): PreflightScope {
  const teamId = input.configuredTeamId;
  if (teamId) {
    return {
      kind: "team",
      teamId,
      name: input.team?.name ?? null,
      slug: input.team?.slug ?? null,
    };
  }
  if (input.user) {
    return { kind: "personal", username: input.user.username, email: input.user.email };
  }
  return { kind: "none" };
}

function scopeCheck(input: PreflightInput): PreflightCheck {
  const teamId = input.configuredTeamId;
  if (!teamId) {
    // The expected default for the dedicated-Hobby-account setup. Stated as a
    // fact rather than a warning — a blank team id is correct here, and
    // flagging it would train the operator to ignore this panel.
    const who = input.user?.username ?? input.user?.email ?? null;
    return {
      id: "scope",
      label: "Deployment scope",
      level: input.user ? "ok" : "unknown",
      // For an OAuth connection the absence of a team is Vercel's OWN answer
      // (`team_id: null` in the exchange response means "installed on a Hobby
      // account"), not an unset setting — so it must not be described as one.
      detail:
        input.credentialSource === "oauth"
          ? who
            ? `Personal account (${who}). Vercel reported no team for this installation, which is what a Hobby account returns.`
            : "Personal account. Vercel reported no team for this installation."
          : who
            ? `Personal account (${who}). No VERCEL_TEAM_ID is set, which is correct for a Hobby account.`
            : "Personal account. No VERCEL_TEAM_ID is set.",
    };
  }
  if (input.teamError) {
    return {
      id: "scope",
      label: "Deployment scope",
      level: input.teamError.kind === "network" ? "unknown" : "error",
      detail: `VERCEL_TEAM_ID is set to ${teamId}, but Vercel would not confirm it: ${input.teamError.message}`,
      remedy:
        "Either clear VERCEL_TEAM_ID (for a personal account) or set it to a team the token can access. A mismatch here silently creates projects in the wrong place.",
      remedyHref: TEAM_SETTINGS_URL,
    };
  }
  if (!input.team) {
    return {
      id: "scope",
      label: "Deployment scope",
      level: "unknown",
      detail: `VERCEL_TEAM_ID is set to ${teamId}, but the team could not be identified.`,
      remedy: "Re-run the check, or clear VERCEL_TEAM_ID if this token is for a personal account.",
      remedyHref: TEAM_SETTINGS_URL,
    };
  }
  const name = input.team.name ?? input.team.slug ?? input.team.id;
  return {
    id: "scope",
    label: "Deployment scope",
    level: "ok",
    detail: `Team "${name}". Every Vercel call DevPilot makes is scoped to this team.`,
  };
}

function gitAppCheck(input: PreflightInput): PreflightCheck {
  if (input.namespacesError) {
    const level = input.namespacesError.kind === "network" ? "unknown" : "error";
    return {
      id: "github_app",
      label: "Vercel for GitHub App",
      level,
      detail: input.namespacesError.message,
      remedy:
        level === "unknown"
          ? "Could not reach Vercel, so the GitHub App install could not be checked."
          : "Fix the token or scope above, then re-run the check.",
    };
  }
  if (input.namespaces === null) {
    return {
      id: "github_app",
      label: "Vercel for GitHub App",
      level: "unknown",
      detail: "Not checked — the token must be valid first.",
    };
  }
  const github = input.namespaces.filter((n) => (n.provider ?? "github") === "github");
  if (github.length === 0) {
    return {
      id: "github_app",
      label: "Vercel for GitHub App",
      level: "error",
      detail:
        "Not installed. Vercel cannot see any GitHub account, so it cannot link a repository to a project.",
      remedy:
        'Install the Vercel for GitHub App on the GitHub account that owns your repos. Choose "All repositories" so DevPilot never needs a manual step per project. This is a browser grant — no API token can perform it.',
      remedyHref: GITHUB_APP_URL,
    };
  }
  const reauth = github.filter((n) => n.requireReauth);
  if (reauth.length > 0) {
    const names = reauth.map((n) => n.slug ?? n.id).join(", ");
    return {
      id: "github_app",
      label: "Vercel for GitHub App",
      level: "error",
      detail: `Installed, but the grant has lapsed for: ${names}.`,
      remedy: "Reconnect the GitHub account from Vercel's Git integration settings.",
      remedyHref: GITHUB_APP_URL,
    };
  }
  const restricted = github.filter((n) => n.isAccessRestricted);
  if (restricted.length > 0) {
    const names = restricted.map((n) => n.slug ?? n.id).join(", ");
    return {
      id: "github_app",
      label: "Vercel for GitHub App",
      level: "warn",
      detail: `Installed with restricted repository access for: ${names}. Vercel can only see repositories that were explicitly selected.`,
      remedy:
        'Deploys will work, but every NEW repo DevPilot creates needs a manual click to grant Vercel access — forever. Change the install to "All repositories" to remove that step permanently.',
      remedyHref: GITHUB_APP_URL,
    };
  }
  const names = github.map((n) => n.slug ?? n.id).join(", ");
  return {
    id: "github_app",
    label: "Vercel for GitHub App",
    level: "ok",
    detail: `Installed with full repository access for: ${names}.`,
  };
}

/** Only meaningful once we can see namespaces — a configured namespace that
 *  Vercel cannot see is a typo, and it would otherwise surface as a link
 *  failure much later with no hint of the cause. */
function namespaceCheck(input: PreflightInput): PreflightCheck | null {
  const configured = input.configuredNamespace;
  const github = (input.namespaces ?? []).filter((n) => (n.provider ?? "github") === "github");
  if (!configured) {
    if (github.length <= 1) return null; // Nothing to disambiguate.
    return {
      id: "namespace",
      label: "Git namespace",
      level: "warn",
      detail: `Vercel can see ${github.length} GitHub namespaces and VERCEL_GIT_NAMESPACE is not set.`,
      remedy: `Set VERCEL_GIT_NAMESPACE to the owner DevPilot should link repositories under (one of: ${github
        .map((n) => n.slug ?? n.id)
        .join(", ")}).`,
    };
  }
  if (input.namespaces === null) {
    return {
      id: "namespace",
      label: "Git namespace",
      level: "unknown",
      detail: `Set to "${configured}" — not verified, because the namespace list could not be read.`,
    };
  }
  const match = github.find((n) => n.slug === configured);
  if (!match) {
    const seen = github.map((n) => n.slug ?? n.id).join(", ") || "none";
    return {
      id: "namespace",
      label: "Git namespace",
      level: "error",
      detail: `VERCEL_GIT_NAMESPACE is "${configured}", which Vercel cannot see. Visible: ${seen}.`,
      remedy:
        "Correct the value to one of the visible namespaces, or clear it and let DevPilot use the only one available.",
    };
  }
  return {
    id: "namespace",
    label: "Git namespace",
    level: "ok",
    detail: `Repositories will be linked under "${configured}".`,
  };
}

/**
 * Evaluate the whole preflight.
 *
 * `ready` is true only when no check is `error` AND none is `unknown` — an
 * unverified state is not a green light. A `warn` (restricted App access,
 * ambiguous namespace) does NOT block: those configurations genuinely work,
 * they just carry a recurring cost the operator should know about.
 */
export function evaluatePreflight(input: PreflightInput): PreflightReport {
  const checks: PreflightCheck[] = [tokenCheck(input)];
  const shadowed = shadowedPasteCheck(input);
  if (shadowed) checks.push(shadowed);
  checks.push(scopeCheck(input), gitAppCheck(input));
  const ns = namespaceCheck(input);
  if (ns) checks.push(ns);

  const ready = checks.every((c) => c.level === "ok" || c.level === "warn");
  const namespaceSlugs = (input.namespaces ?? [])
    .map((n) => n.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  return {
    ready,
    credentialSource: input.credentialSource,
    scope: scopeOf(input),
    checks,
    namespaceSlugs,
  };
}
