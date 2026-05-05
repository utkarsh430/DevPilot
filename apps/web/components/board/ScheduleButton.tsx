"use client";

// Phase 2.5++ / Scheduler — board header button that opens <ScheduleDialog>.
// Disabled (with tooltip) when no project is active, mirroring the
// PlanSheetButton ergonomics.

import * as React from "react";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScheduleDialog } from "@/components/board/ScheduleDialog";

export function ScheduleButton({
  activeProjectId,
  activeProjectName,
  backlogCount,
  open: openProp,
  onOpenChange,
}: {
  activeProjectId: string | null;
  activeProjectName: string | null;
  backlogCount: number;
  /** Controlled open — when provided, the trigger button is NOT rendered and
   *  the caller drives the dialog (e.g. from a "More" menu item). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : internalOpen;
  const setOpen = controlled ? (onOpenChange ?? (() => {})) : setInternalOpen;

  const dialog = (
    <ScheduleDialog
      open={open}
      onOpenChange={setOpen}
      activeProjectId={activeProjectId}
      activeProjectName={activeProjectName}
      backlogCount={backlogCount}
    />
  );

  // Controlled: the caller owns the trigger (a menu item); we only host the dialog.
  if (controlled) return dialog;

  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!activeProjectId}
      onClick={() => setOpen(true)}
    >
      <CalendarClock className="h-3.5 w-3.5" />
      Schedule
    </Button>
  );

  return (
    <>
      {activeProjectId ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>{button}</span>
          </TooltipTrigger>
          <TooltipContent>Pick a project from the topbar first.</TooltipContent>
        </Tooltip>
      )}
      {dialog}
    </>
  );
}
