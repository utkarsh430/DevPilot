"use client";

import * as React from "react";

const DEBOUNCE_MS = 200;

/**
 * Mirror a string value into `localStorage` at `key` so an accidental
 * refresh doesn't drop a half-typed composer or pre-session form. Pass
 * `key=null` to disable persistence (e.g. when the canonical store — a
 * Supabase row — has taken over).
 *
 * Behaviour:
 *  - On mount (or when `key` changes): reads `key` from storage and
 *    overrides the current value if a non-empty entry is present.
 *  - On change: debounced write; empty strings remove the entry.
 *  - `clear()` resets to `initial` and removes the storage entry.
 *
 * Returns `[value, setValue, clear]`.
 */
export function useDraft(
  key: string | null,
  initial: string,
): [string, React.Dispatch<React.SetStateAction<string>>, () => void] {
  const [value, setValue] = React.useState<string>(initial);
  const hydratedFor = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (key === null) {
      hydratedFor.current = null;
      return;
    }
    if (hydratedFor.current === key) return;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null && stored.length > 0) {
        setValue(stored);
      }
    } catch {
      // Storage may be disabled (privacy mode / SSR); fall through silently.
    }
    hydratedFor.current = key;
  }, [key]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (key === null) return;
    if (hydratedFor.current !== key) return;
    const t = window.setTimeout(() => {
      try {
        if (value.length === 0) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, value);
        }
      } catch {
        // ignore
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [key, value]);

  const clear = React.useCallback(() => {
    setValue(initial);
    if (typeof window === "undefined") return;
    if (key === null) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }, [key, initial]);

  return [value, setValue, clear];
}
