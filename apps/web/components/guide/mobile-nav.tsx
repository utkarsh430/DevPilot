"use client";

// The guide rail on a phone.
//
// STATEFUL and Radix-bearing (Sheet), so it is outside the render-tested set —
// which is exactly why it is a separate file from `GuideSidebarNav`: the rail's
// active-state logic is shared with the desktop rail rather than duplicated into
// a second, drifting copy.
//
// The sheet CLOSES ON NAVIGATION (`onNavigate`). Without it, tapping a section
// leaves the reader looking at the nav they just used, on top of the page they
// asked for — a Next.js client navigation does not unmount this component, so
// nothing else would close it.

import * as React from "react";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { GuideSidebarNav } from "./sidebar";

export function GuideMobileNav() {
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className="border-border text-muted-foreground hover:text-foreground inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors">
        <Menu className="h-3.5 w-3.5" />
        Guide contents
      </SheetTrigger>
      <SheetContent side="left" className="w-72 overflow-y-auto">
        <SheetTitle className="mb-4 text-sm">Guide contents</SheetTitle>
        <GuideSidebarNav onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
