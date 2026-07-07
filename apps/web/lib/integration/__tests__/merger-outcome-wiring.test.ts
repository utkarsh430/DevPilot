// The wiring half of "a finished merger is never given a landing outcome".
//
// WHY A SOURCE SCAN. `lib/engine/merger-outcome-reaper.ts` pulls in
// `supabaseService`, `transitions.ts` and the Inngest client, all of which reach
// `server-only`, so it cannot be imported under Vitest - the same reason
// `unqueued-land-wiring.test.ts` and `nothing-to-land-wiring.test.ts` scan
// source. That is precisely the gap this class of defect lives in: the pure rule
// is testable and the SCOPE it sits in is covered by nothing.
//
// Every assertion below is mutation-verified: reaching for `enqueueForLanding`,
// widening a sibling's scan, dropping the disjointness clause, borrowing the
// reconciler's author id, or forgetting the route registration turns a test here
// red.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Strip comments so PROSE about a thing never trips the scan for it.
 *
 * Not optional here and worth stating: every module in this change explains at
 * length why it does NOT call `enqueueForLanding` and does NOT author as
 * `devpilot_move_ticket`. A raw substring scan reads those explanations as the
 * violations they warn against, so the scan would fail on correct code — and the
 * obvious "fix" is to delete the explanation, which is the worst outcome
 * available. Same stripper as `lib/activity/__tests__/read-only.test.ts`.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const code = (rel: string) => stripComments(read(rel));

const POLICY = code("lib/integration/merger-outcome-policy.ts");
const STORE = code("lib/integration/merger-outcome-store.ts");
const REAPER = code("lib/engine/merger-outcome-reaper.ts");
const UNQUEUED_POLICY = read("lib/integration/unqueued-land-policy.ts");
const UNQUEUED_STORE = read("lib/integration/unqueued-land-store.ts");
const WORKER = read("lib/engine/land-worker.ts");
const RESCUE_REAPER = read("lib/engine/land-rescue-reaper.ts");
const ROUTE = read("app/api/inngest/route.ts");

describe("THE TWO CLAUSES THE TASK SAID NOT TO TOUCH ARE UNTOUCHED", () => {
  it("the unqueued sweep still stands down on every merger, unconditionally", () => {
    // Verbatim. `enqueueForLanding` redirects a finished merger to its source,
    // so enqueueing the merger itself would be meaningless - this fix records an
    // outcome instead, and changes nothing about that.
    expect(UNQUEUED_POLICY).toContain(
      'if (candidate.isMerger) return { action: "none", reason: "merger-redirects-to-source" };',
    );
  });

  it("`enqueueForLanding`'s merger redirect is still the seam's own rule", () => {
    // `decideMergerRelease` is untouched and is still what both the seam and
    // both sweeps use to decide what a merger is.
    expect(UNQUEUED_STORE).toContain("decideMergerRelease({");
    expect(STORE).toContain("decideMergerRelease({");
  });
});

describe("this sweep never enqueues, lands, or merges anything", () => {
  it("does not reach for the queue seam at all", () => {
    for (const src of [POLICY, STORE, REAPER]) {
      expect(src).not.toContain("enqueueForLanding");
      expect(src).not.toContain("emitLandNeeded");
      expect(src).not.toContain("claimNextLand");
    }
  });

  it("writes exactly one table, and it is `tickets`", () => {
    // The record of an outcome that was already true - not a landing.
    const writes = STORE.match(/\.from\("(\w+)"\)[\s\S]{0,120}?\.update\(/g) ?? [];
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('.from("tickets")');
    for (const write of [".insert(", ".upsert(", ".delete("]) {
      expect(STORE).not.toContain(write);
    }
    expect(STORE).not.toMatch(/\.from\("integration_queue"\)[\s\S]{0,200}?\.update\(/);
  });

  it("the stamp is CAS-guarded on `landed_sha IS NULL`", () => {
    // Two overlapping ticks, or this sweep and a late-waking land worker, can
    // never both claim the ticket - and the loser writes nothing further.
    expect(STORE).toMatch(
      /\.from\("tickets"\)[\s\S]{0,300}?\.is\("landed_sha", null\)[\s\S]{0,60}?\.select\("id"\)/,
    );
    expect(STORE).toContain('return { closed: false, reason: "already-closed" }');
  });
});

describe("scope stays disjoint from all four siblings", () => {
  it("the queue-driven sweeps are untouched", () => {
    expect(WORKER).toContain('.in("status", ["landing", "awaiting_merge_resolution"])');
    expect(RESCUE_REAPER).toContain('.eq("status", "pending")');
  });

  it("this sweep pre-filters to mergers in SQL and re-derives it in the policy", () => {
    // The SQL filter is a COST filter. The guard is the policy's first clause,
    // so a loosened scan can never widen what this acts on.
    expect(STORE).toContain('.eq("requested_role", "release_engineer")');
    expect(STORE).toContain('.not("parent_ticket_id", "is", null)');
    expect(POLICY).toContain(
      'if (!candidate.isMerger) return { action: "none", reason: "not-a-merger" };',
    );
  });

  it("the disjointness clause is the FIRST thing the policy checks", () => {
    // Anything above it would make the scope a matter of reading the code rather
    // than a property of it.
    const body = POLICY.slice(POLICY.indexOf("export function decideMergerOutcome"));
    const first = body.indexOf("if (!candidate.isMerger)");
    const anyOther = body.indexOf("if (!candidate.instanceAutoLandEnabled)");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(anyOther);
  });
});

describe("the record it writes is the one the board already reads", () => {
  it("posts under `devpilot_nothing_to_land`, NEVER `devpilot_move_ticket`", () => {
    // The ticket reconciler string-matches `devpilot_move_ticket` to mean "an
    // agent rendered a verdict"; borrowing it here would fake one.
    expect(REAPER).toContain("authorId: NOTHING_TO_LAND_AUTHOR_ID");
    expect(REAPER).toContain('authorType: "system"');
    for (const src of [POLICY, STORE, REAPER]) {
      expect(src).not.toContain("devpilot_move_ticket");
    }
  });

  it("records the merger outcome kind, not one of the land worker's two", () => {
    expect(STORE).toContain(
      'MERGER_NOTHING_TO_LAND_OUTCOME: NothingToLandOutcome = "merger_no_branch"',
    );
    expect(STORE).toContain("outcome: MERGER_NOTHING_TO_LAND_OUTCOME");
  });

  it("fires the same post-land fan-out `closeNothingToLand` does", () => {
    // Everything downstream keys off `landed_sha`, not off HOW it was reached.
    // A stamp nobody was told about leaves a dependent waiting on a blocker that
    // has already closed.
    expect(REAPER).toContain('name: "branch/parent-landed"');
    expect(REAPER).toContain("promoteUnblockedDependents({ blockerTicketId: ticketId, tenantId })");
    expect(REAPER).toContain('name: "ticket-drain/requested"');
  });

  it("uses `sendEventBounded`, never a raw `inngest.send`", () => {
    // A hang is not an error: an unbounded send never rejects, so the statements
    // after it would simply never execute - and this sweep runs precisely when
    // the landing layer, and therefore the event endpoint, has been unwell.
    expect(REAPER).toContain("sendEventBounded(");
    expect(REAPER).not.toMatch(/\binngest\.send\(/);
  });
});

describe("every read and the write are tenant-scoped", () => {
  // Service-role, RLS off. What a missing predicate produces here is a
  // `landed_sha` stamped on ANOTHER TENANT'S ticket - marking their work shipped
  // and releasing every ticket blocked behind it.
  it("scopes the queue, project and source reads plus the stamp", () => {
    const scoped = STORE.match(/\.eq\("tenant_id", (tenantId|args\.tenantId)\)/g) ?? [];
    // queue + project + source + notice-context project + notice-context source
    // + the stamp itself.
    expect(scoped.length).toBeGreaterThanOrEqual(6);
    expect(STORE).toMatch(
      /\.from\("tickets"\)[\s\S]{0,300}?\.eq\("tenant_id", args\.tenantId\)[\s\S]{0,120}?\.is\("landed_sha", null\)/,
    );
  });

  it("tenantId comes off the SCAN ROW, never a caller", () => {
    expect(STORE).toContain("const tenantId = row.tenant_id;");
    expect(STORE).not.toMatch(
      /tenantId\s*[:?]\s*string;?\s*\n\s*\}\s*\)\s*:\s*Promise<MergerOutcomeSweepResult>/,
    );
  });
});

describe("the cron is registered and gated", () => {
  it("runs at the cadence the grace is pinned against", () => {
    expect(REAPER).toContain('{ cron: "*/5 * * * *" }');
  });

  it("is gated on the kill switch in the cron AND as a policy clause", () => {
    expect(REAPER).toContain("if (!isAutoLandEnabled()) return { skipped:");
    expect(REAPER).toContain("instanceAutoLandEnabled: isAutoLandEnabled()");
  });

  it("is registered on the Inngest route", () => {
    expect(ROUTE).toContain(
      'import { mergerOutcomeReaper } from "@/lib/engine/merger-outcome-reaper"',
    );
    expect(ROUTE).toMatch(/^\s*mergerOutcomeReaper,$/m);
  });

  it("the policy and store stay loadable under Vitest", () => {
    // The whole reason the fan-out is injected. A `server-only` import in either
    // silently removes this sweep from the suite.
    for (const src of [POLICY, STORE]) {
      expect(src).not.toMatch(/^import "server-only";/m);
      expect(src).not.toMatch(/from "@\/lib\/board\/transitions"/);
      expect(src).not.toMatch(/from "@\/lib\/integration\/queue\.server"/);
    }
  });
});
