import { describe, expect, it } from "vitest";
import {
  newSessionPrefsSeed,
  shouldSkipPrefsSync,
  type PrefsSyncState,
} from "@/lib/plan/prefs-sync";

describe("shouldSkipPrefsSync", () => {
  it("never skips when nothing has been sent yet (null last-sent)", () => {
    expect(shouldSkipPrefsSync(null, { flavor: "mixed", prefs: "no AWS" })).toBe(false);
    // Even an empty current value patches on the very first sync.
    expect(shouldSkipPrefsSync(null, { flavor: "mixed", prefs: "" })).toBe(false);
  });

  it("skips when the last-sent value exactly matches the current", () => {
    const last: PrefsSyncState = { flavor: "oss", prefs: "prefer Vercel" };
    expect(shouldSkipPrefsSync(last, { flavor: "oss", prefs: "prefer Vercel" })).toBe(true);
  });

  it("patches when flavor differs", () => {
    const last: PrefsSyncState = { flavor: "oss", prefs: "prefer Vercel" };
    expect(shouldSkipPrefsSync(last, { flavor: "industry", prefs: "prefer Vercel" })).toBe(false);
  });

  it("patches when prefs differ", () => {
    const last: PrefsSyncState = { flavor: "oss", prefs: "prefer Vercel" };
    expect(shouldSkipPrefsSync(last, { flavor: "oss", prefs: "prefer Fly" })).toBe(false);
  });
});

describe("newSessionPrefsSeed - the data-loss regression", () => {
  // The bug: on the new-session start path the typed prefs are persisted by
  // startPlanSessionAction, but the old onStart then emptied the live `prefs`
  // draft (clearPrefsDraft) WITHOUT seeding the guard ref. The debounced
  // effect saw a changed, now-empty `prefs`, did NOT skip, and overwrote the
  // just-saved stack_preferences with "".
  const typed = "Postgres OK, no AWS, prefer Vercel";
  const flavor = "mixed" as const;

  it("reproduces the pre-fix overwrite: unseeded ref + emptied draft would patch away the prefs", () => {
    // Pre-fix state right before the debounced sync fires: ref never seeded,
    // draft blanked to "".
    const unseededRef: PrefsSyncState | null = null;
    const emptiedDraft: PrefsSyncState = { flavor, prefs: "" };
    // The effect would NOT skip → it would patch stack_preferences = "".
    expect(shouldSkipPrefsSync(unseededRef, emptiedDraft)).toBe(false);
  });

  it("post-fix: seeding the ref to the persisted value + keeping the draft in sync makes the first sync a no-op", () => {
    // onStart now seeds the ref to the persisted prefs AND sets local `prefs`
    // to the same value, so the effect observes an already-matched state.
    const seed = newSessionPrefsSeed(flavor, typed);
    const localDraftAfterFix: PrefsSyncState = { flavor, prefs: typed };
    expect(seed).toEqual({ flavor, prefs: typed });
    // The initial sync is skipped: the persisted stack_preferences survives.
    expect(shouldSkipPrefsSync(seed, localDraftAfterFix)).toBe(true);
  });

  it("post-fix still lets a genuine later edit through", () => {
    // After the seeded no-op, the operator edits prefs in the Refine view; the
    // effect must patch that real change.
    const seed = newSessionPrefsSeed(flavor, typed);
    const edited: PrefsSyncState = { flavor, prefs: `${typed} — also no Kafka` };
    expect(shouldSkipPrefsSync(seed, edited)).toBe(false);
  });

  it("handles an empty persisted prefs (operator typed nothing) without spurious patches", () => {
    // No prefs typed: persisted value is "". Seeding to "" + draft "" still
    // skips, so we don't churn a redundant write either.
    const seed = newSessionPrefsSeed(flavor, "");
    expect(shouldSkipPrefsSync(seed, { flavor, prefs: "" })).toBe(true);
  });
});
