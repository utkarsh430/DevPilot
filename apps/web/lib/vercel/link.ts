// Pure decision rules for linking a DevPilot project to a Vercel project.
// No fetch, no server-only, no DB — the IO lives in `api.ts` and the actions.
//
// Three decisions live here, and each exists because getting it wrong produces a
// failure the operator cannot diagnose from what Vercel tells them:
//
//   decideLinkGate       — may we even attempt this? (the preflight gate)
//   deriveVercelProjectName — what to call a newly created Vercel project
//   decideRepoMatch      — does an EXISTING Vercel project point at this repo?

import type { PreflightReport } from "@/lib/vercel/preflight";
import type { VercelProject } from "@/lib/vercel/types";

/** A refusal carries the reason AND the fix. A bare "cannot link" is the thing
 *  this whole feature was built to stop producing. */
export type LinkGateRefusal = {
  code:
    | "no_token"
    | "github_app_missing"
    | "preflight_failed"
    | "no_repo"
    | "not_operator"
    | "already_linked";
  message: string;
  /** The exact page that fixes it, when there is one. */
  href?: string;
};

export type LinkGateDecision = { ok: true } | { ok: false; refusal: LinkGateRefusal };

const GITHUB_APP_URL = "https://github.com/apps/vercel/installations/new";
const SETTINGS_URL = "/settings/platform-secrets";

export type LinkGateInput = {
  /** The preflight report, or null when it could not be produced at all. */
  preflight: PreflightReport | null;
  /** Does the DevPilot project have GitHub owner + repo recorded? */
  hasRepo: boolean;
  /** Is this project already linked to a Vercel project? */
  alreadyLinked: boolean;
  /** Is the caller an instance operator? Linking configures a deploy target
   *  using an instance-wide credential, so it carries the same gate the
   *  `operatorOnly` VERCEL_* catalog keys carry. */
  isOperator: boolean;
};

/**
 * May we attempt a link/create?
 *
 * The `github_app_missing` arm is the reason this function exists rather than
 * letting the API call fail. Without the Vercel-for-GitHub App installed,
 * `POST /v11/projects` with a `gitRepository` returns
 * `400 "To link a GitHub repository, you need to install the GitHub integration
 * first."` — a message that names no account, no install URL, and no next step,
 * attached to a status code that reads as "your request was malformed". PR 1
 * already built the preflight that detects this precisely; blocking here turns
 * that 400 into a sentence with a link.
 *
 * Note what is deliberately NOT a blocker: `isAccessRestricted` (a "Selected
 * repositories" install). That configuration WORKS — it just costs a manual
 * click per new repo. Refusing it would take away something the operator can
 * legitimately do; the preflight already warns about the recurring cost.
 */
export function decideLinkGate(input: LinkGateInput): LinkGateDecision {
  if (!input.isOperator) {
    return {
      ok: false,
      refusal: {
        code: "not_operator",
        message:
          "Only an instance operator can link a project to Vercel. Linking configures a production deploy target using the instance-wide Vercel credential.",
      },
    };
  }
  if (input.alreadyLinked) {
    return {
      ok: false,
      refusal: {
        code: "already_linked",
        message:
          "This project is already linked to a Vercel project. Unlink it first if you want to point it somewhere else.",
      },
    };
  }
  if (!input.hasRepo) {
    return {
      ok: false,
      refusal: {
        code: "no_repo",
        message:
          "This DevPilot project isn't connected to a GitHub repository yet, so there is nothing for Vercel to deploy. Connect the repo first.",
      },
    };
  }
  if (!input.preflight) {
    return {
      ok: false,
      refusal: {
        code: "preflight_failed",
        message:
          "DevPilot could not check the Vercel connection, so it will not attempt a link. Re-run the check on the platform credentials page.",
        href: SETTINGS_URL,
      },
    };
  }

  const token = input.preflight.checks.find((c) => c.id === "token");
  if (token && token.level === "error") {
    return {
      ok: false,
      refusal: {
        code: "no_token",
        message: `Vercel credential problem: ${token.detail} ${token.remedy ?? ""}`.trim(),
        href: SETTINGS_URL,
      },
    };
  }

  const app = input.preflight.checks.find((c) => c.id === "github_app");
  if (app && app.level === "error") {
    return {
      ok: false,
      refusal: {
        code: "github_app_missing",
        message:
          "The Vercel for GitHub App is not installed on the GitHub account that owns this repo, so Vercel cannot see it. " +
          'Install the App (choose "All repositories" so no future project needs a manual step), then try again. ' +
          "This is a browser grant — no API token can perform it.",
        href: GITHUB_APP_URL,
      },
    };
  }

  // Anything still not `ok` (an unresolved `unknown`, a scope error) blocks too:
  // creating a project in the wrong Vercel scope is this feature's worst silent
  // failure, and `ready` is exactly the "nothing unresolved" predicate.
  if (!input.preflight.ready) {
    const blocking = input.preflight.checks.find((c) => c.level !== "ok" && c.level !== "warn");
    return {
      ok: false,
      refusal: {
        code: "preflight_failed",
        message: blocking
          ? `${blocking.label}: ${blocking.detail} ${blocking.remedy ?? ""}`.trim()
          : "The Vercel connection check did not pass. Resolve it on the platform credentials page first.",
        href: SETTINGS_URL,
      },
    };
  }

  return { ok: true };
}

/**
 * Derive a legal Vercel project name from a DevPilot project name.
 *
 * Vercel's rules: lowercase, alphanumeric plus `.`/`_`/`-`, 1..100 chars, and it
 * may not contain `---`. We normalise rather than reject so an ordinary project
 * name ("My App!") does not dead-end the operator on a validation error about a
 * naming scheme that is not theirs.
 *
 * Returns null only when nothing usable survives, which the caller turns into
 * "pick a name yourself" rather than guessing.
 */
export function deriveVercelProjectName(raw: string): string | null {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{3,}/g, "--")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 100)
    // A trailing separator can reappear after the slice.
    .replace(/[-._]+$/g, "");
  return slug.length > 0 ? slug : null;
}

/** Vercel's own constraint set, applied to an operator-typed name too. */
export function isValidVercelProjectName(name: string): boolean {
  if (name.length < 1 || name.length > 100) return false;
  if (name.includes("---")) return false;
  return /^[a-z0-9._-]+$/.test(name);
}

export type RepoMatch =
  | { kind: "match" }
  | { kind: "sourceless" }
  | { kind: "mismatch"; linkedTo: string };

/**
 * Does an existing Vercel project point at the repo this DevPilot project uses?
 *
 * Refusing a mismatch is the point. A Vercel project linked to a DIFFERENT repo
 * will happily accept the link on our side and then deploy someone else's code
 * under this project's name, with DevPilot's UI attributing it here. There is no
 * legitimate version of that: a monorepo subdirectory project still carries the
 * same `link.repo`, so a differing repo genuinely means a different codebase.
 *
 * `sourceless` (a Vercel project with no git link at all) is allowed and is
 * SAFER, not less safe: with no git connection there is no push-to-deploy path
 * at all. The caller states that rather than silently treating it as a match.
 *
 * Comparison is case-insensitive because GitHub owner/repo names are.
 */
export function decideRepoMatch(args: {
  project: VercelProject;
  githubOwner: string;
  githubRepo: string;
}): RepoMatch {
  const link = args.project.link;
  if (!link || (!link.org && !link.repo)) return { kind: "sourceless" };
  const linkedTo = `${link.org ?? "?"}/${link.repo ?? "?"}`;
  const want = `${args.githubOwner}/${args.githubRepo}`.toLowerCase();
  return linkedTo.toLowerCase() === want ? { kind: "match" } : { kind: "mismatch", linkedTo };
}
