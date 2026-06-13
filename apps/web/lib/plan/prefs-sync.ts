// Plan preferences debounced-sync guard - the pure decision behind the
// PlanSheet's `stack_flavor` / `stack_preferences` debounced patch.
//
// The Refine view mirrors local (flavor, prefs) edits into the DB row on an
// 800ms debounce. To avoid a redundant (or destructive) write the moment a
// session first appears in local state, the effect skips its patch when the
// last-sent value already matches the current one.
//
// Extracted from the component (`.tsx` can't load under Vitest) so the
// skip decision and the new-session seed value are unit-testable without a
// DB, mirroring how the revamp extracted `stage-rail.ts` / `provenance.ts`.
//
// WHY THIS EXISTS (the bug it pins): on the new-session start path the typed
// stack preferences are persisted by `startPlanSessionAction`, but the old
// `onStart` then called `clearPrefsDraft()` which emptied the live `prefs`
// state. With the guard ref left unseeded, the debounced effect saw a
// changed (now-empty) `prefs`, didn't skip, and ~800ms later overwrote the
// just-saved `stack_preferences` with "". Seeding the ref to the persisted
// value (and setting `prefs` to it) makes that first sync a genuine no-op.

import type { StackFlavor } from "@/lib/plan/types";

/** The (flavor, prefs) pair the debounced sync compares and patches. */
export type PrefsSyncState = { flavor: StackFlavor; prefs: string };

/**
 * The debounced prefs-sync skips its DB patch when the last value it sent
 * already matches the current (flavor, prefs). `lastSent === null` (never
 * synced) never matches, so a genuine first edit still patches.
 */
export function shouldSkipPrefsSync(
  lastSent: PrefsSyncState | null,
  current: PrefsSyncState,
): boolean {
  return (
    lastSent !== null && lastSent.flavor === current.flavor && lastSent.prefs === current.prefs
  );
}

/**
 * The value to seed the guard ref (AND the local `prefs` draft) with when a
 * new session is created, so the first debounced sync is a no-op instead of
 * clobbering the just-persisted `stack_preferences`. `persistedPrefs` is the
 * session row's `stackPreferences` (what the server actually saved); `flavor`
 * is the local flavor state the effect will observe (unchanged by start).
 */
export function newSessionPrefsSeed(flavor: StackFlavor, persistedPrefs: string): PrefsSyncState {
  return { flavor, prefs: persistedPrefs };
}
