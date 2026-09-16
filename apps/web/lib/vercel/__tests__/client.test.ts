// Request construction, with the teamId-threading property as the centrepiece.
//
// A forgotten `teamId` does not error — it silently creates the resource in the
// wrong scope, invisible until someone opens the wrong dashboard. That makes it
// the one property in this client worth a control test: several assertions
// below are paired with a case that neuters the threading and confirms the
// assertion would go red, because a guard test that stays green when the guard
// is deleted is worth nothing.

import { describe, expect, it } from "vitest";
import {
  buildVercelRequest,
  buildVercelUrl,
  specCreateProject,
  specGetProject,
  specGetTeam,
  specGetUser,
  specGitNamespaces,
  specListProjects,
  specUpdateProject,
  VERCEL_API_BASE,
  type VercelCredential,
  type VercelRequestSpec,
} from "@/lib/vercel/client";

const TOKEN = "vercel_test_token_abcdefghijklmnop";
const PERSONAL: VercelCredential = { token: TOKEN, teamId: null };
const TEAM: VercelCredential = { token: TOKEN, teamId: "team_abc123" };

/** Every `scope: "team"` spec the codebase builds. PRs 2-5 append here; the
 *  threading tests below iterate it, so a new endpoint is covered on arrival
 *  rather than needing its own test. */
const TEAM_SPECS: VercelRequestSpec[] = [
  specGitNamespaces(),
  specListProjects(),
  specGetProject("prj_1"),
  specCreateProject({ name: "app", repo: "acme/app" }),
  specUpdateProject("prj_1", { deploymentPolicy: { gitSources: [] } }),
];
const ACCOUNT_SPECS: VercelRequestSpec[] = [specGetUser(), specGetTeam("team_abc123")];

describe("teamId threading", () => {
  it("threads teamId onto every team-scoped call when configured", () => {
    for (const spec of TEAM_SPECS) {
      const url = new URL(buildVercelUrl(spec, TEAM));
      expect(url.searchParams.get("teamId"), spec.path).toBe("team_abc123");
    }
  });

  it("CONTROL: the same assertion fails without a configured team", () => {
    // Proves the assertion above is load-bearing rather than trivially true.
    for (const spec of TEAM_SPECS) {
      const url = new URL(buildVercelUrl(spec, PERSONAL));
      expect(url.searchParams.get("teamId")).toBeNull();
    }
  });

  it("omits teamId for a personal account — the expected Hobby default", () => {
    const url = buildVercelUrl(specGitNamespaces(), PERSONAL);
    expect(url).not.toContain("teamId");
    expect(url).toBe(`${VERCEL_API_BASE}/v1/integrations/git-namespaces?provider=github`);
  });

  it("treats a whitespace-only team id as absent", () => {
    const url = buildVercelUrl(specGitNamespaces(), { token: TOKEN, teamId: "   " });
    expect(url).not.toContain("teamId");
  });

  it("does NOT thread teamId onto account-scoped identity calls", () => {
    // /v2/user must answer "who is this token" even when the configured team is
    // wrong — otherwise the preflight cannot tell a bad token from a bad team
    // id, which are two very different fixes for the operator.
    for (const spec of ACCOUNT_SPECS) {
      expect(buildVercelUrl(spec, TEAM), spec.path).not.toContain("teamId");
    }
  });

  it("ignores a teamId a call site tries to pass in its own query", () => {
    // The credential owns the scope. A per-call override would reintroduce the
    // drift that central threading exists to prevent.
    const spec: VercelRequestSpec = {
      path: "/v9/projects",
      scope: "team",
      query: { teamId: "team_attacker", slug: "someone-else" },
    };
    const url = new URL(buildVercelUrl(spec, TEAM));
    expect(url.searchParams.get("teamId")).toBe("team_abc123");
    expect(url.searchParams.get("slug")).toBeNull();
  });
});

describe("buildVercelUrl", () => {
  it("drops undefined, null and empty query values", () => {
    const spec: VercelRequestSpec = {
      path: "/v6/deployments",
      scope: "team",
      query: { projectId: "prj_1", limit: 10, target: undefined, since: null, app: "" },
    };
    const url = new URL(buildVercelUrl(spec, PERSONAL));
    expect(url.searchParams.get("projectId")).toBe("prj_1");
    expect(url.searchParams.get("limit")).toBe("10");
    expect([...url.searchParams.keys()].sort()).toEqual(["limit", "projectId"]);
  });

  it("always targets the real Vercel API origin", () => {
    expect(buildVercelUrl(specGetUser(), PERSONAL).startsWith(`${VERCEL_API_BASE}/`)).toBe(true);
  });

  it("percent-encodes a path segment", () => {
    expect(buildVercelUrl(specGetTeam("team/../evil"), PERSONAL)).toContain("team%2F..%2Fevil");
  });
});

describe("buildVercelRequest", () => {
  it("puts the token in the Authorization header and NOWHERE else", () => {
    const req = buildVercelRequest(
      { path: "/v10/projects/prj_1/env", scope: "team", method: "POST", body: [{ key: "A" }] },
      TEAM,
    );
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // The URL is what gets logged; the body is what gets serialised. Neither
    // may carry the credential.
    expect(req.url).not.toContain(TOKEN);
    expect(req.body ?? "").not.toContain(TOKEN);
  });

  it("defaults to GET with no body and no Content-Type", () => {
    const req = buildVercelRequest(specGetUser(), PERSONAL);
    expect(req.method).toBe("GET");
    expect(req.body).toBeUndefined();
    expect(req.headers["Content-Type"]).toBeUndefined();
  });

  it("serialises a JSON body and sets Content-Type", () => {
    const req = buildVercelRequest(
      { path: "/v11/projects", scope: "team", method: "POST", body: { name: "demo" } },
      PERSONAL,
    );
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body ?? "null")).toEqual({ name: "demo" });
  });
});
