// Unit coverage for the pure workspace-path guard
// (`lib/dev-servers/workspace-path.ts`). Exercises the bug this closes: a
// `workspace_path` persisted by a different host must never be trusted
// as-is — see the module doc comment for the full incident.

import { describe, it, expect, vi } from "vitest";
import {
  classifyWorkspaceAvailability,
  hostWorkspacePath,
  isUnderWorkspaceRoot,
} from "@/lib/dev-servers/workspace-path";

const WORKSPACE_ROOT = "/Users/utkarsh430/.devpilot/workspaces";

describe("isUnderWorkspaceRoot", () => {
  it("is true for a path nested under the root", () => {
    expect(isUnderWorkspaceRoot(`${WORKSPACE_ROOT}/some-ticket-id`, WORKSPACE_ROOT)).toBe(true);
  });

  it("is false for a path on a different host entirely", () => {
    expect(
      isUnderWorkspaceRoot(
        "/Users/ethan-hunt/Downloads/devpilot-engine/.devpilot/workspaces/x",
        WORKSPACE_ROOT,
      ),
    ).toBe(false);
  });

  it("is false for the root itself (not a workspace, the root)", () => {
    expect(isUnderWorkspaceRoot(WORKSPACE_ROOT, WORKSPACE_ROOT)).toBe(false);
  });

  it("is false for a sibling directory that merely shares the root as a prefix", () => {
    expect(
      isUnderWorkspaceRoot("/Users/utkarsh430/.devpilot/workspaces-backup/x", WORKSPACE_ROOT),
    ).toBe(false);
  });
});

describe("hostWorkspacePath", () => {
  it("returns a local path unchanged", () => {
    const local = `${WORKSPACE_ROOT}/ticket-123`;
    expect(hostWorkspacePath(local, "ticket-123", "project-1", WORKSPACE_ROOT)).toBe(local);
  });

  it("re-derives a foreign absolute path via the ticket id when one is present", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const foreign = "/Users/ethan-hunt/Downloads/devpilot-engine/.devpilot/workspaces/ticket-123";
    const result = hostWorkspacePath(foreign, "ticket-123", "project-1", WORKSPACE_ROOT);
    expect(result).toBe(`${WORKSPACE_ROOT}/ticket-123`);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("re-derives via the project-scoped path when ticketId is null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const foreign = "/Users/ethan-hunt/Downloads/devpilot-engine/.devpilot/workspaces/project-1";
    const result = hostWorkspacePath(foreign, null, "project-1", WORKSPACE_ROOT);
    expect(result).toBe(`${WORKSPACE_ROOT}/project-project-1`);
    warn.mockRestore();
  });

  it("does not warn when the stored path is already local", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    hostWorkspacePath(`${WORKSPACE_ROOT}/ticket-123`, "ticket-123", "project-1", WORKSPACE_ROOT);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// The 2026-07-11 data-loss bug: the reaper deleted an unpushed workspace, the
// `pending_pushes` row survived pointing at the dead path, and the push flow
// spawned git with a missing cwd - which Node reports as a bare
// `spawn git ENOENT`. These lock in that the operator now gets an explanation
// and a way out instead.
describe("classifyWorkspaceAvailability", () => {
  const local = `${WORKSPACE_ROOT}/ticket-123`;

  it("is available when the path is local and on disk", () => {
    const result = classifyWorkspaceAvailability({
      stored: local,
      workspaceRoot: WORKSPACE_ROOT,
      exists: true,
      hasSavedDiff: true,
    });
    expect(result.available).toBe(true);
  });

  it("explains a reaped workspace instead of dead-ending on ENOENT", () => {
    const result = classifyWorkspaceAvailability({
      stored: local,
      workspaceRoot: WORKSPACE_ROOT,
      exists: false,
      hasSavedDiff: true,
    });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.code).toBe("missing");
    expect(result.message).toContain("no longer exists on disk");
    // The whole point: the operator is told the work is not lost, and how to
    // get it back.
    expect(result.message).toContain("Rebuild from saved diff");
    expect(result.message).not.toContain("ENOENT");
  });

  it("says so honestly when a reaped workspace has no saved diff to rebuild from", () => {
    const result = classifyWorkspaceAvailability({
      stored: local,
      workspaceRoot: WORKSPACE_ROOT,
      exists: false,
      hasSavedDiff: false,
    });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.code).toBe("missing");
    expect(result.message).toContain("cannot be reconstructed automatically");
  });

  it("still reports a foreign-host path as foreign, not merely missing", () => {
    const result = classifyWorkspaceAvailability({
      stored: "/Users/ethan-hunt/.devpilot/workspaces/ticket-123",
      workspaceRoot: WORKSPACE_ROOT,
      exists: false,
      hasSavedDiff: true,
    });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.code).toBe("foreign_host");
    expect(result.message).toContain("recorded on another host");
  });

  it("prefers the foreign-host diagnosis even if such a path somehow exists here", () => {
    // Foreign-ness is decided by the ROOT, not by the stat: a path outside our
    // root that happens to exist is still not our workspace.
    const result = classifyWorkspaceAvailability({
      stored: "/Users/ethan-hunt/.devpilot/workspaces/ticket-123",
      workspaceRoot: WORKSPACE_ROOT,
      exists: true,
      hasSavedDiff: true,
    });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.code).toBe("foreign_host");
  });
});
