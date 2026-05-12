// WI-4 (connect-existing) — integration-branch resolution for a CONNECTED repo.
//
// The property under test is the one that keeps auto-land from hijacking a
// branch the operator already uses: if `dev` exists it must be left alone and a
// devpilot-namespaced branch used instead; if `dev` is absent it may be adopted.

import { describe, expect, it } from "vitest";
import {
  DEVPILOT_INTEGRATION_BRANCH,
  DEFAULT_INTEGRATION_BRANCH,
  resolveConnectIntegrationBranch,
} from "../connect-integration-branch";

describe("resolveConnectIntegrationBranch", () => {
  it("adopts `dev` when the repo has no dev branch", () => {
    const plan = resolveConnectIntegrationBranch({ devExists: false, defaultBranch: "main" });
    expect(plan.branch).toBe(DEFAULT_INTEGRATION_BRANCH);
    expect(plan.branch).toBe("dev");
    // Cut off the default branch so it's rooted in real history.
    expect(plan.sourceBranch).toBe("main");
  });

  it("uses the devpilot-namespaced branch when `dev` already exists (operator's own)", () => {
    const plan = resolveConnectIntegrationBranch({ devExists: true, defaultBranch: "main" });
    expect(plan.branch).toBe(DEVPILOT_INTEGRATION_BRANCH);
    expect(plan.branch).toBe("devpilot-integration");
    expect(plan.sourceBranch).toBe("main");
  });

  it("cuts from whatever the repo's default branch is, not a hardcoded name", () => {
    const plan = resolveConnectIntegrationBranch({ devExists: false, defaultBranch: "master" });
    expect(plan.sourceBranch).toBe("master");
  });

  it("never returns the per-ticket namespace (no `devpilot/` slash prefix)", () => {
    // The slash form would be mistaken for a ticket branch by isTicketBranch and
    // refused by setIntegrationBranchAction; the dash form must be used instead.
    for (const devExists of [true, false]) {
      const plan = resolveConnectIntegrationBranch({ devExists, defaultBranch: "main" });
      expect(plan.branch).not.toMatch(/^(?:ace|devpilot)\//);
    }
  });

  it("keeps the integration branch distinct from the default in the common cases", () => {
    // Both `dev` (default main) and `devpilot-integration` (default main) differ
    // from the production branch — required by setIntegrationBranchAction, which
    // rejects integration === default.
    expect(
      resolveConnectIntegrationBranch({ devExists: false, defaultBranch: "main" }).branch,
    ).not.toBe("main");
    expect(
      resolveConnectIntegrationBranch({ devExists: true, defaultBranch: "main" }).branch,
    ).not.toBe("main");
  });
});
