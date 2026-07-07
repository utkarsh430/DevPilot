// The requested GitHub OAuth scope set, and the "does this stored grant still
// need re-authorising" rule that keeps an under-scoped token from failing
// silently at push time.
//
// Both halves exist because of one concrete incident: two tickets whose only
// remaining blocker was GitHub refusing a push that added `.github/workflows/`
// files, because the grant lacked `workflow`.

import { describe, it, expect } from "vitest";
import {
  adviseGithubConnection,
  GITHUB_OAUTH_SCOPES,
  GITHUB_OAUTH_SCOPE_LIST,
  GITHUB_SCOPE_PURPOSE,
  hasWorkflowScope,
  parseGrantedScopes,
} from "@/lib/github/scopes";

describe("GITHUB_OAUTH_SCOPES", () => {
  it("requests `workflow` - without it GitHub rejects any push touching .github/workflows", () => {
    expect(GITHUB_OAUTH_SCOPES.split(" ")).toContain("workflow");
  });

  it("still requests the scopes that were already needed", () => {
    // `workflow` is an ADDITION. A refactor that swapped the set rather than
    // extending it would break cloning/pushing outright.
    for (const s of ["repo", "read:user", "user:email"]) {
      expect(GITHUB_OAUTH_SCOPES.split(" ")).toContain(s);
    }
  });

  it("requests NOTHING beyond the four documented scopes", () => {
    // The guard against quiet permission creep: every scope here widens what a
    // leaked token can do, so adding one should have to fail this test first
    // and be a deliberate edit rather than a drive-by.
    expect([...GITHUB_OAUTH_SCOPE_LIST].sort()).toEqual(
      ["read:user", "repo", "user:email", "workflow"].sort(),
    );
  });

  it("explains every scope it requests", () => {
    for (const s of GITHUB_OAUTH_SCOPE_LIST) {
      expect(GITHUB_SCOPE_PURPOSE[s]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("is a space-separated string, the form signInWithOAuth expects", () => {
    expect(GITHUB_OAUTH_SCOPES).toBe(GITHUB_OAUTH_SCOPE_LIST.join(" "));
    expect(GITHUB_OAUTH_SCOPES).not.toContain(",");
  });
});

describe("parseGrantedScopes", () => {
  it("splits GitHub's comma-separated X-OAuth-Scopes header form", () => {
    expect(parseGrantedScopes("repo, workflow, user:email")).toEqual([
      "repo",
      "workflow",
      "user:email",
    ]);
  });

  it("splits the space-separated form we request", () => {
    expect(parseGrantedScopes("repo workflow")).toEqual(["repo", "workflow"]);
  });

  it("returns [] for null/undefined/empty/whitespace", () => {
    expect(parseGrantedScopes(null)).toEqual([]);
    expect(parseGrantedScopes(undefined)).toEqual([]);
    expect(parseGrantedScopes("")).toEqual([]);
    expect(parseGrantedScopes("   ")).toEqual([]);
  });
});

describe("hasWorkflowScope", () => {
  it("is true when granted", () => {
    expect(hasWorkflowScope("repo, workflow, read:user")).toBe(true);
  });

  it("is false for a full-`repo` grant without it - the exact failing case", () => {
    // `repo` does NOT imply `workflow`. This is why a token with complete
    // private-repo write access still had its CI push rejected.
    expect(hasWorkflowScope("repo, read:user, user:email")).toBe(false);
  });

  it("matches whole tokens, not substrings", () => {
    expect(hasWorkflowScope("repo, workflow:write-nonsense")).toBe(false);
  });
});

describe("adviseGithubConnection", () => {
  const FULL = GITHUB_OAUTH_SCOPE_LIST.join(", ");

  it("says nothing when the grant carries every requested scope (no nagging)", () => {
    // A banner that shows while everything is fine is a banner people learn to
    // ignore - which would cost us the one time it matters.
    expect(adviseGithubConnection({ connected: true, scopes: FULL })).toEqual({ state: "ok" });
  });

  it("reports reconnect_required for a pre-`workflow` grant, naming what's missing", () => {
    // The operator's actual stored row: connected, working, authorised before
    // DevPilot asked for `workflow`.
    const advice = adviseGithubConnection({
      connected: true,
      scopes: "repo, read:user, user:email",
    });
    expect(advice).toEqual({
      state: "reconnect_required",
      reason: "missing_scope",
      missing: ["workflow"],
    });
  });

  it("distinguishes 'never connected' from 'connected without the scope'", () => {
    // Different situations needing different words: one is "set this up", the
    // other is "your setup works but re-authorise". Collapsing them would tell
    // someone with a live connection that they have none.
    expect(adviseGithubConnection({ connected: false }).state).toBe("not_connected");
    expect(adviseGithubConnection(null).state).toBe("not_connected");
    expect(adviseGithubConnection(undefined).state).toBe("not_connected");
    expect(
      adviseGithubConnection({ connected: true, scopes: "repo, read:user, user:email" }).state,
    ).toBe("reconnect_required");
  });

  it("prompts a reconnect when the stored scopes are unknown, flagged as unproven", () => {
    // We cannot prove the grant lacks `workflow` - but we cannot prove it has
    // it either, and the costs are lopsided: a needless reconnect is one click,
    // staying silent means the next CI ticket dies at push time. So we prompt,
    // and `scopes_unknown` lets the copy say "couldn't confirm" rather than
    // asserting something we don't know.
    for (const scopes of [null, "", "   "]) {
      expect(adviseGithubConnection({ connected: true, scopes })).toEqual({
        state: "reconnect_required",
        reason: "scopes_unknown",
        missing: [],
      });
    }
  });

  it("does not treat an EXTRA scope on the stored grant as a reason to reconnect", () => {
    // A token that carries more than we ask for (e.g. granted by hand) still
    // satisfies everything we need.
    expect(adviseGithubConnection({ connected: true, scopes: `${FULL}, gist` })).toEqual({
      state: "ok",
    });
  });
});
