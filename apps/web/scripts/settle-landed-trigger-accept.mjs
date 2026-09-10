// Exercises migration `20260757000000` against a REAL Postgres, with controls.
//
//   pnpm --filter @devpilot/web accept:settle-landed-trigger
//
// There is nothing to unit-test here on purpose: the whole point of the change
// is that the invariant lives in the DATABASE, so that no TypeScript caller —
// present, future, or absent altogether (a hand-typed UPDATE) — can bypass it.
// A TS twin of the rule would be a second thing that can disagree with the SQL,
// which is the drift this migration exists to end. So the SQL is proven by
// running it.
//
// Two halves, and the FIRST is not optional. It drops the trigger, performs the
// exact write that leaked in production, and asserts the leak REPRODUCES —
// without it the whole suite would pass against a database where the defect
// never existed. Only then is the migration applied and the same write asserted
// to settle.
//
// Everything runs inside a transaction that is ALWAYS rolled back and it never
// commits. POINT IT AT A LOCAL DATABASE ANYWAY, and that is a stronger caution
// than the sibling accept scripts carry: this one briefly DROPs and re-creates
// `trg_pending_pushes_ticket_id_tenant` (see `poisonedForeignPushOn`), which
// takes an ACCESS EXCLUSIVE lock on `pending_pushes` for the length of the
// transaction. Nothing is lost against production, but a live land worker would
// block on it.
//
//   DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
//     node scripts/settle-landed-trigger-accept.mjs
//
// The migration's own effect on production was verified separately, by applying
// it inside a rolled-back transaction and reading back the row list it would
// touch — which takes only the locks the real deploy takes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  here,
  "../../../supabase/migrations/20260757000000_settle_pending_pushes_on_landed.sql",
);

const url = process.env.DATABASE_URL;
if (!url) {
  // Deliberately NOT defaulted from `.env.local`, unlike the sibling accept
  // scripts: that file points at the cloud database, and this script takes a
  // DDL lock. Naming the local URL explicitly is the whole safeguard.
  console.error(
    "DATABASE_URL is missing. Point it at a LOCAL database (`supabase start`), e.g.\n" +
      "  DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \\\n" +
      "    pnpm --filter @devpilot/web accept:settle-landed-trigger",
  );
  process.exit(2);
}

// The migration wraps itself in `begin; … commit;`. Applying that verbatim
// would COMMIT this script's outer transaction and leave every fixture behind,
// turning the rollback in `finally` into a silent no-op. The top-level pair is
// therefore stripped; anchored to column 0 AND requiring the semicolon, so the
// bare `begin` keywords opening the plpgsql bodies survive untouched. The strip
// is not TRUSTED — `the migration did not commit our transaction` below asserts
// it, because a red run beats polluting whatever database this is pointed at.
const migrationSql = readFileSync(MIGRATION, "utf8").replace(/^(begin|commit);[ \t]*$/gm, "");
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

const SHA = "06e9a3961f2c4d5e6f708192a3b4c5d6e7f80912";
const LANDED_AT = "2026-08-03T20:11:00Z";
const EARLIER_PUSH = "2026-07-01T00:00:00Z";

await client.connect();
await client.query("begin");
try {
  // ── fixtures ────────────────────────────────────────────────────────────
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

  let seq = 0;
  const uid = (prefix) => `${prefix}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  /** A ticket, plus `pushes` push rows on it. */
  async function seed({ tenant = T, project = P, status = "done", landedSha = null, pushes = 1 }) {
    const tid = uid("dddddddd");
    await client.query(
      // `chk_tickets_landed_pair` enforces landed_sha IS NULL <=> integrated_at
      // IS NULL, so the two always move together — as they do everywhere the
      // application writes them.
      `insert into public.tickets (id, tenant_id, project_id, title, status, landed_sha, integrated_at)
       values ($1,$2,$3,$4,$5::ticket_status,$6,$7)`,
      [
        tid,
        tenant,
        project,
        `accept ${tid.slice(-4)}`,
        status,
        landedSha,
        landedSha ? LANDED_AT : null,
      ],
    );
    const pushIds = [];
    for (const p of pushes === 1 ? [{}] : pushes) {
      const pid = uid("eeeeeeee");
      await client.query(
        `insert into public.pending_pushes
           (id, tenant_id, project_id, ticket_id, workspace_path, branch, unpushed_count, pushed_at)
         values ($1,$2,$3,$4,'/tmp/ws','devpilot/accept-'||$5,42,$6)`,
        [pid, tenant, project, tid, pid.slice(-6), p.pushedAt ?? null],
      );
      pushIds.push(pid);
    }
    return { ticketId: tid, pushId: pushIds[0], pushIds };
  }

  const pushedAt = async (id) =>
    (await client.query(`select pushed_at from public.pending_pushes where id=$1`, [id])).rows[0]
      .pushed_at;
  const unsettled = async (id) => (await pushedAt(id)) === null;
  const iso = async (id) => new Date(await pushedAt(id)).toISOString();

  /**
   * A push row owned by ANOTHER tenant that points at one of OUR tickets.
   *
   * This is the shape both tenant predicates exist to refuse, and it cannot be
   * written normally — `assert_tenant_matches_parent` refuses it, which is
   * exactly why an accept script that only asserts that refusal leaves both
   * predicates untested (neuter either one and every check stays green). So the
   * guard is lifted for the length of one INSERT and restored immediately, and
   * the poisoned row then stands as a live control: it models a row already in
   * the table from before that trigger existed, which is precisely the case an
   * app-layer predicate is still needed for.
   */
  async function poisonedForeignPushOn(ticketId) {
    const { rows: def } = await client.query(
      `select pg_get_triggerdef(oid) def from pg_trigger
        where tgrelid = 'public.pending_pushes'::regclass
          and tgname = 'trg_pending_pushes_ticket_id_tenant'`,
    );
    if (def.length !== 1) throw new Error("expected exactly one ticket_id tenant guard to lift");
    await client.query(`drop trigger trg_pending_pushes_ticket_id_tenant on public.pending_pushes`);
    const pid = uid("eeeeeeee");
    await client.query(
      `insert into public.pending_pushes
         (id, tenant_id, project_id, ticket_id, workspace_path, branch, unpushed_count, pushed_at)
       values ($1,$2,$3,$4,'/tmp/ws','devpilot/accept-poisoned-'||$5,7,null)`,
      [pid, OTHER, PF, ticketId, pid.slice(-6)],
    );
    await client.query(def[0].def); // restored before anything else runs
    return pid;
  }

  /** The exact production write: record a landing directly on the ticket row. */
  const landDirectly = (ticketId, sha = SHA, at = LANDED_AT) =>
    client.query(`update public.tickets set landed_sha = $2, integrated_at = $3 where id = $1`, [
      ticketId,
      sha,
      sha === null ? null : at,
    ]);

  // ── HALF ONE: the leak reproduces without the trigger ────────────────────
  // A database that has already run this migration would otherwise make every
  // assertion below vacuous.
  console.log("\nbefore — a direct UPDATE leaks its push row:");
  await client.query(
    `drop trigger if exists tickets_settle_pending_pushes_on_landed on public.tickets`,
  );
  const before = await seed({ landedSha: null });
  await landDirectly(before.ticketId);
  check(
    "the push row is left unsettled (the measured defect)",
    await unsettled(before.pushId),
    true,
  );

  // ── fixtures for the REPAIR, seeded pre-migration ────────────────────────
  // The target: a landed ticket whose row never learned. Eleven of these exist
  // on `scoursh` right now.
  const rTarget = await seed({ landedSha: SHA });
  // THE CONTROL THAT MATTERS. A migration that settles everything looks
  // identical to a correct one on a healthy board; only a genuinely-unlanded
  // row surviving tells the two apart. This is DevPilot-97's shape.
  const rNotLanded = await seed({ status: "paused", landedSha: null });
  // …and its `done` twin, which is the one that isolates the `landed_sha`
  // clause. Without it the assertion above is satisfied by `status = 'done'`
  // alone, so both landed_sha clauses could be deleted with every check still
  // green. DevPilot-7's shape: review-only, finished, nothing to land.
  const rDoneUnlanded = await seed({ status: "done", landedSha: null });
  // A guess is not evidence — `20260715000000` §6's sentinel.
  const rBackfill = await seed({ landedSha: "backfill" });
  // Landed but not terminal: the repair's conservatism about historical rows.
  const rWorking = await seed({ status: "in_progress", landedSha: SHA });
  // Already settled: the CAS must not rewrite a genuine push timestamp.
  const rSettled = await seed({ landedSha: SHA, pushes: [{ pushedAt: EARLIER_PUSH }] });
  // Two unsettled rows on one landed ticket — DevPilot-77 / DevPilot-87's shape,
  // and what makes the measured count eleven rather than nine.
  const rTwo = await seed({ landedSha: SHA, pushes: [{}, {}] });
  // A foreign tenant's row that qualifies ON ITS OWN terms.
  const rForeign = await seed({ tenant: OTHER, project: PF, landedSha: SHA });
  // A foreign row hanging off OUR landed ticket — what the repair's
  // `p.tenant_id = t.tenant_id` clause is for.
  const rPoisoned = await poisonedForeignPushOn(rTarget.ticketId);
  // A ticket-less row proves nothing about where its commits are.
  const { rows: ticketless } = await client.query(
    `insert into public.pending_pushes
       (tenant_id, project_id, ticket_id, workspace_path, branch, pushed_at)
     values ($1,$2,null,'/tmp/ws','devpilot/accept-ticketless',null) returning id`,
    [T, P],
  );

  // ── apply ───────────────────────────────────────────────────────────────
  console.log("\napplying 20260757000000…");
  await client.query(migrationSql);
  const { rows: tx } = await client.query(
    `select transaction_timestamp() <> statement_timestamp() as in_tx`,
  );
  check("the migration did not commit our transaction", tx[0].in_tx, true);

  console.log("\nthe repair settles what it can prove:");
  check("a landed ticket's unsettled row settles", await unsettled(rTarget.pushId), false);
  check(
    "stamped with the ticket's integrated_at, not now()",
    await iso(rTarget.pushId),
    "2026-08-03T20:11:00.000Z",
  );
  check(
    "both rows of a landed ticket carrying two settle",
    await unsettled(rTwo.pushIds[0]),
    false,
  );
  check("…including the second", await unsettled(rTwo.pushIds[1]), false);
  check(
    "the row the pre-migration UPDATE leaked is repaired too",
    await unsettled(before.pushId),
    false,
  );
  check(
    "a foreign tenant's own qualifying row settles on its own evidence",
    await unsettled(rForeign.pushId),
    false,
  );

  console.log("\nand leaves everything it cannot — still on the badge:");
  check("a NOT-landed ticket's row is untouched", await unsettled(rNotLanded.pushId), true);
  check("…including a done one with nothing to land", await unsettled(rDoneUnlanded.pushId), true);
  check("landed_sha='backfill' settles nothing", await unsettled(rBackfill.pushId), true);
  check("a landed but non-terminal ticket's row", await unsettled(rWorking.pushId), true);
  check("a ticket-less row", await unsettled(ticketless[0].id), true);
  check(
    "an already-settled row keeps its original timestamp",
    await iso(rSettled.pushId),
    "2026-07-01T00:00:00.000Z",
  );
  check(
    "a foreign row hanging off our landed ticket (the tenant clause)",
    await unsettled(rPoisoned),
    true,
  );

  // Measured HERE, against the repair's own fixtures, rather than at the end of
  // the script: the trigger fixtures below deliberately construct rows the
  // repair sweep would legitimately claim on a re-run, which would make a
  // trailing idempotency check fail for a reason that is not idempotency.
  const remaining = async () =>
    (
      await client.query(
        `select count(*)::int n from public.pending_pushes
          where pushed_at is null and tenant_id = any($1::uuid[])`,
        [[T, OTHER]],
      )
    ).rows[0].n;
  console.log("\nidempotency — re-applying the repair moves nothing:");
  const afterFirst = await remaining();
  check(
    "exactly the fixtures deliberately left visible remain",
    afterFirst,
    6, // rNotLanded, rDoneUnlanded, rBackfill, rWorking, rPoisoned, ticketless
  );
  await client.query(migrationSql);
  check("unchanged by a second apply", await remaining(), afterFirst);

  // ── HALF TWO: the trigger, which is the whole point ──────────────────────
  // A test that only exercises `stampLanded` proves nothing new — that path
  // already settled its row. Every write below is a bare `UPDATE tickets`.
  console.log("\nthe trigger fires for a DIRECT UPDATE (no application code involved):");
  const tDirect = await seed({ landedSha: null });
  await landDirectly(tDirect.ticketId);
  check("a direct landing settles the push row", await unsettled(tDirect.pushId), false);
  check(
    "stamped with the integrated_at of that same statement",
    await iso(tDirect.pushId),
    "2026-08-03T20:11:00.000Z",
  );

  const tTwo = await seed({ landedSha: null, pushes: [{}, {}] });
  await landDirectly(tTwo.ticketId);
  check("both of a ticket's unsettled rows settle", await unsettled(tTwo.pushIds[0]), false);
  check("…including the second", await unsettled(tTwo.pushIds[1]), false);

  console.log("\nand the trigger's own refusals:");
  const tBackfill = await seed({ landedSha: null });
  await landDirectly(tBackfill.ticketId, "backfill");
  check("a transition INTO 'backfill' settles nothing", await unsettled(tBackfill.pushId), true);

  // NULL -> NULL. `discardAndRestartFromDevAction` writes
  // `{landed_sha: null, integrated_at: null}` unconditionally, so this lands on
  // a ticket that never had a sha — a no-op write that must stay a no-op. It is
  // also what isolates `new.landed_sha is not null`: settling here would stamp
  // `coalesce(NULL, now())`, i.e. invent a push that never happened.
  const tNullToNull = await seed({ landedSha: null });
  await client.query(
    `update public.tickets set landed_sha = null, integrated_at = null where id = $1`,
    [tNullToNull.ticketId],
  );
  check("a NULL -> NULL write settles nothing", await unsettled(tNullToNull.pushId), true);

  const tSettled = await seed({ landedSha: null, pushes: [{ pushedAt: EARLIER_PUSH }, {}] });
  await landDirectly(tSettled.ticketId);
  check(
    "the CAS spares an earlier genuine push timestamp",
    await iso(tSettled.pushIds[0]),
    "2026-07-01T00:00:00.000Z",
  );
  check("…while its unsettled sibling settles", await unsettled(tSettled.pushIds[1]), false);

  // SCOPE: another ticket in the same project and tenant must be untouched.
  const tNeighbour = await seed({ landedSha: null });
  const tLander = await seed({ landedSha: null });
  await landDirectly(tLander.ticketId);
  check("a neighbouring ticket's row is untouched", await unsettled(tNeighbour.pushId), true);
  check("CONTROL: the landing ticket's own row did settle", await unsettled(tLander.pushId), false);

  // Only the NULL -> non-NULL transition counts — and a row written AFTER the
  // landing stays visible on purpose. Those commits are by definition not what
  // the landing carried, so settling them would be a claim the evidence does
  // not support; the same reasoning as the CAS one assertion up.
  const tRelanded = await seed({ landedSha: null });
  await landDirectly(tRelanded.ticketId);
  const { rows: extra } = await client.query(
    `insert into public.pending_pushes
       (tenant_id, project_id, ticket_id, workspace_path, branch, pushed_at)
     values ($1,$2,$3,'/tmp/ws','devpilot/accept-relanded-2',null) returning id`,
    [T, P, tRelanded.ticketId],
  );
  check("a push row written after the landing is left alone", await unsettled(extra[0].id), true);
  await client.query(`update public.tickets set landed_sha = $2 where id = $1`, [
    tRelanded.ticketId,
    "ffffffff11112222333344445555666677778888",
  ]);
  check(
    "…and a re-stamp from a non-null sha does not fire either",
    await unsettled(extra[0].id),
    true,
  );

  // An UPDATE that never mentions the column does not fire at all.
  const tTitle = await seed({ landedSha: SHA });
  await client.query(`update public.tickets set title = 'renamed' where id = $1`, [
    tTitle.ticketId,
  ]);
  check(
    "an UPDATE that does not touch landed_sha does not fire",
    await unsettled(tTitle.pushId),
    true,
  );

  // Clearing the sha (Discard & restart) must not settle anything either.
  const tCleared = await seed({ landedSha: null, pushes: [{}, {}] });
  await landDirectly(tCleared.ticketId); // settles both
  const { rows: afterClear } = await client.query(
    `insert into public.pending_pushes
       (tenant_id, project_id, ticket_id, workspace_path, branch, pushed_at)
     values ($1,$2,$3,'/tmp/ws','devpilot/accept-cleared-3',null) returning id`,
    [T, P, tCleared.ticketId],
  );
  await client.query(
    `update public.tickets set landed_sha = null, integrated_at = null where id = $1`,
    [tCleared.ticketId],
  );
  check("clearing landed_sha settles nothing", await unsettled(afterClear[0].id), true);

  console.log("\ntenant scope:");
  // A foreign tenant landing one of THEIR tickets must not reach our rows —
  // and the dangerous shape (our push row hanging off their ticket) cannot be
  // constructed at all, because `assert_tenant_matches_parent` refuses to write
  // it. Assert that refusal; it is the independent guard the trigger's
  // `tenant_id = new.tenant_id` clause stands beside rather than replaces.
  const tOursIdle = await seed({ landedSha: null });
  const tTheirs = await seed({ tenant: OTHER, project: PF, landedSha: null });
  await landDirectly(tTheirs.ticketId);
  check("a foreign tenant's landing leaves our row alone", await unsettled(tOursIdle.pushId), true);
  check("CONTROL: their own row settled", await unsettled(tTheirs.pushId), false);

  // The predicate-exercising control: our ticket lands while a foreign-owned
  // row points at it. Without `tenant_id = new.tenant_id` the trigger settles
  // it — marking another workspace's genuinely unpushed work as pushed.
  const tPoisonHost = await seed({ landedSha: null });
  const tPoisoned = await poisonedForeignPushOn(tPoisonHost.ticketId);
  await landDirectly(tPoisonHost.ticketId);
  check(
    "our landing does not settle a foreign-owned row on our ticket",
    await unsettled(tPoisoned),
    true,
  );
  check(
    "CONTROL: our own row on that ticket did settle",
    await unsettled(tPoisonHost.pushId),
    false,
  );

  let refused = false;
  await client.query("savepoint xt");
  try {
    await client.query(
      `insert into public.pending_pushes
         (tenant_id, project_id, ticket_id, workspace_path, branch, pushed_at)
       values ($1,$2,$3,'/tmp/x','devpilot/cross-tenant',null)`,
      [T, P, tTheirs.ticketId],
    );
  } catch {
    refused = true;
  }
  await client.query("rollback to savepoint xt");
  check("a cross-tenant push/ticket pair is unwritable", refused, true);

  console.log("\nthe trigger is idempotent — re-landing settles nothing further:");
  const settledAt = await iso(tDirect.pushId);
  await client.query(
    `update public.tickets set landed_sha = null, integrated_at = null where id = $1`,
    [tDirect.ticketId],
  );
  await landDirectly(tDirect.ticketId, SHA, "2027-01-01T00:00:00Z");
  check(
    "a settled row's timestamp survives a reopen-and-reland",
    await iso(tDirect.pushId),
    settledAt,
  );
} finally {
  await client.query("rollback");
  await client.end().catch(() => {});
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nall checks passed (transaction rolled back; nothing persisted)");
