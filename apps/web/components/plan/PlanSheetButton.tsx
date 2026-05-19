"use client";

// Phase 2.5+ / M7 — Trigger surface for the plan-tickets Sheet.
//
// Two consumer sites:
//   1. The board header (`<BoardClient>`), inserted before `<NewTicketButton>`.
//      Gated on `activeProjectId !== null` — disabled with a tooltip when no
//      project is active because the planner reads repo context.
//   2. `<PlanningCard>` "Resume" buttons (planning_sessions list on the
//      project detail page). Those reuse this button shell but pass an
//      `initialSessionId` to resume mid-discussion.
//
// The wrapper owns the open state so the consumer just renders <PlanSheetButton>
// and we deal with the rest.

import * as React from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PlanSheet } from "@/components/plan/PlanSheet";

export function PlanSheetButton({
  activeProjectId,
  projectName,
  initialSessionId,
  /** Optional override — defaults to a primary-style topbar trigger. */
  triggerLabel,
  triggerVariant = "outline",
  open: openProp,
  onOpenChange,
}: {
  activeProjectId: string | null;
  projectName: string | null;
  initialSessionId?: string | null;
  triggerLabel?: string;
  triggerVariant?: "primary" | "outline" | "secondary" | "ghost";
  /** Controlled open — when provided, the trigger button is NOT rendered and
   *  the caller drives the sheet (e.g. from a "More" menu item). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : internalOpen;
  const setOpen = controlled ? (onOpenChange ?? (() => {})) : setInternalOpen;
  const label = triggerLabel ?? "Plan tickets…";
  const gated = activeProjectId === null || projectName === null;

  // Controlled: the caller owns the trigger; we only host the sheet.
  if (controlled) {
    if (gated) return null;
    return (
      <PlanSheet
        open={open}
        onOpenChange={setOpen}
        activeProjectId={activeProjectId!}
        projectName={projectName!}
        initialSessionId={initialSessionId ?? null}
      />
    );
  }

  if (gated) {
    // Tooltip wraps a span that wraps a disabled button — Radix Tooltip can't
    // open on a button with `disabled` because pointer events are blocked on
    // the button itself. The span carries the hover/focus surface.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>
            <Button
              variant={triggerVariant}
              size="sm"
              disabled
              aria-disabled="true"
              className="cursor-not-allowed"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Pick a project from the topbar first.</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <Button variant={triggerVariant} size="sm" onClick={() => setOpen(true)}>
        <Sparkles className="h-3.5 w-3.5" />
        {label}
      </Button>
      <PlanSheet
        open={open}
        onOpenChange={setOpen}
        activeProjectId={activeProjectId!}
        projectName={projectName!}
        initialSessionId={initialSessionId ?? null}
      />
    </>
  );
}
