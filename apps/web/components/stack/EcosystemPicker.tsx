"use client";

// Stack advisor (Stage 4) - operator-facing picker for the project's
// ecosystem commitment (`projects.stack_ecosystem`). The cheap, LLM-free half
// of the advisor: no network call, no inference, safe on the create form
// where project creation must not depend on a live runner.
//
// Shaped after `PlatformPicker` (components/projects/PlatformPicker.tsx) -
// the two sit in the same forms, so a divergent affordance would read as an
// accident. Same card-radio pattern: states the CONSEQUENCE of the choice
// (which services the advisor's ranker will prefer), not just the name,
// because that consequence is invisible at click time.
//
// 'unset' (the DEFAULT_ECOSYSTEM) is a real, selectable card here, not a
// hidden fallback - same posture as PlatformPicker's 'other': the operator
// should see exactly what "no commitment yet" means rather than have it
// happen implicitly.

import * as React from "react";
import { Check } from "lucide-react";
import { ECOSYSTEM_CHOICES, type EcosystemChoice } from "@/lib/stack/rank";
import { cn } from "@/lib/cn";

type EcosystemConfig = {
  displayName: string;
  /** One-line consequence, shown under the label. */
  description: string;
};

const ECOSYSTEM_CONFIG: Record<EcosystemChoice, EcosystemConfig> = {
  aws: {
    displayName: "AWS",
    description: "Native AWS services are ranked first when the advisor suggests a stack.",
  },
  azure: {
    displayName: "Azure",
    description: "Native Azure services are ranked first when the advisor suggests a stack.",
  },
  gcp: {
    displayName: "Google Cloud",
    description: "Native GCP services are ranked first when the advisor suggests a stack.",
  },
  oss: {
    displayName: "Open source",
    description: "Free tiers and self-hosted options are ranked first - no cloud vendor lock-in.",
  },
  mixed: {
    displayName: "Mixed",
    description: "No single cloud commitment; a fitting service is picked per capability.",
  },
  unset: {
    displayName: "Not sure yet",
    description: "No ecosystem asserted. Cloud and open-source options rank near-parity.",
  },
};

// Card order: the three clouds, then oss, then the two non-committal choices -
// matches ECOSYSTEM_CHOICES (lib/stack/rank.ts), the ranker's own ordering.
const CARD_ORDER: readonly EcosystemChoice[] = ECOSYSTEM_CHOICES;

type EcosystemPickerProps = {
  value: EcosystemChoice;
  onChange: (ecosystem: EcosystemChoice) => void;
  disabled?: boolean;
  className?: string;
};

export function EcosystemPicker({
  value,
  onChange,
  disabled = false,
  className,
}: EcosystemPickerProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          Ecosystem
        </label>
        <span className="text-muted-foreground text-[11px]">
          Steers which services the stack advisor suggests first
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label="Ecosystem"
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {CARD_ORDER.map((ecosystem) => {
          const cfg = ECOSYSTEM_CONFIG[ecosystem];
          return (
            <button
              key={ecosystem}
              type="button"
              role="radio"
              aria-checked={value === ecosystem}
              onClick={() => onChange(ecosystem)}
              disabled={disabled}
              data-ecosystem={ecosystem}
              className={cn(
                "group relative flex flex-col rounded-md border p-3 text-left transition-colors",
                value === ecosystem
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
                    value === ecosystem
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input",
                  )}
                >
                  {value === ecosystem ? <Check className="h-3 w-3" /> : null}
                </span>
              </div>
              <p className="text-muted-foreground mt-2 text-[11px] leading-snug">
                {cfg.description}
              </p>
            </button>
          );
        })}
      </div>
      {value === "mixed" ? (
        <p
          role="alert"
          className="border-warning/30 bg-warning/5 text-warning rounded-md border px-3 py-2 text-[11px] leading-snug"
        >
          Mixing clouds means two bills, two IAM models, and cross-cloud egress. Most projects are
          better off committing to one cloud, or going all-open-source on free tiers - you can still
          proceed with Mixed.
        </p>
      ) : null}
    </div>
  );
}
