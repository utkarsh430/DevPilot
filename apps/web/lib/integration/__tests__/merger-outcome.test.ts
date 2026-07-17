// The merger-outcome sweep, driven against the MEASURED production state.
//
// PRODUCTION SHAPE, reproduced in `scourshBoard()` below (project `scoursh`,
// 2026-08-04). Thirty tickets read `done` with their commits not on the
// integration branch. Exactly ONE was genuinely owed a landing:
//
//   26 mergers ("Resolve merge conflict: …")   can NEVER land, by design
//    3 with no branch (#2, #14, #16)           nothing to land, correctly done
//    1 genuinely stranded (#42)                real
//
// THE ASSERTIONS ARE BIDIRECTIONAL AND THAT IS THE WHOLE POINT. A change that
// silences every one of the thirty is a REGRESSION, not a fix: the value of the
// not-landed list is that an entry on it means something. So every test asserts
// the exact SET closed — never a count, never membership — and the genuinely
// stranded ticket is asserted to SURVIVE in each of them.
//
// The fake ACTUALLY APPLIES `.eq` / `.is` / `.lt` / `.not` against a shared
// store, and applies `.update()` to it. A filter-ignoring fake would make every
// tenant assertion vacuous. Each tenant assertion carries a CONTROL that neuters
// exactly one predicate — i.e. what deleting it looks like — and proves the
// foreign row WOULD be reached.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decideMergerOutcome,
  LANDED_SHA_BACKFILL_SENTINEL,
  MERGER_OUTCOME_CRON_PERIOD_SECONDS,
  MERGER_OUTCOME_GRACE_SECONDS_DEFAULT,
  type MergerOutcomeCandidate,
} from "@/lib/integration/merger-outcome-policy";
import {
  loadMergerOutcomeCandidate,
  recordMergerOutcome,
  sweepMergerOutcomes,
  MERGER_NOTHING_TO_LAND_OUTCOME,
  type MergerOutcomeDeps,
  type UnlandedMergerRow,
} from "@/lib/integration/merger-outcome-store";
import { decideUnqueuedLandRescue } from "@/lib/integration/unqueued-land-policy";
import { LANDED_SHA_BACKFILL_SENTINEL as POLICY_SENTINEL } from "@/lib/integration/land-policy";
import {
  buildNothingToLandComment,
  buildNothingToLandMetadata,
  NOTHING_TO_LAND_METADATA_KIND,
} from "@/lib/integration/land-outcome";
import { deriveLandingState, landingCardTreatment } from "@/lib/integration/landing-state";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function fakeClient(
  tables: Tables,
  opts: { neuterTenantEqOn?: string[]; errorOn?: string[] } = {},
): SupabaseClient {
  const neutered = new Set(opts.neuterTenantEqOn ?? []);
  const erroring = new Set(opts.errorOn ?? []);

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    let order: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    const self: Record<string, unknown> = {};

    self.select = () => self;
    self.update = (p: Row) => {
      patch = p;
      return self;
    };
    self.eq = (c: string, v: unknown) => {
      // Drops ONLY the tenant predicate, and only on the named tables — the
      // precise mutation "deleting the `.eq('tenant_id', …)`" is. Neutering
      // every `.eq` would also break the scan's own `status` filter and prove
      // nothing about tenant scoping.
      if (c === "tenant_id" && neutered.has(table)) return self;
      filters.push((r) => r[c] === v);
      return self;
    };
    self.is = (c: string, v: unknown) => {
      filters.push((r) => (r[c] ?? null) === v);
      return self;
    };
    self.not = (c: string, _op: string, _v: unknown) => {
      filters.push((r) => r[c] !== null && r[c] !== undefined);
      return self;
    };
    self.lt = (c: string, v: unknown) => {
      filters.push((r) => String(r[c] ?? "") < String(v));
      return self;
    };
    self.order = (column: string, o?: { ascending?: boolean }) => {
      order = { column, ascending: o?.ascending ?? true };
      return self;
    };
    self.limit = (n: number) => {
      limit = n;
      return self;
    };

    const run = () => {
      const source = tables[table] ?? [];
      let matched = source.filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { column, ascending } = order;
        matched = [...matched].sort((a, b) => {
          const av = String(a[column] ?? "");
          const bv = String(b[column] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limit !== null) matched = matched.slice(0, limit);
      // An UPDATE mutates the shared store in place, so a second pass sees what
      // the first wrote — which is what makes the idempotency assertions real.
      if (patch) for (const r of matched) Object.assign(r, patch);
      return matched.map((r) => ({ ...r }));
    };

    const fail = () => ({ data: null, error: { message: `${table} unreadable` } });

    self.maybeSingle = () =>
      Promise.resolve(
        erroring.has(table) ? fail() : { data: run()[0] ?? null, error: null as null },
      );
    self.then = (
      resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) =>
      Promise.resolve()
        .then(() => (erroring.has(table) ? fail() : { data: run(), error: null }))
        .then(resolve, reject);

    return self;
  }

  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const PROJ = "99999999-9999-4999-8999-999999999999";
const SRC_SHA = "aaaaaaaabbbbbbbbccccccccdddddddd11111111";

const NOW = "2026-08-04T18:00:00.000Z";
/** Comfortably past the 15-minute grace. */
const OLD = "2026-08-04T12:00:00.000Z";

type Recorded = {
  notices: Array<{ ticketId: string; body: string; metadata: Record<string, unknown> }>;
  fanOut: string[];
};

function deps(
  tables: Tables,
  over: Partial<MergerOutcomeDeps> & { neuterTenantEqOn?: string[]; errorOn?: string[] } = {},
): { deps: MergerOutcomeDeps; recorded: Recorded } {
  const recorded: Recorded = { notices: [], fanOut: [] };
  const { neuterTenantEqOn, errorOn, ...rest } = over;
  return {
    recorded,
    deps: {
      db: fakeClient(tables, { neuterTenantEqOn, errorOn }),
      postNotice: async ({ ticketId, body, metadata }) => {
        recorded.notices.push({ ticketId, body, metadata });
      },
      fanOut: async ({ ticketId }) => {
        recorded.fanOut.push(ticketId);
      },
      nowIso: NOW,
      graceSeconds: 15 * 60,
      instanceAutoLandEnabled: true,
      ...rest,
    },
  };
}

// ── the measured board ─────────────────────────────────────────────────────

/** The 26 mergers, by their real `DevPilot-<N>` numbers. */
const MERGERS = [
  30, 31, 32, 56, 60, 61, 65, 66, 67, 69, 70, 71, 72, 73, 76, 77, 78, 80, 81, 83, 84, 85, 87, 95,
  96, 99,
].map((n) => `t-m${n}`);
/** The three that correctly produced no branch — #2, #14, #16. */
const NO_BRANCH = ["t-2", "t-14", "t-16"];
/** The one genuinely owed a landing. It must SURVIVE every sweep here. */
const STRANDED = "t-42";

function ticket(id: string, over: Row = {}): Row {
  return {
    id,
    tenant_id: T1,
    project_id: PROJ,
    status: "done",
    landed_sha: null,
    updated_at: OLD,
    requested_role: null,
    parent_ticket_id: null,
    ticket_number: null,
    ...over,
  };
}

function scourshBoard(): Tables {
  const tickets: Row[] = [];
  // Every merger's SOURCE landed — the settledness gate is satisfied for all 26,
  // which is what the live board showed (23 with a `landed` queue row, 3 with a
  // `failed` one, all 26 carrying a real `landed_sha`).
  for (const [i, id] of MERGERS.entries()) {
    const src = `t-src-${i}`;
    tickets.push(ticket(src, { landed_sha: SRC_SHA, ticket_number: 100 + i }));
    tickets.push(
      ticket(id, { requested_role: "release_engineer", parent_ticket_id: src, ticket_number: i }),
    );
  }
  for (const id of NO_BRANCH) tickets.push(ticket(id));
  tickets.push(ticket(STRANDED));
  return {
    tickets,
    projects: [{ id: PROJ, tenant_id: T1, auto_land_enabled: true, integration_branch: "dev" }],
    integration_queue: [],
  };
}

/** Row lookup that never returns `undefined` — a test that silently skipped its
 *  assertion because the row was missing would be worse than one that fails. */
function rowById(t: Tables, id: string): Row {
  const r = (t.tickets as Row[]).find((x) => x.id === id);
  if (!r) throw new Error(`no ticket ${id} in the fixture`);
  return r;
}
/** Positional lookup, same reason. */
function nth(t: Tables, i: number): Row {
  const r = (t.tickets as Row[])[i];
  if (!r) throw new Error(`no ticket at index ${i}`);
  return r;
}

const closedIds = (t: Tables) =>
  (t.tickets as Row[])
    .filter((r) => r.landed_sha === SRC_SHA && String(r.id).startsWith("t-m"))
    .map((r) => String(r.id))
    .sort();

// ── the sweep, against the measured board ──────────────────────────────────

describe("the measured scoursh board", () => {
  it("closes all 26 mergers and NOTHING else", async () => {
    const tables = scourshBoard();
    const { deps: d, recorded } = deps(tables);
    const res = await sweepMergerOutcomes(d);

    // The exact SET, not a count: an implementation that closed all 30 would
    // pass a count assertion and would be strictly worse than the bug.
    expect(closedIds(tables)).toEqual([...MERGERS].sort());
    expect(res.closed).toBe(26);
    expect(recorded.notices.map((n) => n.ticketId).sort()).toEqual([...MERGERS].sort());
    expect(recorded.fanOut.sort()).toEqual([...MERGERS].sort());
  });

  it("leaves the ONE genuinely stranded ticket exactly where it was", async () => {
    // THE anti-regression. A change that silences the whole list is not a fix.
    const tables = scourshBoard();
    await sweepMergerOutcomes(deps(tables).deps);
    const t42 = rowById(tables, STRANDED);
    expect(t42.landed_sha).toBeNull();
  });

  it("leaves the three correctly-done, no-branch tickets alone", async () => {
    const tables = scourshBoard();
    const { deps: d, recorded } = deps(tables);
    await sweepMergerOutcomes(d);
    for (const id of NO_BRANCH) {
      expect(rowById(tables, id).landed_sha).toBeNull();
    }
    expect(recorded.notices.map((n) => n.ticketId)).not.toContain(NO_BRANCH[0]);
  });

  it("is idempotent — a second tick closes nothing more", async () => {
    const tables = scourshBoard();
    const first = await sweepMergerOutcomes(deps(tables).deps);
    const { deps: d2, recorded } = deps(tables);
    const second = await sweepMergerOutcomes(d2);
    expect(first.closed).toBe(26);
    // The scan itself filters on `landed_sha IS NULL`, so a closed merger is not
    // even a candidate on the next tick.
    expect(second.scanned).toBe(0);
    expect(second.closed).toBe(0);
    expect(recorded.notices).toHaveLength(0);
  });
});

// ── the pure policy ────────────────────────────────────────────────────────

function candidate(over: Partial<MergerOutcomeCandidate> = {}): MergerOutcomeCandidate {
  return {
    ticketId: "t-m30",
    isMerger: true,
    sourceTicketId: "t-src",
    status: "done",
    landedSha: null,
    updatedAtIso: OLD,
    autoLandEnabled: true,
    instanceAutoLandEnabled: true,
    hasQueueRow: false,
    sourceLandedSha: SRC_SHA,
    ...over,
  };
}
const decide = (over: Partial<MergerOutcomeCandidate> = {}) =>
  decideMergerOutcome(candidate(over), NOW, 15 * 60);

describe("decideMergerOutcome — every clause stands the sweep down", () => {
  it("closes the happy case against the SOURCE's sha", () => {
    expect(decide()).toEqual({ action: "close", sha: SRC_SHA, reason: expect.any(String) });
  });

  const REFUSALS: Array<[string, Partial<MergerOutcomeCandidate>, string]> = [
    ["not a merger", { isMerger: false }, "not-a-merger"],
    ["instance kill switch", { instanceAutoLandEnabled: false }, "auto-land-kill-switch"],
    ["project opted out", { autoLandEnabled: false }, "auto-land-disabled-for-project"],
    ["merger still working", { status: "in_progress" }, "merger-not-done:in_progress"],
    ["merger parked", { status: "blocked" }, "merger-not-done:blocked"],
    ["already closed", { landedSha: "deadbeef" }, "already-closed"],
    ["the landing layer owns it", { hasQueueRow: true }, "has-queue-row"],
    ["no source ticket", { sourceTicketId: null }, "no-source-ticket"],
    ["source has not landed", { sourceLandedSha: null }, "source-not-settled"],
    ["source landing is blank", { sourceLandedSha: "   " }, "source-not-settled"],
    [
      "source landing is the migration sentinel",
      { sourceLandedSha: LANDED_SHA_BACKFILL_SENTINEL },
      "source-landing-unproven",
    ],
    ["unparseable timestamp", { updatedAtIso: "not-a-date" }, "indeterminate-idle-time"],
    ["missing timestamp", { updatedAtIso: null }, "indeterminate-idle-time"],
    ["inside the grace", { updatedAtIso: NOW }, "within-grace"],
  ];

  for (const [name, over, reason] of REFUSALS) {
    it(`${name} → none:${reason}`, () => {
      expect(decide(over)).toEqual({ action: "none", reason });
    });
  }

  it("a merger whose source is mid-flight is HELD, not closed", () => {
    // The stated constraint: a merger whose source has not landed yet is still
    // mid-flight — its fix may be re-attempted, or a second merger spawned.
    expect(decide({ sourceLandedSha: null }).action).toBe("none");
  });

  it("never stamps the `'backfill'` sentinel onto a second ticket", () => {
    // The sentinel is a guess an old migration recorded, not a landing.
    // Propagating it would launder that guess into a fresh-looking record.
    const d = decide({ sourceLandedSha: LANDED_SHA_BACKFILL_SENTINEL });
    expect(d.action).toBe("none");
    expect(JSON.stringify(d)).not.toContain(LANDED_SHA_BACKFILL_SENTINEL);
  });

  it("the sentinel matches the land policy's, so the two cannot drift", () => {
    expect(LANDED_SHA_BACKFILL_SENTINEL).toBe(POLICY_SENTINEL);
  });

  it("the grace exceeds the cron period, so the sweep cannot race a fresh merger", () => {
    // Same relationship `orphanTicketReaper`'s grace has to its cron, and pinned
    // for the same reason: a grace below the period is not a grace.
    expect(MERGER_OUTCOME_GRACE_SECONDS_DEFAULT).toBeGreaterThan(
      MERGER_OUTCOME_CRON_PERIOD_SECONDS,
    );
  });

  it("the structural clause is FIRST, so nothing above it can widen the scope", () => {
    // Every other refusal is checked against a candidate that is ALSO not a
    // merger: whatever else is wrong, `not-a-merger` must win.
    for (const [, over] of REFUSALS) {
      expect(decide({ ...over, isMerger: false }).reason).toBe("not-a-merger");
    }
  });
});

// ── disjointness with the sibling sweep ────────────────────────────────────

describe("action scope is disjoint from the unqueued-land sweep", () => {
  // The two SCAN overlapping rows. The guarantee is that their ACTIONS cannot:
  // one stands down on every merger, the other on every non-merger. Asserted in
  // BOTH directions — a one-directional test passes for an implementation that
  // acts on everything.
  const shared = {
    ticketId: "t",
    status: "done",
    landedSha: null,
    updatedAtIso: OLD,
    autoLandEnabled: true,
    instanceAutoLandEnabled: true,
    hasQueueRow: false,
  };

  it("the unqueued sweep never enqueues a merger", () => {
    const d = decideUnqueuedLandRescue(
      { ...shared, isMerger: true, hasBranch: true, dependencyDeferred: false },
      NOW,
      15 * 60,
    );
    expect(d.action).toBe("none");
    expect(d.reason).toBe("merger-redirects-to-source");
  });

  it("this sweep never closes a non-merger", () => {
    // Including one that is otherwise perfectly closeable.
    expect(decide({ isMerger: false, sourceLandedSha: SRC_SHA }).action).toBe("none");
  });

  it("the same ticket is acted on by AT MOST one of them", () => {
    for (const isMerger of [true, false]) {
      const mine = decideMergerOutcome(
        candidate({ isMerger, sourceLandedSha: SRC_SHA }),
        NOW,
        15 * 60,
      );
      const theirs = decideUnqueuedLandRescue(
        { ...shared, isMerger, hasBranch: true, dependencyDeferred: false },
        NOW,
        15 * 60,
      );
      const acting = [mine.action === "close", theirs.action === "enqueue"].filter(Boolean).length;
      expect(acting, `isMerger=${isMerger}`).toBeLessThanOrEqual(1);
    }
  });
});

// ── tenant scope: the co-located `.eq` is the entire boundary ──────────────

describe("tenant scoping, with a CONTROL per predicate", () => {
  function crossTenant(): Tables {
    return {
      tickets: [
        ticket("t-m", {
          requested_role: "release_engineer",
          parent_ticket_id: "t-src",
          tenant_id: T1,
        }),
        // The source belongs to ANOTHER tenant. Its sha must never be stamped
        // onto our ticket — that is a foreign commit recorded as our landing.
        ticket("t-src", { tenant_id: T2, landed_sha: SRC_SHA }),
      ],
      projects: [{ id: PROJ, tenant_id: T1, auto_land_enabled: true, integration_branch: "dev" }],
      integration_queue: [],
    };
  }

  const row = (): UnlandedMergerRow => ({
    id: "t-m",
    tenant_id: T1,
    project_id: PROJ,
    status: "done",
    landed_sha: null,
    updated_at: OLD,
    requested_role: "release_engineer",
    parent_ticket_id: "t-src",
  });

  it("a foreign source's sha is never read, so nothing is stamped", async () => {
    const tables = crossTenant();
    const { deps: d } = deps(tables);
    const res = await recordMergerOutcome(d, row());
    expect(res).toEqual({ ok: true, action: "none", reason: "source-not-settled" });
    expect(nth(tables, 0).landed_sha).toBeNull();
  });

  it("CONTROL: neutering the source read's tenant predicate DOES stamp it", async () => {
    // Without this the test above passes for a fake that ignores filters, and
    // proves nothing at all.
    const tables = crossTenant();
    const { deps: d } = deps(tables, { neuterTenantEqOn: ["tickets"] });
    const res = await recordMergerOutcome(d, row());
    expect(res).toMatchObject({ ok: true, action: "close", closed: true });
    expect(nth(tables, 0).landed_sha).toBe(SRC_SHA);
  });

  it("a foreign project's opt-in does not arm a project that opted out", async () => {
    const tables = crossTenant();
    nth(tables, 1).tenant_id = T1; // source is ours; only the project is not
    tables.projects = [
      { id: PROJ, tenant_id: T2, auto_land_enabled: true, integration_branch: "dev" },
    ];
    const { deps: d } = deps(tables);
    const res = await recordMergerOutcome(d, row());
    expect(res).toEqual({ ok: true, action: "none", reason: "auto-land-disabled-for-project" });
  });

  it("CONTROL: neutering the project read's tenant predicate DOES arm it", async () => {
    const tables = crossTenant();
    nth(tables, 1).tenant_id = T1;
    tables.projects = [
      { id: PROJ, tenant_id: T2, auto_land_enabled: true, integration_branch: "dev" },
    ];
    const { deps: d } = deps(tables, { neuterTenantEqOn: ["projects"] });
    expect(await recordMergerOutcome(d, row())).toMatchObject({ action: "close", closed: true });
  });

  it("a foreign queue row does not strand our merger", async () => {
    const tables = crossTenant();
    nth(tables, 1).tenant_id = T1;
    tables.integration_queue = [{ id: "q", ticket_id: "t-m", tenant_id: T2, status: "pending" }];
    expect(await recordMergerOutcome(deps(tables).deps, row())).toMatchObject({
      action: "close",
      closed: true,
    });
  });

  it("CONTROL: neutering the queue read's tenant predicate DOES strand it", async () => {
    const tables = crossTenant();
    nth(tables, 1).tenant_id = T1;
    tables.integration_queue = [{ id: "q", ticket_id: "t-m", tenant_id: T2, status: "pending" }];
    const { deps: d } = deps(tables, { neuterTenantEqOn: ["integration_queue"] });
    expect(await recordMergerOutcome(d, row())).toEqual({
      ok: true,
      action: "none",
      reason: "has-queue-row",
    });
  });

  it("the WRITE is tenant-scoped too — a foreign merger is never stamped", async () => {
    const tables = crossTenant();
    nth(tables, 0).tenant_id = T2; // the merger itself is foreign
    nth(tables, 1).tenant_id = T1;
    const { deps: d, recorded } = deps(tables);
    // The scan row still claims T1 (this is what a leaked row looks like), so
    // every read passes and only the write's own predicate can refuse.
    const res = await recordMergerOutcome(d, row());
    expect(res).toMatchObject({ action: "close", closed: false });
    expect(nth(tables, 0).landed_sha).toBeNull();
    // And no notice describing an outcome that did not happen.
    expect(recorded.notices).toHaveLength(0);
    expect(recorded.fanOut).toHaveLength(0);
  });
});

// ── unreadable facts fail closed ───────────────────────────────────────────

describe("every unreadable fact fails CLOSED", () => {
  const row = (): UnlandedMergerRow => ({
    id: "t-m",
    tenant_id: T1,
    project_id: PROJ,
    status: "done",
    landed_sha: null,
    updated_at: OLD,
    requested_role: "release_engineer",
    parent_ticket_id: "t-src",
  });

  function healthy(): Tables {
    return {
      tickets: [
        ticket("t-m", { requested_role: "release_engineer", parent_ticket_id: "t-src" }),
        ticket("t-src", { landed_sha: SRC_SHA }),
      ],
      projects: [{ id: PROJ, tenant_id: T1, auto_land_enabled: true, integration_branch: "dev" }],
      integration_queue: [],
    };
  }

  it("an unreadable queue reads as 'a row exists'", async () => {
    const c = await loadMergerOutcomeCandidate(
      {
        db: fakeClient(healthy(), { errorOn: ["integration_queue"] }),
        instanceAutoLandEnabled: true,
      },
      row(),
    );
    expect(c.hasQueueRow).toBe(true);
  });

  it("an unreadable source reads as 'not settled', never as a sha", async () => {
    const c = await loadMergerOutcomeCandidate(
      { db: fakeClient(healthy(), { errorOn: ["tickets"] }), instanceAutoLandEnabled: true },
      row(),
    );
    expect(c.sourceLandedSha).toBeNull();
  });

  it("a project-less merger spends no reads and stands down", async () => {
    const c = await loadMergerOutcomeCandidate(
      { db: fakeClient(healthy()), instanceAutoLandEnabled: true },
      { ...row(), project_id: null },
    );
    expect(c).toMatchObject({ autoLandEnabled: false, hasQueueRow: true, sourceLandedSha: null });
    expect(decideMergerOutcome(c, NOW, 15 * 60).action).toBe("none");
  });

  it("recordMergerOutcome never throws", async () => {
    const broken = {
      from: () => {
        throw new Error("boom");
      },
    } as unknown as SupabaseClient;
    const { deps: d } = deps(healthy(), { db: broken });
    await expect(recordMergerOutcome(d, row())).resolves.toMatchObject({ ok: false });
  });
});

// ── the record an operator reads ───────────────────────────────────────────

describe("the notice tells the truth about what happened", () => {
  const body = buildNothingToLandComment({
    branch: null,
    base: "dev",
    outcome: MERGER_NOTHING_TO_LAND_OUTCOME,
    sourceRef: "DevPilot-42",
  });

  it("says the merger had no branch of its own, and names the source", () => {
    expect(body).toContain("DevPilot-42");
    expect(body).toMatch(/never had a branch of its own/i);
  });

  it("does NOT claim the merger's own commits were merged", () => {
    // The sha recorded is the SOURCE's landing. Presenting it as this ticket's
    // own merge would be the one claim this outcome must not make.
    expect(body).toMatch(/not a separate merge of its own/i);
  });

  it("reads as a success, not a failure", () => {
    expect(body).toMatch(/successful outcome, not a failure/i);
  });

  it("the metadata is the same record the board already knows how to read", () => {
    const meta = buildNothingToLandMetadata({
      branch: null,
      base: "dev",
      outcome: MERGER_NOTHING_TO_LAND_OUTCOME,
      sourceTicketId: "t-src",
    });
    expect(meta.kind).toBe(NOTHING_TO_LAND_METADATA_KIND);
    expect(meta.outcome).toBe("merger_no_branch");
    expect(meta.source_ticket_id).toBe("t-src");
  });

  it("the two land-worker outcomes are unchanged by the third", () => {
    expect(
      buildNothingToLandComment({ branch: "devpilot/x", base: "dev", outcome: "no_commits" }),
    ).toMatch(/zero commits ahead/);
    expect(
      buildNothingToLandComment({ branch: "devpilot/x", base: "dev", outcome: "already_on_base" }),
    ).toMatch(/already on/);
  });
});

describe("a closed merger disappears from the not-landed list", () => {
  it("renders as a neutral nothing-to-land, never as a warning", () => {
    // End to end through the board's own derivation: the notice this sweep
    // writes is exactly the record `deriveLandingState` reads FIRST, so a closed
    // merger stops carrying a chip that says its work was lost.
    const state = deriveLandingState({
      landedSha: SRC_SHA,
      push: null,
      queue: null,
      nothingToLandNotice: { branch: null, base: "dev" },
    });
    expect(state.kind).toBe("nothing_to_land");
    expect(landingCardTreatment(state, "done")).not.toBe("warn");
  });

  it("but an unclosed merger still shows up — the list is not silenced", () => {
    const state = deriveLandingState({
      landedSha: null,
      push: { pushedAt: null, conflictState: "clean", unpushedCount: 42, branch: "devpilot/m" },
      queue: null,
      nothingToLandNotice: null,
    });
    expect(landingCardTreatment(state, "done")).toBe("warn");
  });
});
