"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { THEMES, useTheme, type Theme } from "@/components/shell/theme-provider";

export default function AppearancePage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="font-display text-xl font-bold tracking-tight">Appearance</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Pick a palette for the entire DevPilot surface. The choice is stored on this device —
          switch any time.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {THEMES.map((t) => (
          <ThemeCard
            key={t.value}
            value={t.value}
            label={t.label}
            tagline={t.tagline}
            mode={t.mode}
            swatch={t.swatch}
            active={theme === t.value}
            onSelect={() => setTheme(t.value)}
          />
        ))}
      </div>
    </div>
  );
}

function ThemeCard({
  value,
  label,
  tagline,
  mode,
  swatch,
  active,
  onSelect,
}: {
  value: Theme;
  label: string;
  tagline: string;
  mode: "light" | "dark" | "auto";
  swatch: { bg: string; fg: string } | null;
  active: boolean;
  onSelect: () => void;
}) {
  const SysIcon = mode === "auto" ? Monitor : mode === "dark" ? Moon : Sun;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "bg-card group flex flex-col gap-3 overflow-hidden rounded-xl border p-3 text-left transition-colors",
        active ? "border-ring ring-ring/40 ring-2" : "hover:border-foreground/30",
      )}
    >
      {/* Swatch */}
      <div
        className="relative h-24 w-full overflow-hidden rounded-md border"
        style={
          swatch
            ? { backgroundColor: swatch.bg }
            : { background: "linear-gradient(135deg, #F8F7F3 50%, #0E1116 50%)" }
        }
      >
        {swatch ? (
          <>
            <div
              className="absolute inset-y-0 right-0 w-1/3"
              style={{ backgroundColor: swatch.fg }}
            />
            <div
              className="absolute left-3 top-3 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider"
              style={{ color: swatch.fg, mixBlendMode: "normal" }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: swatch.fg }}
              />
              DevPilot
            </div>
            <div
              className="absolute bottom-2 right-2 rounded-sm px-1.5 py-0.5 text-[9px] font-medium"
              style={{ backgroundColor: swatch.fg, color: swatch.bg }}
            >
              {mode}
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="bg-background/85 text-foreground/90 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium backdrop-blur-sm">
              <SysIcon className="h-3.5 w-3.5" />
              Match system
            </span>
          </div>
        )}
        {active ? (
          <div className="bg-foreground text-background absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full">
            <Check className="h-3 w-3" />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-0.5 px-1 pb-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium tracking-tight">{label}</span>
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
            {value}
          </span>
        </div>
        <span className="text-muted-foreground text-xs">{tagline}</span>
      </div>
    </button>
  );
}
