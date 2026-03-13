// Acceptance check: the verdictless-review nudge WORKS AGAINST A REAL AGENT.
//
//   pnpm --filter @devpilot/runner accept:verdict-nudge
//
// WHY THIS EXISTS AND WHY A UNIT TEST IS NOT ENOUGH
// ────────────────────────────────────────────────
// `verdict-outcome.test.ts` proves the DECISION and the message. That is the
// half that is easy: `decideTicketReconciliation` has correctly identified this
// exact shape since the verdictless-park branch was written, and tickets still
// stranded twelve times — because the finding arrived after `claude -p` had
// exited. So the claim this change actually makes is not "a function returns a
// decision", it is:
//
//   a reviewer that finished a run having recorded no verdict receives that
//   fact at a point where recording one is still possible, and records it.
//
// Nothing short of a real `claude -p` — with the real narrowed tool set, the
// real board-only MCP config, and the real stdio relay actually calling an
// engine — can show that. A stub engine stands in for DevPilot here so the run
// costs one model turn and no database: it is the relay's own HTTP contract, and
// what it records is what a real engine would have been told.
//
// It is NOT in `pnpm test`: it spends real `claude -p` turns on the operator's
// subscription and takes tens of seconds, not milliseconds. It needs an
// authenticated `claude` CLI and nothing else.
//
// THE THREE SCENARIOS, and none of them is a formality:
//
//   A  A review whose conclusion clearly REQUESTS CHANGES. The agent must record
//      `in_progress`. Asserting the DIRECTION — not merely "some verdict" — is
//      what makes this a test of recording rather than of guessing: a run that
//      recorded `done` here would be the fabricated approval this design exists
//      to prevent, and a red result on that assertion is a real finding, not
//      flake.
//
//   B  A review whose conclusion states NO verdict. The agent must NOT move the
//      ticket. This is the constraint-3 half, and a script that only ran
//      scenario A would pass for a prompt that says "approve if unsure".
//
//   C  The seam standing down. A run that DID record a verdict must not be
//      nudged, a producer role must never be nudged, and an ignored nudge must
//      leave the marker empty — which is precisely the state that hands the
//      ticket to the reconciler's park, unchanged.

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

// ── the stub engine, up BEFORE the imports that snapshot its URL ────────────
//
// `BOARD_ONLY_MCP_CONFIG_PATH` is built at module load and bakes
// LOCAL_CC_ENGINE_URL into the relay's declared env, so the server has to exist
// and its port has to be in `process.env` before `claude.js` is imported.

type RelayCall = { path: string; body: Record<string, unknown> };
const calls: RelayCall[] = [];

const engine = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* record it as empty */
    }
    calls.push({ path: req.url ?? "", body });
    res.writeHead(200, { "Content-Type": "application/json" });
    // Shape does not matter to the relay beyond being 2xx JSON; what matters is
    // that `ok` is what drives the marker write.
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
const enginePort = (engine.address() as AddressInfo).port;
const ENGINE_URL = `http://127.0.0.1:${enginePort}`;

process.env.LOCAL_CC_ENGINE_URL = ENGINE_URL;
process.env.UPSTASH_REDIS_REST_URL ||= "https://accept.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "accept-token";
process.env.DEVPILOT_RUNNER_REGISTRATION_KEY ||= "accept-key";
process.env.DEVPILOT_RUNNER_TENANT_ID ||= "00000000-0000-0000-0000-000000000000";

const { runClaude, VERDICT_NUDGE_TOOLS_CSV, BOARD_ONLY_MCP_CONFIG_PATH, buildClaudeBaseArgs } =
  await import("../src/claude.js");
const { decideVerdictNudge, renderVerdictNudgePrompt, VERDICT_NUDGE_SYSTEM_PROMPT } =
  await import("../src/verdict-outcome.js");
const { outcomeMarkerPathFor, readRecordedOutcomes, removeOutcomeMarker } =
  await import("../src/outcome-marker.js");

const TICKET_ID = "3f2b1c90-0000-4000-8000-0000000000090";

/** A review that plainly requests changes — the conclusion a reviewer reached
 *  and then failed to record. Modelled on ticket #90's shape: real findings,
 *  no `devpilot_move_ticket` call. */
const REVIEW_REQUESTING_CHANGES = [
  "I reviewed the widget-validation change on this branch.",
  "",
  "Findings:",
  "  1. `check_parser` returns true for an empty string, so the empty-input case",
  "     documented in the acceptance criteria is not actually rejected.",
  "  2. `tests/fixtures/widget.invalid.json` is never loaded by any test — the",
  "     invalid case is unexercised.",
  "  3. `pnpm build` fails: src/index.ts re-exports a symbol that no longer exists.",
  "",
  "Conclusion: this is not ready. The build is broken and the stated acceptance",
  "criterion is unmet. This needs to go back to the engineer for changes.",
].join("\n");

/** A review that never reaches a verdict — cut short mid-inspection. There is
 *  nothing here to record, and the only honest move is to escalate. */
const REVIEW_WITHOUT_A_VERDICT = [
  "Starting the review of the widget-validation change.",
  "",
  "I read src/parser.ts and src/validate.ts and began cross-checking them against",
  "the acceptance criteria. I have not yet run the build, and I have not looked at",
  "index.ts or the fixtures at all, so I cannot say whether the criteria are met.",
].join("\n");

function banner(s: string) {
  console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
}

function movesRecorded(): RelayCall[] {
  return calls.filter((c) => c.path.includes("/move-ticket"));
}

/** Run the REAL nudge turn exactly as `nudgeMissingVerdict` does. */
async function runNudgeTurn(markerPath: string, reviewSummary: string) {
  const prompt = renderVerdictNudgePrompt({ ticketId: TICKET_ID, role: "qa", reviewSummary });
  console.log(prompt);
  const startedAt = Date.now();
  const out = await runClaude({
    prompt,
    systemPrompt: VERDICT_NUDGE_SYSTEM_PROMPT,
    toolsCsv: VERDICT_NUDGE_TOOLS_CSV,
    mcpConfigPath: BOARD_ONLY_MCP_CONFIG_PATH,
    runId: null,
    model: null,
    envOverrides: {
      DEVPILOT_RUN_ID: "0222c4c9-0000-4000-8000-000000000000",
      DEVPILOT_TENANT_ID: process.env.DEVPILOT_RUNNER_TENANT_ID!,
      DEVPILOT_TICKET_ID: TICKET_ID,
      DEVPILOT_ROLE: "qa",
      DEVPILOT_OUTCOME_MARKER_PATH: markerPath,
    },
  });
  console.log(`\n--- agent reply (${Math.round((Date.now() - startedAt) / 1000)}s) ---`);
  console.log(out.text.trim().slice(0, 1200));
  return out;
}

async function main(): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "devpilot-verdict-nudge-accept-"));
  let failed = false;

  try {
    // ── the turn really is narrowed, on the argv the child is spawned with ──
    banner("BOUNDS — the real argv and the real MCP config for the nudge turn");
    const argv = buildClaudeBaseArgs(null, BOARD_ONLY_MCP_CONFIG_PATH, VERDICT_NUDGE_TOOLS_CSV);
    console.log(argv.join(" "));
    // Read the value the child is actually given for `--tools`, not the whole
    // argv: `--permission-mode=acceptEdits` contains the substring "Edit" and a
    // whole-argv scan reports a violation that is not there. Both flags carry
    // the same list, so both are checked.
    const toolsIdx = argv.indexOf("--tools");
    const allowedIdx = argv.indexOf("--allowedTools");
    assert.ok(toolsIdx >= 0 && allowedIdx >= 0, "the nudge turn must pin both tool flags");
    const toolLists = [argv[toolsIdx + 1]!, argv[allowedIdx + 1]!];
    for (const list of toolLists) {
      for (const banned of ["Bash", "Edit", "Write", "Task", "browser_", "WebFetch", "WebSearch"]) {
        assert.ok(!list.includes(banned), `the verdict turn must not carry ${banned}`);
      }
      assert.ok(list.includes("devpilot_move_ticket"), "the turn must be able to record a verdict");
      assert.ok(list.includes("devpilot_request_human"), "the turn must be able to escalate");
      assert.ok(
        !list.includes("devpilot_create_ticket") && !list.includes("devpilot_spawn_agent"),
        "the verdict turn must not be able to file work or fan out",
      );
    }
    const cfg = JSON.parse(await fs.readFile(BOARD_ONLY_MCP_CONFIG_PATH, "utf8"));
    assert.deepEqual(Object.keys(cfg.mcpServers), ["devpilot-board"], "board relay only");
    console.log(`\nMCP servers declared: ${Object.keys(cfg.mcpServers).join(", ")}`);
    console.log(
      `relay engine URL:     ${cfg.mcpServers["devpilot-board"].env.LOCAL_CC_ENGINE_URL}`,
    );

    // ══ SCENARIO A ═════════════════════════════════════════════════════════
    banner("SCENARIO A — the reviewer's conclusion REQUESTS CHANGES and was never recorded");
    const markerA = outcomeMarkerPathFor("run-A", base);

    // DETECTION: exactly what handleJob computes after `claude -p` returns.
    const before = readRecordedOutcomes(markerA);
    console.log(`outcomes recorded by the review run: ${JSON.stringify(before)}`);
    assert.deepEqual(before, [], "fixture must start with NO recorded outcome");
    const decision = decideVerdictNudge({
      verdictRole: true, // engine-stamped isVerdictRoleConfig(ROLES.qa)
      ticketId: TICKET_ID,
      finalIteration: true,
      recordedOutcomes: before,
      alreadyNudged: false,
    });
    assert.equal(decision.nudge, true, "the seam must fire on the defect shape");
    console.log("decision: NUDGE\n");

    banner("THE MESSAGE, DELIVERED WHILE THE REVIEWER CAN STILL ACT");
    await runNudgeTurn(markerA, REVIEW_REQUESTING_CHANGES);

    banner("AFTER");
    const afterA = readRecordedOutcomes(markerA);
    console.log(`marker now records: ${JSON.stringify(afterA)}`);
    console.log(`relay calls:`);
    for (const c of calls) console.log(`  ${c.path} ${JSON.stringify(c.body).slice(0, 160)}`);

    assert.ok(
      afterA !== null && afterA.includes("devpilot_move_ticket"),
      `THE CLAIM FAILED: no verdict was recorded (marker=${JSON.stringify(afterA)})`,
    );
    const moves = movesRecorded();
    assert.equal(moves.length, 1, `expected exactly one move, got ${moves.length}`);
    const recorded = moves[0]!.body.status;
    console.log(`\nverdict recorded: ${String(recorded)}`);
    assert.equal(
      moves[0]!.body.ticketId,
      TICKET_ID,
      "the move must target the ticket named in the prompt",
    );
    // The direction is the point. Its own conclusion said "not ready … back to
    // the engineer"; recording `done` here would be a fabricated approval.
    assert.equal(
      recorded,
      "in_progress",
      `the reviewer recorded "${String(recorded)}" for a conclusion that requested changes — ` +
        `that is a SYNTHESISED verdict, not a recorded one`,
    );
    console.log(
      "\n✓ SCENARIO A: the reviewer received the finding in time and recorded ITS OWN verdict",
    );

    // ══ SCENARIO B ═════════════════════════════════════════════════════════
    banner("SCENARIO B — the review reached NO verdict: the agent must not invent one");
    calls.length = 0;
    const markerB = outcomeMarkerPathFor("run-B", base);
    await runNudgeTurn(markerB, REVIEW_WITHOUT_A_VERDICT);

    banner("AFTER");
    const afterB = readRecordedOutcomes(markerB);
    console.log(`marker now records: ${JSON.stringify(afterB)}`);
    console.log(`relay calls:`);
    for (const c of calls) console.log(`  ${c.path} ${JSON.stringify(c.body).slice(0, 200)}`);

    assert.equal(
      movesRecorded().length,
      0,
      "THE CLAIM FAILED: the agent moved the ticket on a review that stated no verdict — " +
        "that is exactly the fabricated verdict this design forbids",
    );
    console.log(
      `\n✓ SCENARIO B: no verdict was invented` +
        ((afterB ?? []).includes("devpilot_request_human")
          ? " — it escalated to a human instead, carrying its question"
          : " — it recorded nothing, and the reconciler's park is the backstop"),
    );

    // ══ SCENARIO C ═════════════════════════════════════════════════════════
    banner("CONTROL — the seam must stand down where it should, and never loop");

    const recovered = decideVerdictNudge({
      verdictRole: true,
      ticketId: TICKET_ID,
      finalIteration: true,
      recordedOutcomes: readRecordedOutcomes(markerA),
      alreadyNudged: false,
    });
    assert.equal(recovered.nudge, false, "must not re-fire on a run that now has a verdict");
    console.log(
      `a run that recorded a verdict  -> no nudge (${(recovered as { skipped: string }).skipped})`,
    );

    const escalated = decideVerdictNudge({
      verdictRole: true,
      ticketId: TICKET_ID,
      finalIteration: true,
      recordedOutcomes: ["devpilot_request_human"],
      alreadyNudged: false,
    });
    assert.equal((escalated as { skipped: string }).skipped, "outcome-recorded");
    console.log(`a run that escalated to a human -> no nudge (outcome-recorded)`);

    const producer = decideVerdictNudge({
      verdictRole: false,
      ticketId: TICKET_ID,
      finalIteration: true,
      recordedOutcomes: [],
      alreadyNudged: false,
    });
    assert.equal((producer as { skipped: string }).skipped, "not-verdict-role");
    console.log(`an engineer / PM / designer     -> no nudge (not-verdict-role)`);

    const second = decideVerdictNudge({
      verdictRole: true,
      ticketId: TICKET_ID,
      finalIteration: true,
      recordedOutcomes: [],
      alreadyNudged: true,
    });
    assert.equal((second as { skipped: string }).skipped, "nudge-already-spent");
    console.log(`a second evaluation in one step -> no nudge (nudge-already-spent)`);

    // The ignored-nudge end state, which is the input the reconciler acts on.
    const ignored = outcomeMarkerPathFor("run-ignored", base);
    removeOutcomeMarker(ignored);
    assert.deepEqual(
      readRecordedOutcomes(ignored),
      [],
      "an ignored nudge must leave NO recorded outcome",
    );
    console.log(
      `an IGNORED nudge leaves the marker empty -> the run reports no verdict, and\n` +
        `  decideTicketReconciliation still parks the ticket 'blocked' unchanged\n` +
        `  (proved in apps/web: lib/engine/__tests__/reconcile-policy.test.ts)`,
    );

    banner("ACCEPTED — the verdictless seam reaches the reviewer while it can still act");
  } catch (err) {
    failed = true;
    console.error(`\n✗ ACCEPTANCE FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    engine.close();
    if (!failed || process.env.KEEP_WORKSPACE !== "1") {
      await fs.rm(base, { recursive: true, force: true });
    } else {
      console.error(`marker dir kept for inspection: ${base}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

await main();
