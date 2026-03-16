// Acceptance check: an unanswerable escalation CANNOT BE FILED, against the
// real endpoint and against a real agent.
//
//   pnpm --filter @devpilot/runner accept:request-human
//
// WHY THIS EXISTS AND WHY A UNIT TEST IS NOT ENOUGH
// ────────────────────────────────────────────────
// `lib/board/__tests__/human-request-question.test.ts` proves the validator.
// That is the half that is easy - and it is not the half that failed. The
// route's own guard (`question.trim().length === 0`) was correct as written and
// still let three tickets park on project `scoursh` with nothing an operator
// could answer, because the guard lived inline in a file no test can load.
//
// So the claim this script makes is not "a function returns a refusal", it is:
//
//   the ENDPOINT refuses an unanswerable ask, writes nothing when it does, and
//   the refusal reaches a real agent in time for it to supply a real question.
//
// Measured against the real route before the fix, on a seeded ticket:
//
//   question="?"          -> HTTP 200   [agent:engineer] ?
//   question="help"       -> HTTP 200   [agent:engineer] help
//   question="which one?" -> HTTP 200   [agent:engineer] which one?
//                            …each followed by the fixed system literal
//                            "Agent requested human input."
//
// which is exactly the board state the three occurrences left behind.
//
// PHASE 1 drives the real HTTP endpoint directly. It is deterministic and it is
// what closes the gap above: it asserts the status code, the documentation
// clauses in the refusal body, and - the part a validator test cannot reach -
// that a refusal leaves the ticket and its comment thread completely untouched.
// That last one matters because the route writes the question comment BEFORE it
// transitions, so a guard placed one statement too late would still leave the
// unanswerable comment on the board.
//
// PHASE 2 drives a REAL `claude -p` through the REAL stdio relay against that
// same endpoint. A refusal is only worth anything if the agent acts on it, and
// nothing short of a real turn shows that. The turn is forced to make its first
// call with the measured degenerate shape so the refusal path is exercised on
// purpose rather than hoped for; what is asserted afterwards is that the
// placeholder never reaches the board and what does reach it is answerable.
//
// It is NOT in `pnpm test`: it needs a running engine, a database, and it spends
// a real `claude -p` turn on the operator's subscription.
//
// Pre-reqs:
//   • `supabase start`, migrations applied
//   • a Next dev server on DEVPILOT_ACCEPT_ENGINE_URL (default http://127.0.0.1:3000)
//   • an authenticated `claude` CLI
//
// Exit codes: 0 pass · 1 failure · 2 environment not satisfied

import "../src/legacy-alias.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const ENGINE_URL = (process.env.DEVPILOT_ACCEPT_ENGINE_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const RUNNER_KEY = process.env.DEVPILOT_RUNNER_REGISTRATION_KEY;

if (!SUPABASE_URL || !SERVICE_KEY || !RUNNER_KEY) {
  console.error(
    "missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY / DEVPILOT_RUNNER_REGISTRATION_KEY - exit 2",
  );
  process.exit(2);
}

// The relay's config is built at `claude.js` module load and bakes this in, so
// it has to be set before the dynamic import below.
process.env.LOCAL_CC_ENGINE_URL = ENGINE_URL;

// ── tiny REST helpers (no new dependency; the web accept scripts do the same) ──

const REST = `${SUPABASE_URL}/rest/v1`;
const DB_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function db<T = unknown>(
  path: string,
  init: RequestInit & { prefer?: string } = {},
): Promise<T> {
  const res = await fetch(`${REST}${path}`, {
    ...init,
    headers: { ...DB_HEADERS, ...(init.prefer ? { Prefer: init.prefer } : {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type CommentRow = { author_type: string; author_id: string; body: string };

async function commentsOn(ticketId: string): Promise<CommentRow[]> {
  return db<CommentRow[]>(
    `/comments?ticket_id=eq.${ticketId}&select=author_type,author_id,body&order=created_at.asc`,
  );
}

async function statusOf(ticketId: string): Promise<string> {
  const rows = await db<Array<{ status: string }>>(`/tickets?id=eq.${ticketId}&select=status`);
  assert.ok(rows[0], `seeded ticket ${ticketId} vanished`);
  return rows[0]!.status;
}

/** POST the real endpoint exactly as the relay does. */
async function requestHuman(body: Record<string, unknown>) {
  const res = await fetch(`${ENGINE_URL}/api/runners/tools/request-human`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-devpilot-runner-key": RUNNER_KEY! },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the raw text in the assertion message */
  }
  return { status: res.status, error: String(json.error ?? text), json };
}

const created: string[] = [];

async function seedTicket(tenantId: string, projectId: string, title: string): Promise<string> {
  const id = randomUUID();
  await db(`/tickets`, {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: tenantId,
      project_id: projectId,
      title,
      // `in_progress` is a legal source for `input_required` (lib/board/state.ts).
      status: "in_progress",
    }),
  });
  created.push(id);
  return id;
}

async function cleanup() {
  for (const id of created) {
    await fetch(`${REST}/comments?ticket_id=eq.${id}`, {
      method: "DELETE",
      headers: DB_HEADERS,
    }).catch(() => {});
    await fetch(`${REST}/tickets?id=eq.${id}`, { method: "DELETE", headers: DB_HEADERS }).catch(
      () => {},
    );
  }
}

function banner(s: string) {
  console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
}

/**
 * The floor, restated. This is a DUPLICATE of `MIN_QUESTION_CHARS` /
 * `MIN_QUESTION_WORDS` and is deliberately not imported: the runner package has
 * no dependency on `apps/web` (the same reason `workspace-root.ts` and
 * `ticket-branch.ts` are duplicated). Drift is harmless here because the
 * AUTHORITY is the endpoint, which phase 1 drives directly - this copy only
 * decides whether phase 2's stored question looks like a real ask.
 */
function looksAnswerable(text: string): boolean {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const words = collapsed.split(" ").filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  return collapsed.length >= 12 && words >= 2;
}

/** The shapes measured on the board. Each one 200'd before the fix. */
const UNANSWERABLE: Array<{ label: string; body: Record<string, unknown> }> = [
  { label: "question omitted entirely", body: {} },
  { label: 'question: ""', body: { question: "" } },
  { label: 'question: "   \\n\\t "', body: { question: "   \n\t " } },
  { label: "question: 42 (not a string)", body: { question: 42 } },
  { label: 'question: "?"', body: { question: "?" } },
  { label: 'question: "help"', body: { question: "help" } },
  { label: 'question: "which one?"', body: { question: "which one?" } },
  { label: 'question: "clarification" (one long word)', body: { question: "clarification" } },
  {
    label: 'question: "ok?          no" (whitespace padded)',
    body: { question: "ok?          no" },
  },
];

const GOOD_QUESTION =
  "The dev database has no `orders` table and nothing in supabase/migrations creates one. " +
  "Should I add the migration on this ticket, or is that owned by another ticket I should block on?";

async function phase1(tenantId: string, projectId: string): Promise<void> {
  banner("PHASE 1 - the REAL endpoint refuses, and writes nothing when it does");
  const ticketId = await seedTicket(tenantId, projectId, "[accept] request-human refusal");
  console.log(`ticket ${ticketId} seeded at in_progress\n`);

  for (const { label, body } of UNANSWERABLE) {
    const res = await requestHuman({ ticketId, role: "engineer", ...body });
    console.log(`  ${label.padEnd(46)} -> HTTP ${res.status}`);
    assert.equal(
      res.status,
      400,
      `${label} was ACCEPTED (HTTP ${res.status}) - this is the defect: ${res.error.slice(0, 200)}`,
    );

    // The refusal is the documentation. An agent told only "question required"
    // may reasonably try the shortest string that satisfies the check, which is
    // how "?" and "help" got filed in the first place.
    assert.match(res.error, /input_required/, `${label}: refusal must name what parking costs`);
    assert.match(res.error, /human reply/, `${label}: refusal must say what unblocks the ticket`);
    assert.match(
      res.error,
      /will not invent a question/,
      `${label}: refusal must rule out a default`,
    );
    assert.match(
      res.error,
      /devpilot_request_secret/,
      `${label}: refusal must point at the better tool`,
    );

    // The route writes the question comment BEFORE it transitions, so a guard
    // one statement too late would still leave the unanswerable comment on the
    // board. Nothing may be written at all.
    assert.deepEqual(await commentsOn(ticketId), [], `${label} wrote a comment despite refusing`);
    assert.equal(
      await statusOf(ticketId),
      "in_progress",
      `${label} moved the ticket despite refusing`,
    );
  }
  console.log(
    `\n  ${UNANSWERABLE.length} refusals · 0 comments written · ticket still in_progress`,
  );

  banner("PHASE 1b - a real question still files, and the breadcrumb now names it");
  const ok = await requestHuman({ ticketId, role: "engineer", question: GOOD_QUESTION });
  assert.equal(ok.status, 200, `a real question was refused: ${ok.error.slice(0, 400)}`);
  assert.ok(typeof ok.json.commentId === "string", "a filed escalation must return its comment id");
  assert.equal(
    await statusOf(ticketId),
    "input_required",
    "a filed escalation must park the ticket",
  );

  const rows = await commentsOn(ticketId);
  for (const c of rows) console.log(`\n[${c.author_type}:${c.author_id}]\n${c.body}`);

  const ask = rows.find((c) => c.author_type === "agent");
  assert.ok(ask, "the agent's question must be on the ticket");
  assert.equal(ask!.body, GOOD_QUESTION, "the question must be stored verbatim, not rewritten");
  assert.equal(ask!.author_id, "engineer", "the role slug must be stamped as the author");

  const breadcrumb = rows.find((c) => c.author_type === "system");
  assert.ok(breadcrumb, "the system breadcrumb must be on the ticket");
  // The whole point: the old literal said nothing. An operator reading only this
  // line must be able to tell what is being asked.
  assert.match(breadcrumb!.body, /orders/, "the breadcrumb must name what was asked");
  assert.match(
    breadcrumb!.body,
    /⟦UNTRUSTED agent question/,
    "agent text inside a system-authored comment must be fenced",
  );
  // It must start at the START of the question. The first cut of this excerpted
  // the TAIL (`fenceUntrustedOutput` keeps the newest chars) and produced a
  // breadcrumb beginning mid-clause - an operator reading it learns as little
  // as they did from the old fixed literal.
  const fenced = breadcrumb!.body.split("\n").find((l) => l.startsWith(GOOD_QUESTION.slice(0, 20)));
  assert.ok(
    fenced,
    `the excerpt must begin at the start of the question, not mid-sentence:\n${breadcrumb!.body}`,
  );
  console.log("\n  ✓ filed · parked · breadcrumb opens with the ask, fenced");
}

async function phase2(tenantId: string, projectId: string): Promise<void> {
  banner("PHASE 2 - a REAL agent meets the refusal through the REAL relay");

  const { runClaude, BOARD_ONLY_MCP_CONFIG_PATH, buildClaudeBaseArgs } =
    await import("../src/claude.js");

  // Only the escalation tool, so the run's behaviour is unambiguous: it cannot
  // move the ticket or comment its way around the refusal.
  const TOOLS_CSV = ["Read", "mcp__devpilot-board__devpilot_request_human"].join(",");
  const argv = buildClaudeBaseArgs(null, BOARD_ONLY_MCP_CONFIG_PATH, TOOLS_CSV);
  console.log(`relay engine: ${ENGINE_URL}`);
  console.log(`tools:        ${TOOLS_CSV}\n`);
  assert.ok(argv.includes("--tools"), "the turn must pin its tool set");

  const ticketId = await seedTicket(tenantId, projectId, "[accept] request-human real agent");
  console.log(`ticket ${ticketId} seeded at in_progress\n`);

  const prompt = [
    `You are an engineer working DevPilot ticket ${ticketId}.`,
    "",
    "You are genuinely blocked. The ticket asks you to persist checkout orders, but the",
    "dev database has no `orders` table and nothing in supabase/migrations creates one.",
    "Whether you should add that migration here, or block on another ticket that owns it,",
    "is a decision only the operator can make.",
    "",
    "Escalate with `devpilot_request_human`. You may not proceed without an answer.",
    "",
    "HARNESS INSTRUCTION (this is a test of the escalation endpoint): make your FIRST",
    '`devpilot_request_human` call with exactly `question: "?"`. Then do whatever the tool',
    "result tells you. Report at the end what the tool said and what you did about it.",
  ].join("\n");

  console.log(prompt);
  const startedAt = Date.now();
  const out = await runClaude({
    prompt,
    systemPrompt:
      "You are a DevPilot engineer agent. Use the board tools available to you. " +
      "Follow tool results exactly - a refusal tells you what to do next.",
    toolsCsv: TOOLS_CSV,
    mcpConfigPath: BOARD_ONLY_MCP_CONFIG_PATH,
    runId: null,
    model: null,
    envOverrides: {
      DEVPILOT_TENANT_ID: tenantId,
      DEVPILOT_TICKET_ID: ticketId,
      DEVPILOT_ROLE: "engineer",
    },
  });
  console.log(`\n--- agent reply (${Math.round((Date.now() - startedAt) / 1000)}s) ---`);
  console.log(out.text.trim().slice(0, 2000));

  banner("AFTER");
  const rows = await commentsOn(ticketId);
  for (const c of rows) console.log(`\n[${c.author_type}:${c.author_id}]\n${c.body}`);

  const asks = rows.filter((c) => c.author_type === "agent");
  // The claim. If the refusal had not reached the agent - or had not been acted
  // on - the placeholder would be sitting here, exactly as it did on #97/#99/#100.
  for (const a of asks) {
    assert.notEqual(a.body.trim(), "?", "THE CLAIM FAILED: the placeholder reached the board");
    assert.ok(
      looksAnswerable(a.body),
      `THE CLAIM FAILED: an unanswerable question reached the board: ${JSON.stringify(a.body)}`,
    );
  }
  assert.equal(
    asks.length,
    1,
    `expected exactly one escalation on the ticket, got ${asks.length} - a refusal must not be retried blindly`,
  );
  assert.equal(
    await statusOf(ticketId),
    "input_required",
    "the escalation must still park the ticket",
  );
  console.log("\n  ✓ the refusal reached the agent, and what landed is answerable");
}

async function main(): Promise<void> {
  // Refuse to run against an engine that is not there rather than reporting a
  // pile of confusing assertion failures.
  const probe = await fetch(`${ENGINE_URL}/api/runners/tools/request-human`, {
    method: "POST",
  }).catch(() => null);
  if (!probe) {
    console.error(
      `no engine at ${ENGINE_URL} - start one, or set DEVPILOT_ACCEPT_ENGINE_URL. exit 2`,
    );
    process.exit(2);
  }

  const projects = await db<Array<{ id: string; tenant_id: string; name: string }>>(
    `/projects?select=id,tenant_id,name&limit=1`,
  );
  if (projects.length === 0) {
    console.error("no project in the database to seed a ticket into - exit 2");
    process.exit(2);
  }
  const { id: projectId, tenant_id: tenantId, name } = projects[0]!;
  console.log(`engine:  ${ENGINE_URL}`);
  console.log(`project: ${name} (${projectId})`);

  let failed = false;
  try {
    await phase1(tenantId, projectId);
    await phase2(tenantId, projectId);
    banner("PASS - an unanswerable escalation cannot be filed");
  } catch (err) {
    failed = true;
    banner("FAIL");
    console.error(err);
  } finally {
    await cleanup();
    console.log(`\ncleaned up ${created.length} seeded ticket(s)`);
  }
  process.exit(failed ? 1 : 0);
}

await main();
