// Preflight decision rules.
//
// The bar this screen has to clear is SPECIFICITY: the operator's complaint was
// that he could not tell what was missing, so a check that says "not connected"
// is a failed check even when it is technically accurate. Several tests below
// therefore assert on the presence of a remedy and a link, not just on a level.

import { describe, expect, it } from "vitest";
import { evaluatePreflight, type PreflightInput } from "@/lib/vercel/preflight";
import { classifyVercelError, VercelApiError } from "@/lib/vercel/errors";
import type { VercelGitNamespace } from "@/lib/vercel/types";

const USER = { id: "u1", username: "devpilot-bot", email: "bot@example.com", name: null };

function ns(over: Partial<VercelGitNamespace> = {}): VercelGitNamespace {
  return {
    id: "1",
    slug: "acme",
    provider: "github",
    installationId: 42,
    isAccessRestricted: false,
    requireReauth: false,
    ...over,
  };
}

function input(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    // Default to the PRE-PR-3 world: a pasted token. Every assertion written
    // before "Connect Vercel" existed keeps testing exactly what it did.
    credentialSource: "pasted",
    tokenConfigured: true,
    pastedTokenConfigured: true,
    configuredTeamId: null,
    configuredNamespace: null,
    user: USER,
    userError: null,
    team: null,
    teamError: null,
    namespaces: [ns()],
    namespacesError: null,
    ...over,
  };
}

const check = (r: ReturnType<typeof evaluatePreflight>, id: string) => {
  const c = r.checks.find((x) => x.id === id);
  expect(c, `check ${id} missing`).toBeDefined();
  return c!;
};

describe("the healthy default: personal Hobby account, App on All repositories", () => {
  const report = evaluatePreflight(input());

  it("is ready", () => {
    expect(report.ready).toBe(true);
  });

  it("reports a personal scope without warning about the absent team id", () => {
    // A blank VERCEL_TEAM_ID is CORRECT here. Flagging it would train the
    // operator to ignore this panel.
    expect(check(report, "scope").level).toBe("ok");
    expect(report.scope).toEqual({
      kind: "personal",
      username: "devpilot-bot",
      email: "bot@example.com",
    });
  });

  it("names the visible namespace rather than saying 'connected'", () => {
    expect(check(report, "github_app").detail).toContain("acme");
  });

  it("emits no namespace check when there is nothing to disambiguate", () => {
    expect(report.checks.find((c) => c.id === "namespace")).toBeUndefined();
  });
});

describe("token", () => {
  it("says specifically that no token is configured, and links where to mint one", () => {
    const c = check(evaluatePreflight(input({ tokenConfigured: false, user: null })), "token");
    expect(c.level).toBe("error");
    expect(c.detail).toContain("VERCEL_TOKEN");
    expect(c.remedyHref).toContain("vercel.com");
  });

  it("distinguishes a rejected token from an unreachable API", () => {
    const rejected = evaluatePreflight(
      input({
        user: null,
        userError: new VercelApiError({ kind: "unauthorized", path: "/v2/user", message: "bad" }),
      }),
    );
    const offline = evaluatePreflight(
      input({
        user: null,
        userError: new VercelApiError({ kind: "network", path: "/v2/user", message: "offline" }),
      }),
    );
    // A rejected token is the operator's problem; an unreachable API is not,
    // and telling them to mint a new token would be actively misleading.
    expect(check(rejected, "token").level).toBe("error");
    expect(check(offline, "token").level).toBe("unknown");
    expect(check(offline, "token").remedyHref).toBeUndefined();
  });

  it("is not ready when the token state is merely unknown", () => {
    const r = evaluatePreflight(
      input({
        user: null,
        userError: new VercelApiError({ kind: "network", path: "/v2/user", message: "offline" }),
        namespaces: null,
      }),
    );
    expect(r.ready).toBe(false);
  });
});

describe("scope", () => {
  it("confirms a configured team by name", () => {
    const r = evaluatePreflight(
      input({
        configuredTeamId: "team_abc",
        team: { id: "team_abc", slug: "acme-inc", name: "Acme Inc" },
      }),
    );
    expect(check(r, "scope").level).toBe("ok");
    expect(check(r, "scope").detail).toContain("Acme Inc");
    expect(r.scope).toMatchObject({ kind: "team", teamId: "team_abc" });
  });

  it("errors on a team id the token cannot reach, and says why it matters", () => {
    const r = evaluatePreflight(
      input({
        configuredTeamId: "team_wrong",
        teamError: new VercelApiError({
          kind: "forbidden_scope",
          path: "/v2/teams",
          message: "no permission",
        }),
      }),
    );
    const c = check(r, "scope");
    expect(c.level).toBe("error");
    expect(c.remedy).toContain("wrong place");
    expect(r.ready).toBe(false);
  });
});

describe("the Vercel for GitHub App", () => {
  it("reports an EMPTY namespace list as 'not installed', with the install link", () => {
    const c = check(evaluatePreflight(input({ namespaces: [] })), "github_app");
    expect(c.level).toBe("error");
    expect(c.detail).toContain("Not installed");
    expect(c.remedy).toContain("All repositories");
    expect(c.remedyHref).toContain("github.com/apps/vercel");
  });

  it("does NOT report a failed call as 'not installed'", () => {
    // Collapsing these would send the operator to redo a browser grant that was
    // never broken — the single most expensive wrong diagnosis this panel can
    // make.
    const c = check(
      evaluatePreflight(
        input({
          namespaces: null,
          namespacesError: new VercelApiError({
            kind: "network",
            path: "/v1/integrations/git-namespaces",
            message: "offline",
          }),
        }),
      ),
      "github_app",
    );
    expect(c.level).toBe("unknown");
    expect(c.detail).not.toContain("Not installed");
  });

  it("WARNS on a 'Selected repositories' install and states the recurring cost", () => {
    const r = evaluatePreflight(input({ namespaces: [ns({ isAccessRestricted: true })] }));
    const c = check(r, "github_app");
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("restricted");
    expect(c.remedy).toContain("forever");
    // A warn is a real, working configuration — it must not block.
    expect(r.ready).toBe(true);
  });

  it("errors when the grant has lapsed", () => {
    const c = check(
      evaluatePreflight(input({ namespaces: [ns({ requireReauth: true })] })),
      "github_app",
    );
    expect(c.level).toBe("error");
    expect(c.detail).toContain("lapsed");
  });

  it("prefers the reauth error over the restricted warning", () => {
    const c = check(
      evaluatePreflight(
        input({ namespaces: [ns({ requireReauth: true, isAccessRestricted: true })] }),
      ),
      "github_app",
    );
    expect(c.level).toBe("error");
  });

  it("ignores namespaces from a non-GitHub provider", () => {
    const c = check(
      evaluatePreflight(input({ namespaces: [ns({ provider: "gitlab", slug: "gl" })] })),
      "github_app",
    );
    expect(c.level).toBe("error");
    expect(c.detail).toContain("Not installed");
  });
});

describe("git namespace", () => {
  it("warns when several namespaces are visible and none is configured", () => {
    const r = evaluatePreflight(
      input({ namespaces: [ns({ id: "1", slug: "acme" }), ns({ id: "2", slug: "acme-labs" })] }),
    );
    const c = check(r, "namespace");
    expect(c.level).toBe("warn");
    expect(c.remedy).toContain("acme-labs");
    expect(r.ready).toBe(true);
  });

  it("errors on a configured namespace Vercel cannot see, and lists what it can", () => {
    const c = check(evaluatePreflight(input({ configuredNamespace: "typo-org" })), "namespace");
    expect(c.level).toBe("error");
    expect(c.detail).toContain("typo-org");
    expect(c.detail).toContain("acme");
  });

  it("confirms a namespace that matches", () => {
    const r = evaluatePreflight(input({ configuredNamespace: "acme" }));
    expect(check(r, "namespace").level).toBe("ok");
    expect(r.ready).toBe(true);
  });

  it("does not claim to have verified a namespace it could not check", () => {
    const c = check(
      evaluatePreflight(input({ configuredNamespace: "acme", namespaces: null })),
      "namespace",
    );
    expect(c.level).toBe("unknown");
  });
});

describe("every non-ok check carries a remedy", () => {
  it("holds across the failure modes", () => {
    const cases: PreflightInput[] = [
      input({ tokenConfigured: false, user: null, namespaces: null }),
      input({ namespaces: [] }),
      input({ configuredNamespace: "typo-org" }),
      input({
        configuredTeamId: "team_wrong",
        teamError: new VercelApiError({ kind: "unauthorized", path: "/v2/teams", message: "x" }),
      }),
    ];
    for (const c of cases) {
      for (const chk of evaluatePreflight(c).checks) {
        if (chk.level === "error" || chk.level === "warn") {
          expect(chk.remedy, `${chk.id} has no remedy`).toBeTruthy();
        }
      }
    }
  });
});

// ── PR 3: credential provenance ─────────────────────────────────────────────
// The operator's stated reason for wanting "Connect Vercel" was to stop
// handling tokens by hand. A connection they cannot SEE is one they cannot
// trust, so provenance is reported, not inferred.

describe("credential provenance", () => {
  it("says a connected credential is connected, and names the account", () => {
    const report = evaluatePreflight(input({ credentialSource: "oauth" }));
    expect(report.credentialSource).toBe("oauth");
    const token = report.checks.find((c) => c.id === "token")!;
    expect(token.label).toBe("Vercel connection");
    expect(token.detail).toContain("Connected via the DevPilot Vercel integration");
    expect(token.detail).toContain("devpilot-bot");
  });

  it("says a pasted credential is pasted", () => {
    const token = evaluatePreflight(input({ credentialSource: "pasted" })).checks.find(
      (c) => c.id === "token",
    )!;
    expect(token.label).toBe("Vercel API token");
    expect(token.detail).toContain("pasted token");
  });

  it("SHADOWING: reports that a pasted token exists but is not in use", () => {
    // Without this row the settings page shows a populated token field that has
    // no effect on anything — the same silent lie as a model badge for a model
    // that never reaches the runner.
    const report = evaluatePreflight(
      input({ credentialSource: "oauth", pastedTokenConfigured: true }),
    );
    const shadow = report.checks.find((c) => c.id === "shadowed_token");
    expect(shadow).toBeDefined();
    expect(shadow!.detail).toContain("not being used");
    // Informational, not a warning — having a fallback configured is a good
    // state, and `ready` must not be affected by it.
    expect(shadow!.level).toBe("ok");
    expect(report.ready).toBe(true);
  });

  it("emits NO shadowing row for the combinations that are not shadowed", () => {
    expect(
      evaluatePreflight(
        input({ credentialSource: "pasted", pastedTokenConfigured: true }),
      ).checks.find((c) => c.id === "shadowed_token"),
    ).toBeUndefined();
    expect(
      evaluatePreflight(
        input({ credentialSource: "oauth", pastedTokenConfigured: false }),
      ).checks.find((c) => c.id === "shadowed_token"),
    ).toBeUndefined();
  });

  it("describes an OAuth Hobby account as Vercel's own answer, not an unset setting", () => {
    // `team_id: null` from the exchange means "installed on a Hobby account".
    // Calling that "no VERCEL_TEAM_ID is set" would describe a setting the
    // operator never touched on this path.
    const scope = evaluatePreflight(
      input({ credentialSource: "oauth", configuredTeamId: null }),
    ).checks.find((c) => c.id === "scope")!;
    expect(scope.detail).toContain("Vercel reported no team");
    expect(scope.detail).not.toContain("VERCEL_TEAM_ID");
  });

  it("a disabled integration is surfaced with a re-enable remedy, not a re-mint one", () => {
    const disabled = classifyVercelError({
      status: 403,
      body: { error: { code: "integration_configuration_disabled" } },
      path: "/v2/user",
    });
    const token = evaluatePreflight(
      input({ credentialSource: "oauth", user: null, userError: disabled }),
    ).checks.find((c) => c.id === "token")!;
    expect(token.level).toBe("error");
    expect(token.remedy).toContain("Re-enable");
    expect(token.remedy).toContain("do NOT reconnect");
  });

  it("with no credential at all, offers BOTH paths", () => {
    const token = evaluatePreflight(
      input({ credentialSource: "none", tokenConfigured: false, pastedTokenConfigured: false }),
    ).checks.find((c) => c.id === "token")!;
    expect(token.remedy).toContain("Connect Vercel");
    expect(token.remedy).toContain("paste");
  });
});
