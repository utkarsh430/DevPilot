// One-off ticket prune for a single project.
//
// Lists every ticket in `--project=<id>` and deletes every row EXCEPT those
// whose id is in `--keep=<id1>,<id2>,…`. Cascades wipe comments, runs (and
// their run_steps), dispatch_queue rows, and ticket_dependencies via the FK
// constraints in supabase/migrations/20260601000000_core.sql + siblings.
//
// `pending_pushes.ticket_id` is ON DELETE SET NULL — those rows survive but
// lose their ticket linkage. `--also-drop-pushes` deletes the project's
// pending_pushes for the doomed tickets in the same run so /changes is clean.
//
// Per-ticket workspaces on the runner host (~/.devpilot/workspaces/<ticketId>/)
// are NOT touched — the runner's reaper keys off ticket status and a ticket
// row that no longer exists falls outside its query. Either `rm -rf` them
// manually or wait for them to age out of their parent disk.
//
// Run (dry-run, lists what would be deleted):
//   cd apps/web
//   node --env-file=.env.local scripts/scratch-repo-prune-tickets.mjs \
//     --project=8794f295-8f1f-4e05-8895-05b016593b5b \
//     --keep=1b34d698-ad2e-420e-8344-99f62e3ba9a7
//
// Run (executes the deletes — destructive, no undo):
//   add `--confirm` (and optionally `--also-drop-pushes`)
//
// Exit codes:
//   0 = success (dry-run report OR confirmed deletes)
//   1 = nothing matched / inputs invalid
//   2 = env missing
//   3 = a DELETE returned non-2xx (partial state possible — investigate)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SECRET) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY — exit 2");
  process.exit(2);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const projectId = args.project;
const keepIds = (args.keep ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const confirm = args.confirm === "true";
const alsoDropPushes = args["also-drop-pushes"] === "true";

if (!projectId) {
  console.error(
    "usage: --project=<uuid> --keep=<uuid>[,<uuid>...] [--confirm] [--also-drop-pushes]",
  );
  process.exit(1);
}

function rest(path, init = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      Prefer: init.method === "DELETE" ? "return=representation" : "return=representation",
      ...(init.headers ?? {}),
    },
  });
}

const ticketsRes = await rest(
  `tickets?project_id=eq.${projectId}&select=id,title,status,updated_at&order=updated_at.desc`,
);
if (!ticketsRes.ok) {
  console.error(`tickets fetch ${ticketsRes.status} — exit 3`);
  process.exit(3);
}
const tickets = await ticketsRes.json();

const keepSet = new Set(keepIds);
const doomed = tickets.filter((t) => !keepSet.has(t.id));
const kept = tickets.filter((t) => keepSet.has(t.id));

console.log(`\nProject ${projectId}: ${tickets.length} ticket(s) total\n`);
console.log(`KEEPING (${kept.length}):`);
for (const t of kept) {
  console.log(`  ${t.id.slice(0, 8)} ${t.status.padEnd(15)} ${t.title.slice(0, 70)}`);
}
console.log(`\nDELETING (${doomed.length}):`);
for (const t of doomed) {
  console.log(`  ${t.id.slice(0, 8)} ${t.status.padEnd(15)} ${t.title.slice(0, 70)}`);
}

if (!confirm) {
  console.log("\n(dry-run — re-run with --confirm to execute)");
  process.exit(0);
}

if (doomed.length === 0) {
  console.log("\nnothing to delete");
  process.exit(0);
}

console.log("\n--- executing deletes ---");

// Optional: drop pending_pushes for the doomed tickets first so /changes is
// clean. Done before the ticket delete so we don't have to query by NULL
// ticket_id later.
if (alsoDropPushes) {
  const doomedIdList = doomed.map((t) => t.id).join(",");
  const pushesRes = await rest(`pending_pushes?ticket_id=in.(${doomedIdList})`, {
    method: "DELETE",
  });
  if (!pushesRes.ok) {
    console.error(`pending_pushes delete ${pushesRes.status} — exit 3`);
    process.exit(3);
  }
  const removed = await pushesRes.json();
  console.log(`  pending_pushes: deleted ${removed.length}`);
}

// Tickets next. We DELETE one row at a time so a partial failure stops the
// loop with a useful error rather than burying it inside a bulk response.
let deleted = 0;
for (const t of doomed) {
  const res = await rest(`tickets?id=eq.${t.id}`, { method: "DELETE" });
  if (!res.ok) {
    console.error(`  tickets ${t.id.slice(0, 8)} delete ${res.status} — exit 3`);
    process.exit(3);
  }
  const out = await res.json();
  if (out.length === 0) {
    console.error(`  tickets ${t.id.slice(0, 8)} not found (race?) — exit 3`);
    process.exit(3);
  }
  deleted += 1;
  console.log(`  tickets ${t.id.slice(0, 8)} deleted`);
}

console.log(
  `\n${deleted} ticket(s) deleted. Cascades wiped comments, runs, dispatch_queue, ticket_dependencies.`,
);
if (!alsoDropPushes) {
  console.log(
    "pending_pushes for those tickets are now orphaned (ticket_id = NULL); they still appear in /changes scoped by project.",
  );
}
console.log(
  "Per-ticket workspaces on disk are untouched — `rm -rf ~/.devpilot/workspaces/<ticketId>` if you want them gone.",
);
