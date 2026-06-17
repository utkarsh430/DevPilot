// "A landing settles its push row" — asserted as a property of EVERY landing
// path, not of the two that happened to remember.
//
// WHY A SOURCE SCAN. `lib/engine/land-worker.ts` and `lib/integration/
// queue.server.ts` both reach `server-only`, so neither loads under Vitest —
// the same reason `nothing-to-land-wiring.test.ts` scans source. And that is
// exactly the gap this defect lived in: the settle was correct wherever it was
// written, and nothing anywhere asserted it was written everywhere. Two of the
// four `stampLanded` call sites did the full post-land fan-out and left the push
// row `pushed_at IS NULL` forever.
//
// Every assertion below is mutation-verified: dropping the settle out of
// `stampLanded`, or re-inlining a `pending_pushes` write in the worker, or
// passing a bare `null` push id from a site that has one in hand, turns one red.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const WORKER = read("lib/engine/land-worker.ts");
const QUEUE = read("lib/integration/queue.server.ts");

describe("stampLanded owns the push settle", () => {
  // THE STRUCTURAL GUARANTEE. The settle lives inside the one function that
  // writes `tickets.landed_sha`, so "landed" and "push settled" are one write
  // path rather than a convention each call site re-implements.
  it("calls settleLandedPush from inside stampLanded", () => {
    const fn = QUEUE.slice(
      QUEUE.indexOf("export async function stampLanded"),
      QUEUE.indexOf("export async function moveQueueRow"),
    );
    expect(fn).toContain("settleLandedPush(supabase, {");
    expect(fn).toContain("pendingPushId: args.pendingPushId");
    expect(fn).toContain("tenantId: args.tenantId");
  });

  // REQUIRED, not optional. Optional is what the original bug looked like — a
  // fact available at the call site that nobody passed. A new landing path is a
  // compile error until it decides what happens to the push row.
  it("declares tenantId and pendingPushId as required parameters", () => {
    const sig = QUEUE.slice(
      QUEUE.indexOf("export async function stampLanded"),
      QUEUE.indexOf("}): Promise<{ stamped: boolean; sha: string }>"),
    );
    expect(sig).toContain("tenantId: string;");
    expect(sig).toContain("pendingPushId: string | null;");
    // Not `tenantId?:` / `pendingPushId?:` — an optional one is forgettable.
    expect(sig).not.toMatch(/tenantId\?:/);
    expect(sig).not.toMatch(/pendingPushId\?:/);
  });

  it("is the only place pending_pushes.pushed_at is written on the landing path", () => {
    // The worker used to carry two inline copies of this write and miss two
    // sites. A re-inlined copy is how the two drift apart again.
    expect(WORKER).not.toContain("pushed_at: new Date().toISOString()");
  });
});

describe("every stampLanded call site threads its push row", () => {
  const CALLS = [...WORKER.matchAll(/stampLanded\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);

  it("finds all four landing paths", () => {
    expect(CALLS).toHaveLength(4);
  });

  it("passes tenantId and pendingPushId at every one of them", () => {
    for (const call of CALLS) {
      expect(call, `missing tenantId in: ${call}`).toMatch(/tenantId[,:]/);
      expect(call, `missing pendingPushId in: ${call}`).toContain("pendingPushId:");
    }
  });

  // The two that used to leak. Both had the push in hand the whole time — the
  // reaper had already read `ctx.pendingPush.branch` to decide the ticket had
  // landed at all — so neither is entitled to pass a bare `null`.
  it("resolves the push from context on the two paths that previously leaked", () => {
    const alreadyLanded = CALLS.find((c) => c.includes("sha: ctx!.landedSha!"));
    const reaper = CALLS.find((c) => c.includes("ticketId: row.ticket_id"));
    expect(alreadyLanded).toBeDefined();
    expect(reaper).toBeDefined();
    expect(alreadyLanded).toContain("pendingPushId: ctx?.pendingPush?.id ?? null");
    expect(reaper).toContain("pendingPushId: ctx?.pendingPush?.id ?? null");
  });
});
