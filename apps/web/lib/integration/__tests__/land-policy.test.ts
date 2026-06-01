// WI-4 — the land worker's decision core.

import { describe, expect, it } from "vitest";
import {
  assertSerializableLandEvent,
  decideLandable,
  decideReap,
  resolveLandedSha,
  LAND_HEARTBEAT_TIMEOUT_MS,
  LAND_SERIALIZATION,
  MAX_LAND_ATTEMPTS,
  type LandableInput,
  type ReapInput,
} from "@/lib/integration/land-policy";

const landable = (over: Partial<LandableInput> = {}): LandableInput => ({
  status: "done",
  hasBranch: true,
  landedSha: null,
  autoLandEnabled: true,
  hasIntegrationTarget: true,
  ...over,
});

describe("decideLandable", () => {
  it("lands a done ticket that has a branch", () => {
    expect(decideLandable(landable())).toEqual({ action: "land" });
  });

  it("CANCELS a ticket that was reverted to in_progress after being enqueued", () => {
    // The load-bearing negative. The dispatcher's TERMINAL_TICKET_STATES CONTAINS
    // `done`, so reusing it here would cancel exactly the tickets we exist to
    // land. This predicate is the opposite shape: done is the ONLY landable
    // state, and everything else is a withdrawn verdict.
    const d = decideLandable(landable({ status: "in_progress" }));
    expect(d.action).toBe("cancel");
    expect(d).toMatchObject({ reason: expect.stringContaining("in_progress") });
  });

  it("CANCELS a ticket parked to blocked (a WI-2 safety park / QA retry ceiling)", () => {
    // A parked ticket has no approved work. It must never be landed, and it must
    // never sit in the queue holding a lane.
    expect(decideLandable(landable({ status: "blocked" })).action).toBe("cancel");
  });

  it("cancels a done ticket with no branch — there is nothing to land", () => {
    expect(decideLandable(landable({ hasBranch: false })).action).toBe("cancel");
  });

  it("cancels when the project opted out, or has nowhere to land to", () => {
    expect(decideLandable(landable({ autoLandEnabled: false })).action).toBe("cancel");
    expect(decideLandable(landable({ hasIntegrationTarget: false })).action).toBe("cancel");
  });

  it("cancels a ticket that no longer exists", () => {
    expect(decideLandable(landable({ status: null })).action).toBe("cancel");
  });

  it("reports already_landed BEFORE anything else — a duplicate enqueue never re-merges", () => {
    // Checked first on purpose: a second enqueue for an already-landed ticket must
    // close its row out, not merge the branch a second time.
    expect(decideLandable(landable({ landedSha: "abc1234" }))).toEqual({
      action: "already_landed",
    });
    // …even if the ticket has since been reverted.
    expect(decideLandable(landable({ landedSha: "abc1234", status: "in_progress" })).action).toBe(
      "already_landed",
    );
  });
});

describe("resolveLandedSha — the crash-safe stamp", () => {
  it("resolves the sha from the REF when the merge says already-up-to-date (the 204 path)", () => {
    // THE bug this exists to prevent. A worker merges, then crashes before
    // stamping. Inngest replays. GitHub, asked to merge an already-merged branch,
    // correctly answers "already up to date" and returns NO SHA. Stamping the
    // merge response would write landed_sha = NULL on a row marked `landed` — a
    // silent half-land: the work IS on dev, nothing on the ticket says so, the row
    // is terminal so no reaper revisits it, and under WI-5 every dependent is
    // wedged out of `ready` forever while the board shows the parent as done.
    const r = resolveLandedSha({
      observation: { kind: "already_up_to_date" },
      devRefSha: "feed1234",
    });
    expect(r).toEqual({ ok: true, sha: "feed1234", alreadyUpToDate: true });
  });

  it("still takes the sha from the REF on a fresh merge, not from the merge response", () => {
    // The ref is the truth; the merge response is only ever a cross-check. One
    // code path, no branch on which the response is authoritative.
    const r = resolveLandedSha({
      observation: { kind: "merged", sha: "aaaa111" },
      devRefSha: "bbbb222",
    });
    expect(r).toEqual({ ok: true, sha: "bbbb222", alreadyUpToDate: false });
  });

  it("REFUSES to stamp when the ref cannot be resolved — never a NULL landing", () => {
    const r = resolveLandedSha({ observation: { kind: "merged", sha: "aaa" }, devRefSha: null });
    expect(r.ok).toBe(false);
  });

  it("refuses even on the already-up-to-date path when the ref is unreadable", () => {
    const r = resolveLandedSha({
      observation: { kind: "already_up_to_date" },
      devRefSha: null,
    });
    expect(r.ok).toBe(false);
  });
});

describe("decideReap", () => {
  const reap = (over: Partial<ReapInput> = {}): ReapInput => ({
    status: "landing",
    heartbeatAgeMs: LAND_HEARTBEAT_TIMEOUT_MS + 1,
    attempts: 1,
    landedOnDev: false,
    mergerStatus: null,
    ...over,
  });

  it("RECONCILES FORWARD when the branch is already on dev", () => {
    // A worker that merged and then died looks identical to one that died before
    // merging. Re-landing the first would try to merge a branch GitHub has already
    // merged, so the reaper's first question is always "is it already in?".
    expect(decideReap(reap({ landedOnDev: true })).action).toBe("stamp_landed");
  });

  it("reconciles forward regardless of how fresh the heartbeat is", () => {
    // Landed is landed. It doesn't become un-landed because a worker is alive.
    expect(decideReap(reap({ landedOnDev: true, heartbeatAgeMs: 0 })).action).toBe("stamp_landed");
  });

  it("leaves a `landing` row alone while its worker is still heartbeating", () => {
    expect(decideReap(reap({ heartbeatAgeMs: 1000 })).action).toBe("leave");
  });

  it("requeues a `landing` row whose worker died", () => {
    expect(decideReap(reap()).action).toBe("requeue");
  });

  it("fails a row that has burned its attempt ceiling", () => {
    expect(decideReap(reap({ attempts: MAX_LAND_ATTEMPTS })).action).toBe("fail");
  });

  it("does NOT time out a row parked on a live merger", () => {
    // Parked is not stale. It is legitimately parked for as long as the merger
    // takes (hours, potentially), and nothing is holding it. Timing it out would
    // spawn a second merger on top of a live one.
    expect(
      decideReap(
        reap({
          status: "awaiting_merge_resolution",
          mergerStatus: "in_progress",
          heartbeatAgeMs: 24 * 60 * 60_000,
        }),
      ).action,
    ).toBe("leave");
  });

  it("re-pends a parked row once its merger reaches done (the merger → retry edge)", () => {
    // Without this the source ticket is orphaned: done on the board, never on dev,
    // with nothing left to move it.
    expect(
      decideReap(reap({ status: "awaiting_merge_resolution", mergerStatus: "done" })).action,
    ).toBe("requeue");
  });

  it("re-pends a parked row whose merger vanished", () => {
    expect(
      decideReap(reap({ status: "awaiting_merge_resolution", mergerStatus: null })).action,
    ).toBe("requeue");
  });

  it("fails a parked row whose merger itself failed — the conflict needs a human", () => {
    expect(
      decideReap(reap({ status: "awaiting_merge_resolution", mergerStatus: "failed" })).action,
    ).toBe("fail");
  });
});

describe("LAND_SERIALIZATION — the property everything else rests on", () => {
  it("is limit 1, keyed on the PROJECT", () => {
    // Two workers landing into the same dev tip would each verify a tip the other
    // is about to move. The SQL claim does NOT provide this: FOR UPDATE SKIP
    // LOCKED is a single-ROW claim, so concurrent callers get DIFFERENT rows and
    // both proceed. This key is the actual mutex.
    expect(LAND_SERIALIZATION.limit).toBe(1);
    expect(LAND_SERIALIZATION.key).toBe("event.data.projectId");
  });

  it("refuses an event with no projectId — an undefined key serializes NOTHING", () => {
    // The failure mode is silent, which is what makes it dangerous: Inngest would
    // happily run every such invocation concurrently under the key `undefined`.
    expect(() => assertSerializableLandEvent({ tenantId: "t1", projectId: null })).toThrow(
      /concurrency key/i,
    );
    expect(() => assertSerializableLandEvent({ tenantId: "t1", projectId: undefined })).toThrow();
    expect(() => assertSerializableLandEvent({ tenantId: "t1", projectId: "" })).toThrow();
    expect(() => assertSerializableLandEvent({ tenantId: null, projectId: "p1" })).toThrow();
  });

  it("passes a well-formed event through", () => {
    expect(assertSerializableLandEvent({ tenantId: "t1", projectId: "p1" })).toEqual({
      tenantId: "t1",
      projectId: "p1",
    });
  });
});
