// The link decision rules: the preflight gate, name derivation, repo matching.

import { describe, expect, it } from "vitest";
import {
  decideLinkGate,
  decideRepoMatch,
  deriveVercelProjectName,
  isValidVercelProjectName,
} from "@/lib/vercel/link";
import type { PreflightCheck, PreflightReport } from "@/lib/vercel/preflight";
import type { VercelProject } from "@/lib/vercel/types";

function report(checks: PreflightCheck[]): PreflightReport {
  return {
    ready: checks.every((c) => c.level === "ok" || c.level === "warn"),
    credentialSource: "pasted",
    scope: { kind: "personal", username: "acme", email: null },
    checks,
    namespaceSlugs: ["acme"],
  };
}

const OK_CHECKS: PreflightCheck[] = [
  { id: "token", label: "Vercel API token", level: "ok", detail: "Valid." },
  { id: "scope", label: "Deployment scope", level: "ok", detail: "Personal." },
  { id: "github_app", label: "Vercel for GitHub App", level: "ok", detail: "Installed." },
];

const BASE = {
  preflight: report(OK_CHECKS),
  hasRepo: true,
  alreadyLinked: false,
  isOperator: true,
};

describe("decideLinkGate", () => {
  it("permits a fully configured project", () => {
    expect(decideLinkGate(BASE).ok).toBe(true);
  });

  it("blocks when the Vercel for GitHub App is missing, with the install link", () => {
    // The whole reason this gate exists: without it the operator gets Vercel's
    // 400 "…install the GitHub integration first", which names no account, no
    // install URL and no next step.
    const decision = decideLinkGate({
      ...BASE,
      preflight: report([
        ...OK_CHECKS.slice(0, 2),
        {
          id: "github_app",
          label: "Vercel for GitHub App",
          level: "error",
          detail: "Not installed.",
        },
      ]),
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.code).toBe("github_app_missing");
    expect(decision.refusal.href).toContain("github.com/apps/vercel");
    expect(decision.refusal.message).toMatch(/browser grant/i);
  });

  it("does NOT block a restricted ('Selected repositories') install", () => {
    // That configuration works. Refusing it would take away something the
    // operator can legitimately do; the preflight already warns about its cost.
    const decision = decideLinkGate({
      ...BASE,
      preflight: report([
        ...OK_CHECKS.slice(0, 2),
        {
          id: "github_app",
          label: "Vercel for GitHub App",
          level: "warn",
          detail: "Restricted access.",
        },
      ]),
    });
    expect(decision.ok).toBe(true);
  });

  it("blocks a non-operator", () => {
    const d = decideLinkGate({ ...BASE, isOperator: false });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.code).toBe("not_operator");
  });

  it("blocks a project with no repo", () => {
    const d = decideLinkGate({ ...BASE, hasRepo: false });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.code).toBe("no_repo");
  });

  it("blocks an already-linked project", () => {
    const d = decideLinkGate({ ...BASE, alreadyLinked: true });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.code).toBe("already_linked");
  });

  it("blocks when the preflight could not be produced at all", () => {
    const d = decideLinkGate({ ...BASE, preflight: null });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.code).toBe("preflight_failed");
  });

  it("blocks on an unresolved check, not just an outright error", () => {
    // Creating a project in the wrong Vercel scope is this feature's worst
    // silent failure, so "we could not verify the scope" is not a green light.
    const d = decideLinkGate({
      ...BASE,
      preflight: report([
        OK_CHECKS[0]!,
        { id: "scope", label: "Deployment scope", level: "unknown", detail: "Unconfirmed." },
        OK_CHECKS[2]!,
      ]),
    });
    expect(d.ok).toBe(false);
  });

  it("blocks a dead token before anything else about Vercel", () => {
    const d = decideLinkGate({
      ...BASE,
      preflight: report([
        { id: "token", label: "Vercel API token", level: "error", detail: "Rejected." },
        ...OK_CHECKS.slice(1),
      ]),
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.refusal.code).toBe("no_token");
  });
});

describe("deriveVercelProjectName", () => {
  it.each([
    ["My App!", "my-app"],
    ["DevPilot", "devpilot"],
    ["  spaced  out  ", "spaced-out"],
    ["a___b", "a___b"],
    ["UPPER.case_1", "upper.case_1"],
  ])("normalises %s", (input, expected) => {
    expect(deriveVercelProjectName(input)).toBe(expected);
  });

  it("never produces a name Vercel would reject", () => {
    for (const raw of ["!!!x!!!", "a & b & c", "---", "..dots..", "Ünïcødé Name"]) {
      const out = deriveVercelProjectName(raw);
      if (out !== null) expect(isValidVercelProjectName(out), raw).toBe(true);
    }
  });

  it("returns null when nothing usable survives", () => {
    expect(deriveVercelProjectName("!!!")).toBe(null);
    expect(deriveVercelProjectName("   ")).toBe(null);
  });
});

describe("isValidVercelProjectName", () => {
  it("rejects Vercel's specific constraints", () => {
    expect(isValidVercelProjectName("a---b")).toBe(false);
    expect(isValidVercelProjectName("Upper")).toBe(false);
    expect(isValidVercelProjectName("")).toBe(false);
    expect(isValidVercelProjectName("x".repeat(101))).toBe(false);
    expect(isValidVercelProjectName("ok-name_1.2")).toBe(true);
  });
});

// ── Repo matching ───────────────────────────────────────────────────────────

function project(link: VercelProject["link"]): VercelProject {
  return { id: "prj_1", name: "app", accountId: null, link, raw: {} };
}

describe("decideRepoMatch", () => {
  it("matches the same repo", () => {
    const m = decideRepoMatch({
      project: project({ type: "github", org: "acme", repo: "app", productionBranch: "dev" }),
      githubOwner: "acme",
      githubRepo: "app",
    });
    expect(m.kind).toBe("match");
  });

  it("matches case-insensitively", () => {
    const m = decideRepoMatch({
      project: project({ type: "github", org: "Acme", repo: "App", productionBranch: null }),
      githubOwner: "acme",
      githubRepo: "app",
    });
    expect(m.kind).toBe("match");
  });

  it("REFUSES a different repo, and reports what it is linked to", () => {
    // A Vercel project pointing at another repo would deploy someone else's
    // code while DevPilot's UI attributes it here. There is no legitimate
    // version of that — a monorepo subdirectory project carries the same
    // link.repo.
    const m = decideRepoMatch({
      project: project({ type: "github", org: "other", repo: "thing", productionBranch: null }),
      githubOwner: "acme",
      githubRepo: "app",
    });
    expect(m.kind).toBe("mismatch");
    if (m.kind === "mismatch") expect(m.linkedTo).toBe("other/thing");
  });

  it("reports a sourceless project distinctly rather than as a match", () => {
    expect(
      decideRepoMatch({ project: project(null), githubOwner: "a", githubRepo: "b" }).kind,
    ).toBe("sourceless");
  });
});
