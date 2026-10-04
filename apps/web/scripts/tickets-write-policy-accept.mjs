// Exercises migration `20260759000000` against a REAL Postgres, with controls.
//
//   pnpm --filter @devpilot/web accept:tickets-write-policy
//
// There is nothing to unit-test here on purpose: the defect and the fix both
// live entirely in the DATABASE. No TypeScript changed, so a TS test could only
// assert a restatement of the SQL - a second thing that can disagree with it.
// The SQL is therefore proven by running it.
//
// Two halves, and the FIRST is not optional. It restores the PRE-FIX policy
// (verbatim from 20260730000000), performs the exact write the operator
// performed, and asserts the 42P17 REPRODUCES. Without it every assertion below
// would pass against a database where the defect never existed - and this
// script is expected to be run against a local database that has already had
// the fix applied, so that is the normal case, not a corner one.
//
// The check that carries the whole change is `a FOREIGN-tenant parent is still
// REFUSED`. A "fix" that simply deletes the clause passes the two happy-path
// checks and silently re-opens a cross-tenant hole; only that one tells the two
// apart. It is asserted BOTH before and after, so the migration is shown to
// preserve a refusal rather than to have inherited a coincidence.
//
// Everything runs inside a transaction that is ALWAYS rolled back and it never
// commits. POINT IT AT A LOCAL DATABASE ANYWAY: it briefly DROPs and re-creates
// `tickets_member_write`, which takes an ACCESS EXCLUSIVE lock on `tickets` for
// the length of the transaction. Nothing is lost against production, but a live
// board would block on it.
//
//   DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
//     node scripts/tickets-write-policy-accept.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  here,
  "../../../supabase/migrations/20260759000000_tickets_write_policy_no_self_reference.sql",
);

const url = process.env.DATABASE_URL;
if (!url) {
  // Deliberately NOT defaulted from `.env.local`, matching
  // `settle-landed-trigger-accept.mjs`: that file points at the cloud database
  // and this script takes a DDL lock. Naming the local URL explicitly is the
  // whole safeguard.
  console.error(
    "DATABASE_URL is missing. Point it at a LOCAL database (`supabase start`), e.g.\n" +
      "  DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \\\n" +
      "    pnpm --filter @devpilot/web accept:tickets-write-policy",
  );
  process.exit(2);
}

// The migration wraps itself in `begin; … commit;`. Applying that verbatim would
// COMMIT this script's outer transaction and leave every fixture behind, turning
// the rollback in `finally` into a silent no-op. The top-level pair is therefore
// stripped; anchored to column 0 AND requiring the semicolon, so any `begin`
// opening a plpgsql body would survive. The strip is not TRUSTED - the
// `did not commit our transaction` check below asserts it, because a red run
// beats polluting whatever database this is pointed at.
const migrationSql = readFileSync(MIGRATION, "utf8").replace(/^(begin|commit);[ \t]*$/gm, "");

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

const T = "aaaaaaaa-0000-4000-8000-000000000001"; // our tenant
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002"; // a foreign tenant
const USER = "99999999-0000-4000-8000-000000000001"; // a member of T, and only T
const P = "cccccccc-0000-4000-8000-000000000001"; // our project
const PF = "cccccccc-0000-4000-8000-000000000002"; // theirs
const PARENT = "dddddddd-0000-4000-8000-000000000001"; // a ticket in T
const FOREIGN_PARENT = "dddddddd-0000-4000-8000-000000000002"; // a ticket in OTHER

// The policy exactly as 20260730000000 left it, i.e. the shipped, broken one.
const BROKEN_POLICY = `
  drop policy if exists tickets_member_write on public.tickets;
  create policy tickets_member_write on public.tickets
    for all
    using (tenant_id in (select public.current_user_tenants()))
    with check (
      tenant_id in (select public.current_user_tenants())
      and (project_id is null or project_id in (
        select id from public.projects where tenant_id in (select public.current_user_tenants())))
      and (parent_ticket_id is null or parent_ticket_id in (
        select id from public.tickets where tenant_id in (select public.current_user_tenants())))
    );`;

await client.connect();
await client.query("begin");
try {
  // ── fixtures ──────────────────────────────────────────────────────────────
  // A real `auth.users` row is required: `tenant_members.user_id` FKs to it, and
  // `current_user_tenants()` reads `tenant_members where user_id = auth.uid()`.
  // The empty strings are not decoration - those columns are nullable in the
  // schema and GoTrue scans them into non-nullable Go strings, so a NULL yields
  // a bare `500 Database error finding user` with nothing visibly wrong.
  await client.query(
    `insert into auth.users (
       id, instance_id, aud, role, email, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at, encrypted_password,
       confirmation_token, recovery_token, email_change, email_change_token_new,
       email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
       'tickets-write-policy-accept@example.com', now(), '{}'::jsonb, '{}'::jsonb, now(), now(),
       'local-only', '', '', '', '', '', '', '', '')`,
    [USER],
  );
  // `handle_new_user` fires on that insert and mints a personal tenant plus an
  // owner membership. Left in place the account reaches TWO tenants, which would
  // make "this user is a member of T and nothing else" false and weaken every
  // refusal below. The predicate is narrow - only a tenant named exactly after
  // the fixture email - so it cannot reach a real workspace.
  await client.query(
    `delete from public.tenant_members m using public.tenants t
      where m.tenant_id = t.id and m.user_id = $1
        and t.name = 'tickets-write-policy-accept@example.com'`,
    [USER],
  );
  await client.query(
    `delete from public.tenants t where t.name = 'tickets-write-policy-accept@example.com'
       and not exists (select 1 from public.tenant_members m where m.tenant_id = t.id)`,
  );

  await client.query(
    `insert into public.tenants (id, name) values ($1,'accept-ours'), ($2,'accept-foreign')`,
    [T, OTHER],
  );
  await client.query(
    `insert into public.tenant_members (tenant_id, user_id, role) values ($1,$2,'owner')`,
    [T, USER],
  );
  await client.query(
    `insert into public.projects (id, tenant_id, name) values ($1,$2,'ours'), ($3,$4,'theirs')`,
    [P, T, PF, OTHER],
  );
  // Seeded as the superuser (RLS off) so the fixtures exist regardless of which
  // policy is installed at the time.
  await client.query(
    `insert into public.tickets (id, tenant_id, project_id, title, status)
     values ($1,$2,$3,'accept parent','backlog'), ($4,$5,$6,'accept foreign parent','backlog')`,
    [PARENT, T, P, FOREIGN_PARENT, OTHER, PF],
  );

  // Sanity: the trigger this fix leans on must actually be installed, or every
  // refusal below would be proving something about the policy we just removed
  // rather than about the guard we claim replaces it.
  const { rows: trg } = await client.query(
    `select count(*)::int n from pg_trigger
      where tgrelid = 'public.tickets'::regclass
        and tgname = 'trg_tickets_parent_ticket_id_tenant' and not tgisinternal`,
  );
  check("PRECONDITION: trg_tickets_parent_ticket_id_tenant is installed", trg[0].n, 1);

  /**
   * Run one INSERT as the `authenticated` role, i.e. with RLS applied, exactly
   * as the browser-bound `supabaseServer()` client does. Returns the SQLSTATE,
   * or `"ok"` when the row was written. Always rolled back to a savepoint, so
   * cases cannot contaminate each other.
   */
  let n = 0;
  async function insertAs({ tenant = T, project = P, parent = null }) {
    await client.query("savepoint tc");
    let outcome;
    try {
      await client.query(
        `select set_config('request.jwt.claims',
           json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`,
        [USER],
      );
      await client.query("set local role authenticated");
      await client.query(
        `insert into public.tickets (tenant_id, project_id, title, status, parent_ticket_id)
         values ($1,$2,$3,'backlog',$4)`,
        [tenant, project, `accept case ${++n}`, parent],
      );
      outcome = "ok";
    } catch (e) {
      outcome = e.code ?? "unknown";
    }
    // `set local role` is undone by the savepoint rollback, but be explicit -
    // a leaked `authenticated` role would make every later fixture write fail
    // for a reason that has nothing to do with what is being measured.
    await client.query("rollback to savepoint tc");
    await client.query("reset role");
    return outcome;
  }

  // ── HALF ONE: the operator's failure reproduces ───────────────────────────
  console.log("\nbefore - the shipped 20260730000000 policy (self-referencing):");
  await client.query(BROKEN_POLICY);
  check(
    "creating a ticket with NO parent fails with 42P17 (the operator's error)",
    await insertAs({}),
    "42P17",
  );
  check(
    "…and so does one with a valid same-tenant parent",
    await insertAs({ parent: PARENT }),
    "42P17",
  );
  check(
    "…and so does a foreign-tenant parent, for the same unrelated reason",
    await insertAs({ parent: FOREIGN_PARENT }),
    "42P17",
  );
  // The recursion is detected while the policy expression is PLANNED, so the
  // `is null` short-circuit never gets a chance to run. That is why this is
  // "ticket creation is broken" and not "sub-issue creation is broken", and it
  // is worth asserting rather than asserting in prose.
  console.log(
    "  note  all three fail identically - the `is null` short-circuit is a runtime\n" +
      "        property and the recursion is a planning-time one.",
  );

  // ── apply ─────────────────────────────────────────────────────────────────
  console.log("\napplying 20260759000000…");
  await client.query(migrationSql);
  const { rows: tx } = await client.query(
    `select transaction_timestamp() <> statement_timestamp() as in_tx`,
  );
  check("the migration did not commit our transaction", tx[0].in_tx, true);

  console.log("\nafter - ticket creation works again:");
  check("a ticket with NO parent is created", await insertAs({}), "ok");
  check(
    "a ticket with a valid same-tenant parent is created",
    await insertAs({ parent: PARENT }),
    "ok",
  );

  console.log("\nand the cross-tenant refusals are INTACT - the controls that matter:");
  // 23514 = check_violation, raised by assert_tenant_matches_parent. A fix that
  // merely deleted the clause returns "ok" here.
  check(
    "a FOREIGN-tenant parent is still REFUSED (by the trigger, not the policy)",
    await insertAs({ parent: FOREIGN_PARENT }),
    "23514",
  );
  check("a FOREIGN-tenant project is still REFUSED", await insertAs({ project: PF }), "23514");
  // 42501 = the RLS policy itself. The row's OWN tenant clause is untouched by
  // this migration, and this is what proves the policy is still doing its job
  // rather than having been dropped outright.
  check(
    "a row claiming a tenant I am not a member of is still REFUSED by RLS",
    await insertAs({ tenant: OTHER, project: PF }),
    "42501",
  );

  // ── the class, not just the site ──────────────────────────────────────────
  // The defect is "a policy that queries the relation it guards". Checking only
  // `tickets` would leave an identical bug elsewhere invisible, and it is a
  // cheap, exact question to ask of the whole schema.
  console.log("\nschema-wide: no policy may query the relation it guards:");
  const { rows: pols } = await client.query(
    `select c.relname as tbl, p.polname,
            coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
            coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public'`,
  );
  const selfRef = pols.filter((r) => new RegExp(`\\b${r.tbl}\\b`).test(r.expr));
  for (const r of selfRef) console.log(`     ${r.tbl}.${r.polname}: ${r.expr}`);
  check(`no self-referencing policy remains (scanned ${pols.length})`, selfRef.length, 0);

  // ── idempotency ───────────────────────────────────────────────────────────
  console.log("\nidempotency - re-applying changes nothing:");
  await client.query(migrationSql);
  check("a ticket with no parent still creates", await insertAs({}), "ok");
  check("a foreign parent is still refused", await insertAs({ parent: FOREIGN_PARENT }), "23514");
} finally {
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nall checks passed (transaction rolled back; nothing persisted)");
