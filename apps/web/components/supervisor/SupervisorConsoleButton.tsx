"use client";

// Trigger for the supervisor console. Owns the open state so a consumer can
// just render it; same shape as `PlanSheetButton`.
//
// It sits in the board header rather than behind the "More" menu, and that is a
// deliberate call: this is the surface an operator reaches for when the board
// has stopped and they do not yet know why, which is exactly the moment a
// two-click hunt through a menu is worst. It is also the only control that
// answers a question rather than performing an action, so it reads as chrome.

import * as React from "react";
import { LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SupervisorConsole } from "@/components/supervisor/SupervisorConsole";

export function SupervisorConsoleButton({
  activeProjectId,
  projectName,
}: {
  activeProjectId: string | null;
  projectName: string | null;
}) {
  const [open, setOpen] = React.useState(false);

  // "All projects" has no single board to explain, and the whole snapshot is
  // project-scoped, so the control is disabled rather than silently answering
  // about whichever project happens to be first.
  if (!activeProjectId) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button variant="outline" size="icon-sm" disabled aria-label="Supervisor console">
              <LifeBuoy className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Pick a project to ask about its board.</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Supervisor console"
            onClick={() => setOpen(true)}
          >
            <LifeBuoy className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Ask what this board is doing, and unstick it</TooltipContent>
      </Tooltip>
      <SupervisorConsole
        projectId={activeProjectId}
        projectName={projectName}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
