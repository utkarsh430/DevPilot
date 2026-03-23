// Source-scan guards for the 2026-08-03 deadlock.
//
// Two of the three modules involved (`dispatcher.ts`, the Inngest route) reach
// `server-only` chains and cannot load under Vitest — which is precisely the
// gap the defect lived in: `decideDispatchRescue`'s question was never asked
// anywhere, and no unit test could have noticed, because the thing that was
// missing was a WIRE, not a function.
//
// So these assert the shape of the source. They are deliberately about
// REACHABILITY ("can anything release a stalled queue row?"), which is the
// property that was false, rather than about behaviour, which the sibling
// suites cover.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("what can release a pending dispatch_queue row", () => {
  // THE DEADLOCK, stated as a property. Before this PR the answer was exactly
  // one thing — `agent/run.completed` — so a lost or never-sent completion
  // left the row immortal and the board wedged at its WIP limit with nothing
  // running. This test FAILS on the pre-fix tree: `dispatch-rescue.ts` does
  // not exist and the route registers no second releaser.
  it("has a releaser that does NOT depend on the completion event", () => {
    const route = read("app/api/inngest/route.ts");
    expect(route).toContain("dispatchRescueReaper");

    const rescue = read("lib/engine/dispatch-rescue.ts");
    // A cron trigger is the whole point: an event-triggered rescue would have
    // the same single point of failure as the thing it is rescuing.
    expect(rescue).toMatch(/cron:\s*"\*\/5 \* \* \* \*"/);
    // And it must not be listening on the very event that goes missing.
    expect(rescue).not.toContain('event: "agent/run.completed"');
  });

  it("both releasers go through the SAME atomic claim, so neither can double-release", () => {
    // `dispatch_queue_claim_next` is FOR UPDATE SKIP LOCKED → status='dispatched'
    // in one statement. A row claimed by either path is invisible to the other.
    expect(read("lib/engine/dispatch-queue.ts")).toContain("dispatch_queue_claim_next");
    expect(read("lib/engine/dispatch-rescue-store.ts")).toContain(
      'import { claimNext } from "@/lib/engine/dispatch-queue"',
    );
  });

  it("the rescue re-derives capacity from runs, never from ticket status", () => {
    const rescue = read("lib/engine/dispatch-rescue-store.ts");
    expect(rescue).toContain('.from("runs")');
    // A capacity number taken off `tickets` is the mistake this whole area
    // invites; the board's status column says nothing about whether an agent
    // is executing.
    expect(rescue).not.toContain('.from("tickets")');
  });
});

describe("the WIP gate itself is unchanged", () => {
  // The limit is correct; the accounting around it was wrong. Removing or
  // raising it would be worse than the bug — unbounded concurrency is what
  // makes the engine time out under load.
  it("still counts live runs against a per-agent limit", () => {
    const dispatcher = read("lib/engine/dispatcher.ts");
    expect(dispatcher).toContain('.in("status", ["running", "awaiting_human"])');
    expect(dispatcher).toContain("over: active >= agent.wipLimit");
  });
});

describe("who owns a ticket stranded by a failed/cancelled run", () => {
  // The brief asked whether the stuck sweeper's exclusion delegates to a
  // mechanism that does not exist. It does exist: `orphanTicketReaper`. It was
  // confirmed in production on 2026-08-03 to have fired and recovered two such
  // tickets. So the sweeper is NOT widened here, and these two assertions pin
  // the division of labour that makes the exclusion correct rather than a bug.
  it("the stuck sweeper still declines them (it owns latest-run-done only)", () => {
    const sweep = read("lib/engine/stuck-ticket-sweep.ts");
    expect(sweep).toContain('(latest.status as string) !== "done"');
  });

  it("the orphan reaper owns them, and stands down on a latest run of done", () => {
    const policy = read("lib/engine/orphan-ticket-policy.ts");
    // Non-overlap by construction: the two 5-minute crons can never both act.
    expect(policy).toContain('reason: "latest-run-done"');
    expect(policy).toContain('ORPHANABLE_TICKET_STATUSES = ["in_progress", "in_review"]');
  });

  it("its pending-dispatch stand-down is now backed by something that bounds the queue", () => {
    // Guard (b) stands down on a pending `dispatch_queue` row, reasoning that
    // the drain will release it. That reasoning was only true while a
    // completion event was still coming — which is exactly how three of the
    // five stranded tickets stayed stranded while two were recovered. The
    // reaper is unchanged; what changed is that the promise is now kept.
    const reaper = read("lib/engine/orphan-ticket-reaper.ts");
    expect(reaper).toContain('.eq("status", "pending")');
    expect(reaper).toContain("dispatch-rescue");
  });
});
