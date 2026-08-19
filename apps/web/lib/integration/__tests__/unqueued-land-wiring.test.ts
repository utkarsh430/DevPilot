// The wiring half of "a landing nobody asked for is still owed", plus the
// no-force property of the reconcile.
//
// WHY A SOURCE SCAN. `lib/engine/land-worker.ts` and
// `lib/engine/unqueued-land-reaper.ts` both pull in `supabaseService` and the
// Inngest client, which reach `server-only`, so neither can be imported under
// Vitest - the same reason `nothing-to-land-wiring.test.ts` scans source. That
// is precisely the gap both of these defects lived in: the pure rules were
// testable and the ORDER and SCOPE they sat in were covered by nothing.
//
// Every assertion below is mutation-verified: widening a reaper's status set,
// moving the reconcile below the base rebase, dropping a tenant predicate, or
// reaching for a force push turns a test here red.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const WORKER = read("lib/engine/land-worker.ts");
const RESCUE_REAPER = read("lib/engine/land-rescue-reaper.ts");
const UNQUEUED_REAPER = read("lib/engine/unqueued-land-reaper.ts");
const UNQUEUED_STORE = read("lib/integration/unqueued-land-store.ts");
const RECONCILE = read("lib/git/reconcile-branch.ts");
const ROUTE = read("app/api/inngest/route.ts");

/** Index of the first occurrence, or -1. Used to compare ORDER in the source. */
const at = (haystack: string, needle: string) => haystack.indexOf(needle);

describe("the three landing sweeps have disjoint scopes, by construction", () => {
  // The existing pair both SELECT FROM `integration_queue`; the new one selects
  // from `tickets` and acts only on the ABSENCE of a queue row. So no ticket can
  // be inside two scopes at once, and neither existing reaper was widened -
  // AGENTS.md records why widening one is the wrong move (two crons with two
  // policies on one row endanger each other).
  it("integrationQueueReaper still scans ONLY in-flight rows", () => {
    expect(WORKER).toContain('.in("status", ["landing", "awaiting_merge_resolution"])');
    for (const other of ['"pending"', '"landed"', '"cancelled"', '"failed"']) {
      expect(WORKER).not.toContain(`.in("status", [${other}`);
      expect(WORKER).not.toContain(`.eq("status", ${other})`);
    }
  });

  it("landRescueReaper still scans ONLY never-claimed pending rows", () => {
    // Its SCAN is `pending`. It does also read `landing` - but as the
    // "is this project's land lane busy" stand-down, not as a row it acts on,
    // which is why that status is excluded from the terminal sweep below rather
    // than from the file.
    expect(RESCUE_REAPER).toContain('.eq("status", "pending")');
    for (const terminal of ['"landed"', '"cancelled"', '"failed"']) {
      expect(RESCUE_REAPER).not.toContain(`.eq("status", ${terminal})`);
      expect(RESCUE_REAPER).not.toContain(`.in("status", [${terminal}`);
    }
    // Every write it makes is CAS-guarded on the pending it observed, so it can
    // never move a row a worker has claimed.
    expect((RESCUE_REAPER.match(/\.eq\("status", "pending"\)/g) ?? []).length).toBeGreaterThan(1);
  });

  it("the unqueued sweep scans TICKETS, never the queue", () => {
    // The one query in the landing layer that does not start from a queue row -
    // which is the point, since the rows it exists to find have none.
    expect(UNQUEUED_STORE).toContain('.from("tickets")');
    expect(UNQUEUED_STORE).toContain('.eq("status", "done")');
    expect(UNQUEUED_STORE).toContain('.is("landed_sha", null)');
    // Its ONLY use of integration_queue is the existence check, which reads
    // every status precisely so a terminal decision is never re-litigated.
    expect(UNQUEUED_STORE).not.toMatch(/from\("integration_queue"\)[\s\S]{0,200}?\.eq\("status"/);
    expect(UNQUEUED_STORE).not.toMatch(/from\("integration_queue"\)[\s\S]{0,200}?\.in\("status"/);
  });
});

describe("the sweep enqueues through the one seam and inserts nothing itself", () => {
  it("never writes to integration_queue", () => {
    for (const write of [".insert(", ".upsert(", ".update(", ".delete("]) {
      expect(UNQUEUED_STORE).not.toContain(write);
    }
  });

  it("wires its action to enqueueForLanding", () => {
    expect(UNQUEUED_REAPER).toContain("enqueueForLanding({ ticketId, tenantId })");
    // …and only there. The store takes it as an injected dep - which is what
    // keeps the store loadable under Vitest, since `queue.server.ts` reaches
    // `next/headers`.
    expect(UNQUEUED_STORE).not.toMatch(/^import .*queue\.server/m);
    expect(UNQUEUED_STORE).toContain("enqueue: (args:");
  });

  it("is gated on the auto-land kill switch in the cron AND as a policy clause", () => {
    expect(UNQUEUED_REAPER).toContain("if (!isAutoLandEnabled()) return { skipped:");
    expect(UNQUEUED_REAPER).toContain("instanceAutoLandEnabled: isAutoLandEnabled()");
  });

  it("is registered on the Inngest route", () => {
    expect(ROUTE).toContain(
      'import { unqueuedLandReaper } from "@/lib/engine/unqueued-land-reaper"',
    );
    expect(ROUTE).toMatch(/^\s*unqueuedLandReaper,$/m);
  });

  it("runs at the cadence the grace is pinned against", () => {
    expect(UNQUEUED_REAPER).toContain('{ cron: "*/5 * * * *" }');
  });
});

describe("every read the sweep makes is tenant-scoped", () => {
  // Service-role, RLS off. What a missing predicate leaks here is a list of
  // BRANCHES TO MERGE into another tenant's integration branch.
  it("scopes the queue-existence, project and dependency reads", () => {
    const loader = UNQUEUED_STORE.slice(
      at(UNQUEUED_STORE, "export async function loadUnqueuedLandCandidate"),
      at(UNQUEUED_STORE, "export async function rescueUnqueuedLand"),
    );
    // One `.eq("tenant_id", tenantId)` per direct read (queue + projects); the
    // push and dependency reads are scoped inside their own shared helpers,
    // which take the resolved tenantId explicitly.
    const scoped = loader.match(/\.eq\("tenant_id", tenantId\)/g) ?? [];
    expect(scoped.length).toBeGreaterThanOrEqual(2);
    expect(loader).toContain("resolveTicketPush(deps.db, { ticketId: row.id, tenantId })");
    expect(loader).toContain("loadBlockingRelations(deps.db, { ticketId: row.id, tenantId })");
    // tenantId comes off the SCAN ROW, never a caller.
    expect(loader).toContain("const tenantId = row.tenant_id;");
  });

  it("takes the dependency gate from the shared rule, never a second copy", () => {
    expect(UNQUEUED_STORE).toContain(
      'import { isDependencyDeferred } from "@/lib/integration/land-rescue-policy"',
    );
    // …and the existing reaper now shares the same READS, so the disarm signal
    // cannot drift between the two sweeps.
    expect(RESCUE_REAPER).toContain(
      'import { loadBlockingRelations } from "@/lib/integration/blocking-relations"',
    );
  });
});

describe("the reconcile runs before anything rewrites the branch", () => {
  it("sits between the base fetch and the base rebase", () => {
    const reconcile = at(WORKER, "await reconcileWithRemoteBranch({");
    const baseRebase = at(WORKER, 'await gitExec(workspacePath, ["rebase", `origin/${base}`]');
    const push = at(WORKER, "const pushArgs = rebased");
    expect(reconcile).toBeGreaterThan(-1);
    expect(baseRebase).toBeGreaterThan(-1);
    expect(reconcile).toBeLessThan(baseRebase);
    expect(reconcile).toBeLessThan(push);
  });

  it("reads HEAD for the `rebased` flag AFTER the reconcile", () => {
    // Otherwise a reconcile that fast-forwarded us would read as a rewrite and
    // force-push where a plain push was correct.
    const reconcile = at(WORKER, "await reconcileWithRemoteBranch({");
    const headBefore = at(WORKER, "const headBefore = (");
    expect(reconcile).toBeLessThan(headBefore);
  });

  it("routes a reconcile conflict through the existing conflict path", () => {
    expect(WORKER).toContain('if (reconcile.kind === "conflict")');
    expect(WORKER).toContain("RECONCILE CONFLICT:");
    // …i.e. the same `{kind: "conflict", detail}` the base rebase produces, so
    // `stampConflict` / `spawnMerger` / the parked row all apply unchanged.
    expect(WORKER).toContain("await stampConflict(push.id, prep.detail);");
  });
});

describe("already-on-base is the nothing-to-land SUCCESS path, never an error", () => {
  // MEASURED: #69/#76/#77 - the exact tickets this sweep finds - had already
  // shipped through pull requests #39/#42/#44. The sweep cannot know that (it is
  // a git fact, not a database one), so the worker must resolve it as a success.
  it("checks it before the base rebase and before the push", () => {
    const check = at(WORKER, "await mergeWouldChangeNothing(workspacePath, base)");
    const baseRebase = at(WORKER, 'await gitExec(workspacePath, ["rebase", `origin/${base}`]');
    const push = at(WORKER, "const pushArgs = rebased");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(baseRebase);
    expect(check).toBeLessThan(push);
  });

  it("returns commitsAhead 0, which routes it into the existing closure", () => {
    // `commitsAhead: 0` rather than a new branch of the worker, so the outcome
    // is the SAME `closeNothingToLand` - the stamp, the notice and the fan-out
    // are shared with the case that already worked, and cannot drift from it.
    const block = WORKER.slice(
      at(WORKER, "if ((await mergeWouldChangeNothing(workspacePath, base)) === true) {"),
      at(WORKER, "// Read HEAD **after** the reconcile"),
    );
    expect(block).toContain("commitsAhead: 0");
    expect(block).toContain("alreadyOnBase: true");
    // It is a SUCCESS: no error, no conflict, no merger.
    expect(block).not.toContain('kind: "error"');
    expect(block).not.toContain('kind: "conflict"');
    expect(block).toContain('kind: "ok"');
  });

  it("only the PROVEN case acts - indeterminate falls through unchanged", () => {
    // `mergeWouldChangeNothing` returns `boolean | null`; a truthiness test would
    // let `null` (old git, a conflicting merge) read as "not landed" silently,
    // which is right, but a `!== false` test would let it read as landed, which
    // would stamp a landing over unshipped work.
    expect(WORKER).toContain("(await mergeWouldChangeNothing(workspacePath, base)) === true");
  });

  it("records WHICH nothing-to-land outcome it was", () => {
    // "completed without changing any files" is false about work sitting on dev
    // right now, so the two outcomes carry different copy and different metadata.
    expect(WORKER).toContain('prep.alreadyOnBase ? "already_on_base" : "no_commits"');
    expect(WORKER).toContain("buildNothingToLandComment({ branch, base, outcome })");
    expect(WORKER).toContain("buildNothingToLandMetadata({ branch, base, outcome })");
  });
});

describe("nothing about this fix force-pushes", () => {
  // The remote branch is the sole home of any commit not yet on the integration
  // branch. A force here would discard exactly the work the landing exists to
  // preserve - this repo's data-loss invariant.
  it("the reconcile module issues no force push", () => {
    // argv is written with double quotes; the prose explaining WHY not uses
    // backticks, so this matches an actual argument and not the reasoning.
    expect(RECONCILE).not.toMatch(/"--force/);
    // The one `+` it does use is on a REMOTE-TRACKING refspec, which is a mirror
    // of the remote and holds no work of ours.
    expect(RECONCILE).toContain("`+refs/heads/${branch}:${remoteRef}`");
  });

  it("leaves the workspace on a clean branch after a conflicted reconcile", () => {
    expect(RECONCILE).toContain('["rebase", "--abort"]');
  });

  it("the worker's only force stays conditional on the base rebase rewriting", () => {
    expect(WORKER).toContain(
      'const pushArgs = rebased\n      ? ["push", "--force-with-lease", "--set-upstream", "origin", branch]\n      : ["push", "--set-upstream", "origin", branch];',
    );
    // Exactly one force in the whole worker, and it is that one.
    expect((WORKER.match(/"--force/g) ?? []).length).toBe(1);
  });
});
