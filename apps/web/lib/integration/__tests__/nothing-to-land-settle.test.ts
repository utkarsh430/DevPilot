import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  NOTHING_TO_LAND_REPAIR_PREFIX,
  decideNothingToLandSettle,
  type NothingToLandSettleInput,
} from "../nothing-to-land-settle";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

/**
 * DevPilot-7 as it actually sits in production: a review-only QA ticket, `done`,
 * with NO `landed_sha`, whose queue row was adjudicated by `20260745000000`.
 * Every test below is this row with exactly one fact changed, so a passing
 * assertion is always attributable to that one fact.
 */
function row(overrides: Partial<NothingToLandSettleInput> = {}): NothingToLandSettleInput {
  return {
    pushedAt: null,
    ticketId: "ticket-7",
    pushTenantId: TENANT,
    ticketTenantId: TENANT,
    ticketStatus: "done",
    landedSha: null,
    queueTenantId: TENANT,
    queueStatus: "cancelled",
    queuePrNumber: null,
    queueLastError:
      `${NOTHING_TO_LAND_REPAIR_PREFIX}the branch carried no commits the integration ` +
      `branch lacked, so GitHub refused the pull request (422). Recorded as a failure ` +
      `before DevPilot detected this case locally; repaired by migration 20260745000000. ` +
      `No pull request was opened and nothing was merged.`,
    queueMergeSha: null,
    otherUnsettledPushCount: 0,
    inFlightQueueCount: 0,
    ...overrides,
  };
}

describe("the justification: the branch provably reached origin", () => {
  it("settles the adjudicated review-only row", () => {
    expect(decideNothingToLandSettle(row())).toEqual({ action: "settle" });
  });

  it("does not depend on the branch being empty — a large unpushed_count is irrelevant", () => {
    // The production row reports `unpushed_count = 8`, because
    // `getUnpushedCommits` falls back to every commit reachable from HEAD when
    // `origin/<branch>` is absent. The rule takes NO input for it: safety here
    // comes from the commits being DELIVERED, not from there being none. If a
    // count could change the answer, this rule would be resting on a fact the
    // database cannot establish.
    expect(Object.keys(row())).not.toContain("unpushedCount");
  });

  it("refuses without the adjudicated verdict — a bare failed land is not evidence", () => {
    expect(decideNothingToLandSettle(row({ queueLastError: null }))).toEqual({
      action: "leave",
      reason: "no-nothing-to-land-verdict",
    });
    // The raw 422 the repair CONSUMED is itself not enough: this rule reads the
    // adjudication, not the symptom, so an unrepaired row stays visible.
    expect(
      decideNothingToLandSettle({
        ...row(),
        queueStatus: "failed",
        queueLastError: "GitHub 422 on /repos/o/r/pulls: Validation Failed",
      }),
    ).toEqual({ action: "leave", reason: "queue-not-cancelled" });
  });

  it("refuses when a pull request was opened or a merge recorded", () => {
    // These are the two facts that make the recorded 422 a "no commits between"
    // rather than "a pull request already exists" — the shape that describes a
    // world where the branch really did carry work.
    expect(decideNothingToLandSettle(row({ queuePrNumber: 41 }))).toEqual({
      action: "leave",
      reason: "pull-request-exists",
    });
    expect(decideNothingToLandSettle(row({ queueMergeSha: "c921359" }))).toEqual({
      action: "leave",
      reason: "merge-recorded",
    });
  });
});

describe("the data-loss constraint: a genuinely-pending push is still counted", () => {
  // `pushed_at` non-null releases `decideWorkspaceReap`, so a row settled
  // without proof is a route to deleting the only copy of a commit. Leaving the
  // row means `pushed_at` stays NULL, which is exactly what every badge query
  // (`.is("pushed_at", null)`) counts — the badge is not made blind, the row
  // simply stays out of scope.

  it("leaves a working ticket's unpushed branch alone", () => {
    // The two production rows on `input_required` tickets. These may hold real
    // commits that reached no remote; nothing here proves otherwise.
    for (const status of ["input_required", "in_progress", "blocked", "in_review"]) {
      expect(decideNothingToLandSettle(row({ ticketStatus: status }))).toEqual({
        action: "leave",
        reason: "ticket-not-done",
      });
    }
  });

  it("leaves a row with no adjudicating queue row at all", () => {
    expect(
      decideNothingToLandSettle(
        row({ queueStatus: null, queueLastError: null, queueTenantId: null }),
      ),
    ).toEqual({ action: "leave", reason: "no-queue-row" });
  });

  it("leaves a ticket-less row — nothing can adjudicate it", () => {
    expect(decideNothingToLandSettle(row({ ticketId: null }))).toEqual({
      action: "leave",
      reason: "no-ticket",
    });
  });

  it("leaves an already-settled row, never overwriting a genuine push timestamp", () => {
    expect(decideNothingToLandSettle(row({ pushedAt: "2026-07-15T18:53:40Z" }))).toEqual({
      action: "leave",
      reason: "already-settled",
    });
  });

  it("leaves both rows when a ticket carries two unsettled pushes", () => {
    // The verdict names a TICKET; the settle names a ROW. Settling one on the
    // other's evidence is exactly the orphaned-push confusion #140 fixed.
    expect(decideNothingToLandSettle(row({ otherUnsettledPushCount: 1 }))).toEqual({
      action: "leave",
      reason: "ambiguous-push-rows",
    });
  });

  it("leaves a row whose land is still in flight", () => {
    expect(decideNothingToLandSettle(row({ inFlightQueueCount: 1 }))).toEqual({
      action: "leave",
      reason: "land-in-flight",
    });
  });
});

describe("non-overlap with 20260749000000 is by construction", () => {
  it("declines any ticket carrying a landed_sha", () => {
    // #156 owns every landed ticket and justifies itself off that column. This
    // repair is its exact complement, so the two can never both act on one row.
    expect(decideNothingToLandSettle(row({ landedSha: "c9213591b0" }))).toEqual({
      action: "leave",
      reason: "landed-sha-present",
    });
  });

  it("declines the 'backfill' sentinel — a guess is not evidence", () => {
    // The four out-of-scope production rows. `'backfill'` records that an
    // earlier process PRESUMED the work landed; whether such a guess may ever
    // settle a push row is a decision the operator has not made.
    expect(decideNothingToLandSettle(row({ landedSha: "backfill" }))).toEqual({
      action: "leave",
      reason: "landed-sha-present",
    });
  });
});

describe("tenant scope is the whole boundary", () => {
  // Service-role repair, RLS off. A foreign verdict settling a local row would
  // mark another workspace's genuinely unpushed work as pushed — dropping it
  // off their badge and releasing their reap guard.

  it("refuses a justification drawn from another tenant's ticket", () => {
    expect(decideNothingToLandSettle(row({ ticketTenantId: OTHER_TENANT }))).toEqual({
      action: "leave",
      reason: "ticket-tenant-mismatch",
    });
  });

  it("refuses a verdict drawn from another tenant's queue row", () => {
    expect(decideNothingToLandSettle(row({ queueTenantId: OTHER_TENANT }))).toEqual({
      action: "leave",
      reason: "queue-tenant-mismatch",
    });
  });

  it("CONTROL: the same row settles once both tenants match", () => {
    // Without this, the two assertions above would pass for a rule that refused
    // everything.
    expect(
      decideNothingToLandSettle(row({ ticketTenantId: TENANT, queueTenantId: TENANT })),
    ).toEqual({ action: "settle" });
  });
});

describe("the migration applies the same rule", () => {
  // `20260750000000` is SQL and cannot be imported, so the binding between it
  // and the rule above is a source scan — the `landed-push-wiring.test.ts`
  // posture. Without it the two could drift into disagreeing about scope, and
  // the SQL is the half that actually runs against production.
  const sql = readFileSync(
    join(
      process.cwd(),
      "../../supabase/migrations/20260750000000_settle_nothing_to_land_pending_pushes.sql",
    ),
    "utf8",
  );

  it.each([
    ["only unsettled rows", "p.pushed_at  is null"],
    ["ticket-bound rows only", "p.ticket_id  is not null"],
    ["ticket tenant scope", "p.tenant_id  = t.tenant_id"],
    ["queue tenant scope", "q.tenant_id  = p.tenant_id"],
    ["done tickets only", "t.status     = 'done'"],
    ["non-overlap with 20260749000000", "t.landed_sha is null"],
    ["the adjudicated verdict", "q.status     = 'cancelled'"],
    ["no pull request was opened", "q.pr_number  is null"],
    ["nothing was merged", "q.merge_sha  is null"],
    ["the repair's provenance marker", "q.last_error like 'nothing to land: %'"],
  ])("carries the %s clause", (_label, clause) => {
    expect(sql).toContain(clause);
  });

  it("carries both ambiguity guards", () => {
    expect(sql).toContain("from public.pending_pushes p2");
    expect(sql).toContain("p2.pushed_at is null");
    expect(sql).toContain("from public.integration_queue q2");
    expect(sql).toContain("q2.status in ('pending', 'landing', 'awaiting_merge_resolution')");
  });

  it("never widens 20260749000000's predicate", () => {
    // The whole point: this row is settled on its OWN justification. If a later
    // edit relaxes #156 to sweep it in instead, that predicate stops protecting
    // a genuinely-unpushed branch.
    const prior = readFileSync(
      join(
        process.cwd(),
        "../../supabase/migrations/20260749000000_settle_landed_pending_pushes.sql",
      ),
      "utf8",
    );
    expect(prior).toContain("t.landed_sha is not null");
    expect(prior).toContain("t.landed_sha <> 'backfill'");
  });

  it("stamps the adjudication time, not now()", () => {
    // `now()` would date a push that happened in 2026-07 to whenever this is
    // applied, which is a worse record than the one being repaired.
    expect(sql).toContain("set pushed_at  = coalesce(q.updated_at, now())");
  });
});
