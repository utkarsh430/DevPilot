// Phase 2.5++ / Slice C — Open-in-VS-Code + auto-stash + file-watcher sync.
//
// What this proves
// ────────────────
// 1. Schema: dev_server_sessions has workspace_head_sha,
//    workspace_dirty_file_count, workspace_dirty_at after migration
//    20260606010000.
// 2. The runner→engine system-comment route writes a `system`-authored
//    comment on a ticket. This is the bridge the runner's auto-stash path
//    uses to drop a recovery hint on the timeline.
// 3. The heartbeat route accepts + persists the new workspaceHeadSha and
//    workspaceDirtyFileCount fields. We simulate a runner heartbeat with
//    the two new fields and assert they land on the row.
//
// What is NOT proved here (manual verification only)
// ───────────────────────────────────────────────────
//   • The "Open in VS Code" buttons in the Live tab, RunPanel, and
//     TicketDrawer launch VS Code via the vscode:// scheme. The server
//     action's path resolution is typechecked but not exercised here.
//   • The auto-stash path in workspace.ts that runs before `git reset
//     --hard HEAD`. Needs a real workspace + runner job. Validate by:
//       (a) Create a ticket, run engineer once so a commit lands.
//       (b) `echo "hello" >> ~/.devpilot/workspaces/<ticketId>/README.md`
//       (c) Re-dispatch the ticket. Assert: `git stash list` in the
//           workspace shows `devpilot-operator-edits-…`; a `system` comment
//           with the recovery hint appears on the ticket.
//   • The file-watcher heartbeat from the runner's dev-server-loop. Needs
//     a running dev server. Validate by starting `Run on localhost`,
//     then `touch <workspace>/foo.txt` and watching the panel show an
//     "1 uncommitted edit" badge within ~3-5s.
//
// Pre-reqs:
//   • NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY in env.
//   • Next.js dev :3000 (for the routes).
//   • DEVPILOT_RUNNER_REGISTRATION_KEY in env.
//   • Migrations 20260606000000 + 20260606010000 applied.
//
// Run:
//   cd apps/web
//   node --env-file=.env.local scripts/phase2-5-vscode-and-sync-accept.mjs

import "./_legacy-env.mjs"; // legacy ACE_* env aliases (transitional)
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const RUNNER_KEY = process.env.DEVPILOT_RUNNER_REGISTRATION_KEY;
const ENGINE_URL = process.env.LOCAL_CC_ENGINE_URL ?? "http://localhost:3000";
const TENANT_ID = process.env.DEVPILOT_TEST_TENANT_ID ?? "e98507ec-d5a2-4951-8a5d-445c86dbfca8";

if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY — exit 2");
  process.exit(2);
}
if (!RUNNER_KEY) {
  console.error("missing DEVPILOT_RUNNER_REGISTRATION_KEY — exit 2");
  process.exit(2);
}

const sb = (path, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function seedProject(name) {
  const id = randomUUID();
  const r = await sb("projects", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      name,
      description: "Slice C acceptance fixture — safe to delete.",
      default_branch: "main",
    }),
  });
  if (!r.ok) throw new Error(`seed project failed: ${r.status} ${await r.text()}`);
  return id;
}

async function seedTicket(projectId) {
  const id = randomUUID();
  const r = await sb("tickets", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      project_id: projectId,
      title: "Slice C — vscode + sync smoke",
      description: "Acceptance fixture — safe to delete.",
      status: "in_progress",
      priority: 3,
    }),
  });
  if (!r.ok) throw new Error(`seed ticket failed: ${r.status} ${await r.text()}`);
  return id;
}

async function seedDevServerSession(projectId) {
  const id = randomUUID();
  const r = await sb("dev_server_sessions", {
    method: "POST",
    body: JSON.stringify({
      id,
      tenant_id: TENANT_ID,
      project_id: projectId,
      workspace_path: `/tmp/fake-workspace/${id}`,
      branch: "devpilot/slice-c-smoke",
      command: "pnpm dev",
      status: "running",
    }),
  });
  if (!r.ok) throw new Error(`seed dev_server failed: ${r.status} ${await r.text()}`);
  return id;
}

async function cleanup({ projectIds, ticketIds, sessionIds }) {
  for (const id of sessionIds) {
    await sb(`dev_server_sessions?id=eq.${id}`, { method: "DELETE" });
  }
  for (const id of ticketIds) {
    await sb(`comments?ticket_id=eq.${id}`, { method: "DELETE" });
    await sb(`tickets?id=eq.${id}`, { method: "DELETE" });
  }
  for (const id of projectIds) {
    await sb(`projects?id=eq.${id}`, { method: "DELETE" });
  }
}

(async () => {
  console.log("=== Slice C — Open-in-VS-Code + sync acceptance ===\n");
  const projectIds = [];
  const ticketIds = [];
  const sessionIds = [];

  try {
    // ── Test 1: schema columns exist ─────────────────────────────────────
    console.log("--- Test 1: dev_server_sessions has 3 new columns ---");
    // PostgREST returns a column-missing error if the column doesn't exist
    // in the table; we attempt a tiny PATCH on a no-op row to surface that.
    // A simpler approach: just SELECT the columns — PostgREST 400s on
    // unknown columns.
    const probe = await sb(
      `dev_server_sessions?select=id,workspace_head_sha,workspace_dirty_file_count,workspace_dirty_at&limit=1`,
    );
    if (!probe.ok) {
      throw new Error(
        `column probe failed: ${probe.status} ${await probe.text()} — apply migration 20260606010000 first`,
      );
    }
    console.log("  ✓ workspace_head_sha / workspace_dirty_file_count / workspace_dirty_at exist");

    // ── Test 2: system-comment route writes a comment ────────────────────
    console.log("\n--- Test 2: system-comment route ---");
    const proj = await seedProject("slice-c-accept");
    projectIds.push(proj);
    const ticket = await seedTicket(proj);
    ticketIds.push(ticket);
    const sc = await fetch(`${ENGINE_URL}/api/runners/tools/system-comment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-devpilot-runner-key": RUNNER_KEY,
      },
      body: JSON.stringify({
        ticketId: ticket,
        body: "auto-stash recovery hint: git stash apply",
      }),
    });
    if (!sc.ok) throw new Error(`system-comment failed: ${sc.status} ${await sc.text()}`);
    const sj = await sc.json();
    assert(sj.ok === true, `expected ok:true, got ${JSON.stringify(sj)}`);
    const cRes = await sb(
      `comments?ticket_id=eq.${ticket}&author_type=eq.system&author_id=eq.devpilot_runner&select=body`,
    );
    const cRows = await cRes.json();
    assert(cRows.length === 1, `expected exactly 1 system comment, got ${cRows.length}`);
    assert(
      cRows[0].body.includes("git stash"),
      `expected body to mention git stash, got ${cRows[0].body}`,
    );
    console.log("  ✓ system-comment route landed a system-authored row");

    // ── Test 3: heartbeat route accepts new fields ───────────────────────
    console.log("\n--- Test 3: dev-server heartbeat persists new fields ---");
    const session = await seedDevServerSession(proj);
    sessionIds.push(session);
    const hbRes = await fetch(`${ENGINE_URL}/api/runners/dev-servers/${session}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-devpilot-runner-key": RUNNER_KEY,
      },
      body: JSON.stringify({
        status: "running",
        port: 3100,
        url: "http://localhost:3100",
        pid: 12345,
        logTail: "Compiled successfully\n",
        workspaceHeadSha: "abc1234",
        workspaceDirtyFileCount: 2,
      }),
    });
    if (!hbRes.ok) {
      throw new Error(`heartbeat failed: ${hbRes.status} ${await hbRes.text()}`);
    }
    const sRow = await sb(
      `dev_server_sessions?id=eq.${session}&select=workspace_head_sha,workspace_dirty_file_count,workspace_dirty_at`,
    );
    const sJson = await sRow.json();
    assert(
      sJson[0]?.workspace_head_sha === "abc1234",
      `expected SHA=abc1234, got ${sJson[0]?.workspace_head_sha}`,
    );
    assert(
      sJson[0]?.workspace_dirty_file_count === 2,
      `expected dirty=2, got ${sJson[0]?.workspace_dirty_file_count}`,
    );
    assert(
      typeof sJson[0]?.workspace_dirty_at === "string",
      `expected workspace_dirty_at timestamp, got ${sJson[0]?.workspace_dirty_at}`,
    );
    console.log("  ✓ heartbeat persisted workspace_head_sha + dirty_file_count + dirty_at");

    console.log("\n=== Slice C acceptance PASS ===");
    console.log("\nNote: auto-stash + Open-in-VS-Code button + dirty-pill UI require");
    console.log("manual verification — see the script's 'NOT proved here' header.");
    process.exit(0);
  } catch (err) {
    console.error(`\n✗ Slice C acceptance FAIL: ${err.message}`);
    process.exit(1);
  } finally {
    await cleanup({ projectIds, ticketIds, sessionIds });
  }
})();
