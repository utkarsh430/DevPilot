// The empty-delivery seam — the decision, the prompt, and the wiring.
//
// Run: tsx src/empty-delivery.test.ts
//
// What these guards are FOR, stated plainly because a green suite here is easy
// to write and easy to make vacuous:
//
//   • Every fail-open branch is asserted as a NON-nudge. A test that only
//     proves the nudge fires on the happy shape passes for an implementation
//     that nudges on everything — including a git failure, which is exactly the
//     fail-closed behaviour `decideQaGate` is careful not to have.
//   • The loop bound is asserted directly, and asserted to be checked FIRST, so
//     a later edit reordering the fact-gathering cannot reopen it.
//   • The prompt's load-bearing sentences are asserted by content, not by
//     snapshot. Each one is a requirement (`git add -A` over `git commit -a`,
//     the no-safety-net statement, the honest escape), and a snapshot would let
//     all three drift green under one `-u`.
//   • The wiring is SOURCE-SCANNED, because `index.ts` cannot be imported —
//     which is precisely the gap this class of defect lives in.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMIT_NUDGE_SYSTEM_PROMPT,
  NUDGE_STATUS_ENTRY_CAP,
  decideCommitNudge,
  renderCommitNudgePrompt,
  type CommitNudgeInput,
} from "./empty-delivery.js";

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

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), "utf8");

/** The measured defect shape: a code-producing role, a real workspace, zero
 *  commits, and the agent's own edits sitting on disk. */
function theDefect(over: Partial<CommitNudgeInput> = {}): CommitNudgeInput {
  return {
    codeProducing: true,
    workspacePath: "/tmp/ws",
    commitsAhead: 0,
    statusEntries: [" M src/a.ts", " M src/b.ts", "?? tests/fixtures/"],
    alreadyNudged: false,
    ...over,
  };
}

console.log("empty-delivery — the decision");

test("THE DEFECT (#27/#86/#88): code-producing, 0 commits, dirty tree -> NUDGE", () => {
  const d = decideCommitNudge(theDefect());
  assert.equal(d.nudge, true);
  // The listing is carried through, not recomputed — the untracked entry that
  // made #86 unfixable by `git commit -a` has to reach the agent.
  assert.deepEqual(d.nudge ? d.statusEntries : [], [
    " M src/a.ts",
    " M src/b.ts",
    "?? tests/fixtures/",
  ]);
});

test("#86 exactly: modified files PLUS an untracked directory still nudges", () => {
  const d = decideCommitNudge(
    theDefect({ statusEntries: [" M a.ts", " M b.ts", " M c.ts", "?? fixtures/"] }),
  );
  assert.equal(d.nudge, true);
});

test("an UNTRACKED-ONLY tree nudges — `git commit -a` would have committed nothing", () => {
  const d = decideCommitNudge(theDefect({ statusEntries: ["?? tests/fixtures/"] }));
  assert.equal(d.nudge, true);
});

console.log("empty-delivery — the ~48 non-code roles are never touched");

test("a non-code role with 0 commits and a dirty tree is NOT nudged", () => {
  // A PM, designer or techwriter finishes EVERY run in this state. Nudging them
  // would wedge every one of them — the regression this feature must not cause.
  const d = decideCommitNudge(theDefect({ codeProducing: false }));
  assert.equal(d.nudge, false);
  assert.equal(d.nudge === false && d.skipped, "not-code-producing");
});

test("an ABSENT stamp (older engine / ticket-less enqueuer) is NOT nudged", () => {
  for (const stamp of [undefined, null] as const) {
    const d = decideCommitNudge(theDefect({ codeProducing: stamp }));
    assert.equal(d.nudge, false, `stamp=${String(stamp)}`);
    assert.equal(d.nudge === false && d.skipped, "not-code-producing");
  }
});

test("only a literal `true` arms it — a truthy non-boolean does not", () => {
  // `codeProducing !== true`, not a truthiness test: a payload field that
  // arrived as the STRING "false" is truthy and must not arm a spend.
  const d = decideCommitNudge(theDefect({ codeProducing: "false" as unknown as boolean }));
  assert.equal(d.nudge, false);
  assert.equal(d.nudge === false && d.skipped, "not-code-producing");
});

console.log("empty-delivery — every uncertain input fails OPEN");

test("commitsAhead === null is NEVER inferred to 0 (mirrors delivery-indeterminate)", () => {
  const d = decideCommitNudge(theDefect({ commitsAhead: null }));
  assert.equal(d.nudge, false);
  assert.equal(d.nudge === false && d.skipped, "delivery-indeterminate");
});

test("an unreadable worktree is NEVER inferred to be clean", () => {
  const d = decideCommitNudge(theDefect({ statusEntries: null }));
  assert.equal(d.nudge, false);
  assert.equal(d.nudge === false && d.skipped, "worktree-indeterminate");
});

test("no workspace -> no nudge", () => {
  const d = decideCommitNudge(theDefect({ workspacePath: null }));
  assert.equal(d.nudge, false);
  assert.equal(d.nudge === false && d.skipped, "no-workspace");
});

test("a branch that already carries work is left alone", () => {
  for (const n of [1, 7]) {
    const d = decideCommitNudge(theDefect({ commitsAhead: n }));
    assert.equal(d.nudge, false, `commitsAhead=${n}`);
    assert.equal(d.nudge === false && d.skipped, "delivery-present");
  }
});

console.log("empty-delivery — it cannot loop");

test("NOTHING TO COMMIT is terminal, not a bounce: 0 commits + clean tree -> no nudge", () => {
  // The agent genuinely produced nothing. There is no work a nudge could ask it
  // to record, so control falls straight through to `decideQaGate`, which
  // refuses `empty_delivery` and parks the ticket `blocked` for a human — one
  // pass, one refusal, a reversible state.
  const d = decideCommitNudge(theDefect({ statusEntries: [] }));
  assert.equal(d.nudge, false);
  assert.equal(d.nudge === false && d.skipped, "nothing-to-commit");
});

test("ONE nudge per step: alreadyNudged refuses the defect shape itself", () => {
  const d = decideCommitNudge(theDefect({ alreadyNudged: true }));
  assert.equal(d.nudge, false);
  assert.equal(d.nudge === false && d.skipped, "nudge-already-spent");
});

test("the loop bound is checked FIRST — it wins over every other branch", () => {
  // Asserted against inputs that would otherwise report a DIFFERENT reason, so
  // this fails if a later edit moves the check below the fact-gathering.
  for (const over of [
    { codeProducing: false },
    { workspacePath: null },
    { commitsAhead: null },
    { statusEntries: null },
    { statusEntries: [] },
  ] as Partial<CommitNudgeInput>[]) {
    const d = decideCommitNudge(theDefect({ ...over, alreadyNudged: true }));
    assert.equal(d.nudge === false && d.skipped, "nudge-already-spent", JSON.stringify(over));
  }
});

console.log("empty-delivery — the agent-facing message");

test("it names `git add -A` AND warns off `git commit -a` by name", () => {
  // #86's fixtures directory was untracked. `-a` stages tracked modifications
  // only, so the reflex instruction would have committed three files and
  // silently dropped the deliverable's new directory.
  const p = renderCommitNudgePrompt([" M a.ts", "?? fixtures/"]);
  assert.match(p, /git add -A/);
  assert.match(p, /git commit -a/);
  assert.match(p, /NOT `git commit -a`/);
  assert.match(p, /stages tracked modifications ONLY/);
});

test("it states plainly that uncommitted edits have no safety net", () => {
  // The reap guard protects unpushed COMMITS only, by design, and that rule is
  // not changed. The agent must not assume the platform is holding its work.
  const p = renderCommitNudgePrompt([" M a.ts"]);
  assert.match(p, /NO safety net/);
  assert.match(p, /unpushed COMMITS/);
  assert.match(p, /only copy/);
});

test("it names the consequence: refused hand-off, parked ticket, no further action", () => {
  const p = renderCommitNudgePrompt([" M a.ts"]);
  assert.match(p, /REFUSED/);
  assert.match(p, /blocked/);
  assert.match(p, /you cannot act on it/);
});

test("it offers the honest escape and forbids a noise commit", () => {
  // A ticket that truly needs no code change must reach the human-parked state
  // with a truthful reply, not with a manufactured commit that satisfies the
  // check and lies to QA.
  const p = renderCommitNudgePrompt([" M a.ts"]);
  assert.match(p, /nothing here worth committing/);
  assert.match(p, /Do not manufacture a commit/);
});

test("the actual dirty entries are quoted back, capped, and the omission is stated", () => {
  const many = Array.from({ length: NUDGE_STATUS_ENTRY_CAP + 5 }, (_, i) => ` M src/f${i}.ts`);
  const p = renderCommitNudgePrompt(many);
  assert.ok(p.includes(" M src/f0.ts"));
  assert.ok(p.includes(` M src/f${NUDGE_STATUS_ENTRY_CAP - 1}.ts`));
  assert.ok(!p.includes(` M src/f${NUDGE_STATUS_ENTRY_CAP}.ts`), "cap not applied");
  assert.match(p, /and 5 more entries/);
});

test("under the cap, nothing claims entries were omitted", () => {
  const p = renderCommitNudgePrompt([" M a.ts", " M b.ts"]);
  assert.ok(!/more entr/.test(p), "reported an omission that did not happen");
});

test("the nudge system prompt scopes the turn to recording, not re-doing, the work", () => {
  // A fresh `claude -p` handed the engineer's own role brief would treat this as
  // a second unbudgeted attempt at the ticket.
  assert.match(COMMIT_NUDGE_SYSTEM_PROMPT, /ALREADY DONE/);
  assert.match(COMMIT_NUDGE_SYSTEM_PROMPT, /Do not start new work/);
  assert.match(COMMIT_NUDGE_SYSTEM_PROMPT, /ONLY job/);
});

console.log("empty-delivery — wiring (source scan: index.ts cannot be imported)");

const indexSrc = read("index.ts");
const claudeSrc = read("claude.ts");

test("the nudge runs on the SUCCESS path, BEFORE the verification record", () => {
  // Ordering is the guarantee that the gate sees the post-nudge truth. A nudge
  // after the record would leave `decideQaGate` refusing on evidence the nudge
  // had already made stale.
  const nudgeAt = indexSrc.indexOf("await nudgeUncommittedWork(job, workspacePath)");
  const recordAt = indexSrc.indexOf("await recordStepVerification(job, workspacePath, baseSha)");
  assert.ok(nudgeAt > 0, "nudgeUncommittedWork is not called from handleJob");
  assert.ok(recordAt > 0, "recordStepVerification call not found");
  assert.ok(nudgeAt < recordAt, "the nudge must run before the verification record");
});

test("it is called exactly ONCE — no loop, no retry", () => {
  const calls = indexSrc.match(/await nudgeUncommittedWork\(/g) ?? [];
  assert.equal(calls.length, 1, `expected 1 call site, found ${calls.length}`);
  assert.match(indexSrc, /alreadyNudged: false/);
});

test("the nudge turn carries NO board tools and NO MCP servers", () => {
  // Two independent bounds. Omitting a tool from `--tools` leaves it deferred
  // but reachable; a server that is not declared cannot be spawned at all.
  assert.match(indexSrc, /toolsCsv: COMMIT_NUDGE_TOOLS_CSV/);
  assert.match(indexSrc, /mcpConfigPath: NO_MCP_CONFIG_PATH/);
  assert.match(claudeSrc, /export const NO_MCP_CONFIG_PATH/);
  assert.match(claudeSrc, /mcpServers: \{\}/);
  // The narrowed set must not contain a board tool, a browser tool, `Edit`, or
  // `Task` — an automatic turn does not get to rewrite the work or fan out.
  const csv = claudeSrc.match(/export const COMMIT_NUDGE_TOOLS_CSV = \[([^\]]*)\]/)?.[1] ?? "";
  assert.ok(csv.length > 0, "COMMIT_NUDGE_TOOLS_CSV not found");
  for (const banned of ["devpilot_", "browser_", "Edit", "Task", "WebFetch", "WebSearch"]) {
    assert.ok(!csv.includes(banned), `COMMIT_NUDGE_TOOLS_CSV must not contain ${banned}`);
  }
  assert.ok(csv.includes("Bash"), "the nudge cannot run git without Bash");
});

test("the full agent surface is UNCHANGED for every existing caller", () => {
  // `toolsCsv` is additive: absent means `AGENT_TOOLS_CSV`, at both the option
  // and the arg-builder default, so no existing step's tool set moved.
  assert.match(claudeSrc, /toolsCsv: string = AGENT_TOOLS_CSV/);
  assert.match(claudeSrc, /input\.toolsCsv \?\? AGENT_TOOLS_CSV/);
});

test("the gate stays the backstop — nothing here evaluates or re-implements it", () => {
  // `decideQaGate` is not weakened, and the structural reason is that this side
  // never CONSULTS it: the runner holds no gate policy and cannot short-circuit
  // one. Matched on the CALL form (`decideQaGate(`) rather than the bare name,
  // so the doc comments that legitimately cite the gate's fail-open rules — the
  // rules this module deliberately mirrors — do not trip it. A stripper that
  // tried to remove those comments would be the fragile half of this test.
  for (const src of [read("empty-delivery.ts"), indexSrc]) {
    assert.ok(!src.includes("decideQaGate("), "the runner must not evaluate the QA gate");
    assert.ok(!/from "[^"]*qa-gate/.test(src), "the runner must not import a gate policy");
  }
});

console.log(
  failures === 0 ? "\nempty-delivery: all guards passed" : `\nempty-delivery: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
