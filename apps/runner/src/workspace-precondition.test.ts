// Workspace precondition guard - the runner half.
//
// Run: tsx src/workspace-precondition.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideJobWorkspaceRefusal, decideWorkspacePrepAttempt } from "./workspace-precondition.js";

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("workspace-precondition - refusals");

test("THE INCIDENT: workspace required, no ticket reference, no workspace -> REFUSED", () => {
  const d = decideJobWorkspaceRefusal({ requiresWorkspace: true, ticketId: null }, null);
  assert.equal(d.refuse, true);
  assert.equal(d.refuse && d.code, "workspace_required_but_absent");
  // The reason must be diagnosable, not a bare "error": someone reading the
  // board has to tell this apart from a genuine failure of the work.
  assert.match(d.refuse ? d.error : "", /no ticket reference/);
  assert.match(d.refuse ? d.error : "", /workspace precondition failed/);
});

test("empty-string ticketId is treated as absent, not as a present ticket", () => {
  const d = decideJobWorkspaceRefusal({ requiresWorkspace: true, ticketId: "" }, null);
  assert.equal(d.refuse, true);
  assert.match(d.refuse ? d.error : "", /no ticket reference/);
});

test("workspace required, ticket present, but prep produced nothing -> REFUSED, names the ticket", () => {
  const d = decideJobWorkspaceRefusal({ requiresWorkspace: true, ticketId: "t-42" }, null);
  assert.equal(d.refuse, true);
  assert.match(d.refuse ? d.error : "", /t-42/);
  assert.match(d.refuse ? d.error : "", /no repo URL resolved/);
});

console.log("workspace-precondition - the flows that MUST keep working");

test("a legitimately ticket-less job (one-shot / plan / spawn child / headless) still runs", () => {
  // No stamp at all - the one-shot and plan-bridge enqueuers never set it.
  assert.deepEqual(decideJobWorkspaceRefusal({ ticketId: null }, null), { refuse: false });
  assert.deepEqual(decideJobWorkspaceRefusal({}, null), { refuse: false });
  // Explicit false - a run-agent dispatch of a non-code role, or a ticket-less
  // run-agent run (supervisor child, headless /v1, widget).
  assert.deepEqual(decideJobWorkspaceRefusal({ requiresWorkspace: false, ticketId: null }, null), {
    refuse: false,
  });
});

test("a non-code role on a repo-less project still runs (the ~48-role regression)", () => {
  // Ticket present, no workspace, but the engine did NOT require one.
  assert.deepEqual(decideJobWorkspaceRefusal({ requiresWorkspace: false, ticketId: "t-1" }, null), {
    refuse: false,
  });
});

test("workspace required AND prepared -> runs normally", () => {
  assert.deepEqual(
    decideJobWorkspaceRefusal({ requiresWorkspace: true, ticketId: "t-1" }, "/ws/t-1"),
    { refuse: false },
  );
});

test("a non-boolean stamp is not truthy-coerced into a requirement", () => {
  // The stamp arrives over Redis as JSON; only a real `true` may refuse, or a
  // garbled payload starts wedging legitimate jobs.
  const j = { requiresWorkspace: "true", ticketId: null } as unknown as {
    requiresWorkspace?: boolean;
  };
  assert.deepEqual(decideJobWorkspaceRefusal(j, null), { refuse: false });
});

console.log("workspace-precondition - prep eligibility (the 2026-08-06 incident)");

test("ticket + repo + no eligibility stamp -> prep attempted (today's default behaviour)", () => {
  assert.equal(
    decideWorkspacePrepAttempt({ ticketId: "t-1", repoUrl: "https://x/y.git" }, undefined),
    true,
  );
});

test("ticket + no repo anywhere -> no prep attempted", () => {
  assert.equal(decideWorkspacePrepAttempt({ ticketId: "t-1", repoUrl: null }, undefined), false);
});

test("no ticket at all -> no prep attempted, regardless of repo availability", () => {
  assert.equal(
    decideWorkspacePrepAttempt({ ticketId: null, repoUrl: "https://x/y.git" }, undefined),
    false,
  );
  assert.equal(decideWorkspacePrepAttempt({ ticketId: null }, "https://legacy/repo.git"), false);
});

test("the legacy ENGINEER_REPO_URL env fallback still counts as a resolvable repo", () => {
  assert.equal(decideWorkspacePrepAttempt({ ticketId: "t-1" }, "https://legacy/repo.git"), true);
});

test(
  "THE INCIDENT'S FIX: a real ticketId with workspacePrepEligible=false is NEVER prepped, " +
    "even when a repo IS resolvable via the legacy env fallback",
  () => {
    assert.equal(
      decideWorkspacePrepAttempt(
        { ticketId: "t-1", workspacePrepEligible: false },
        "https://legacy/repo.git",
      ),
      false,
    );
  },
);

test("workspacePrepEligible=true is indistinguishable from the absent (default) case", () => {
  const args: [Parameters<typeof decideWorkspacePrepAttempt>[0], string | undefined] = [
    { ticketId: "t-1", repoUrl: "https://x/y.git" },
    undefined,
  ];
  assert.equal(
    decideWorkspacePrepAttempt({ ...args[0], workspacePrepEligible: true }, args[1]),
    decideWorkspacePrepAttempt(args[0], args[1]),
  );
});

console.log("workspace-precondition - wiring (refused BEFORE the model call)");

// The pure decision cannot prove WHERE it is consulted, and "before the LLM
// call" is the entire value of this guard - a check that ran afterwards would
// save nothing. index.ts cannot be imported here (it starts pull loops on
// import), so assert it over the source, the same instrument the web side uses
// for `secret-actions.ts`.
const here = path.dirname(fileURLToPath(import.meta.url));
const fullSource = readFileSync(path.join(here, "index.ts"), "utf8");

// Scoped to handleJob's body, NOT the whole file. The claim is about the
// dispatch path: "the refusal precedes THE JOB'S model call". index.ts now
// contains a second `runClaude` call in `nudgeUncommittedWork` (the
// empty-delivery seam), which is declared above handleJob — so a whole-file
// `indexOf` finds that one and silently starts asserting the wrong ordering,
// making the guard's verdict depend on the order helpers happen to be declared
// in. It caught exactly that when the nudge landed. Anchoring here keeps it
// answering the question it was written to answer, whatever else calls
// `runClaude`.
const handleJobAt = fullSource.indexOf("async function handleJob(");
if (handleJobAt < 0) throw new Error("index.ts no longer declares `async function handleJob(`");
const source = fullSource.slice(handleJobAt);

test("handleJob consults the guard, and does so before runClaude", () => {
  const guardAt = source.indexOf("decideJobWorkspaceRefusal(job, workspacePath)");
  const claudeAt = source.indexOf("await runClaude({");
  assert.ok(guardAt > 0, "handleJob must call decideJobWorkspaceRefusal(job, workspacePath)");
  assert.ok(claudeAt > 0, "handleJob must call runClaude");
  assert.ok(guardAt < claudeAt, "the guard must be consulted BEFORE runClaude");
});

test("the refusal returns out of handleJob rather than falling through", () => {
  const guardAt = source.indexOf("const wsRefusal = decideJobWorkspaceRefusal");
  const claudeAt = source.indexOf("await runClaude({");
  const block = source.slice(guardAt, claudeAt);
  assert.match(block, /if \(wsRefusal\.refuse\)/);
  // Reported through the same channel as a workspace-prep failure, then return.
  assert.match(block, /postStepResult\(/);
  assert.match(block, /ok: false/);
  assert.match(block, /\n    return;\n/);
});

test("handleJob's prep gate goes through decideWorkspacePrepAttempt, not a hand-rolled condition", () => {
  // The 2026-08-06 incident's OTHER half: a job that hardcoded ticketId=null
  // to suppress prep was fine as long as the gate here stayed `job.ticketId &&
  // haveRepoUrl` — but reverting to that inline shape after this fix lands
  // would silently drop the `workspacePrepEligible` guard and reopen the race
  // between a one-shot audit-tagged job and a live producer's workspace for
  // the same ticket, this time with ticketId left truthful. The gate must
  // route through the pure decision, which is what makes it testable at all.
  const gateAt = source.indexOf("decideWorkspacePrepAttempt(job, env.ENGINEER_REPO_URL)");
  const prepareAt = source.indexOf("await prepareWorkspace({");
  assert.ok(gateAt > 0, "handleJob must gate prep on decideWorkspacePrepAttempt(job, ...)");
  assert.ok(prepareAt > 0, "handleJob must call prepareWorkspace");
  assert.ok(gateAt < prepareAt, "the eligibility decision must precede the prepareWorkspace call");
});

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
if (failures > 0) process.exit(1);
