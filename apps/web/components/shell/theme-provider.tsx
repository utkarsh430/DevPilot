"use client";

import * as React from "react";
import { getItemWithLegacy } from "@/lib/storage/legacy-key";

export type Theme = "light" | "dark" | "system" | "daylight" | "lilac-cream" | "blush-butter";

export type ThemeMode = "light" | "dark";

export type ThemeDescriptor = {
  value: Theme;
  label: string;
  /** Short tagline shown under the swatch. */
  tagline: string;
  /** "auto" = follows OS pref; otherwise the surface mode of the theme. */
  mode: ThemeMode | "auto";
  /** Anchor hex pair (background, accent). null for `system`. */
  swatch: { bg: string; fg: string } | null;
};

// Order is the display order of every theme picker (appearance page, topbar
// dropdown): Match system first, then the classic DevPilot identity pair, then
// the named palettes.
export const THEMES: ReadonlyArray<ThemeDescriptor> = [
  {
    value: "system",
    label: "Match system",
    tagline: "Follows OS appearance",
    mode: "auto",
    swatch: null,
  },
  {
    value: "dark",
    label: "DevPilot Dark",
    tagline: "Night shift · ink & signal",
    mode: "dark",
    swatch: { bg: "#0E1116", fg: "#F98A2B" },
  },
  {
    value: "light",
    label: "DevPilot Light",
    tagline: "Day shift · porcelain & signal",
    mode: "light",
    swatch: { bg: "#F8F7F3", fg: "#C4560C" },
  },
  {
    value: "daylight",
    label: "DevPilot Daylight",
    tagline: "Porcelain, warmed \u00b7 cream & signal",
    mode: "light",
    swatch: { bg: "#EEE8DD", fg: "#B93704" },
  },
  {
    value: "lilac-cream",
    label: "Lilac & Cream",
    tagline: "Buttery cream · mauve",
    mode: "light",
    swatch: { bg: "#FEFBCE", fg: "#C8A2C9" },
  },
  {
    value: "blush-butter",
    label: "Blush & Butter",
    tagline: "Golden butter · dusty rose",
    mode: "light",
    swatch: { bg: "#F3D98F", fg: "#E36887" },
  },
];

export const DEFAULT_THEME: Theme = "system";
const NAMED_PALETTE_THEMES = new Set<Theme>(["daylight", "lilac-cream", "blush-butter"]);
const VALID_THEMES = new Set<Theme>(THEMES.map((t) => t.value));

type Ctx = {
  theme: Theme;
  resolvedMode: ThemeMode;
  setTheme: (t: Theme) => void;
};

const STORAGE_KEY = "devpilot-theme";
// Pre-rename key. Read-through only (see lib/storage/legacy-key.ts): an operator's
// saved theme survives the rename instead of silently reverting to "system".
const LEGACY_STORAGE_KEY = "ace-theme";
const ThemeContext = React.createContext<Ctx | null>(null);

function sanitizeTheme(value: string | null | undefined): Theme {
  return value && VALID_THEMES.has(value as Theme) ? (value as Theme) : DEFAULT_THEME;
}

function readStoredTheme(): Theme {
  try {
    return sanitizeTheme(getItemWithLegacy(STORAGE_KEY, LEGACY_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

function resolveMode(t: Theme): ThemeMode {
  if (t === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  if (t === "light") return "light";
  if (t === "dark") return "dark";
  const descriptor = THEMES.find((th) => th.value === t);
  return descriptor?.mode === "light" ? "light" : "dark";
}

function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const mode = resolveMode(t);

  // Classic light/dark and system both use the legacy `.dark` class so existing
  // dark: utilities keep working; named palettes use `data-theme` instead.
  // Always start from a clean slate: stale attrs from a previous theme would
  // otherwise win the CSS cascade and revert the surface.
  if (NAMED_PALETTE_THEMES.has(t)) {
    root.classList.remove("dark");
    root.setAttribute("data-theme", t);
  } else {
    root.removeAttribute("data-theme");
    root.classList.toggle("dark", mode === "dark");
  }
  root.style.colorScheme = mode;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(DEFAULT_THEME);
  // Held in state (not derived) so the client's first render matches what the
  // server produced: resolveMode("system") reads matchMedia in the browser,
  // and deriving it during hydration would mismatch the SSR markup of
  // resolvedMode consumers (e.g. the diff viewers) for light-OS users. The
  // mount effect and the media-query listener below reconcile it afterwards.
  const [resolvedMode, setResolvedMode] = React.useState<ThemeMode>(
    DEFAULT_THEME === "system" ? "dark" : resolveMode(DEFAULT_THEME),
  );

  const syncTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    setResolvedMode(resolveMode(next));
    applyTheme(next);
  }, []);

  // Reconcile React + DOM with localStorage on mount. The inline <head> script
  // already applied the same theme before first paint, but we re-apply here so
  // the DOM is guaranteed to match React state even if (a) the inline script
  // hit the bare `catch` (Safari private mode etc.), or (b) the page was
  // restored from bfcache with stale attributes.
  React.useEffect(() => {
    const stored = readStoredTheme();
    // Normalize the persisted value: a stored theme that no longer exists
    // (e.g. a retired palette name) sanitizes to the default - write that
    // back so the key never carries a dead value forward. Untouched (null)
    // keys stay unset.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null && raw !== stored) {
        localStorage.setItem(STORAGE_KEY, stored);
      }
    } catch {
      // Storage may be unavailable (private mode); the in-memory theme still applies.
    }
    syncTheme(stored);

    // Cross-tab sync: when the user changes the theme in another tab,
    // the `storage` event fires here. Without this, two open tabs drift.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      syncTheme(sanitizeTheme(e.newValue));
    };

    // bfcache restore: Safari/Chrome can resurrect a stale DOM whose
    // attributes don't reflect what localStorage now says. Re-apply.
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      syncTheme(readStoredTheme());
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [syncTheme]);

  // Watch the OS preference if theme === 'system'. Listener only: the mount
  // effect's syncTheme already resolves and applies the theme, and calling the
  // handler eagerly here would run with the render-1 default ("system") before
  // the stored theme has re-rendered, clobbering a saved non-system theme.
  React.useEffect(() => {
    if (theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      setResolvedMode(mql.matches ? "light" : "dark");
      applyTheme("system");
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = React.useCallback(
    (next: Theme) => {
      const safe = sanitizeTheme(next);
      try {
        localStorage.setItem(STORAGE_KEY, safe);
      } catch {
        // Storage may throw in private-mode quotas; theme still applies for this session.
      }
      syncTheme(safe);
    },
    [syncTheme],
  );

  return (
    <ThemeContext.Provider value={{ theme, resolvedMode, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

/**
 * Inline script that runs BEFORE first paint to set the theme so we don't
 * flash the default theme on hard refresh. Embed once in <head>.
 *
 * Defensive contract: any localStorage value not in VALID is treated as the
 * default — without that check, an unknown string (cross-device sync from an
 * older build, manual edit, etc.) falls through every branch and the surface
 * ends up looking like classic light because `:root` is the light baseline.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var DEFAULT = '${DEFAULT_THEME}';
    var NAMED = ${JSON.stringify(Array.from(NAMED_PALETTE_THEMES))};
    var LIGHT_NAMED = ${JSON.stringify(
      THEMES.filter((th) => NAMED_PALETTE_THEMES.has(th.value) && th.mode === "light").map(
        (th) => th.value,
      ),
    )};
    var VALID = ${JSON.stringify(Array.from(VALID_THEMES))};
    var raw = null;
    // Read-through to the pre-rename key so a saved theme doesn't flash the
    // default for one paint before ThemeProvider's mount effect migrates it
    // forward. Read-only here; the effect owns the write.
    try {
      raw = localStorage.getItem('${STORAGE_KEY}');
      if (raw === null) raw = localStorage.getItem('${LEGACY_STORAGE_KEY}');
    } catch (_) {}
    var t = (raw && VALID.indexOf(raw) >= 0) ? raw : DEFAULT;
    var root = document.documentElement;
    // Clear any stale theme markers first so re-runs (bfcache restore,
    // dev fast refresh of <head>) can't leave conflicting attrs behind.
    root.removeAttribute('data-theme');
    root.classList.remove('dark');
    var mode = t;
    if (t === 'system') {
      mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } else if (NAMED.indexOf(t) >= 0) {
      // Surface mode of a named palette, derived from THEMES at build time.
      mode = LIGHT_NAMED.indexOf(t) >= 0 ? 'light' : 'dark';
    }
    if (NAMED.indexOf(t) >= 0) {
      root.setAttribute('data-theme', t);
    } else if (mode === 'dark') {
      root.classList.add('dark');
    }
    root.style.colorScheme = mode;
  } catch (_) { /* fallback to default theme */ }
})();
`;
