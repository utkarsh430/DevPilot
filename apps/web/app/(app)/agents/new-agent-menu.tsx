"use client";

// Primary create-flow surface on /agents. Replaces the two side-by-side
// "From JD" / "Open builder" CTAs with one dropdown — the entries used to
// each be their own sidebar item, but they're create verbs, not destinations.

import Link from "next/link";
import { ChevronDown, Plus, Sparkles, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function NewAgentMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus className="h-3.5 w-3.5" />
          New agent
          <ChevronDown className="ml-1 h-3 w-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem asChild>
          <Link href="/builder" className="cursor-pointer">
            <Workflow className="mr-2 h-3.5 w-3.5" />
            <span className="flex-1">Visual builder</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/agents/new" className="cursor-pointer">
            <Sparkles className="mr-2 h-3.5 w-3.5" />
            <span className="flex-1">From job description</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
