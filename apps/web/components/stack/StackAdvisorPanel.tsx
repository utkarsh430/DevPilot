"use client";

// Stack advisor (Stage 5) — the project-page Card rendering of the advisor.
//
// After the plan-component revamp (Phase 2) this is the CARD surface only: the
// project page's StackCard (`sessionId` omitted — covers `generatePlan: false`
// projects, which never get a plan session). The plan surface renders the SAME
// advisor as a pinned Stack Strip + in-sheet overlay (components/plan/*), not
// this Card — but both share one state source, `useStackAdvisor`, and one
// editing body, `StackAdvisorBody`, so the two renderings never drift.
//
// D5 (no auto-fire) and S8 (nothing persisted until Save) are enforced in the
// hook; see use-stack-advisor.tsx.

import * as React from "react";
import { ChevronUp, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { StackAdvisorBody } from "@/components/stack/StackAdvisorBody";
import { useStackAdvisor } from "@/components/stack/use-stack-advisor";
import type { StackAdviceStatus } from "@/lib/plan/types";

export function StackAdvisorPanel({
  projectId,
  sessionId = null,
  initialAdviceStatus = null,
}: {
  projectId: string;
  /** Set only when mounted inside a plan session's `discussing` phase. */
  sessionId?: string | null;
  /** The session's persisted `planning_sessions.stack_advice_status`, when the
   *  caller already has it loaded — passed in rather than re-queried here. */
  initialAdviceStatus?: StackAdviceStatus | null;
}) {
  const advisor = useStackAdvisor({ projectId, sessionId, initialAdviceStatus });
  const { loaded, status, running, collapsed, setCollapsed, handleRun } = advisor;

  if (!loaded) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Stack advisor</CardTitle>
          {!collapsed ? (
            <CardDescription className="text-xs">
              AI-suggested services for this project, ranked for your ecosystem.
            </CardDescription>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {!collapsed && status !== "unrun" && status !== "skipped" ? (
            <Button variant="outline" size="sm" onClick={() => void handleRun()} disabled={running}>
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Re-run
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand stack advisor" : "Collapse stack advisor"}
            title={collapsed ? "Expand stack advisor" : "Collapse stack advisor"}
          >
            <ChevronUp className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
          </Button>
        </div>
      </CardHeader>
      {collapsed ? null : (
        <CardContent>
          <StackAdvisorBody advisor={advisor} />
        </CardContent>
      )}
    </Card>
  );
}
