"use client";

// Pinned one-line Stack Strip (plan-component revamp Phase 2 — the position
// keystone). Sits as pinned chrome ABOVE the transcript scroll region in the
// Refine view and is the stack's ALWAYS-visible home: it can no longer scroll
// away because it is not in the scroll region at all. Clicking it (or its
// primary CTA, when there's something to review/edit) opens the in-sheet
// overlay that carries the full advisor.
//
// Four states, driven by the advisor's `status` + self-loaded tags:
//   unrun    → "Stack · not set — we'll use sensible defaults"   · Suggest my stack
//   ready    → "N services suggested — review"                   · Review & save
//   accepted → "Saved — drives every ticket"                     · Edit
//   skipped  → "Skipped for this session"                        · Reopen
//
// D5 (no auto-fire) is preserved: inference only ever runs from a click. The
// "auto-offer" after the first answered Q&A round is a PROMINENCE change —
// before the round the CTA is quiet and carries a "sharper after a couple of
// questions" hint; after it, the CTA is promoted to primary — never an
// automatic inference call and never an automatic screen-covering overlay.

import * as React from "react";
import { ChevronDown, Diamond, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { ECOSYSTEM_CHOICES, type EcosystemChoice } from "@/lib/stack/rank";
import { savedStackServiceNames } from "@/lib/stack/provenance";
import type { StackAdvisor } from "@/components/stack/use-stack-advisor";

// Compact ecosystem labels for the strip dropdown — shorter than the full
// EcosystemPicker card titles (which live in the overlay).
const ECOSYSTEM_LABEL: Record<EcosystemChoice, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "GCP",
  oss: "OSS",
  mixed: "Mixed",
  unset: "No ecosystem",
};

const MAX_VISIBLE_PILLS = 4;

export function PlanStackStrip({
  advisor,
  hasAnsweredFirstRound,
  onExpand,
}: {
  advisor: StackAdvisor;
  /** Whether the operator has answered the planner's first clarifying round.
   *  Only flips the `unrun` CTA from quiet → primary (the "auto-offer"); never
   *  fires inference. */
  hasAnsweredFirstRound: boolean;
  /** Open the in-sheet overlay (the full advisor body). */
  onExpand: () => void;
}) {
  const { loaded, status, running, ecosystem, setEcosystem } = advisor;

  // Selected service per included capability (in catalog order), then the
  // "extra" services — the run of pills the strip truncates. Shares the one
  // derivation with the Build/Review provenance surfaces (Phase 4) so the three
  // can never disagree on the saved-stack name list.
  const pills = React.useMemo(
    () =>
      savedStackServiceNames({
        plans: advisor.plans,
        selectedByCapability: advisor.selectedByCapability,
        extraServiceKeys: advisor.extraServiceKeys,
      }),
    [advisor.plans, advisor.selectedByCapability, advisor.extraServiceKeys],
  );

  const visiblePills = pills.slice(0, MAX_VISIBLE_PILLS);
  const overflow = pills.length - visiblePills.length;
  const isInferring = running || status === "inferring";

  return (
    <div className="bg-card flex h-11 items-center gap-2 border-b px-6">
      {/* --primary marker — the one accent that means "this drives the build". */}
      <Diamond className="text-primary h-3 w-3 shrink-0 fill-current" aria-hidden />

      {/* Ecosystem control — isolated; changing it re-ranks instantly. */}
      <EcosystemDropdown value={ecosystem} onChange={setEcosystem} disabled={isInferring} />

      {/* Truncating run of capability→service pills. The whole run is the
          click target that opens the overlay. */}
      <button
        type="button"
        onClick={onExpand}
        aria-label="Open stack advisor"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-left"
      >
        {visiblePills.map((label, i) => (
          <React.Fragment key={`${label}-${i}`}>
            {i > 0 ? (
              <span className="text-muted-foreground/50 shrink-0 text-[11px]" aria-hidden>
                ·
              </span>
            ) : null}
            <span className="text-foreground/80 shrink-0 truncate text-[11px]">{label}</span>
          </React.Fragment>
        ))}
        {overflow > 0 ? (
          <span className="text-muted-foreground shrink-0 text-[11px]">+{overflow}</span>
        ) : null}
      </button>

      {/* Right-aligned status + CTA. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <StatusLine
          loaded={loaded}
          status={status}
          isInferring={isInferring}
          serviceCount={pills.length}
          hasAnsweredFirstRound={hasAnsweredFirstRound}
        />
        <StripCta
          advisor={advisor}
          hasAnsweredFirstRound={hasAnsweredFirstRound}
          onExpand={onExpand}
        />
      </div>
    </div>
  );
}

function StatusLine({
  loaded,
  status,
  isInferring,
  serviceCount,
  hasAnsweredFirstRound,
}: {
  loaded: boolean;
  status: StackAdvisor["status"];
  isInferring: boolean;
  serviceCount: number;
  hasAnsweredFirstRound: boolean;
}) {
  if (!loaded) {
    return <span className="text-muted-foreground text-[11px]">Loading stack…</span>;
  }
  if (isInferring) {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
        <Loader2 className="h-3 w-3 animate-spin" />
        Suggesting…
      </span>
    );
  }
  if (status === "accepted") {
    return (
      <span className="text-muted-foreground hidden items-center gap-1 text-[11px] sm:inline-flex">
        Saved — <span className="text-primary font-medium">drives every ticket</span>
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="text-muted-foreground hidden text-[11px] sm:inline">
        {serviceCount} service{serviceCount === 1 ? "" : "s"} suggested — review
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="text-muted-foreground hidden text-[11px] sm:inline">
        Skipped for this session
      </span>
    );
  }
  // unrun
  return (
    <span className="text-muted-foreground hidden text-[11px] sm:inline">
      Stack · not set — we&apos;ll use sensible defaults
      {!hasAnsweredFirstRound ? (
        <span className="text-muted-foreground/70"> · sharper after a couple of questions</span>
      ) : null}
    </span>
  );
}

function StripCta({
  advisor,
  hasAnsweredFirstRound,
  onExpand,
}: {
  advisor: StackAdvisor;
  hasAnsweredFirstRound: boolean;
  onExpand: () => void;
}) {
  const { loaded, status, running } = advisor;
  const isInferring = running || status === "inferring";

  if (!loaded || isInferring) return null;

  if (status === "accepted") {
    return (
      <Button variant="outline" size="xs" onClick={onExpand}>
        Edit
      </Button>
    );
  }
  if (status === "ready") {
    return (
      <Button variant="primary" size="xs" onClick={onExpand}>
        Review &amp; save
      </Button>
    );
  }
  if (status === "skipped") {
    return (
      <Button variant="outline" size="xs" onClick={() => advisor.handleReopen()}>
        Reopen
      </Button>
    );
  }
  // unrun — D5: this is a click; the "offer" is the prominence bump after the
  // first answered round (primary), not an automatic run.
  return (
    <Button
      variant={hasAnsweredFirstRound ? "primary" : "outline"}
      size="xs"
      onClick={() => void advisor.handleRun()}
    >
      <Sparkles className="h-3 w-3" />
      Suggest my stack
    </Button>
  );
}

function EcosystemDropdown({
  value,
  onChange,
  disabled,
}: {
  value: EcosystemChoice;
  onChange: (v: EcosystemChoice) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "border-input hover:bg-muted/60 inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
            disabled && "cursor-not-allowed opacity-60",
          )}
          aria-label={`Ecosystem: ${ECOSYSTEM_LABEL[value]}`}
        >
          {ECOSYSTEM_LABEL[value]}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as EcosystemChoice)}>
          {ECOSYSTEM_CHOICES.map((eco) => (
            <DropdownMenuRadioItem key={eco} value={eco} className="text-xs">
              {ECOSYSTEM_LABEL[eco]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
