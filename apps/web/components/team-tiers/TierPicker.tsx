"use client";

// Operator-facing picker for the team-tier preset. Same component is used by:
//   • New-project form (project creation default)
//   • Project settings (change project default later)
//   • Plan-kickoff entry on the planning surface (per-session override; in
//     that mode `allowInherit` adds an "Inherit from project" option that
//     stores `null` so the planner falls back to projects.team_tier)
//
// Why one shared component: the affordance and the preview are identical in
// every surface — the only variance is whether `null` is a valid value. That
// difference is a single flag rather than three near-duplicate components.

import * as React from "react";
import { Check } from "lucide-react";
import { ROLE_CATALOG } from "@/lib/roles/catalog";
import { TEAM_TIER_CONFIG, TEAM_TIERS, type TeamTier } from "@/lib/team-tiers/tiers";
import { cn } from "@/lib/cn";

type TierPickerProps = {
  /**
   * Current selection. `null` means "inherit from project" — only valid when
   * `allowInherit` is true (typically the plan-kickoff surface).
   */
  value: TeamTier | null;
  onChange: (tier: TeamTier | null) => void;
  /**
   * When true, prepends an "Inherit from project" option whose value is null.
   * Pair with `inheritedLabel` so the operator sees what the project default
   * actually resolves to (e.g. "Inherit (Standard)").
   */
  allowInherit?: boolean;
  /** Label suffix for the inherit option — usually the project's tier name. */
  inheritedLabel?: string;
  disabled?: boolean;
  className?: string;
};

export function TierPicker({
  value,
  onChange,
  allowInherit = false,
  inheritedLabel,
  disabled = false,
  className,
}: TierPickerProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          Team tier
        </label>
        <span className="text-muted-foreground text-[10px]">
          Drives roster + ticket count on every plan run
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {allowInherit ? (
          <TierCard
            key="inherit"
            tier={null}
            label="Inherit from project"
            sublabel={inheritedLabel ?? "Use the project's default"}
            description="Whatever this project's setting is at the time the plan runs."
            selected={value === null}
            disabled={disabled}
            onSelect={() => onChange(null)}
          />
        ) : null}
        {TEAM_TIERS.map((tier) => {
          const cfg = TEAM_TIER_CONFIG[tier];
          return (
            <TierCard
              key={tier}
              tier={tier}
              label={cfg.displayName}
              sublabel={`Up to ${cfg.maxTickets} tickets`}
              description={cfg.description}
              selected={value === tier}
              disabled={disabled}
              onSelect={() => onChange(tier)}
            />
          );
        })}
      </div>
      {/* Always-visible preview of the active tier's roster. Keeps the
          consequences of a click legible without forcing the operator to
          expand a tooltip. */}
      <ActiveTierPreview tier={value} />
    </div>
  );
}

function TierCard({
  tier,
  label,
  sublabel,
  description,
  selected,
  disabled,
  onSelect,
}: {
  tier: TeamTier | null;
  label: string;
  sublabel: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "group relative flex flex-col rounded-md border p-3 text-left transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-input hover:border-primary/30 hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
      data-tier={tier ?? "inherit"}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-muted-foreground text-[10px]">{sublabel}</div>
        </div>
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
          )}
        >
          {selected ? <Check className="h-3 w-3" /> : null}
        </span>
      </div>
      <p className="text-muted-foreground mt-2 text-[11px] leading-snug">{description}</p>
    </button>
  );
}

function ActiveTierPreview({ tier }: { tier: TeamTier | null }) {
  if (tier === null) {
    return (
      <p className="border-input bg-muted/30 text-muted-foreground rounded-md border border-dashed px-3 py-2 text-[11px]">
        Will resolve at plan time using the project&apos;s current default.
      </p>
    );
  }
  const cfg = TEAM_TIER_CONFIG[tier];
  const allowed = cfg.allowedRoles;
  const displayBySlug = new Map(ROLE_CATALOG.map((e) => [e.slug, e.displayName] as const));
  return (
    <div className="border-input bg-muted/30 rounded-md border px-3 py-2">
      <div className="text-muted-foreground text-[10px] uppercase tracking-wide">
        Roles that will be deployed
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {allowed === null ? (
          <span className="border-input bg-background rounded-full border px-2 py-0.5 text-[10px] font-medium">
            Full catalog — every specialist available
          </span>
        ) : (
          allowed.map((slug) => (
            <span
              key={slug}
              className="border-input bg-background rounded-full border px-2 py-0.5 text-[10px] font-medium"
              title={slug}
            >
              {displayBySlug.get(slug) ?? slug}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
