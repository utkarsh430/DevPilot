// Workspace precondition guard - the engine half.
//
// Two things are proved here. The pure decision (which runs require a checkout,
// and which of those provably cannot get one), and - over the source, because
// `run-agent.ts` cannot be imported under Vitest - that the refusal is raised
// BEFORE the job is enqueued and in a form that leaves the run `failed` rather
// than `done`. The second half is the whole point of the guard: a check that
// ran after the model call would save nothing.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decideWorkspacePrecondition,
  runRequiresWorkspace,
} from "@/lib/engine/workspace-precondition";

describe("runRequiresWorkspace - which runs need a checkout", () => {
  it("requires one for a ticket-bound dispatch of a code-producing role", () => {
    for (const role of [
      "engineer",
      "frontend_engineer",
      "backend_engineer",
      "fullstack_engineer",
      "mobile_engineer",
      "project_scaffolder",
    ]) {
      expect(runRequiresWorkspace({ ticketId: "t-1", role })).toBe(true);
    }
  });

  it("requires none for a ticket-LESS run, whatever the role", () => {
    // The one-shot classifiers/rankers, plan-mode calls, supervisor-spawned
    // children, and the headless /v1 + widget surfaces all land here. This is
    // the regression that would hurt most, so it is asserted for the role most
    // likely to look like it needs a workspace.
    expect(runRequiresWorkspace({ ticketId: null, role: "engineer" })).toBe(false);
    expect(runRequiresWorkspace({ ticketId: undefined, role: "engineer" })).toBe(false);
  });

  it("requires none for a non-code role, even with a ticket", () => {
    // A project with no connected repo is a supported configuration and the
    // ~48 non-code producer roles run against it fine. Refusing them would be
    // a strictly worse bug than the one this guard fixes.
    for (const role of [
      "product_manager",
      "designer",
      "techwriter",
      "qa",
      "devops",
      "sre",
      "release_engineer",
      "some_custom_jd_synthesized_role",
    ]) {
      expect(runRequiresWorkspace({ ticketId: "t-1", role })).toBe(false);
    }
  });

  it("requires none when the role is unresolvable", () => {
    expect(runRequiresWorkspace({ ticketId: "t-1", role: null })).toBe(false);
    expect(runRequiresWorkspace({ ticketId: "t-1", role: undefined })).toBe(false);
  });
});

describe("decideWorkspacePrecondition - refusal", () => {
  it("refuses a code-producing ticket dispatch with no repo URL", () => {
    const d = decideWorkspacePrecondition({ ticketId: "t-1", role: "engineer", repoUrl: null });
    expect(d.requiresWorkspace).toBe(true);
    expect(d.refusal?.code).toBe("no_repo_url");
    // Diagnosable, and actionable: it names the role and says what to do.
    expect(d.refusal?.message).toMatch(/engineer/);
    expect(d.refusal?.message).toMatch(/Connect a repository/);
  });

  it("treats a blank/whitespace repo URL as absent", () => {
    for (const repoUrl of ["", "   "]) {
      expect(
        decideWorkspacePrecondition({ ticketId: "t-1", role: "engineer", repoUrl })?.refusal?.code,
      ).toBe("no_repo_url");
    }
  });

  it("allows a code-producing ticket dispatch that HAS a repo URL", () => {
    const d = decideWorkspacePrecondition({
      ticketId: "t-1",
      role: "engineer",
      repoUrl: "https://github.com/acme/app.git",
    });
    expect(d.requiresWorkspace).toBe(true);
    expect(d.refusal).toBeNull();
  });

  it("never refuses a run that does not require a workspace", () => {
    // Ticket-less with no repo - the exact shape of a one-shot / plan / spawn /
    // headless job. Must pass through untouched.
    expect(
      decideWorkspacePrecondition({ ticketId: null, role: "engineer", repoUrl: null }).refusal,
    ).toBeNull();
    // Non-code role on a repo-less project.
    expect(
      decideWorkspacePrecondition({ ticketId: "t-1", role: "product_manager", repoUrl: null })
        .refusal,
    ).toBeNull();
  });

  it("does NOT refuse on a missing GitHub token (a public repo clones without one)", () => {
    // The guard deliberately checks only `repoUrl`. `token=absent` in the
    // incident log is not on its own proof the run cannot succeed, and an
    // unusable token surfaces through the existing workspace-prep failure path.
    const d = decideWorkspacePrecondition({
      ticketId: "t-1",
      role: "engineer",
      repoUrl: "https://github.com/acme/public.git",
    });
    expect(d.refusal).toBeNull();
  });
});

describe("run-agent wiring - refused before spending, and never 'done'", () => {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const source = readFileSync(path.join(webRoot, "lib", "engine", "run-agent.ts"), "utf8");

  it("consults the guard, and does so BEFORE the job is enqueued", () => {
    const guardAt = source.indexOf("decideWorkspacePrecondition({ ticketId, role, repoUrl })");
    const lpushAt = source.indexOf("await redis().lpush(\n            LOCAL_CC_QUEUE");
    expect(guardAt).toBeGreaterThan(0);
    expect(lpushAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(lpushAt);
  });

  it("raises NonRetriableError on refusal, so the `finish` step never marks it done", () => {
    const guardAt = source.indexOf("if (precondition.refusal) {");
    expect(guardAt).toBeGreaterThan(0);
    const block = source.slice(guardAt, source.indexOf("await redis().lpush", guardAt));
    expect(block).toMatch(/throw new NonRetriableError\(/);
    // …and tells the operator on the ticket, not only in the run row.
    expect(block).toMatch(/noticeWorkspacePreconditionRefusal\(/);
  });

  it("stamps the requirement on the job so the runner can enforce it too", () => {
    expect(source).toMatch(/requiresWorkspace: precondition\.requiresWorkspace/);
  });

  it("does not touch tickets.retry_count on a precondition refusal", () => {
    const guardAt = source.indexOf("if (precondition.refusal) {");
    // Comments stripped - the block explains in prose why it leaves the column
    // alone, and the assertion is about the CODE.
    const block = source
      .slice(guardAt, source.indexOf("await redis().lpush", guardAt))
      .replace(/\/\/.*$/gm, "");
    // The engineer<->QA reject loop owns that column; a precondition refusal is
    // not a QA rejection and must not consume its budget.
    expect(block).not.toMatch(/retry_count/);
  });
});
