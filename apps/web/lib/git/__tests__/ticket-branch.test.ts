// The ticket-branch dual-match is LOAD-BEARING, and it looks like dead code.
//
// These tests exist so that narrowing `isTicketBranch` to `devpilot/` only is a
// RED TEST rather than a silent data-loss bug. The runner's workspace re-entry
// guard uses it to keep an existing checkout on its current branch; drop the
// `ace` half and the runner cuts a fresh `devpilot/<slug>` on top of a workspace
// already sitting on `ace/<slug>`, stranding commits that in some workspaces
// were never pushed anywhere.

import { describe, it, expect } from "vitest";
import { isTicketBranch, ticketBranch, TICKET_BRANCH_PREFIX } from "@/lib/git/ticket-branch";

describe("ticketBranch", () => {
  it("cuts NEW branches in the devpilot namespace", () => {
    expect(ticketBranch("add-login-form")).toBe("devpilot/add-login-form");
    expect(TICKET_BRANCH_PREFIX).toBe("devpilot/");
  });
});

describe("isTicketBranch", () => {
  it("matches the current namespace", () => {
    expect(isTicketBranch("devpilot/add-login-form")).toBe(true);
  });

  it("STILL matches the pre-rename `ace/` namespace — do not remove this", () => {
    // Existing workspaces on disk are checked out on these, and some hold
    // commits that exist nowhere else.
    expect(isTicketBranch("ace/add-login-form")).toBe(true);
    expect(isTicketBranch("ace/30153ef9-a1b2-4c3d")).toBe(true);
  });

  it("does not match integration or production branches", () => {
    for (const b of ["main", "dev", "develop", "staging", "release/1.0"]) {
      expect(isTicketBranch(b)).toBe(false);
    }
  });

  it("does not match a branch that merely starts with the letters", () => {
    expect(isTicketBranch("acen/thing")).toBe(false);
    expect(isTicketBranch("devpilotana/thing")).toBe(false);
    expect(isTicketBranch("feature/ace/thing")).toBe(false);
  });

  it("handles null/undefined/empty", () => {
    expect(isTicketBranch(null)).toBe(false);
    expect(isTicketBranch(undefined)).toBe(false);
    expect(isTicketBranch("")).toBe(false);
  });
});
