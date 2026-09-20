// Exercises migration `20260752000000` against a REAL Postgres, with controls.
//
//   node --env-file=.env.local scripts/storage-reap-accept.mjs
//
// This is the only test that can prove the bug at all. The defect lives
// entirely in the interaction between our AFTER DELETE trigger and Supabase's
// `storage.protect_delete` BEFORE DELETE STATEMENT trigger — there is no
// TypeScript in the path, so no unit test can reach it, and a fixture would
// just be us reasserting the behaviour we already assumed.
//
// It runs each case in its own SAVEPOINT inside one transaction that is ALWAYS
// rolled back, so it is safe against any database — including, if someone
// points DATABASE_URL there, production. It never commits.
//
// Structure: every assertion is made TWICE — once with the pre-migration
// function bodies restored (proving the bug is real and this script can see
// it), and once after applying the migration (proving the fix). A test that
// only ran the second half would pass against a database where the bug never
// existed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, "../../../supabase/migrations/20260752000000_storage_reap_guard.sql");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is missing — pass it via --env-file=.env.local");
  process.exit(2);
}

// The migration wraps itself in `begin; … commit;`. Applying that verbatim
// would COMMIT this script's outer transaction and leave the fixtures behind,
// so the top-level pair is stripped and the migration runs inside our own
// always-rolled-back transaction instead. Anchored to column 0 so the `begin`
// keywords inside the plpgsql function bodies (which are indented) survive.
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

const T = "aaaaaaaa-0000-4000-8000-000000000001";
const P = "cccccccc-0000-4000-8000-000000000001";
const TICKET = "dddddddd-0000-4000-8000-000000000001";
const RUN = "eeeeeeee-0000-4000-8000-000000000001";
const ATTACH_KEY = `${T}/${TICKET}/shot.png`;
const EXPORT_KEY = `${T}/audit.pdf`;
const ARTIFACT_KEY = `${T}/${RUN}/0/page.png`;

// The two function bodies EXACTLY as 20260725000000 and 20260728000000 left
// them — a bare `delete from storage.objects` with no guard. Restoring these
// is what lets the "before" half of each assertion be a real observation
// rather than a claim.
const PRE_MIGRATION_BODIES = `
create or replace function public.reap_ticket_attachment_object()
returns trigger language plpgsql security definer
set search_path = public, storage as $fn$
begin
  delete from storage.objects
   where bucket_id = 'ticket-attachments' and name = old.storage_key;
  return old;
end;
$fn$;
create or replace function public.reap_export_object()
returns trigger language plpgsql security definer
set search_path = public, storage as $fn$
begin
  if old.storage_key is not null then
    delete from storage.objects
     where bucket_id = 'exports' and name = old.storage_key;
  end if;
  return old;
end;
$fn$;
`;

/** Run `fn` inside a savepoint; roll back to it either way. */
async function inSavepoint(name, fn) {
  await client.query(`savepoint ${name}`);
  try {
    return await fn();
  } finally {
    await client.query(`rollback to savepoint ${name}`);
  }
}

/** Attempt a delete; report the SQLSTATE, or null when it succeeded. */
async function deleteAndCatch(sql, params) {
  try {
    await client.query(sql, params);
    return null;
  } catch (err) {
    return err.code ?? "unknown";
  }
}

async function seedTicketWithAttachment() {
  await client.query(
    `insert into public.tickets (id, tenant_id, project_id, title, status)
     values ($1, $2, $3, 'accept: has an attachment', 'backlog')`,
    [TICKET, T, P],
  );
  await client.query(
    `insert into public.ticket_attachments (ticket_id, tenant_id, storage_key, mime, bytes)
     values ($1, $2, $3, 'image/png', 128)`,
    [TICKET, T, ATTACH_KEY],
  );
  await client.query(
    `insert into storage.objects (bucket_id, name, owner) values ('ticket-attachments', $1, null)`,
    [ATTACH_KEY],
  );
}

async function seedProjectExport() {
  await client.query(
    `insert into public.exports (tenant_id, project_id, status, storage_key)
     values ($1, $2, 'ready', $3)`,
    [T, P, EXPORT_KEY],
  );
  await client.query(
    `insert into storage.objects (bucket_id, name, owner) values ('exports', $1, null)`,
    [EXPORT_KEY],
  );
}

async function seedRunArtifact() {
  await client.query(
    `insert into public.runs (id, tenant_id, budget_cents, status) values ($1, $2, 500, 'done')`,
    [RUN, T],
  );
  await client.query(
    `insert into public.run_artifacts
       (run_id, tenant_id, step_idx, storage_key, mime, bytes, sequence, captured_total, captured_at)
     values ($1, $2, 0, $3, 'image/png', 256, 0, 1, now())`,
    [RUN, T, ARTIFACT_KEY],
  );
  await client.query(
    `insert into storage.objects (bucket_id, name, owner) values ('run-artifacts', $1, null)`,
    [ARTIFACT_KEY],
  );
}

async function objectCount(bucket, key) {
  const { rows } = await client.query(
    `select count(*)::int as n from storage.objects where bucket_id = $1 and name = $2`,
    [bucket, key],
  );
  return rows[0].n;
}

await client.connect();
await client.query("begin");
try {
  // ── preconditions ───────────────────────────────────────────────────────
  // If this Postgres does not ship `protect_delete`, the whole premise is
  // absent and every "before" assertion below would pass vacuously. Say so
  // loudly rather than reporting a green run that proved nothing.
  const { rows: guard } = await client.query(
    `select count(*)::int as n from pg_trigger
      where tgrelid = 'storage.objects'::regclass and tgname = 'protect_objects_delete'`,
  );
  console.log("\npreconditions");
  check("storage.protect_delete is installed on this database", guard[0].n, 1);
  if (guard[0].n !== 1) {
    console.error("\nAborting: without protect_delete this script cannot observe the bug.");
    process.exit(1);
  }

  await client.query(`insert into public.tenants (id, name) values ($1, 'accept-storage-reap')`, [
    T,
  ]);
  await client.query(
    `insert into public.projects (id, tenant_id, name) values ($1, $2, 'accept')`,
    [P, T],
  );

  // ── before: the bug ─────────────────────────────────────────────────────
  console.log("\nbefore the migration (pre-#155 trigger bodies restored)");
  await client.query(PRE_MIGRATION_BODIES);

  await inSavepoint("before_ticket", async () => {
    await seedTicketWithAttachment();
    const code = await deleteAndCatch(`delete from public.tickets where id = $1`, [TICKET]);
    check("deleting a ticket with an attachment raises 42501", code, "42501");
  });

  await inSavepoint("before_export", async () => {
    await seedProjectExport();
    const code = await deleteAndCatch(`delete from public.projects where id = $1`, [P]);
    check("deleting a project with an export raises 42501", code, "42501");
  });

  // The CONTROL for the whole exercise. `reap_run_artifact_object` shipped
  // guarded in #155 and is deliberately left at its original body here, so
  // this asserts the guard genuinely works rather than inheriting the claim
  // from the PR that wrote it. If this ever failed, the shape the other two
  // are being brought onto would be the wrong shape.
  await inSavepoint("before_artifact", async () => {
    await seedRunArtifact();
    const code = await deleteAndCatch(`delete from public.runs where id = $1`, [RUN]);
    check("#155's guarded run-artifact reap already worked", code, null);
    check(
      "...and it really reaped the object",
      await objectCount("run-artifacts", ARTIFACT_KEY),
      0,
    );
  });

  // ── after: the fix ──────────────────────────────────────────────────────
  console.log("\nafter applying 20260752000000");
  // Drop the helper first so the migration is exercised as a FRESH apply.
  // `create or replace function` preserves the existing ACL, so on a database
  // that has already run this migration the privilege assertions below would
  // pass on the OLD revoke and stay green even if the migration stopped
  // revoking — which is precisely how they were vacuous when first written.
  await client.query(`drop function if exists public.storage_reap_object(text, text)`);
  await client.query(migrationSql);

  // Fail LOUDLY if the strip above ever stops working. A migration that
  // commits mid-script would end this transaction, leave every fixture
  // written, and turn the rollback in `finally` into a no-op — which is
  // exactly what happened while writing this. Better a red run than silent
  // pollution of whatever database DATABASE_URL points at.
  const { rows: tx } = await client.query(
    `select transaction_timestamp() <> statement_timestamp() as in_tx`,
  );
  check("the migration did not commit our transaction", tx[0].in_tx, true);

  await inSavepoint("after_ticket", async () => {
    await seedTicketWithAttachment();
    const code = await deleteAndCatch(`delete from public.tickets where id = $1`, [TICKET]);
    check("deleting a ticket with an attachment succeeds", code, null);
    check(
      "the attachment's stored object was reaped",
      await objectCount("ticket-attachments", ATTACH_KEY),
      0,
    );
    const { rows } = await client.query(
      `select count(*)::int as n from public.ticket_attachments where ticket_id = $1`,
      [TICKET],
    );
    check("the attachment row cascaded away", rows[0].n, 0);
  });

  await inSavepoint("after_export", async () => {
    await seedProjectExport();
    const code = await deleteAndCatch(`delete from public.projects where id = $1`, [P]);
    check("deleting a project with an export succeeds", code, null);
    check("the export's stored object was reaped", await objectCount("exports", EXPORT_KEY), 0);
  });

  // Rewriting a working function is the one way this change could REGRESS
  // something, so the third reap is re-proven on the shared helper.
  await inSavepoint("after_artifact", async () => {
    await seedRunArtifact();
    const code = await deleteAndCatch(`delete from public.runs where id = $1`, [RUN]);
    check("deleting a run with an artifact still succeeds", code, null);
    check(
      "the artifact's stored object is still reaped",
      await objectCount("run-artifacts", ARTIFACT_KEY),
      0,
    );
  });

  // A ticket whose object is already gone must still delete — the reap runs a
  // statement that matches zero rows, which `protect_delete` refuses exactly
  // like one that matches many. This is the case that makes the fix necessary
  // rather than merely tidy.
  await inSavepoint("after_missing_object", async () => {
    await client.query(
      `insert into public.tickets (id, tenant_id, project_id, title, status)
       values ($1, $2, $3, 'accept: object already gone', 'backlog')`,
      [TICKET, T, P],
    );
    await client.query(
      `insert into public.ticket_attachments (ticket_id, tenant_id, storage_key, mime, bytes)
       values ($1, $2, $3, 'image/png', 128)`,
      [TICKET, T, ATTACH_KEY],
    );
    // deliberately NO storage.objects row
    const code = await deleteAndCatch(`delete from public.tickets where id = $1`, [TICKET]);
    check("deleting a ticket whose object is already gone succeeds", code, null);
  });

  // ── degradation: an unreapable object must not block the delete ──────────
  // Property (1) of the migration header. Simulated by making the reap itself
  // fail for a reason the GUC cannot fix — a rule on storage.objects that
  // raises unconditionally. If the helper's exception handler were removed,
  // this delete would abort exactly as the original bug did.
  console.log("\ndegradation");
  await inSavepoint("degrade", async () => {
    await client.query(`
      create or replace function pg_temp.boom() returns trigger language plpgsql as $fn$
      begin raise exception 'storage backend is unavailable'; end; $fn$;
    `);
    await client.query(`
      create trigger accept_reap_boom before delete on storage.objects
      for each statement execute function pg_temp.boom();
    `);
    await seedTicketWithAttachment();
    const code = await deleteAndCatch(`delete from public.tickets where id = $1`, [TICKET]);
    check("an unreapable object degrades — the ticket still deletes", code, null);
    await client.query(`drop trigger accept_reap_boom on storage.objects`);
  });

  // ── the GUC is not left armed for the rest of the transaction ────────────
  // Property (2). After a successful reap, a subsequent unrelated direct
  // delete against storage.objects must still be refused.
  console.log("\nblast radius");
  await inSavepoint("guc", async () => {
    await seedTicketWithAttachment();
    await client.query(
      `insert into storage.objects (bucket_id, name, owner) values ('exports', $1, null)`,
      [EXPORT_KEY],
    );
    await deleteAndCatch(`delete from public.tickets where id = $1`, [TICKET]);
    const code = await deleteAndCatch(
      `delete from storage.objects where bucket_id = 'exports' and name = $1`,
      [EXPORT_KEY],
    );
    check("protect_delete is still armed after a reap", code, "42501");
  });

  // ── the helper is not reachable by tenant-facing roles ───────────────────
  // Property (3). PUBLIC execute on a SECURITY DEFINER storage deleter would
  // be a worse bug than the one being fixed.
  console.log("\nprivilege");
  for (const role of ["anon", "authenticated"]) {
    const { rows } = await client.query(
      `select has_function_privilege($1, 'public.storage_reap_object(text,text)', 'execute') as ok`,
      [role],
    );
    check(`${role} cannot execute storage_reap_object`, rows[0].ok, false);
  }

  // ── no reap still writes the guard by hand ──────────────────────────────
  // The point of centralising is that there is one implementation. If a
  // future reap grows its own `delete from storage.objects`, this fails.
  console.log("\ncentralisation");
  const { rows: bodies } = await client.query(`
    select p.proname, p.prosrc from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'reap\\_%'
  `);
  check("all reap functions were found", bodies.length >= 3, true);
  for (const b of bodies) {
    check(
      `${b.proname} delegates instead of deleting directly`,
      /delete\s+from\s+storage\.objects/i.test(b.prosrc),
      false,
    );
  }
} finally {
  await client.query("rollback");
  await client.end();
}

console.log(
  failures.length === 0
    ? "\nAll checks passed. (Transaction rolled back — nothing was written.)"
    : `\n${failures.length} check(s) FAILED:\n  - ${failures.join("\n  - ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
