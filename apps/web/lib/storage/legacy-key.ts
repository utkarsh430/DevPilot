// Read-through for browser storage keys renamed by the ACE → DevPilot rename.
//
// The rename moved every localStorage key from the `ace*` namespace to
// `devpilot*`. A plain rename would silently reset the operator's saved state:
// their theme reverts to "system", the dismissed onboarding checklist and the
// one-time coach marks all resurface. Those flags are the whole point of being
// shown once, so they get a read-through instead: read the new key, fall back
// to the pre-rename one, and migrate it forward on the first hit.
//
// Deliberately NOT migrated (they simply reset, and that is fine): the plain
// board view preferences (`devpilot:board:{collapsed,hideEmpty,density,groupByRole}`).
// They are cheap to re-set and carry no "you have already seen this" meaning.
//
// This helper does NOT swallow storage errors. `localStorage` throws in Safari
// private mode and under quota pressure, and each caller has its own deliberate
// policy for that case (the checklist stays visible, the nudge goes inert). A
// helper that returned null on error would quietly rewrite those policies, so
// reads propagate exactly as a bare `getItem` would. Only the migration WRITE is
// best-effort: a browser that can read but not write still gets its value back.

/**
 * `localStorage.getItem(key)`, falling back to `legacyKey` and migrating the
 * value forward (write new, delete legacy) when only the legacy key is present.
 *
 * Throws whatever `localStorage.getItem` throws — call it inside the try/catch
 * the caller already has.
 */
export function getItemWithLegacy(key: string, legacyKey: string): string | null {
  const value = window.localStorage.getItem(key);
  if (value !== null) return value;

  const legacy = window.localStorage.getItem(legacyKey);
  if (legacy === null) return null;

  try {
    window.localStorage.setItem(key, legacy);
    window.localStorage.removeItem(legacyKey);
  } catch {
    // Read-only storage (quota, private mode): we still know the value, so hand
    // it back. The migration just retries on the next read.
  }
  return legacy;
}
