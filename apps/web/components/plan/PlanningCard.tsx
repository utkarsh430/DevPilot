"use client";

// Phase 2.5+ / M7 — Planning sessions card on the project detail page.
//
// Lists in-progress + recently committed planning sessions for a project.
// Server-rendered prop: the project page does a thin
// `from('planning_sessions').select().eq('project_id', id)` query and threads
// the result down. Status pills + "Resume" buttons; the empty state is a CTA
// that opens a fresh PlanSheet on this project.
//
// This is a client component (interactivity for the PlanSheet trigger), but
// reads no data of its own — the parent already paid the round-trip.

import * as React from "react";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PlanSheet } from "@/components/plan/PlanSheet";
import { relativeTime } from "@/lib/relative-time";
import type { PlanSession, PlanStatus } from "@/lib/plan/types";
import type { TeamTier } from "@/lib/team-tiers/tiers";

const STATUS_TONE: Record<PlanStatus, "info" | "warn" | "ok" | "muted" | "danger"> = {
  discussing: "info",
  planning: "warn",
  planned: "warn",
  committed: "ok",
  discarded: "muted",
};
const STATUS_LABEL: Record<PlanStatus, string> = {
  discussing: "Discussing",
  planning: "Building…",
  planned: "Ready to commit",
  committed: "Committed",
  discarded: "Discarded",
};

export function PlanningCard({
  projectId,
  projectName,
  projectTier,
  sessions,
  initialOpenSessionId,
}: {
  projectId: string;
  projectName: string;
  /** Project's default team tier. Shown as the "Inherit" target in the
   *  PlanSheet's tier picker so a new plan can either inherit or override. */
  projectTier: TeamTier;
  sessions: PlanSession[];
  /**
   * Seed the resume sheet open on mount. Used by the new-project flow:
   * `/projects/:id?planSession=<uuid>` lands the operator straight in the
   * just-created session without an extra click.
   */
  initialOpenSessionId?: string | null;
}) {
  const [openSessionId, setOpenSessionId] = React.useState<string | null>(
    initialOpenSessionId ?? null,
  );
  const [newOpen, setNewOpen] = React.useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="text-muted-foreground h-4 w-4" />
            Planning
            {sessions.length > 0 ? <Badge tone="muted">{sessions.length}</Badge> : null}
          </CardTitle>
          <CardDescription className="text-xs">
            Plan-mode sessions on this project. Open one to resume, or start a new plan from the
            operator&apos;s prose.
          </CardDescription>
        </div>
        <Button variant="primary" size="sm" onClick={() => setNewOpen(true)}>
          <Sparkles className="h-3.5 w-3.5" />
          New plan
        </Button>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No planning sessions yet. Click <strong>New plan</strong> to describe what you want
            built — the panel agents will draft a ticket list for review.
          </p>
        ) : (
          <ul className="divide-y">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                    <Badge tone="muted" className="font-mono text-[11px]">
                      {s.stackFlavor}
                    </Badge>
                    {s.spentCents > 0 ? (
                      <Badge tone="info" className="text-[11px]">
                        ${(s.spentCents / 100).toFixed(2)}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-sm">
                    {s.goalSummary?.trim() || (
                      <span className="text-muted-foreground italic">Untitled plan</span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-muted-foreground text-[11px]">
                    {relativeTime(s.updatedAt)}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setOpenSessionId(s.id)}>
                    {s.status === "committed" || s.status === "discarded" ? "Open" : "Resume"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* "New plan" sheet — fresh empty-state. */}
      <PlanSheet
        open={newOpen}
        onOpenChange={setNewOpen}
        activeProjectId={projectId}
        projectName={projectName}
        projectTier={projectTier}
      />

      {/* Resume sheet — opens whichever session id was clicked. */}
      <PlanSheet
        open={openSessionId !== null}
        onOpenChange={(o) => {
          if (!o) setOpenSessionId(null);
        }}
        activeProjectId={projectId}
        projectName={projectName}
        projectTier={projectTier}
        initialSessionId={openSessionId}
      />
    </Card>
  );
}
