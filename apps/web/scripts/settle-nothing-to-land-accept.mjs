// Exercises migration `20260750000000` against a REAL Postgres, with controls.
//
//   node --env-file=.env.local scripts/settle-nothing-to-land-accept.mjs
//
// The unit tests pin the RULE (`lib/integration/nothing-to-land-settle.ts`) and
// a source scan binds the SQL's clause list to it — but neither runs the SQL,
// and the SQL is the half that touches production. This does: it seeds the one
// row the migration is for, plus a control for every clause, applies the
// migration, and asserts exactly one row moved and every control survived
// UNSETTLED (i.e. still counted by the `pushed_at IS NULL` badge query).
//
// Everything runs inside a transaction that is ALWAYS rolled back, so it is
// safe against any database — including, if someone points DATABASE_URL there,
// production. It never commits.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  here,
  "../../../supabase/migrations/20260750000000_settle_nothing_to_land_pending_pushes.sql",
);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing — pass it via --env-file=.env.local");
  process.exit(2);
}

const sql = readFileSync(MIGRATION, "utf8");
// SSL is left to the connection string's own `sslmode`, so this script never
// weakens verification for whatever database it is pointed at.
const client = new Client({ connectionString: url });

const failures = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${actual}`}`,
  );
  if (!ok) failures.push(label);
}

const T = "aaaaaaaa-0000-4000-8000-000000000001"; // our tenant
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002"; // a foreign tenant

await client.connect();
await client.query("begin");
try {
  // ── fixtures ────────────────────────────────────────────────────────────
  // Two tenants, each with a project. Seeded with explicit ids so every
  // assertion below names the exact row it is about.
  await client.query(
    `insert into public.tenants (id, name) values ($1,'accept-ours'), ($2,'accept-foreign')`,
    [T, OTHER],
  );
  const proj = async (id, tenant) => {
    await client.query(
      `insert into public.projects (id, tenant_id, name) values ($1,$2,'accept')`,
      [id, tenant],
    );
    return id;
  };
  const P = await proj("cccccccc-0000-4000-8000-000000000001", T);
  const PF = await proj("cccccccc-0000-4000-8000-000000000002", OTHER);

  const VERDICT =
    "nothing to land: the branch carried no commits the integration branch lacked, so " +
    "GitHub refused the pull request (422). Recorded as a failure before DevPilot detected " +
    "this case locally; repaired by migration 20260745000000. No pull request was opened " +
    "and nothing was merged.";

  /** A ticket + its unsettled push row, and optionally a queue row. */
  async function seed(key, { tenant = T, project = P, status, landedSha = null, queue = null }) {
    const tid = `dddddddd-0000-4000-8000-${key.padStart(12, "0")}`;
    const pid = `eeeeeeee-0000-4000-8000-${key.padStart(12, "0")}`;
    await client.query(
      // `chk_tickets_landed_pair` enforces landed_sha IS NULL <=> integrated_at
      // IS NULL, so the two always move together — as they do in production,
      // where the target ticket carries neither.
      `insert into public.tickets (id, tenant_id, project_id, title, status, landed_sha, integrated_at)
       values ($1,$2,$3,$4,$5::ticket_status,$6,$7)`,
      [
        tid,
        tenant,
        project,
        `accept ${key}`,
        status,
        landedSha,
        landedSha ? "2026-07-13T01:54:35Z" : null,
      ],
    );
    await client.query(
      `insert into public.pending_pushes
         (id, tenant_id, project_id, ticket_id, workspace_path, branch, unpushed_count, pushed_at)
       values ($1,$2,$3,$4,'/tmp/ws','devpilot/accept-'||$5,8,null)`,
      [pid, tenant, project, tid, key],
    );
    if (queue) {
      await client.query(
        `insert into public.integration_queue
           (tenant_id, project_id, ticket_id, status, attempts, pr_number, merge_sha, last_error, updated_at)
         values ($1,$2,$3,$4,3,$5,$6,$7,'2026-07-20T05:28:47Z')`,
        [
          tenant,
          project,
          tid,
          queue.status,
          queue.prNumber ?? null,
          queue.mergeSha ?? null,
          queue.lastError,
        ],
      );
    }
    return { ticketId: tid, pushId: pid };
  }

  // THE ROW THIS MIGRATION IS FOR: DevPilot-7's shape exactly.
  const target = await seed("1", {
    status: "done",
    landedSha: null,
    queue: { status: "cancelled", lastError: VERDICT },
  });

  // CONTROLS — one per clause. Each is the target with a single fact changed.
  const cBackfill = await seed("2", {
    status: "done",
    landedSha: "backfill", // out of scope: a guess, not evidence
    queue: { status: "cancelled", lastError: VERDICT },
  });
  const cLanded = await seed("3", {
    status: "done",
    landedSha: "c9213591b0", // #156's population, not ours
    queue: { status: "cancelled", lastError: VERDICT },
  });
  const cWorking = await seed("4", {
    status: "input_required", // may hold real commits that reached no remote
    queue: { status: "cancelled", lastError: VERDICT },
  });
  const cNoVerdict = await seed("5", {
    status: "done",
    queue: { status: "failed", lastError: "GitHub 422 on /repos/o/r/pulls: Validation Failed" },
  });
  const cHasPr = await seed("6", {
    status: "done",
    queue: { status: "cancelled", lastError: VERDICT, prNumber: 41 },
  });
  const cNoQueue = await seed("7", { status: "done" }); // no adjudication at all
  // THE DANGEROUS LOOKALIKE. `land-policy` cancels with its OWN wording when it
  // could not resolve a branch at all — a real production shape, `cancelled`
  // like the target but meaning the opposite: nothing was pushed because there
  // was nothing to push FROM. Only the `nothing to land: ` prefix separates the
  // two, so without this control that clause is never exercised.
  const cPolicyCancel = await seed("b", {
    status: "done",
    queue: { status: "cancelled", lastError: "ticket has no branch with work to land" },
  });
  const cInFlight = await seed("8", {
    status: "done",
    queue: { status: "cancelled", lastError: VERDICT },
  });
  await client.query(
    `insert into public.integration_queue (tenant_id, project_id, ticket_id, status)
     values ($1,$2,$3,'pending')`,
    [T, P, cInFlight.ticketId],
  );
  // Ambiguity: a second unsettled push row on an otherwise-qualifying ticket.
  const cAmbiguous = await seed("9", {
    status: "done",
    queue: { status: "cancelled", lastError: VERDICT },
  });
  await client.query(
    `insert into public.pending_pushes
       (tenant_id, project_id, ticket_id, workspace_path, branch, pushed_at)
     values ($1,$2,$3,'/tmp/ws2','devpilot/accept-9-second',null)`,
    [T, P, cAmbiguous.ticketId],
  );
  // A ticket-less row.
  const { rows: ticketless } = await client.query(
    `insert into public.pending_pushes
       (tenant_id, project_id, ticket_id, workspace_path, branch, pushed_at)
     values ($1,$2,null,'/tmp/ws3','devpilot/accept-ticketless',null) returning id`,
    [T, P],
  );
  // A qualifying ticket that ALSO carries an already-settled push row. The
  // ambiguity guard counts only UNSETTLED siblings, so this must still settle —
  // without it, that clause could be dropped with every check still green.
  const cSettledSibling = await seed("c", {
    status: "done",
    queue: { status: "cancelled", lastError: VERDICT },
  });
  await client.query(
    `insert into public.pending_pushes
       (tenant_id, project_id, ticket_id, workspace_path, branch, pushed_at)
     values ($1,$2,$3,'/tmp/ws4','devpilot/accept-c-earlier','2026-07-01T00:00:00Z')`,
    [T, P, cSettledSibling.ticketId],
  );

  // A foreign tenant's row that qualifies ON ITS OWN TERMS. It must be settled
  // by its OWN justification, never by ours — and must be untouched when the
  // predicate is later neutered in the opposite direction.
  const cForeign = await seed("a", {
    tenant: OTHER,
    project: PF,
    status: "done",
    queue: { status: "cancelled", lastError: VERDICT },
  });

  const unsettled = async (id) =>
    (await client.query(`select pushed_at from public.pending_pushes where id=$1`, [id])).rows[0]
      .pushed_at === null;

  // ── apply ───────────────────────────────────────────────────────────────
  console.log("\napplying 20260750000000…");
  await client.query(sql);

  console.log("\nthe target row moved:");
  check("DevPilot-7-shaped row is settled", await unsettled(target.pushId), false);
  const stamped = (
    await client.query(`select pushed_at from public.pending_pushes where id=$1`, [target.pushId])
  ).rows[0].pushed_at;
  check(
    "stamped with the queue row's adjudication time, not now()",
    new Date(stamped).toISOString(),
    "2026-07-20T05:28:47.000Z",
  );

  console.log("\ncontrols — every one still UNSETTLED, i.e. still on the badge:");
  check("landed_sha='backfill' (a guess is not evidence)", await unsettled(cBackfill.pushId), true);
  check("landed_sha present (#156's population)", await unsettled(cLanded.pushId), true);
  check("ticket not done (may hold real commits)", await unsettled(cWorking.pushId), true);
  check("unrepaired failed row (no adjudication)", await unsettled(cNoVerdict.pushId), true);
  check("a pull request was opened", await unsettled(cHasPr.pushId), true);
  check("no queue row at all", await unsettled(cNoQueue.pushId), true);
  check("a land is still in flight", await unsettled(cInFlight.pushId), true);
  check("two unsettled pushes on one ticket", await unsettled(cAmbiguous.pushId), true);
  check("ticket-less row", await unsettled(ticketless[0].id), true);
  check(
    "land-policy's own cancel — no branch was ever resolved, so nothing was pushed",
    await unsettled(cPolicyCancel.pushId),
    true,
  );

  console.log("\nand the guards do not over-refuse:");
  check(
    "a qualifying ticket with an already-settled sibling push still settles",
    await unsettled(cSettledSibling.pushId),
    false,
  );

  console.log("\ntenant scope:");
  // The foreign row qualifies on its own terms, so it IS settled — proving the
  // migration is not tenant-blind in the useless direction (refusing everyone).
  // It qualifies on its OWN terms, so it settles — which proves the migration
  // is not tenant-blind in the useless direction (refusing everyone).
  check(
    "a foreign tenant's own qualifying row settles on its own evidence",
    await unsettled(cForeign.pushId),
    false,
  );

  // CONTROL for the join itself: `assert_tenant_matches_parent` refuses to
  // WRITE a cross-tenant pair at all, so the dangerous shape (our push row
  // justified by a foreign ticket) cannot be constructed to test directly —
  // exactly as #749 found. Assert that refusal instead; it is the independent
  // guard standing behind the join clause.
  let refused = false;
  await client.query("savepoint xt");
  try {
    await client.query(
      `insert into public.pending_pushes
         (tenant_id, project_id, ticket_id, workspace_path, branch, pushed_at)
       values ($1,$2,$3,'/tmp/x','devpilot/cross-tenant',null)`,
      [T, P, cForeign.ticketId],
    );
  } catch {
    refused = true;
  }
  await client.query("rollback to savepoint xt");
  check("a cross-tenant push/ticket pair is unwritable", refused, true);

  console.log("\ntotals:");
  const remaining = (
    await client.query(
      `select count(*)::int n from public.pending_pushes
        where pushed_at is null and tenant_id = any($1::uuid[])`,
      [[T, OTHER]],
    )
  ).rows[0].n;
  // Scoped to this script's own fixtures, so it is a statement about what the
  // migration did rather than about whatever else the target database holds.
  check("exactly the 11 unproven fixture rows remain unsettled", remaining, 11);

  console.log("\nidempotency — re-applying moves nothing:");
  await client.query(sql);
  const after = (
    await client.query(
      `select count(*)::int n from public.pending_pushes
        where pushed_at is null and tenant_id = any($1::uuid[])`,
      [[T, OTHER]],
    )
  ).rows[0].n;
  check("still 11 after a second apply", after, 11);
} finally {
  await client.query("rollback");
  await client.end().catch(() => {});
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nall checks passed (transaction rolled back; nothing persisted)");
