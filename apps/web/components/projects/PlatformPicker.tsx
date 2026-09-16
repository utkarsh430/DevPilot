"use client";

// WI-11 — operator-facing picker for the project's target platform
// (`projects.project_type`). Used by both new-project forms (Connect existing
// and Create new); it is the only place the operator asserts a platform.
//
// Shaped after `components/team-tiers/TierPicker.tsx` on purpose — the two sit
// next to each other in the same form, so a divergent affordance would read as
// an accident. Same card-radio pattern, same selection chrome.
//
// The picker states the CONSEQUENCES of the choice rather than just naming it,
// because both consequences are invisible at click time: the platform steers
// the Run button's inferred command and frames plan mode.

import * as React from "react";
import { Check } from "lucide-react";
import { PROJECT_TYPES, PROJECT_TYPE_CONFIG, type ProjectType } from "@/lib/projects/project-type";
import { cn } from "@/lib/cn";

type PlatformPickerProps = {
  value: ProjectType;
  onChange: (projectType: ProjectType) => void;
  disabled?: boolean;
  className?: string;
};

export function PlatformPicker({
  value,
  onChange,
  disabled = false,
  className,
}: PlatformPickerProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          Platform
        </label>
        <span className="text-muted-foreground text-[10px]">
          Steers the Run command and how agents plan
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label="Platform"
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {PROJECT_TYPES.map((projectType) => {
          const cfg = PROJECT_TYPE_CONFIG[projectType];
          return (
            <button
              key={projectType}
              type="button"
              role="radio"
              aria-checked={value === projectType}
              onClick={() => onChange(projectType)}
              disabled={disabled}
              data-project-type={projectType}
              className={cn(
                "group relative flex flex-col rounded-md border p-3 text-left transition-colors",
                value === projectType
                  ? "border-primary/50 bg-primary/5"
                  : "border-input hover:border-primary/30 hover:bg-muted/40",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-medium">{cfg.displayName}</div>
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    value === projectType
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input",
                  )}
                >
                  {value === projectType ? <Check className="h-3 w-3" /> : null}
                </span>
              </div>
              <p className="text-muted-foreground mt-2 text-[11px] leading-snug">
                {cfg.description}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
