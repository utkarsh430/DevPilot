"use client";

// Phase 2 / M5g — Role picker combobox.
// Phase 2 / F3 — extended to accept an effective catalog (built-ins ∪ custom
//                tenant-scoped agents). Backwards compatible: if no `catalog`
//                prop is passed we fall back to the static `ROLE_CATALOG`
//                from `@/lib/roles/catalog` mapped to `kind: "builtin"`.
//
// Operators OPT-IN to a specific role for a new ticket; the default null value
// means "auto-pick" and lets the dispatcher's classifier (Haiku) decide at
// dispatch time. The combobox is searchable across displayName + slug +
// purpose + category, grouped by category, and pinned with an Auto-pick row
// at the top of the list.

import * as React from "react";
import { Check, ChevronsUpDown, Info, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import {
  groupEffectiveCatalogByCategory,
  type EffectiveCatalogEntry,
} from "@/lib/roles/effective-catalog";

export type RoleSelectProps = {
  /** null = "Auto-pick (let DevPilot classify)" — the default. */
  value: string | null;
  onChange: (slug: string | null) => void;
  disabled?: boolean;
  /** Compact trigger; useful inside dense forms. */
  size?: "sm" | "md";
  /**
   * Optional effective catalog (built-ins ∪ tenant custom agents). When
   * omitted the picker falls back to the static built-in catalog so callers
   * that don't yet thread the server-loaded list keep working.
   */
  catalog?: ReadonlyArray<EffectiveCatalogEntry>;
};

// Built-in fallback — mirrors `loadEffectiveCatalog`'s builtin projection so
// the prop-less render matches the threaded render in shape.
const BUILTIN_FALLBACK: EffectiveCatalogEntry[] = ROLE_CATALOG.map((entry) => ({
  slug: entry.slug,
  displayName: entry.displayName,
  category: entry.category,
  purpose: entry.purpose,
  kind: "builtin",
}));

export function RoleSelect({ value, onChange, disabled, size = "md", catalog }: RoleSelectProps) {
  const [open, setOpen] = React.useState(false);

  const entries = catalog ?? BUILTIN_FALLBACK;
  const selectedEntry = React.useMemo(
    () => (value ? (entries.find((e) => e.slug === value) ?? null) : null),
    [value, entries],
  );

  // Preserve the catalog's insertion order for category sections — built-ins
  // group first (in the order declared in `ROLE_CATALOG`), then any custom
  // bucket lands at the end.
  const groups = React.useMemo(() => {
    const map = groupEffectiveCatalogByCategory(entries);
    return Array.from(map.entries()).map(([category, items]) => ({
      category,
      entries: items,
    }));
  }, [entries]);

  // The Button variants in this repo expose `sm | default | lg | xs | icon | icon-sm`.
  // The `md` prop name in this API maps to `default` (the comfy 36px row).
  const triggerSize = size === "sm" ? "sm" : "default";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={triggerSize}
          disabled={disabled}
          className="w-full justify-between gap-2"
          aria-label="Pick role for this ticket"
        >
          {selectedEntry ? (
            <span className="flex min-w-0 items-center gap-2 truncate">
              <span className="truncate">{selectedEntry.displayName}</span>
              <code className="bg-muted text-muted-foreground rounded px-1 py-0.5 font-mono text-[9px]">
                {selectedEntry.slug}
              </code>
              {selectedEntry.kind === "custom" ? (
                <Badge tone="info" className="px-1 py-0 text-[9px] leading-none">
                  custom
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground flex min-w-0 items-center gap-2 truncate">
              <Sparkles className="text-muted-foreground h-3.5 w-3.5" />
              Auto-pick (let DevPilot classify)
            </span>
          )}
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // Cap to the space Radix measures between the trigger and the viewport
        // edge (respects collisionPadding) so the list never runs off the bottom,
        // bounded by a comfy 22rem. `flex flex-col` + overflow-hidden lets the
        // CommandList below flex-fill and scroll inside that cap.
        className="flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden p-0"
        align="start"
        sideOffset={6}
        collisionPadding={16}
      >
        <Command>
          <CommandInput placeholder="Search roles by name, slug, or purpose…" />
          <CommandList className="max-h-none min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <CommandEmpty>No roles match that search.</CommandEmpty>
            {/* Auto-pick — pinned at top, clears the selection. */}
            <CommandGroup heading="Default">
              <CommandItem
                value="__auto__"
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                <Sparkles className="text-muted-foreground h-3.5 w-3.5" />
                <div className="flex-1">
                  <p className="text-sm">Auto-pick (let DevPilot classify)</p>
                  <p className="text-muted-foreground text-[10px]">
                    Haiku reads the ticket and picks the best role at dispatch.
                  </p>
                </div>
                {value === null ? <Check className="h-3.5 w-3.5" /> : null}
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            {groups.map((group) => (
              <CommandGroup key={group.category} heading={group.category}>
                {group.entries.map((entry) => {
                  const selected = entry.slug === value;
                  return (
                    <CommandItem
                      key={entry.slug}
                      // Search corpus = displayName + slug + purpose + category
                      // + kind so "custom" + a partial name both match the
                      // tenant's bespoke roles.
                      value={`${entry.displayName} ${entry.slug} ${entry.purpose} ${group.category} ${entry.kind}`}
                      onSelect={() => {
                        onChange(entry.slug);
                        setOpen(false);
                      }}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate text-sm">{entry.displayName}</span>
                        <code className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 font-mono text-[9px]">
                          {entry.slug}
                        </code>
                        {entry.kind === "custom" ? (
                          <Badge tone="info" className="shrink-0 px-1 py-0 text-[9px] leading-none">
                            custom
                          </Badge>
                        ) : null}
                      </div>
                      {/* The row shows name + slug only; the role's purpose lives
                          here on hover. stopPropagation keeps a click on the icon
                          from selecting the role + closing the popover. */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Full description for ${entry.displayName}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1"
                          >
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" align="start" className="max-w-xs">
                          <p className="text-foreground font-medium">
                            {entry.displayName}{" "}
                            <span className="text-muted-foreground font-mono text-[10px]">
                              {entry.slug}
                            </span>
                          </p>
                          <p className="text-muted-foreground mt-1 leading-snug">{entry.purpose}</p>
                        </TooltipContent>
                      </Tooltip>
                      {selected ? <Check className="h-3.5 w-3.5" /> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
