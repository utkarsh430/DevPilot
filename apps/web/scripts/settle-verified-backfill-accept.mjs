// Exercises migration `20260753000000` against a REAL Postgres, with controls.
//
//   pnpm --filter @devpilot/web accept:settle-verified-backfill
//
// The migration's justification is EXTERNAL to the database - a live GitHub
// remote and an on-disk workspace - so no test can re-derive it. What a test
// CAN do, and what this does, is pin the other half: that the predicate is as
// narrow as the header claims.
//
// ─── why this is shaped as one scenario per run, not sibling rows ─────────
//
// The predicate is PINNED to a row id, and everything else on it is a
// STALENESS GUARD: "this is still the row that was verified". So a control
// seeded as a DIFFERENT row cannot exercise those guards - the id pin excludes
// it before any of them is consulted, and the check passes with the clause
// deleted. That was this script's first shape and every clause-removal mutation
// stayed green; the controls were vacuous in precisely the way this codebase
// keeps getting bitten by.
//
// So each guard gets its OWN transaction, seeding the target row's id with that
// one fact perturbed, and asserts it does NOT settle. That is the only shape in
// which "the branch must still match" is a claim the database can falsify.
//
// The `does not touch other rows` block keeps sibling rows, because that IS a
// real property with a real mutation behind it: dropping the id pin turns it
// red. Its members are the three production rows the migration deliberately
// leaves, in their real shapes.
//
// Every transaction is ALWAYS rolled back, so this is safe against any
// database - including, if someone points DATABASE_URL there, production. It
// never commits.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  here,
  "../../../supabase/migrations/20260753000000_settle_verified_pushed_backfill_row.sql",
);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing - pass it via --env-file=.env.local");
  process.exit(2);
}

// The migration is wrapped in its own begin/commit. Committing inside this
// script's transaction would defeat the rollback guarantee, so those are
// stripped and the statements run inside OURS instead.
const sql = readFileSync(MIGRATION, "utf8").replace(/^\s*(begin|commit)\s*;\s*$/gim, "");

// SSL is left to the connection string's own `sslmode`, so this script never
// weakens verification for whatever database it is pointed at.
const client = new Client({ connectionString: url });

const failures = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` - expected ${expected}, got ${actual}`}`,
  );
  if (!ok) failures.push(label);
}

const T = "b9aacf58-fd32-418a-96d3-f85bbcc2e991"; // the target row's real tenant
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002"; // a foreign tenant
const P = "cccccccc-0000-4000-8000-000000000001";
const PF = "cccccccc-0000-4000-8000-000000000002";

// The production row the migration names, and the facts it re-asserts.
const TARGET_PUSH = "c5f766c0-482d-4c06-b422-7cea376bbc0a";
const TARGET_BRANCH = "ace/scan-trigger-on-demand-api-route-cron-scheduler-per-domain";
const TARGET_WS = "/Users/utkarsh430/.ace/workspaces/ecb95dcf-533a-4770-9499-c3bcc8630828";
const SENTINEL = "backfill";
const EXPECTED_STAMP = "2026-07-07T07:44:39.000Z";

async function seedTicket(id, { tenant, project, status, landedSha }) {
  await client.query(
    // `chk_tickets_landed_pair` enforces landed_sha IS NULL <=> integrated_at
    // IS NULL, so the two move together - as they do in production, where all
    // four sentinel tickets carry the same stamped `integrated_at`.
    `insert into public.tickets (id, tenant_id, project_id, title, status, landed_sha, integrated_at)
     values ($1,$2,$3,'accept',$4::ticket_status,$5,$6)`,
    [id, tenant, project, status, landedSha, landedSha ? "2026-07-13T01:54:35.108Z" : null],
  );
}

async function seedPush(id, { tenant, project, ticketId, branch, workspacePath, pushedAt }) {
  await client.query(
    `insert into public.pending_pushes
       (id, tenant_id, project_id, ticket_id, workspace_path, branch, unpushed_count, pushed_at)
     values ($1,$2,$3,$4,$5,$6,1,$7)`,
    [id, tenant, project, ticketId, workspacePath, branch, pushedAt],
  );
}

/**
 * Seed the TARGET row - same id - with `perturb` applied, apply the migration,
 * and report whether it settled (and with what stamp). Always rolled back.
 */
async function scenario(perturb = {}) {
  const { sibling, ...rest } = perturb;
  const shape = {
    tenant: T,
    project: P,
    status: "done",
    landedSha: SENTINEL,
    branch: TARGET_BRANCH,
    workspacePath: TARGET_WS,
    pushedAt: null,
    ...rest,
  };
  const ticketId = "dddddddd-0000-4000-8000-000000000001";
  const SIBLING_PUSH = "ffffffff-0000-4000-8000-000000000001";

  await client.query("begin");
  try {
    await client.query(`insert into public.tenants (id, name) values ($1,'ours'), ($2,'foreign')`, [
      T,
      OTHER,
    ]);
    await client.query(
      `insert into public.projects (id, tenant_id, name) values ($1,$2,'a'), ($3,$4,'b')`,
      [P, T, PF, OTHER],
    );
    await seedTicket(ticketId, shape);
    await seedPush(TARGET_PUSH, { ...shape, ticketId });
    // A second push row on the SAME ticket, branch, workspace and tenant -
    // indistinguishable from the target by every clause except the id. This is
    // the shape #157's ambiguity guard exists for, and it is what makes the id
    // pin a claim the database can falsify rather than a redundant one.
    if (sibling) await seedPush(SIBLING_PUSH, { ...shape, ticketId });

    await client.query(sql);

    const read = async (id) =>
      (await client.query(`select pushed_at from public.pending_pushes where id = $1`, [id]))
        .rows[0].pushed_at;
    const pushedAt = await read(TARGET_PUSH);
    return {
      settled: pushedAt !== null,
      stamp: pushedAt ? new Date(pushedAt).toISOString() : null,
      siblingSettled: sibling ? (await read(SIBLING_PUSH)) !== null : null,
    };
  } finally {
    await client.query("rollback");
  }
}

await client.connect();
try {
  // ── baseline: the verified row, exactly as production holds it ───────────
  console.log("the verified row settles:");
  const base = await scenario();
  check("target row settles", base.settled, true);
  check("stamped with the tip commit's date, not now()", base.stamp, EXPECTED_STAMP);

  // ── one perturbation per guard; each must refuse ──────────────────────────
  // Every one of these is the SAME row id with one fact changed, i.e. "the row
  // moved on since the evidence was taken". The evidence no longer describes
  // it, so it must stay visible.
  console.log("\neach staleness guard refuses on its own:");
  check(
    "branch renamed - not the branch checked against the remote",
    (await scenario({ branch: "ace/something-else" })).settled,
    false,
  );
  check(
    "workspace_path changed - not the workspace whose reap guard was run",
    (await scenario({ workspacePath: "/Users/someone-else/.ace/workspaces/ecb95dcf" })).settled,
    false,
  );
  // The sentinel is KEPT here so this isolates the status clause alone. In
  // production the two co-move (reopening a ticket clears `landed_sha`), which
  // makes the clause defence in depth rather than the only thing standing -
  // but a clause no control can falsify is one nobody can trust, so it gets a
  // control that falsifies it.
  check(
    "ticket no longer done",
    (await scenario({ status: "input_required", landedSha: SENTINEL })).settled,
    false,
  );
  check(
    "real sha instead of the sentinel (#156's population)",
    (await scenario({ landedSha: "c9213591b0" })).settled,
    false,
  );
  check(
    "null sha (#157's population - the exact complement)",
    (await scenario({ landedSha: null })).settled,
    false,
  );
  // Tenant boundary. Seeded wholly within the foreign tenant, because
  // `assert_tenant_matches_parent` independently refuses to write a mismatched
  // pair at all - so what this falsifies is the LITERAL tenant pin. The
  // agreement clause (`p.tenant_id = t.tenant_id`) has no control here and
  // cannot have one, for that same reason; the migration header says so rather
  // than implying this check covers it.
  check(
    "foreign tenant - the literal tenant pin is what scopes this",
    (await scenario({ tenant: OTHER, project: PF })).settled,
    false,
  );

  // The id pin. A row identical in every other respect must NOT ride along on
  // evidence gathered about one specific workspace.
  const twin = await scenario({ sibling: true });
  check("the verified row still settles alongside a twin", twin.settled, true);
  check("an otherwise-identical twin row does not", twin.siblingSettled, false);

  // ── idempotency ──────────────────────────────────────────────────────────
  console.log("\nidempotency:");
  const already = await scenario({ pushedAt: "2026-07-01T00:00:00Z" });
  check("an already-settled row is left alone", already.settled, true);
  check(
    "…and its genuine earlier timestamp is not overwritten",
    already.stamp,
    "2026-07-01T00:00:00.000Z",
  );

  // ── it touches nothing else ──────────────────────────────────────────────
  // The three production rows the migration deliberately leaves (§4), in their
  // real shapes: each carries the sentinel on a `done` ticket, i.e. each is
  // exactly what a predicate keyed on the sentinel would have swept in. Goes
  // red if the id pin is ever dropped.
  console.log("\nthe three rows deliberately left (migration §4):");
  await client.query("begin");
  try {
    await client.query(`insert into public.tenants (id, name) values ($1,'ours')`, [T]);
    await client.query(`insert into public.projects (id, tenant_id, name) values ($1,$2,'a')`, [
      P,
      T,
    ]);
    const others = [
      {
        label: "DevPilot-18 - holds 3 commits found nowhere else",
        push: "72c425db-d8df-4e44-89ea-b3512072e6a2",
        branch: "ace/meal-plan-generation-7-day-llm-plan-shopping-list-aggregatio",
        ws: "/Users/utkarsh430/.ace/workspaces/5b7b5e15-ebd0-49f5-b975-6a4823161c6d",
      },
      {
        label: "DevPilot-7 - branch on origin, workspace deleted",
        push: "9f54c88e-aedb-4742-af5e-22f489b72334",
        branch: "ace/sql-migrations-recipes-child-profiles-meal-plans-shopping-li",
        ws: "/Users/utkarsh430/.ace/workspaces/3ead86ef-7a9b-49e4-ac59-07d2c7513413",
      },
      {
        label: "DevPilot-10 - branch never on origin",
        push: "a946ead0-0d9e-41ac-a70c-e0f8f45fde4a",
        branch: "ace/app-shell-navigation-and-auth-guarded-layout",
        ws: "/Users/utkarsh430/.ace/workspaces/83072009-0300-4a45-8b43-d45d82bf3a51",
      },
    ];
    let i = 0;
    for (const o of others) {
      const tid = `dddddddd-0000-4000-8000-00000000000${++i}`;
      await seedTicket(tid, { tenant: T, project: P, status: "done", landedSha: SENTINEL });
      await seedPush(o.push, {
        tenant: T,
        project: P,
        ticketId: tid,
        branch: o.branch,
        workspacePath: o.ws,
        pushedAt: null,
      });
    }
    const before = (
      await client.query(
        `select count(*)::int as n from public.pending_pushes where pushed_at is null`,
      )
    ).rows[0].n;
    await client.query(sql);
    for (const o of others) {
      const { rows } = await client.query(
        `select pushed_at from public.pending_pushes where id = $1`,
        [o.push],
      );
      check(o.label, rows[0].pushed_at !== null, false);
    }
    const after = (
      await client.query(
        `select count(*)::int as n from public.pending_pushes where pushed_at is null`,
      )
    ).rows[0].n;
    check("no row left the badge (the target is not present here)", before - after, 0);
  } finally {
    await client.query("rollback");
  }
} finally {
  await client.end();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
