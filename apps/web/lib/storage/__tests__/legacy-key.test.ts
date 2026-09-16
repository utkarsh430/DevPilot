import { describe, expect, it, vi, afterEach } from "vitest";
import { getItemWithLegacy } from "@/lib/storage/legacy-key";

const KEY = "devpilot:readiness:dismissed";
const LEGACY = "ace:readiness:dismissed";

/** Minimal in-memory localStorage; `failWrites` models Safari private mode. */
function installStorage(seed: Record<string, string>, opts?: { failWrites?: boolean }) {
  const store = new Map(Object.entries(seed));
  const storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (opts?.failWrites) throw new DOMException("QuotaExceededError");
      store.set(k, v);
    },
    removeItem: (k: string) => {
      if (opts?.failWrites) throw new DOMException("QuotaExceededError");
      store.delete(k);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("getItemWithLegacy", () => {
  it("returns the new key's value and never touches the legacy one", () => {
    const store = installStorage({ [KEY]: "1", [LEGACY]: "stale" });
    expect(getItemWithLegacy(KEY, LEGACY)).toBe("1");
    // The legacy key is not consulted, so a stale copy can't win.
    expect(store.get(LEGACY)).toBe("stale");
  });

  it("falls back to the legacy key and migrates it forward", () => {
    const store = installStorage({ [LEGACY]: "1" });
    expect(getItemWithLegacy(KEY, LEGACY)).toBe("1");
    expect(store.get(KEY)).toBe("1");
    expect(store.has(LEGACY)).toBe(false);
  });

  it("returns null when neither key is present", () => {
    installStorage({});
    expect(getItemWithLegacy(KEY, LEGACY)).toBeNull();
  });

  it("distinguishes an empty-string value from an absent key", () => {
    // getItem returns "" (not null) for an empty value, so the fallback must
    // NOT fire — otherwise a deliberately-cleared key resurrects the legacy one.
    const store = installStorage({ [KEY]: "", [LEGACY]: "1" });
    expect(getItemWithLegacy(KEY, LEGACY)).toBe("");
    expect(store.get(LEGACY)).toBe("1");
  });

  it("still returns the legacy value when the migration write fails", () => {
    // Read-only storage: we know the value, so hand it back rather than
    // reporting "not set" and re-showing a dismissed one-time surface.
    installStorage({ [LEGACY]: "1" }, { failWrites: true });
    expect(getItemWithLegacy(KEY, LEGACY)).toBe("1");
  });

  it("propagates a read failure instead of swallowing it as null", () => {
    // Each caller has its own storage-unavailable policy; the helper must not
    // silently rewrite them by returning null.
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new DOMException("SecurityError");
        },
      },
    });
    expect(() => getItemWithLegacy(KEY, LEGACY)).toThrow();
  });
});
