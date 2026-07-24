// Unit coverage for the unpushed-work reap policy (`lib/workspace/unpushed-work.ts`).
//
// The bug this locks down (2026-07-11): the workspace reaper deleted a terminal
// ticket's workspace unconditionally. When the ticket's branch had never been
// pushed, the commits existed ONLY in that directory - so the `rm -rf` destroyed
// them, silently, while the ticket read `done`. In production every missing
// workspace had `pushed_at = null` and no remote branch; every surviving one had
// `pushed_at != null` and was on the remote.
//
// The runner enforces the same rule against git itself
// (`apps/runner/src/workspace-reap-guard.test.ts`); this covers the engine's
// DB-side half.

import { describe, it, expect } from "vitest";
import {
  decideWorkspaceReap,
  formatUnpushedWorkNotice,
  holdsUnpushedWork,
  type PendingPushLike,
} from "@/lib/workspace/unpushed-work";

function row(over: Partial<PendingPushLike> = {}): PendingPushLike {
  return {
    id: "pp-1",
    branch: "devpilot/sql-migrations-abc",
    workspace_path: "/Users/utkarsh430/.devpilot/workspaces/ticket-1",
    pushed_at: null,
    unpushed_count: 2,
    ...over,
  };
}

describe("holdsUnpushedWork", () => {
  it("holds a row that was never pushed", () => {
    expect(holdsUnpushedWork(row({ pushed_at: null }))).toBe(true);
  });

  it("releases a row once it has been pushed", () => {
    expect(holdsUnpushedWork(row({ pushed_at: "2026-07-10T12:00:00Z" }))).toBe(false);
  });

  it("holds an unpushed row even when the commit count reads zero", () => {
    // A live row exists only because the tracker found commits. A zero/stale
    // count must NOT be read as "nothing to lose" - trusting it would re-open
    // the exact hole this policy closes.
    expect(holdsUnpushedWork(row({ pushed_at: null, unpushed_count: 0 }))).toBe(true);
    expect(holdsUnpushedWork(row({ pushed_at: null, unpushed_count: null }))).toBe(true);
  });
});

describe("decideWorkspaceReap", () => {
  it("REFUSES to reap a terminal ticket whose branch was never pushed", () => {
    const decision = decideWorkspaceReap([row()]);
    expect(decision.reap).toBe(false);
    if (decision.reap) throw new Error("unreachable");
    expect(decision.holding).toHaveLength(1);
    expect(decision.reason).toContain("devpilot/sql-migrations-abc");
    expect(decision.reason).toContain("exist nowhere else");
  });

  it("reaps a terminal ticket whose work is all pushed", () => {
    const decision = decideWorkspaceReap([
      row({ id: "pp-1", pushed_at: "2026-07-10T12:00:00Z" }),
      row({ id: "pp-2", branch: "devpilot/other", pushed_at: "2026-07-10T13:00:00Z" }),
    ]);
    expect(decision.reap).toBe(true);
  });

  it("reaps a ticket that never produced any commits at all", () => {
    // No pending_pushes row = the tracker found nothing to push. Nothing to
    // protect, so the workspace is reclaimable as before - the guard must not
    // leak disk on the overwhelmingly common case.
    expect(decideWorkspaceReap([]).reap).toBe(true);
  });

  it("holds if ANY branch is unpushed, even when others are pushed", () => {
    const decision = decideWorkspaceReap([
      row({ id: "pp-1", branch: "devpilot/pushed", pushed_at: "2026-07-10T12:00:00Z" }),
      row({ id: "pp-2", branch: "devpilot/never-pushed", pushed_at: null }),
    ]);
    expect(decision.reap).toBe(false);
    if (decision.reap) throw new Error("unreachable");
    expect(decision.holding.map((r) => r.branch)).toEqual(["devpilot/never-pushed"]);
  });

  it("has NO force/override escape — the automatic guard always refuses on unpushed work", () => {
    // The deliberate operator "Discard & restart" override lives ONLY in the
    // runner's cleanupWorkspace (behind a `force` flag threaded from the operator
    // action) — never here. This function is the automatic reaper's guard and
    // takes only the rows; there is no argument that can make it reap unpushed
    // work. Guarding this keeps the discard flag out of the reaper path forever.
    expect(decideWorkspaceReap.length).toBe(1);
    expect(decideWorkspaceReap([row({ pushed_at: null })]).reap).toBe(false);
  });
});

describe("formatUnpushedWorkNotice", () => {
  it("names the branch, the commit count, and links to the change", () => {
    const body = formatUnpushedWorkNotice([row({ id: "pp-9", unpushed_count: 3 })]);
    expect(body).toContain("never pushed");
    expect(body).toContain("devpilot/sql-migrations-abc");
    expect(body).toContain("3 unpushed commits");
    expect(body).toContain("/changes/pp-9");
  });

  it("singularizes a lone commit", () => {
    expect(formatUnpushedWorkNotice([row({ unpushed_count: 1 })])).toContain("1 unpushed commit ");
  });
});
