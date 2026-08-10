import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration `20260757000000` is SQL, so its BEHAVIOUR is proven by
 * `scripts/settle-landed-trigger-accept.mjs` against a real Postgres — which
 * needs a live database and therefore does not run in CI.
 *
 * This is the half that does. It is a source scan, deliberately: there is no
 * TypeScript twin of the rule to unit-test, and adding one would recreate the
 * exact drift the trigger exists to end (a second place that can disagree about
 * when a push row is settled). What a scan CAN do is fail `pnpm test` when a
 * later edit quietly drops a clause, changes the shape of the guarantee, or
 * reintroduces the sweeper the design rejects.
 */

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const MIGRATIONS = join(process.cwd(), "../../supabase/migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");

const TRIGGER_MIGRATION = "20260757000000_settle_pending_pushes_on_landed.sql";
const sql = read(TRIGGER_MIGRATION);

describe("the settle is a property of the storage layer, not of one caller", () => {
  it("fires on the tickets row itself, so no writer can route around it", () => {
    // Keyed on the FACT (`landed_sha` moving NULL -> non-NULL), not on any
    // function. `stampLanded`'s required `pendingPushId` bound only the paths
    // that call it; `closeMergerOutcome` (#191) and a hand-written UPDATE both
    // leaked past it.
    expect(sql).toContain("after update of landed_sha on public.tickets");
    expect(sql).toContain("for each row");
    expect(sql).toContain("execute function public.settle_pending_pushes_on_landed()");
  });

  it("fires only on the NULL -> non-NULL transition", () => {
    expect(sql).toContain("old.landed_sha is null");
    expect(sql).toContain("and new.landed_sha is not null");
  });

  it("refuses the 'backfill' sentinel, which is a guess and not a landing", () => {
    // `20260715000000` §6 stamped it blanket, having contacted no remote. Both
    // prior repairs excluded it for that reason.
    expect(sql).toContain("and new.landed_sha <> 'backfill'");
  });

  it.each([
    ["this ticket's own rows and no others", "where ticket_id = new.id"],
    ["the tenant boundary", "and tenant_id = new.tenant_id"],
    ["the CAS that spares a genuine push timestamp", "and pushed_at is null"],
  ])("scopes the write by %s", (_label, clause) => {
    expect(sql).toContain(clause);
  });

  it("stamps the landing's own time, never now()", () => {
    // `now()` would date the push to whenever the trigger happened to run. The
    // push became moot at the moment the work landed.
    expect(sql).toContain("set pushed_at = coalesce(new.integrated_at, now())");
  });

  it("writes only pending_pushes, and only that one column", () => {
    const body = sql.slice(sql.indexOf("as $$"), sql.indexOf("$$;", sql.indexOf("as $$")));
    expect(body).toContain("update public.pending_pushes");
    // A trigger on `tickets` that writes `tickets` is a recursion hazard, and
    // one that writes anything else is doing more than its name claims.
    expect(body.match(/\b(update|insert into|delete from)\s+public\.\w+/g)).toEqual([
      "update public.pending_pushes",
    ]);
  });
});

describe("the repair is 20260749000000's predicate, unchanged", () => {
  // That rule was correct; what was missing was anything keeping it true
  // afterwards. Widening it here would stop it protecting a genuinely-unpushed
  // branch — the failure mode `landed-push.ts` and `20260750000000` both guard.
  it.each([
    ["only unsettled rows", "p.pushed_at  is null"],
    ["ticket-bound rows only", "p.ticket_id  is not null"],
    ["the ticket join", "p.ticket_id  = t.id"],
    ["tenant scope", "p.tenant_id  = t.tenant_id"],
    ["done tickets only", "t.status     = 'done'"],
    ["a real landing", "t.landed_sha is not null"],
    ["not the sentinel", "t.landed_sha <> 'backfill'"],
  ])("carries the %s clause", (_label, clause) => {
    expect(sql).toContain(clause);
  });

  it("stamps the ticket's integrated_at, not now()", () => {
    expect(sql).toContain("set pushed_at = coalesce(t.integrated_at, now())");
  });

  it("matches the clauses 20260749000000 shipped", () => {
    const prior = read("20260749000000_settle_landed_pending_pushes.sql");
    for (const clause of ["t.landed_sha is not null", "t.landed_sha <> 'backfill'"]) {
      expect(prior).toContain(clause);
      expect(sql).toContain(clause);
    }
  });
});

describe("what this deliberately is NOT", () => {
  it("adds no second writer of pushed_at — every settle routes through the sanctioned one", () => {
    // `landed-push.ts` rejects a reaper outright and the reason still holds: a
    // sweep would have HIDDEN this defect, because the stale rows were the only
    // visible evidence the write path was incomplete. A reaper that hides a
    // write-path bug is worse than a stale badge.
    //
    // The scan is over who WRITES `pushed_at` rather than who reads the table:
    // reading it is ordinary (the reap guard, the badge, the tracker's own
    // upsert lookup), whereas every settle is one of these, each tied to an
    // event rather than to a clock.
    //
    // ONE SWEEP DOES EXIST NOW and this test's original title over-claimed by
    // denying it: the supervisor's `landed_push_unsettled` repair periodically
    // looks for landed tickets whose row was left behind. It is the OPPOSITE of
    // the reaper refused above and it does not appear in this list, both for
    // the same reason - it performs no write of its own, it calls
    // `settleLandedPush`, so the narrow row-identified semantics above are the
    // only ones that exist. What makes it acceptable is that it INDICTS: every
    // repair writes a `supervisor_actions` row with its cause and repeats
    // escalate as a suspected defect, so it cannot hide a write-path gap the
    // way a silent reaper would. Pinned by the next test.
    const writers = walk(join(process.cwd(), "lib"))
      .concat(walk(join(process.cwd(), "app")))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => /pushed_at:\s*(new Date|now)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(process.cwd().length + 1))
      .sort();
    expect(writers).toEqual([
      // The operator pressing Push, and the recover-from-a-lost-workspace path.
      "app/(app)/changes/actions.ts",
      // The landing's own row-identified settle. The trigger stands behind it.
      "lib/integration/landed-push.ts",
    ]);
  });

  // The claim the test above now makes in prose, checked. Without this, "the
  // sweep routes through the sanctioned writer and indicts" is an assertion
  // about a file nothing looks at - and the supervisor's own store reaches
  // `server-only` via nothing, but its wiring twin does, so a source scan is
  // what can see both halves at once.
  it("the supervisor's sweep settles through settleLandedPush and records its cause", () => {
    const scan = readFileSync(
      join(process.cwd(), "lib/integration/unsettled-push-store.ts"),
      "utf8",
    );
    // It reads and decides; it never stamps.
    expect(/pushed_at:\s*(new Date|now)/.test(scan)).toBe(false);
    expect(scan).not.toContain(".update(");

    const wiring = readFileSync(
      join(process.cwd(), "lib/engine/supervisor-store.server.ts"),
      "utf8",
    );
    expect(wiring).toContain("settleLandedPush");

    // And the repair is recorded WITH ITS CAUSE, which is the whole difference
    // between this and the reaper refused above.
    const store = readFileSync(join(process.cwd(), "lib/engine/supervisor-store.ts"), "utf8");
    expect(store).toContain("recordSupervisorAction");
    expect(store).toContain("plan.bookkeepingRepairs");
  });

  it("leaves the application-side settle in place as the narrow, row-identified write", () => {
    // The trigger stands BEHIND `settleLandedPush`, it does not replace it —
    // that caller knows which row the landing resolved and settles exactly it.
    const mod = readFileSync(join(process.cwd(), "lib/integration/landed-push.ts"), "utf8");
    expect(mod).toContain('.eq("id", args.pendingPushId)');
    expect(mod).toContain('.eq("tenant_id", args.tenantId)');
    expect(mod).toContain('.is("pushed_at", null)');
  });

  it("leaves the data-loss reap guard exactly as it was", () => {
    // `pushed_at === null` alone is the hold signal. A stale or zero commit
    // count must never read as "nothing to lose".
    const guard = readFileSync(join(process.cwd(), "lib/workspace/unpushed-work.ts"), "utf8");
    expect(guard).toContain("return row.pushed_at === null;");
    expect(guard).toContain("if (holding.length === 0) return { reap: true };");
  });

  it("leaves the Changes-queue query counting exactly what it counted before", () => {
    // The badge was never the bug — it reports `pushed_at IS NULL` faithfully.
    // Filtering landed tickets out at the UI would have made the symptom vanish
    // and left the wrong rows for the next reader.
    const queries = readFileSync(join(process.cwd(), "lib/board/queries.ts"), "utf8");
    expect(queries).toContain('.is("pushed_at", null)');
  });
});
